// Chat shell and local session history

'use strict';

function escapeHtml(input) {
  return String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const HISTORY_THINKING_SEGMENT_RE = /(?:<thinking>|&lt;thinking&gt;|<think>|&lt;think&gt;)([\s\S]*?)(?:<\/thinking>|&lt;\/thinking&gt;|<\/think>|&lt;\/think&gt;)/gi;
const HISTORY_ALLOWED_HTML_TAGS = new Set([
  'a',
  'b',
  'blockquote',
  'br',
  'code',
  'del',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'li',
  'ol',
  'p',
  'pre',
  'strong',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul'
]);
const SESSION_STORAGE_ENTRY_CACHE_COUNT = 60;
const SESSION_STORAGE_SCHEMA_VERSION = 2;
const SESSION_STORAGE_TITLE_MAX = 120;
const SESSION_STORAGE_PREVIEW_MAX = 4096;
const SESSION_CARD_TITLE_MAX = 80;
const SESSION_CARD_PREVIEW_MAX = 240;
const SESSION_PENDING_BACKUP_LIMIT = typeof MAX_LOCAL_SESSIONS === 'number' && MAX_LOCAL_SESSIONS > 0
  ? MAX_LOCAL_SESSIONS
  : 40;
const SESSION_HISTORY_DB_NAME = 'tm_session_history_db_v1';
const SESSION_HISTORY_STORE = 'session_entries';
const HISTORY_MCP_TOOL_RESULT_PREFIX = '[MCP_TOOL_RESULT]';
const HISTORY_TOOL_CALL_START_PREFIX = '[TM_TOOL_CALL_START:';
const HISTORY_TOOL_CALL_END_PREFIX = '[TM_TOOL_CALL_END:';
const HISTORY_TOOL_CALL_MARKER_SUFFIX = ']';
let sessionHistoryDbPromise = null;
let pendingDeleteSessionId = null;

function normalizeHistoryLineBreaks(input) {
  return String(input ?? '').replace(/\r\n?/g, '\n');
}

function sanitizeHistoryHref(rawHref) {
  const href = String(rawHref || '').trim();
  if (!href) return '';
  if (/^https?:\/\//i.test(href)) return href;
  if (/^mailto:/i.test(href)) return href;
  return '';
}

function sanitizeHistoryHtmlNode(root) {
  if (!root?.childNodes) return;
  const children = Array.from(root.childNodes);

  for (const child of children) {
    if (child.nodeType === Node.COMMENT_NODE) {
      child.remove();
      continue;
    }

    if (child.nodeType !== Node.ELEMENT_NODE) {
      continue;
    }

    const el = /** @type {Element} */ (child);
    const tag = el.tagName.toLowerCase();

    if (!HISTORY_ALLOWED_HTML_TAGS.has(tag)) {
      const textNode = document.createTextNode(el.textContent || '');
      el.replaceWith(textNode);
      continue;
    }

    const attrs = Array.from(el.attributes);
    for (const attr of attrs) {
      const name = attr.name.toLowerCase();
      if (tag === 'a' && name === 'href') continue;
      el.removeAttribute(attr.name);
    }

    if (tag === 'a') {
      const href = sanitizeHistoryHref(el.getAttribute('href'));
      if (!href) {
        el.removeAttribute('href');
      } else {
        el.setAttribute('href', href);
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
      }
    }

    sanitizeHistoryHtmlNode(el);
  }
}

function sanitizeHistoryHtmlFragment(input) {
  const source = String(input ?? '');
  if (!source.trim()) return '';
  const template = document.createElement('template');
  template.innerHTML = source;
  sanitizeHistoryHtmlNode(template.content);
  return template.innerHTML;
}

function splitHistoryThinkingSegments(input) {
  const source = normalizeHistoryLineBreaks(input);
  const segments = [];
  let lastIndex = 0;
  HISTORY_THINKING_SEGMENT_RE.lastIndex = 0;

  let match;
  while ((match = HISTORY_THINKING_SEGMENT_RE.exec(source)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', text: source.slice(lastIndex, match.index) });
    }
    segments.push({ type: 'thinking', text: match[1] || '' });
    lastIndex = HISTORY_THINKING_SEGMENT_RE.lastIndex;
  }

  if (lastIndex < source.length) {
    segments.push({ type: 'text', text: source.slice(lastIndex) });
  }

  if (segments.length === 0) {
    segments.push({ type: 'text', text: source });
  }

  return segments;
}

function extractHistoryMcpToolResultPayload(rawText) {
  const normalized = String(rawText || '').replace(/\r\n/g, '\n').trim();
  if (!normalized.startsWith(HISTORY_MCP_TOOL_RESULT_PREFIX)) return null;
  const payload = normalized.slice(HISTORY_MCP_TOOL_RESULT_PREFIX.length).trimStart();
  return payload || normalized;
}

function detectHistoryMcpToolResultStatus(payload) {
  const source = String(payload || '');
  const match = source.match(/(?:^|\n)\s*status\s*:\s*([^\n]+)/i);
  if (!match) return 'unknown';
  const normalized = String(match[1] || '').trim().toLowerCase();
  if (!normalized) return 'unknown';
  if (normalized.startsWith('ok') || normalized === 'success' || normalized === 'true') return 'ok';
  if (normalized.startsWith('error') || normalized.startsWith('fail') || normalized === 'false') return 'error';
  return 'unknown';
}

function isSafeHistoryToolCallToken(token) {
  return /^[a-z0-9_-]{4,80}$/i.test(String(token || ''));
}

function findHistoryToolCallMarker(source, markerPrefix, { fromIndex = 0, expectedToken = '' } = {}) {
  const text = String(source || '');
  let cursor = Math.max(0, fromIndex);
  while (cursor < text.length) {
    const startIndex = text.indexOf(markerPrefix, cursor);
    if (startIndex < 0) return null;
    const tokenStart = startIndex + markerPrefix.length;
    const tokenEnd = text.indexOf(HISTORY_TOOL_CALL_MARKER_SUFFIX, tokenStart);
    if (tokenEnd < 0) return null;
    const token = text.slice(tokenStart, tokenEnd).trim();
    const matched = isSafeHistoryToolCallToken(token)
      && (!expectedToken || token === expectedToken);
    if (matched) {
      return {
        token,
        startIndex,
        endIndex: tokenEnd + HISTORY_TOOL_CALL_MARKER_SUFFIX.length
      };
    }
    cursor = tokenEnd + 1;
  }
  return null;
}

function splitHistoryToolCallProtocolSegments(text) {
  const source = String(text || '');
  if (!source) return [];

  const segments = [];
  let cursor = 0;
  let safety = 0;

  while (cursor < source.length && safety < 24) {
    const startMarker = findHistoryToolCallMarker(source, HISTORY_TOOL_CALL_START_PREFIX, {
      fromIndex: cursor
    });
    if (!startMarker) break;

    const endMarker = findHistoryToolCallMarker(source, HISTORY_TOOL_CALL_END_PREFIX, {
      fromIndex: startMarker.endIndex,
      expectedToken: startMarker.token
    });
    if (!endMarker) break;

    const code = source.slice(startMarker.endIndex, endMarker.startIndex).trim();
    const isToolCall = /^\s*await\s+mcp\.call\(\s*(["'])[^"']+\1\s*,[\s\S]*\)\s*;?\s*$/i.test(code);
    if (!isToolCall) {
      break;
    }

    const beforeText = source.slice(cursor, startMarker.startIndex);
    if (beforeText) {
      segments.push({ type: 'text', text: beforeText });
    }
    segments.push({ type: 'tool', code });
    cursor = endMarker.endIndex;
    safety += 1;
  }

  if (cursor < source.length) {
    segments.push({ type: 'text', text: source.slice(cursor) });
  }

  if (segments.length === 0) {
    segments.push({ type: 'text', text: source });
  }

  return segments;
}

function renderHistoryToolCallBlock(code) {
  const sourceCode = typeof code === 'string' ? code : '';
  return `
    <div class="tm-tool-code-block">
      <details>
        <summary class="tm-tool-code-summary">
          <span class="tm-tool-summary-main">工具调用</span>
          <span class="tm-tool-summary-meta">点击展开</span>
        </summary>
        <div class="tm-tool-code-content">
          <pre><code>${escapeHtml(sourceCode)}</code></pre>
        </div>
      </details>
    </div>
  `.trim();
}

function renderHistoryMcpToolResultBlock(payload) {
  const normalizedPayload = typeof payload === 'string' ? payload : '';
  const status = detectHistoryMcpToolResultStatus(normalizedPayload);
  const statusText = status === 'ok' ? '点击展开 · 成功' : status === 'error' ? '点击展开 · 失败' : '点击展开';

  return `
    <div class="tm-tool-code-block tm-mcp-tool-result-block is-status-${escapeHtml(status)}">
      <details>
        <summary class="tm-tool-code-summary tm-tool-code-summary--result">
          <span class="tm-tool-summary-main">工具返回结果</span>
          <span class="tm-tool-summary-meta">${escapeHtml(statusText)}</span>
        </summary>
        <div class="tm-tool-code-content tm-mcp-tool-result-content">
          <pre>${escapeHtml(normalizedPayload)}</pre>
        </div>
      </details>
    </div>
  `.trim();
}

function isLikelyHistoryToolCodeBlock(lang, code) {
  const normalizedLang = String(lang || '').trim().toLowerCase();
  const normalizedCode = String(code || '').trimStart();
  if (/^(tool[_-]?code|toolcall|tool_call|mcp|mcp_tool)$/i.test(normalizedLang)) return true;
  return /^await\s+mcp\.call\(/.test(normalizedCode);
}

function renderHistoryInlineMarkdown(input) {
  const source = String(input ?? '');
  if (!source) return '';
  const tokens = [];

  let working = source.replace(/`([^`\n]+)`/g, (_match, code) => {
    const token = `@@TM_INLINE_TOKEN_${tokens.length}@@`;
    tokens.push({
      type: 'code',
      code: String(code || '')
    });
    return token;
  });

  working = working.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/gi, (_match, label, href) => {
    const token = `@@TM_INLINE_TOKEN_${tokens.length}@@`;
    tokens.push({
      type: 'link',
      label: String(label || ''),
      href: String(href || '')
    });
    return token;
  });

  let escaped = escapeHtml(working);
  escaped = escaped.replace(/\*\*([^*\n][\s\S]*?)\*\*/g, '<strong>$1</strong>');
  escaped = escaped.replace(/~~([^~\n][\s\S]*?)~~/g, '<del>$1</del>');

  return escaped.replace(/@@TM_INLINE_TOKEN_(\d+)@@/g, (_match, tokenIndexText) => {
    const token = tokens[Number(tokenIndexText)];
    if (!token) return '';
    if (token.type === 'code') {
      return `<code class="tm-history-inline-code">${escapeHtml(token.code || '')}</code>`;
    }
    if (token.type === 'link') {
      const href = sanitizeHistoryHref(token.href);
      const label = escapeHtml(token.label || token.href || '');
      if (!href) return label;
      return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    }
    return '';
  });
}

function renderHistoryCodeBlock(block) {
  if (!block) return '';
  const lang = typeof block.lang === 'string'
    ? block.lang.toLowerCase().replace(/[^a-z0-9.+#-]/g, '')
    : '';
  const langBadge = lang
    ? `<span class="tm-history-code-lang">${escapeHtml(lang)}</span>`
    : '';
  const classAttr = lang ? ` class="language-${escapeHtml(lang)}"` : '';
  const code = typeof block.code === 'string' ? block.code : '';
  if (isLikelyHistoryToolCodeBlock(lang, code)) {
    return renderHistoryToolCallBlock(code);
  }
  return `
    <div class="tm-history-code-wrap">
      ${langBadge}
      <button class="tm-history-code-copy" type="button" data-tm-action="copy-history-code" aria-label="复制代码块">复制</button>
      <pre class="tm-history-code-block"><code${classAttr}>${escapeHtml(code)}</code></pre>
    </div>
  `.trim();
}

function fallbackCopyText(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '-9999px';
  textarea.style.left = '-9999px';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  try {
    textarea.focus({ preventScroll: true });
  } catch (_error) {
    textarea.focus();
  }
  textarea.select();

  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch (_error) {
    copied = false;
  }

  textarea.remove();
  return copied;
}

async function copyHistoryCodeText(text) {
  const content = typeof text === 'string' ? text : '';
  if (!content) return false;

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(content);
      return true;
    } catch (_error) {
      // fall back to execCommand
    }
  }

  if (!document.body) return false;
  return fallbackCopyText(content);
}

function markHistoryCodeCopiedState(button, { copied }) {
  if (!(button instanceof HTMLButtonElement)) return;

  if (button._tmCopyStateTimer) {
    clearTimeout(button._tmCopyStateTimer);
    button._tmCopyStateTimer = null;
  }

  button.classList.toggle('is-copied', copied === true);
  button.classList.toggle('is-failed', copied === false);
  button.textContent = copied ? '已复制' : '复制失败';

  button._tmCopyStateTimer = setTimeout(() => {
    button.classList.remove('is-copied', 'is-failed');
    button.textContent = '复制';
    button._tmCopyStateTimer = null;
  }, copied ? 1200 : 1400);
}

async function handleHistoryCodeCopyAction(action) {
  const copyBtn = action instanceof HTMLButtonElement
    ? action
    : action?.closest?.('.tm-history-code-copy');
  if (!(copyBtn instanceof HTMLButtonElement)) return;

  const wrap = copyBtn.closest('.tm-history-code-wrap');
  const codeNode = wrap?.querySelector?.('.tm-history-code-block code');
  const rawText = codeNode?.textContent || '';
  if (!rawText) {
    markHistoryCodeCopiedState(copyBtn, { copied: false });
    return;
  }

  const copied = await copyHistoryCodeText(rawText.replace(/\u00A0/g, ' '));
  markHistoryCodeCopiedState(copyBtn, { copied });
}

function splitHistoryMarkdownTableRow(line) {
  const source = String(line ?? '');
  if (!source.includes('|')) return null;
  let trimmed = source.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('|')) {
    trimmed = trimmed.slice(1);
  }
  if (trimmed.endsWith('|')) {
    trimmed = trimmed.slice(0, -1);
  }

  const cells = [];
  let buffer = '';
  let escaping = false;
  for (const ch of trimmed) {
    if (escaping) {
      buffer += ch;
      escaping = false;
      continue;
    }
    if (ch === '\\') {
      escaping = true;
      continue;
    }
    if (ch === '|') {
      cells.push(buffer.trim());
      buffer = '';
      continue;
    }
    buffer += ch;
  }
  if (escaping) {
    buffer += '\\';
  }
  cells.push(buffer.trim());

  if (cells.length < 2) return null;
  return cells;
}

function isHistoryMarkdownTableSeparatorCell(cell) {
  const normalized = String(cell || '').replace(/\s+/g, '');
  return /^:?-{3,}:?$/.test(normalized);
}

function getHistoryMarkdownTableAlign(cell) {
  const normalized = String(cell || '').replace(/\s+/g, '');
  const hasLeft = normalized.startsWith(':');
  const hasRight = normalized.endsWith(':');
  if (hasLeft && hasRight) return 'center';
  if (hasRight) return 'right';
  if (hasLeft) return 'left';
  return '';
}

function renderHistoryMarkdownTable(headers, separatorCells, rows) {
  const aligns = separatorCells.map(getHistoryMarkdownTableAlign);
  const renderCell = (tag, value, index) => {
    const align = aligns[index] || '';
    const alignStyle = align ? ` style="text-align:${align}"` : '';
    return `<${tag}${alignStyle}>${renderHistoryInlineMarkdown(value || '')}</${tag}>`;
  };

  const headHtml = headers
    .map((cell, index) => renderCell('th', cell, index))
    .join('');

  const bodyHtml = rows
    .map((cells) => `<tr>${cells.map((cell, index) => renderCell('td', cell, index)).join('')}</tr>`)
    .join('');

  return `
    <div class="tm-history-table-wrap">
      <table class="tm-history-table">
        <thead><tr>${headHtml}</tr></thead>
        ${bodyHtml ? `<tbody>${bodyHtml}</tbody>` : ''}
      </table>
    </div>
  `.trim();
}

function renderHistoryMarkdownFragment(input) {
  const source = normalizeHistoryLineBreaks(input).trim();
  if (!source) return '';
  const codeBlocks = [];

  const withCodeTokens = source.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (_match, lang, code) => {
    const token = `@@TM_CODE_BLOCK_${codeBlocks.length}@@`;
    codeBlocks.push({
      lang: String(lang || '').trim(),
      code: String(code || '').replace(/^\n+|\n+$/g, '')
    });
    return `\n${token}\n`;
  });

  const lines = withCodeTokens.split('\n');
  const chunks = [];
  let listType = '';
  let paragraphLines = [];

  const closeList = () => {
    if (!listType) return;
    chunks.push(`</${listType}>`);
    listType = '';
  };

  const flushParagraph = () => {
    if (paragraphLines.length === 0) return;
    const paragraph = renderHistoryInlineMarkdown(paragraphLines.join('\n')).replace(/\n/g, '<br>');
    chunks.push(`<p>${paragraph}</p>`);
    paragraphLines = [];
  };

  const appendToLastListItem = (htmlText) => {
    if (chunks.length === 0) return false;
    const lastIndex = chunks.length - 1;
    const lastChunk = chunks[lastIndex];
    if (!/^<li>[\s\S]*<\/li>$/.test(lastChunk)) return false;
    chunks[lastIndex] = lastChunk.replace(/<\/li>$/, `<br>${htmlText}</li>`);
    return true;
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const trimmed = line.trim();
    const codeToken = trimmed.match(/^@@TM_CODE_BLOCK_(\d+)@@$/);
    if (codeToken) {
      flushParagraph();
      closeList();
      chunks.push(`@@TM_CODE_BLOCK_${codeToken[1]}@@`);
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      closeList();
      continue;
    }

    const headerCells = splitHistoryMarkdownTableRow(line);
    const separatorCells = splitHistoryMarkdownTableRow(lines[lineIndex + 1] || '');
    const isTable = Array.isArray(headerCells)
      && Array.isArray(separatorCells)
      && headerCells.length === separatorCells.length
      && separatorCells.every(isHistoryMarkdownTableSeparatorCell);
    if (isTable) {
      flushParagraph();
      closeList();

      const bodyRows = [];
      let nextLineIndex = lineIndex + 2;
      while (nextLineIndex < lines.length) {
        const rowLine = lines[nextLineIndex];
        const rowTrimmed = rowLine.trim();
        if (!rowTrimmed) break;
        if (/^@@TM_CODE_BLOCK_(\d+)@@$/.test(rowTrimmed)) break;
        const rowCells = splitHistoryMarkdownTableRow(rowLine);
        if (!rowCells || rowCells.length !== headerCells.length) break;
        bodyRows.push(rowCells);
        nextLineIndex += 1;
      }

      chunks.push(renderHistoryMarkdownTable(headerCells, separatorCells, bodyRows));
      lineIndex = nextLineIndex - 1;
      continue;
    }

    if (/^([-*_]\s*){3,}$/.test(trimmed)) {
      flushParagraph();
      closeList();
      chunks.push('<hr>');
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      closeList();
      const level = heading[1].length;
      chunks.push(`<h${level}>${renderHistoryInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    const blockquote = trimmed.match(/^>\s?(.*)$/);
    if (blockquote) {
      flushParagraph();
      closeList();
      chunks.push(`<blockquote>${renderHistoryInlineMarkdown(blockquote[1])}</blockquote>`);
      continue;
    }

    const ordered = trimmed.match(/^\d+\.\s+(.+)$/);
    if (ordered) {
      flushParagraph();
      if (listType !== 'ol') {
        closeList();
        chunks.push('<ol>');
        listType = 'ol';
      }
      chunks.push(`<li>${renderHistoryInlineMarkdown(ordered[1])}</li>`);
      continue;
    }

    const unordered = trimmed.match(/^[-*+]\s+(.+)$/);
    if (unordered) {
      flushParagraph();
      if (listType !== 'ul') {
        closeList();
        chunks.push('<ul>');
        listType = 'ul';
      }
      chunks.push(`<li>${renderHistoryInlineMarkdown(unordered[1])}</li>`);
      continue;
    }

    if (listType) {
      const appended = appendToLastListItem(renderHistoryInlineMarkdown(trimmed));
      if (appended) {
        continue;
      }
      closeList();
    }

    paragraphLines.push(line.replace(/\s+$/g, ''));
  }

  flushParagraph();
  closeList();

  return chunks.join('').replace(/@@TM_CODE_BLOCK_(\d+)@@/g, (_match, tokenIndexText) => {
    return renderHistoryCodeBlock(codeBlocks[Number(tokenIndexText)]);
  });
}

function renderHistoryRawTextSegment(input) {
  const source = normalizeHistoryLineBreaks(input).trim();
  if (!source) return '';
  const mcpPayload = extractHistoryMcpToolResultPayload(source);
  if (mcpPayload) {
    return renderHistoryMcpToolResultBlock(mcpPayload);
  }
  const looksLikeHtml = /<\/?[a-z][^>]*>/i.test(source);
  if (looksLikeHtml && !/```/.test(source)) {
    const html = sanitizeHistoryHtmlFragment(source);
    if (html) return html;
  }
  return renderHistoryMarkdownFragment(source);
}

function renderHistoryTextSegment(input, options = {}) {
  const source = normalizeHistoryLineBreaks(input);
  if (!source.trim()) return '';
  const enableToolCallProtocol = options?.enableToolCallProtocol === true;

  if (!enableToolCallProtocol) {
    return renderHistoryRawTextSegment(source);
  }

  const protocolSegments = splitHistoryToolCallProtocolSegments(source);
  if (protocolSegments.length === 0) return '';

  return protocolSegments.map((segment) => {
    if (segment.type === 'tool') {
      return renderHistoryToolCallBlock(segment.code);
    }
    return renderHistoryRawTextSegment(segment.text);
  }).filter(Boolean).join('');
}

function renderHistoryBubbleText(input, options = {}) {
  const role = typeof options?.role === 'string' ? options.role : '';
  const enableToolCallProtocol = role === 'assistant';
  const normalizedInput = role === 'assistant'
    ? stripContinuationMarkersForHistory(input)
    : input;
  const segments = splitHistoryThinkingSegments(normalizedInput);
  const htmlParts = [];

  for (const segment of segments) {
    const rendered = renderHistoryTextSegment(segment.text, { enableToolCallProtocol });
    if (!rendered) continue;
    if (segment.type === 'thinking') {
      htmlParts.push(`
        <div class="tm-thinking-block">
          <details>
            <summary>思考过程</summary>
            <div class="tm-thinking-content">${rendered}</div>
          </details>
        </div>
      `.trim());
      continue;
    }
    htmlParts.push(rendered);
  }

  return htmlParts.join('') || '<p></p>';
}

function hasHistoryThinkingSegment(input) {
  return splitHistoryThinkingSegments(input).some((segment) => segment.type === 'thinking');
}

function getSessionStorageSchemaVersion() {
  return SESSION_STORAGE_SCHEMA_VERSION;
}

function getSessionHistoryDb() {
  if (typeof indexedDB === 'undefined') {
    return Promise.resolve(null);
  }
  if (sessionHistoryDbPromise) return sessionHistoryDbPromise;

  sessionHistoryDbPromise = new Promise((resolve) => {
    let request;
    try {
      request = indexedDB.open(SESSION_HISTORY_DB_NAME, 1);
    } catch (_error) {
      resolve(null);
      return;
    }

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SESSION_HISTORY_STORE)) {
        db.createObjectStore(SESSION_HISTORY_STORE, { keyPath: 'sessionId' });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => {
      sessionHistoryDbPromise = null;
      resolve(null);
    };
    request.onblocked = () => {
      sessionHistoryDbPromise = null;
      resolve(null);
    };
  });

  return sessionHistoryDbPromise;
}

async function loadPersistedSessionEntries(sessionId) {
  const record = await loadPersistedSessionRecord(sessionId);
  return Array.isArray(record?.entries) ? record.entries : [];
}

async function loadPersistedSessionRecord(sessionId) {
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!normalizedSessionId) return null;
  const db = await getSessionHistoryDb();
  if (!db) return null;

  return new Promise((resolve) => {
    const tx = db.transaction(SESSION_HISTORY_STORE, 'readonly');
    const store = tx.objectStore(SESSION_HISTORY_STORE);
    const request = store.get(normalizedSessionId);

    request.onsuccess = () => {
      const record = request.result;
      if (!record || typeof record !== 'object') {
        resolve(null);
        return;
      }
      const entries = Array.isArray(record.entries)
        ? normalizeSessionEntries(record.entries, Number.POSITIVE_INFINITY)
        : [];
      resolve({
        sessionId: normalizedSessionId,
        conversationKey: typeof record.conversationKey === 'string' ? record.conversationKey : '',
        updatedAt: Number.isFinite(record.updatedAt) ? record.updatedAt : 0,
        title: normalizeSessionTitle(record.title || ''),
        preview: normalizeSessionPreviewText(record.preview || deriveSessionPreviewFromEntries(entries)),
        entryCount: Number.isFinite(record.entryCount) && record.entryCount > 0
          ? Math.max(record.entryCount, entries.length)
          : entries.length,
        entries
      });
    };
    request.onerror = () => resolve(null);
    tx.onabort = () => resolve(null);
    tx.onerror = () => resolve(null);
  });
}

async function persistSessionEntriesToDb(session) {
  if (!session || typeof session !== 'object') return false;
  const sessionId = typeof session.id === 'string' ? session.id.trim() : '';
  if (!sessionId) return false;
  const db = await getSessionHistoryDb();
  if (!db) return false;

  let entries = collapseContinuationEntriesByProtocol(
    normalizeSessionEntries(session.entries, Number.POSITIVE_INFINITY)
  );
  const persistedEntryCount = getSessionPersistedEntryCount(session);
  if (persistedEntryCount > entries.length) {
    const persistedRecord = await loadPersistedSessionRecord(sessionId);
    const persistedEntries = normalizeSessionEntries(persistedRecord?.entries, Number.POSITIVE_INFINITY);
    if (persistedEntries.length > 0) {
      entries = collapseContinuationEntriesByProtocol(mergeSessionEntries(persistedEntries, entries));
    }
  }

  const title = deriveSessionTitleFromEntries(entries, session.title || '新会话');
  const preview = deriveSessionPreviewFromEntries(entries, session.preview || '');
  syncSessionDerivedFields(session, entries, { replaceEntries: true });
  const payload = {
    sessionId,
    conversationKey: typeof session.conversationKey === 'string' ? session.conversationKey : '',
    updatedAt: Number.isFinite(session.updatedAt) ? session.updatedAt : Date.now(),
    title,
    preview,
    entryCount: entries.length,
    entries
  };

  return new Promise((resolve) => {
    const tx = db.transaction(SESSION_HISTORY_STORE, 'readwrite');
    const store = tx.objectStore(SESSION_HISTORY_STORE);
    store.put(payload);
    tx.oncomplete = () => {
      let changed = syncSessionDerivedFields(session, entries, { replaceEntries: true, markPersisted: true });
      if (session.title !== title) {
        session.title = title;
        changed = true;
      }
      if (session.preview !== preview) {
        session.preview = preview;
        changed = true;
      }
      if (changed && state.sessionsLoaded) {
        persistSessionsSoon(0);
      }
      resolve(true);
    };
    tx.onerror = () => resolve(false);
    tx.onabort = () => resolve(false);
  });
}

function persistSessionEntriesToDbSoon(session) {
  void persistSessionEntriesToDb(session);
}

async function deletePersistedSessionEntries(sessionId) {
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!normalizedSessionId) return false;
  const db = await getSessionHistoryDb();
  if (!db) return false;

  return new Promise((resolve) => {
    const tx = db.transaction(SESSION_HISTORY_STORE, 'readwrite');
    const store = tx.objectStore(SESSION_HISTORY_STORE);
    store.delete(normalizedSessionId);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
    tx.onabort = () => resolve(false);
  });
}

function deletePersistedSessionEntriesSoon(sessionId) {
  void deletePersistedSessionEntries(sessionId);
}

async function prunePersistedSessionEntriesByActiveSessions() {
  const db = await getSessionHistoryDb();
  if (!db) return;
  const aliveSessionIds = new Set(
    state.sessions
      .map((session) => (typeof session?.id === 'string' ? session.id : ''))
      .filter(Boolean)
  );

  await new Promise((resolve) => {
    const tx = db.transaction(SESSION_HISTORY_STORE, 'readwrite');
    const store = tx.objectStore(SESSION_HISTORY_STORE);
    const cursorReq = store.openCursor();

    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) return;
      const key = typeof cursor.key === 'string' ? cursor.key : '';
      if (key && !aliveSessionIds.has(key)) {
        cursor.delete();
      }
      cursor.continue();
    };
    cursorReq.onerror = () => resolve();
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

async function resolveSessionEntriesForModal(session) {
  const memoryEntries = collapseContinuationFragmentsForHistory(
    normalizeSessionEntries(session?.entries, Number.POSITIVE_INFINITY)
  );
  const persistedRawEntries = await loadPersistedSessionEntries(session?.id);
  const persistedEntries = collapseContinuationFragmentsForHistory(persistedRawEntries);
  if (persistedEntries.length > 0) {
    if (areSessionEntryListsEquivalent(memoryEntries, persistedEntries)) {
      if (!session.entries || session.entries.length !== persistedEntries.length) {
        session.entries = persistedEntries;
      }
      if (persistedRawEntries.length !== persistedEntries.length) {
        persistSessionEntriesToDbSoon(session);
      }
      return persistedEntries;
    }

    if (memoryEntries.length > persistedEntries.length && hasPendingSessionEntryBackup(session)) {
      session.entries = memoryEntries;
      persistSessionEntriesToDbSoon(session);
      return memoryEntries;
    }

    session.entries = persistedEntries;
    return persistedEntries;
  }
  return memoryEntries;
}

async function reconcileSessionPersistence(session) {
  if (!session || typeof session !== 'object') return;
  const cacheEntries = normalizeSessionEntries(session.entries, Number.POSITIVE_INFINITY);
  const persistedRecord = await loadPersistedSessionRecord(session.id);
  const persistedEntries = normalizeSessionEntries(persistedRecord?.entries, Number.POSITIVE_INFINITY);

  if (persistedEntries.length > 0) {
    if (cacheEntries.length > persistedEntries.length && hasPendingSessionEntryBackup(session)) {
      const didPersist = await persistSessionEntriesToDb(session);
      if (didPersist) {
        renderSessionSidebar({ preserveScroll: true });
      }
      return;
    }
    const changed = applyPersistedSessionRecord(session, persistedRecord, {
      replaceEntries: cacheEntries.length === 0 || persistedEntries.length >= cacheEntries.length
    });
    if (changed) {
      renderSessionSidebar({ preserveScroll: true });
    }
    return;
  }

  if (cacheEntries.length === 0) return;
  const didPersist = await persistSessionEntriesToDb(session);
  if (didPersist) {
    renderSessionSidebar({ preserveScroll: true });
  }
}

function reconcileSessionPersistenceSoon(session) {
  void reconcileSessionPersistence(session);
}

function ensureSessionRenderCount(total) {
  const pageSize = Math.max(1, Number(SESSION_PAGE_SIZE) || 10);
  if (!Number.isFinite(state.sessionsRenderCount) || state.sessionsRenderCount < pageSize) {
    state.sessionsRenderCount = pageSize;
  }
  if (total <= 0) {
    state.sessionsRenderCount = pageSize;
    return;
  }
  state.sessionsRenderCount = Math.min(Math.max(pageSize, state.sessionsRenderCount), total);
}

function getSortedSessions() {
  return [...state.sessions].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function getSessionById(sessionId) {
  if (!sessionId) return null;
  return state.sessions.find((session) => session.id === sessionId) || null;
}

function renderHistoryNoteHtml(hasLockedSession) {
  const line1 = hasLockedSession
    ? '当前会话正在生成，仅该会话卡片暂不可点击'
    : '点击会话卡片可查看历史摘要';
  const line2 = `最多保存 ${MAX_LOCAL_SESSIONS} 条历史会话`;
  return `<span>${escapeHtml(line1)}</span><span>${escapeHtml(line2)}</span>`;
}

function deleteHistorySession(sessionId) {
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!normalizedSessionId) return false;
  const target = getSessionById(normalizedSessionId);
  if (!target) return false;
  if (isSessionCardDisabled(normalizedSessionId)) return false;
  pendingDeleteSessionId = null;

  state.sessions = state.sessions.filter((session) => session.id !== normalizedSessionId);

  Object.keys(state.pendingApiSessions).forEach((conversationKey) => {
    if (state.pendingApiSessions[conversationKey] === normalizedSessionId) {
      delete state.pendingApiSessions[conversationKey];
    }
  });

  if (state.activeSessionId === normalizedSessionId) {
    state.activeSessionId = state.sessions[0]?.id || null;
  }
  if (state.historyModalSessionId === normalizedSessionId) {
    closeHistorySummaryModal();
  }

  deletePersistedSessionEntriesSoon(normalizedSessionId);
  renderSessionSidebar();
  persistSessionsSoon(0);
  return true;
}

function getHistorySessions(sortedSessions = null) {
  const source = Array.isArray(sortedSessions) ? sortedSessions : getSortedSessions();
  return source;
}

function ensureSessionListScrollBinding() {
  const list = state.shellSidebar?.querySelector?.('#tm-session-list');
  if (!list || list.dataset.tmPagingBound === '1') return;
  list.dataset.tmPagingBound = '1';
  list.addEventListener('scroll', onSessionListScroll, { passive: true });
}

function getShellMenuButton() {
  const button = state.shellHost?.querySelector?.('#tm-shell-menu-toggle');
  return button instanceof HTMLButtonElement ? button : null;
}

function getShellBackdropElement() {
  const backdrop = state.shellHost?.querySelector?.('#tm-shell-backdrop');
  return backdrop instanceof HTMLElement ? backdrop : null;
}

function getShellMobileControlsHost() {
  const host = state.shellHost?.querySelector?.('#tm-shell-mobile-controls');
  return host instanceof HTMLElement ? host : null;
}

function dismissShellAnchoredMcpPanel() {
  if (!state.mcpPanelOpen) return;
  if (typeof removeMcpPanel === 'function') {
    removeMcpPanel();
  }
  state.mcpPanelOpen = false;
  if (typeof updateMcpButtonState === 'function') {
    updateMcpButtonState();
  }
}

function focusShellMenuPrimaryAction() {
  const sidebar = state.shellSidebar;
  if (!(sidebar instanceof HTMLElement)) return;

  const primary = sidebar.querySelector(
    '.tm-new-session-btn, #tm-session-list .tm-session-item:not(:disabled), .tm-session-delete-confirm-btn:not(:disabled)'
  );
  if (primary instanceof HTMLElement) {
    primary.focus();
    return;
  }
  sidebar.focus();
}

function syncShellMenuUi() {
  const shell = state.shellHost;
  const sidebar = state.shellSidebar;
  if (!(shell instanceof HTMLElement) || !(sidebar instanceof HTMLElement)) return;

  const mobile = isShellMobileViewport();
  if (!mobile) {
    state.shellMenuOpen = false;
  }
  const menuOpen = mobile && state.shellMenuOpen === true;

  shell.classList.toggle('is-mobile', mobile);
  shell.classList.toggle('is-menu-open', menuOpen);
  document.body?.classList?.toggle('tm-shell-menu-open', menuOpen);

  const button = getShellMenuButton();
  if (button) {
    button.hidden = !mobile;
    button.setAttribute('aria-expanded', menuOpen ? 'true' : 'false');
    button.setAttribute('aria-label', menuOpen ? '关闭工具箱菜单' : '打开工具箱菜单');
    button.title = menuOpen ? '关闭菜单' : '打开菜单';
  }

  const backdrop = getShellBackdropElement();
  if (backdrop) {
    backdrop.setAttribute('aria-hidden', menuOpen ? 'false' : 'true');
  }

  if (mobile) {
    sidebar.setAttribute('role', 'dialog');
    sidebar.setAttribute('aria-modal', 'true');
    sidebar.setAttribute('aria-hidden', menuOpen ? 'false' : 'true');
    sidebar.setAttribute('tabindex', '-1');
  } else {
    sidebar.removeAttribute('role');
    sidebar.removeAttribute('aria-modal');
    sidebar.removeAttribute('aria-hidden');
    sidebar.removeAttribute('tabindex');
  }

  if (state.mcpPanelOpen && typeof getMcpPanelElement === 'function' && typeof repositionMcpPanel === 'function') {
    const panel = getMcpPanelElement();
    if (panel && (!mobile || menuOpen)) {
      requestAnimationFrame(() => repositionMcpPanel(panel));
    }
  }
}

function setShellMenuOpen(nextOpen, { restoreFocus = false, dismissMcpPanel = false, focusDrawer = false } = {}) {
  if (!state.shellHost || !state.shellSidebar) return false;

  const mobile = isShellMobileViewport();
  const resolvedOpen = mobile && nextOpen === true;
  if (!resolvedOpen && dismissMcpPanel) {
    dismissShellAnchoredMcpPanel();
  }

  state.shellMenuOpen = resolvedOpen;
  syncShellMenuUi();

  if (resolvedOpen && focusDrawer) {
    requestAnimationFrame(() => {
      if (state.shellMenuOpen) {
        focusShellMenuPrimaryAction();
      }
    });
  }

  if (!resolvedOpen && restoreFocus) {
    requestAnimationFrame(() => {
      getShellMenuButton()?.focus?.();
    });
  }

  return resolvedOpen;
}

function closeShellMenu(options = {}) {
  return setShellMenuOpen(false, options);
}

function toggleShellMenu() {
  return setShellMenuOpen(!state.shellMenuOpen, {
    restoreFocus: state.shellMenuOpen === true,
    dismissMcpPanel: state.shellMenuOpen === true,
    focusDrawer: state.shellMenuOpen !== true
  });
}

function syncShellResponsiveLayout({ reason = 'manual' } = {}) {
  if (!state.shellHost || !state.shellSidebar) return;

  if (reason === 'route_change' && state.shellMenuOpen) {
    setShellMenuOpen(false, { restoreFocus: false, dismissMcpPanel: true });
    return;
  }

  if (!isShellMobileViewport() && state.shellMenuOpen) {
    setShellMenuOpen(false, { restoreFocus: false, dismissMcpPanel: true });
    return;
  }

  syncShellMenuUi();

  if (isShellMobileViewport() && !state.shellMenuOpen) {
    dismissShellAnchoredMcpPanel();
  }
}

function onHistoryModalKeydown(event) {
  if (event.key !== 'Escape') return;
  if (isShellMobileViewport() && state.shellMenuOpen) {
    event.preventDefault();
    closeShellMenu({ restoreFocus: true, dismissMcpPanel: true });
    return;
  }
  const modal = document.getElementById('tm-history-modal');
  if (!modal || modal.getAttribute('aria-hidden') !== 'false') return;
  event.preventDefault();
  closeHistorySummaryModal({ restoreFocus: true });
}

function ensureHistoryModal() {
  let modal = document.getElementById('tm-history-modal');
  if (modal) return modal;
  if (!document.body) return null;

  modal = document.createElement('div');
  modal.id = 'tm-history-modal';
  modal.setAttribute('aria-hidden', 'true');
  modal.innerHTML = `
    <div class="tm-history-modal-backdrop" data-tm-action="close-history-modal"></div>
    <section class="tm-history-modal-panel" role="dialog" aria-modal="true" aria-labelledby="tm-history-modal-title" tabindex="-1">
      <header class="tm-history-modal-header">
        <div class="tm-history-modal-meta">
          <span class="tm-history-modal-kicker">历史会话摘要</span>
          <h3 id="tm-history-modal-title">历史会话</h3>
          <p id="tm-history-modal-subtitle"></p>
        </div>
        <button class="tm-history-modal-close" type="button" data-tm-action="close-history-modal" aria-label="关闭历史会话摘要">
          <span aria-hidden="true">×</span>
        </button>
      </header>
      <div id="tm-history-modal-body" class="tm-history-modal-body" role="document"></div>
    </section>
  `.trim();

  modal.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const copyAction = target.closest('[data-tm-action="copy-history-code"]');
    if (copyAction) {
      event.preventDefault();
      event.stopPropagation();
      void handleHistoryCodeCopyAction(copyAction);
      return;
    }

    const closeAction = target.closest('[data-tm-action="close-history-modal"]');
    if (!closeAction) return;
    event.preventDefault();
    closeHistorySummaryModal({ restoreFocus: true });
  });

  if (!state.historyModalKeyListenerBound) {
    document.addEventListener('keydown', onHistoryModalKeydown, true);
    state.historyModalKeyListenerBound = true;
  }

  document.body.appendChild(modal);
  return modal;
}

function closeHistorySummaryModal({ restoreFocus = false } = {}) {
  const modal = document.getElementById('tm-history-modal');
  if (!modal) return;

  modal.classList.remove('is-open');
  modal.setAttribute('aria-hidden', 'true');
  state.historyModalSessionId = null;

  if (restoreFocus) {
    if (isShellMobileViewport() && !state.shellMenuOpen) {
      getShellMenuButton()?.focus?.();
      return;
    }
    const firstBtn = state.shellSidebar?.querySelector?.('#tm-session-list .tm-session-item:not(:disabled)');
    firstBtn?.focus?.();
  }
}

function removeHistoryModal() {
  const modal = document.getElementById('tm-history-modal');
  if (modal) {
    modal.remove();
  }
  state.historyModalSessionId = null;
}

function getSessionListLockedId() {
  if (!state.streaming) return null;
  const activeSessionId = typeof state.activeSessionId === 'string' ? state.activeSessionId.trim() : '';
  return activeSessionId || null;
}

function isSessionCardDisabled(sessionId) {
  if (!sessionId) return false;
  const lockedSessionId = getSessionListLockedId();
  return Boolean(lockedSessionId && lockedSessionId === sessionId);
}

async function openHistorySummaryModal(sessionId) {
  const session = getSessionById(sessionId);
  if (!session) return;

  if (isShellMobileViewport() && state.shellMenuOpen) {
    closeShellMenu({ restoreFocus: false, dismissMcpPanel: true });
  }

  const modal = ensureHistoryModal();
  if (!modal) return;

  const titleEl = modal.querySelector('#tm-history-modal-title');
  const subtitleEl = modal.querySelector('#tm-history-modal-subtitle');
  const bodyEl = modal.querySelector('#tm-history-modal-body');
  const panelEl = modal.querySelector('.tm-history-modal-panel');
  if (!titleEl || !subtitleEl || !bodyEl || !panelEl) return;

  const title = sanitizeTextFragment(session.title || '历史会话', 60);

  titleEl.textContent = title;
  subtitleEl.textContent = '正在加载历史内容…';
  bodyEl.innerHTML = '<div class="tm-history-modal-empty">正在加载历史内容…</div>';
  state.historyModalSessionId = session.id;
  modal.classList.add('is-open');
  modal.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => panelEl.focus());

  let normalizedEntries = [];
  try {
    normalizedEntries = await resolveSessionEntriesForModal(session);
  } catch (_error) {
    normalizedEntries = collapseContinuationFragmentsForHistory(
      normalizeSessionEntries(session.entries, Number.POSITIVE_INFINITY)
    );
  }
  if (state.historyModalSessionId !== session.id) return;

  normalizedEntries = collapseContinuationFragmentsForHistory(normalizedEntries);

  const updated = formatSessionTime(session.updatedAt || session.createdAt || Date.now());
  subtitleEl.textContent = `${updated ? `最近更新 ${updated} · ` : ''}${normalizedEntries.length} 条历史记录`;

  bodyEl.innerHTML = normalizedEntries.length === 0
    ? '<div class="tm-history-modal-empty">暂无可展示的历史内容</div>'
    : normalizedEntries.map((entry, index) => {
      const isMcpResult = Boolean(extractHistoryMcpToolResultPayload(entry.text));
      const displayRole = isMcpResult ? 'user' : entry.role;
      const roleLabel = displayRole === 'assistant' ? '助手' : '你';
      const roleClass = displayRole === 'assistant' ? 'is-assistant' : 'is-user';
      const thinkingClass = hasHistoryThinkingSegment(entry.text) ? ' has-thinking' : '';
      const mcpResultClass = displayRole === 'user' && isMcpResult ? ' is-mcp-result' : '';
      return `
        <article class="tm-history-bubble ${roleClass}${thinkingClass}${mcpResultClass}" data-role="${displayRole}" data-index="${index + 1}">
          <header class="tm-history-bubble-role">${roleLabel}</header>
          <div class="tm-history-bubble-text">${renderHistoryBubbleText(entry.text, { role: displayRole })}</div>
        </article>
      `.trim();
    }).join('');
}

function renderSessionSidebar({ preserveScroll = true } = {}) {
  const list = state.shellSidebar?.querySelector?.('#tm-session-list');
  const note = state.shellSidebar?.querySelector?.('.tm-history-note');
  if (!list) return;

  ensureSessionListScrollBinding();

  const sorted = getSortedSessions();
  const lockedSessionId = getSessionListLockedId();
  const hasLockedSession = Boolean(lockedSessionId);
  state.shellSidebar?.classList?.toggle('is-locked', hasLockedSession);
  const noteHtml = renderHistoryNoteHtml(hasLockedSession);
  if (note) {
    if (note.innerHTML !== noteHtml) {
      note.innerHTML = noteHtml;
    }
  }

  const historySessions = getHistorySessions(sorted);
  if (pendingDeleteSessionId && !historySessions.some((session) => session.id === pendingDeleteSessionId)) {
    pendingDeleteSessionId = null;
  }
  let nextListHtml = '';
  if (historySessions.length === 0) {
    state.sessionsRenderCount = Math.max(1, Number(SESSION_PAGE_SIZE) || 10);
    nextListHtml = '<div class="tm-empty-history">暂无本地会话记录</div>';
  } else {
    ensureSessionRenderCount(historySessions.length);
    const visible = historySessions.slice(0, state.sessionsRenderCount);
    const hasMore = visible.length < historySessions.length;
    nextListHtml = [
      ...visible.map((session) => {
        const titleText = sanitizeTextFragment(session.title || '新会话', SESSION_CARD_TITLE_MAX);
        const previewText = sanitizeTextFragment(session.preview || '', SESSION_CARD_PREVIEW_MAX);
        const title = escapeHtml(titleText);
        const preview = escapeHtml(previewText);
        const tooltip = escapeHtml(
          [session.title || '新会话', session.preview || '']
            .filter(Boolean)
            .join('\n')
        );
        const updated = escapeHtml(formatSessionTime(session.updatedAt || session.createdAt || Date.now()));
        const disabled = isSessionCardDisabled(session.id) ? ' disabled aria-disabled="true"' : '';
        const deleteDisabled = isSessionCardDisabled(session.id) ? ' disabled aria-disabled="true"' : '';
        const confirmClass = pendingDeleteSessionId === session.id ? ' is-delete-confirm' : '';
        return `
          <div class="tm-session-row${confirmClass}">
            <button class="tm-session-item" data-tm-action="open-history-session" data-session-id="${escapeHtml(session.id)}" type="button" aria-label="查看历史会话摘要" title="${tooltip}"${disabled}>
              <span class="tm-session-title">${title}</span>
              <span class="tm-session-preview">${preview || '等待第一条消息…'}</span>
              <span class="tm-session-time">${updated}</span>
            </button>
            <button class="tm-session-delete" data-tm-action="delete-history-session" data-session-id="${escapeHtml(session.id)}" type="button" aria-label="删除历史会话"${deleteDisabled}>
              <span aria-hidden="true">×</span>
            </button>
            <div class="tm-session-delete-confirm" role="group" aria-label="确认删除会话">
              <div class="tm-session-delete-confirm-text">确认删除该会话？</div>
              <div class="tm-session-delete-confirm-actions">
                <button class="tm-session-delete-confirm-btn danger" data-tm-action="confirm-delete-history-session" data-session-id="${escapeHtml(session.id)}" type="button"${deleteDisabled}>删除</button>
                <button class="tm-session-delete-confirm-btn" data-tm-action="cancel-delete-history-session" data-session-id="${escapeHtml(session.id)}" type="button">取消</button>
              </div>
            </div>
          </div>
        `.trim();
      }),
      hasMore ? `<div class="tm-session-more">继续下滑加载更多（${visible.length}/${historySessions.length}）</div>` : ''
    ].join('');
  }

  const nextRenderKey = `${nextListHtml.length}:${shortHash(nextListHtml)}`;
  const prevRenderKey = list.dataset.tmRenderKey || '';
  if (prevRenderKey !== nextRenderKey) {
    const scrollTop = preserveScroll ? list.scrollTop : 0;
    list.innerHTML = nextListHtml;
    list.dataset.tmRenderKey = nextRenderKey;
    if (preserveScroll) {
      list.scrollTop = scrollTop;
    } else {
      list.scrollTop = 0;
    }
  } else if (!preserveScroll) {
    list.scrollTop = 0;
  }

  if (lockedSessionId && state.historyModalSessionId === lockedSessionId) {
    closeHistorySummaryModal();
  } else if (state.historyModalSessionId && !getSessionById(state.historyModalSessionId)) {
    closeHistorySummaryModal();
  }
}

function ensureShellRefsFromDom() {
  const host = document.getElementById('tm-chat-shell');
  state.shellHost = host || null;
  state.shellSidebar = host?.querySelector?.('#tm-history-sidebar') || null;
  state.shellStage = host?.querySelector?.('#tm-chat-stage') || null;
}

function onSessionListScroll(event) {
  const list = event.currentTarget;
  if (!(list instanceof Element)) return;
  if (state.sessionPagingBusy) return;
  if (list.scrollTop + list.clientHeight < list.scrollHeight - 20) return;

  const total = getHistorySessions().length;
  if (state.sessionsRenderCount >= total) return;

  state.sessionPagingBusy = true;
  state.sessionsRenderCount = Math.min(total, state.sessionsRenderCount + Math.max(1, Number(SESSION_PAGE_SIZE) || 10));
  renderSessionSidebar({ preserveScroll: true });
  state.sessionPagingBusy = false;
}

function triggerForceReloadCurrentPage() {
  let fallbackUsed = false;
  const fallbackReload = () => {
    if (fallbackUsed) return;
    fallbackUsed = true;
    window.location.reload();
  };

  try {
    chrome.runtime.sendMessage({ type: 'TAB_FORCE_RELOAD', bypassCache: true }, (response) => {
      if (chrome.runtime?.lastError) {
        fallbackReload();
        return;
      }
      if (!response || response.ok !== true) {
        fallbackReload();
      }
    });
  } catch (_error) {
    fallbackReload();
  }
}

function onSessionSidebarClick(event) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const action = target.closest('[data-tm-action]');

  if (action?.dataset.tmAction === 'toggle-shell-menu') {
    event.preventDefault();
    event.stopPropagation();
    toggleShellMenu();
    return;
  }

  if (action?.dataset.tmAction === 'close-shell-menu') {
    event.preventDefault();
    event.stopPropagation();
    closeShellMenu({ restoreFocus: true, dismissMcpPanel: true });
    return;
  }

  if (action?.dataset.tmAction === 'refresh-current-page') {
    event.preventDefault();
    event.stopPropagation();
    triggerForceReloadCurrentPage();
    return;
  }

  if (action?.dataset.tmAction === 'confirm-delete-history-session') {
    event.preventDefault();
    event.stopPropagation();
    const sessionId = action.getAttribute('data-session-id');
    if (!sessionId) return;
    deleteHistorySession(sessionId);
    return;
  }

  if (action?.dataset.tmAction === 'cancel-delete-history-session') {
    event.preventDefault();
    event.stopPropagation();
    pendingDeleteSessionId = null;
    renderSessionSidebar({ preserveScroll: true });
    return;
  }

  if (action?.dataset.tmAction === 'delete-history-session') {
    if (action.matches(':disabled') || action.getAttribute('aria-disabled') === 'true') return;
    event.preventDefault();
    event.stopPropagation();
    const sessionId = action.getAttribute('data-session-id');
    if (!sessionId) return;
    pendingDeleteSessionId = sessionId;
    renderSessionSidebar({ preserveScroll: true });
    return;
  }

  if (action?.dataset.tmAction === 'open-history-session') {
    if (action.matches(':disabled') || action.getAttribute('aria-disabled') === 'true') return;
    event.preventDefault();
    const sessionId = action.getAttribute('data-session-id');
    if (!sessionId) return;
    pendingDeleteSessionId = null;
    if (isShellMobileViewport()) {
      closeShellMenu({ restoreFocus: false, dismissMcpPanel: true });
    }
    void openHistorySummaryModal(sessionId);
    return;
  }
}

function ensureChatShell() {
  ensureShellRefsFromDom();
  if (state.shellHost && state.shellSidebar && state.shellStage) {
    ensureSessionListScrollBinding();
    ensureHistoryModal();
    renderSessionSidebar();
    syncShellResponsiveLayout({ reason: 'ensure' });
    return state.shellHost;
  }
  if (!document.body) return null;

  const shell = document.createElement('div');
  shell.id = 'tm-chat-shell';
  shell.innerHTML = `
    <div id="tm-shell-mobile-bar">
      <button
        id="tm-shell-menu-toggle"
        class="tm-shell-menu-toggle"
        type="button"
        data-tm-action="toggle-shell-menu"
        aria-controls="tm-history-sidebar"
        aria-expanded="false"
        aria-label="打开工具箱菜单"
        title="打开菜单"
      >
        <span class="tm-shell-menu-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" focusable="false">
            <path d="M4 7h16"></path>
            <path d="M4 12h16"></path>
            <path d="M4 17h16"></path>
          </svg>
        </span>
        <span class="tm-shell-menu-text">菜单</span>
      </button>
    </div>
    <div id="tm-shell-backdrop" aria-hidden="true" data-tm-action="close-shell-menu"></div>
    <aside id="tm-history-sidebar" aria-label="会话历史">
      <div class="tm-sidebar-top">
        <div class="tm-history-note">${renderHistoryNoteHtml(false)}</div>
        <div class="tm-sidebar-actions">
          <button class="tm-new-session-btn" type="button" data-tm-action="refresh-current-page" aria-label="新建会话（强制刷新页面，Ctrl+F5）" title="新建会话（强制刷新页面，Ctrl+F5）">
            + 新建会话
          </button>
        </div>
      </div>
      <div class="tm-sidebar-mobile-tools" aria-label="快捷操作">
        <div class="tm-sidebar-mobile-tools-label">快捷操作</div>
        <div id="tm-shell-mobile-controls"></div>
      </div>
      <div id="tm-session-list" role="list"></div>
    </aside>
    <section id="tm-chat-stage-wrap">
      <div id="tm-chat-stage"></div>
    </section>
  `.trim();
  shell.addEventListener('click', onSessionSidebarClick);
  document.body.appendChild(shell);

  ensureShellRefsFromDom();
  ensureHistoryModal();
  ensureSessionListScrollBinding();
  renderSessionSidebar();
  syncShellResponsiveLayout({ reason: 'ensure' });
  return shell;
}

function extractMessageText(node, maxLen = 1200) {
  if (!node) return '';
  return sanitizeTextFragment(node.textContent || '', maxLen);
}

function collectConversationEntries(root) {
  if (!root) return [];
  const entries = [];
  const selector = `${USER_MESSAGE_BUBBLE_SELECTOR}, ${PROSE_CONTAINER_SELECTOR}`;
  const nodes = root.querySelectorAll(selector);

  for (const node of nodes) {
    if (!(node instanceof Element)) continue;
    if (node.matches(USER_MESSAGE_BUBBLE_SELECTOR)) {
      if (!isLikelyUserMessageBubble(node)) continue;
      const userTextEl = node.querySelector(USER_MESSAGE_TEXT_SELECTOR) || node;
      const text = extractMessageText(userTextEl, 900);
      if (!text) continue;
      if (isInternalContinuationRequestText(text)) continue;
      entries.push({ role: 'user', text });
      continue;
    }

    if (!isProseContainer(node)) continue;
    if (node.closest('.tm-thinking-block')) continue;
    const text = extractMessageText(node, 1600);
    if (!text) continue;
    entries.push({ role: 'assistant', text });
  }

  return entries;
}

function normalizeSessionEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const role = entry.role === 'assistant' ? 'assistant' : 'user';
  const text = typeof entry.text === 'string' ? entry.text.trim() : '';
  if (!text) return null;
  return { role, text };
}

function normalizeSessionEntries(entries, maxCount = Number.POSITIVE_INFINITY) {
  if (!Array.isArray(entries)) return [];
  const normalized = entries.map(normalizeSessionEntry).filter(Boolean);
  if (!Number.isFinite(maxCount) || maxCount <= 0) return normalized;
  if (normalized.length <= maxCount) return normalized;
  return normalized.slice(normalized.length - maxCount);
}

function normalizeSessionTitle(input) {
  return sanitizeTextFragment(input || '新会话', SESSION_STORAGE_TITLE_MAX);
}

function normalizeSessionPreviewText(input) {
  return sanitizeTextFragment(normalizeSpace(input || ''), SESSION_STORAGE_PREVIEW_MAX);
}

function deriveSessionTitleFromEntries(entries, fallback = '') {
  const normalizedEntries = normalizeSessionEntries(entries, Number.POSITIVE_INFINITY);
  const firstUser = normalizedEntries.find((entry) => entry.role === 'user')?.text || fallback || '新会话';
  return normalizeSessionTitle(firstUser);
}

function deriveSessionPreviewFromEntries(entries, fallback = '') {
  const normalizedEntries = normalizeSessionEntries(entries, Number.POSITIVE_INFINITY);
  const lastEntry = normalizedEntries[normalizedEntries.length - 1]?.text || fallback || '';
  return normalizeSessionPreviewText(lastEntry);
}

function getSessionEntryCount(session) {
  const cachedCount = normalizeSessionEntries(session?.entries, Number.POSITIVE_INFINITY).length;
  const metaCount = Number(session?.entryCount);
  if (Number.isFinite(metaCount) && metaCount > 0) {
    return Math.max(metaCount, cachedCount);
  }
  return cachedCount;
}

function getSessionPersistedEntryCount(session) {
  const persistedCount = Number(session?.persistedEntryCount);
  return Number.isFinite(persistedCount) && persistedCount > 0 ? persistedCount : 0;
}

function hasPendingSessionEntryBackup(session) {
  const entryCount = getSessionEntryCount(session);
  if (entryCount <= 0) return false;
  return getSessionPersistedEntryCount(session) < entryCount;
}

function syncSessionDerivedFields(session, entries, { replaceEntries = false, markPersisted = false } = {}) {
  if (!session || typeof session !== 'object') return false;
  const normalizedEntries = collapseContinuationEntriesByProtocol(
    normalizeSessionEntries(entries, Number.POSITIVE_INFINITY)
  );
  let changed = false;

  if (replaceEntries === true) {
    if (!areSessionEntryListsEquivalent(session.entries, normalizedEntries)) {
      session.entries = normalizedEntries;
      changed = true;
    }
  } else if (!Array.isArray(session.entries)) {
    session.entries = normalizedEntries;
    changed = true;
  }

  const nextEntryCount = Math.max(normalizedEntries.length, getSessionPersistedEntryCount(session));
  if (session.entryCount !== nextEntryCount) {
    session.entryCount = nextEntryCount;
    changed = true;
  }

  const nextTitle = deriveSessionTitleFromEntries(normalizedEntries, session.title || '新会话');
  if (nextTitle && nextTitle !== session.title) {
    session.title = nextTitle;
    changed = true;
  }

  const nextPreview = deriveSessionPreviewFromEntries(normalizedEntries, session.preview || '');
  if (nextPreview !== (session.preview || '')) {
    session.preview = nextPreview;
    changed = true;
  }

  if (markPersisted === true && getSessionPersistedEntryCount(session) !== normalizedEntries.length) {
    session.persistedEntryCount = normalizedEntries.length;
    changed = true;
  }

  return changed;
}

function applyPersistedSessionRecord(session, record, { replaceEntries = false } = {}) {
  if (!session || !record || typeof record !== 'object') return false;
  const persistedEntries = normalizeSessionEntries(record.entries, Number.POSITIVE_INFINITY);
  let changed = false;

  if (replaceEntries === true || !Array.isArray(session.entries) || session.entries.length === 0) {
    if (!areSessionEntryListsEquivalent(session.entries, persistedEntries)) {
      session.entries = persistedEntries;
      changed = true;
    }
  }

  const nextEntryCount = Number.isFinite(record.entryCount) && record.entryCount > 0
    ? Math.max(record.entryCount, persistedEntries.length)
    : persistedEntries.length;
  if (session.entryCount !== nextEntryCount) {
    session.entryCount = nextEntryCount;
    changed = true;
  }

  if (session.persistedEntryCount !== persistedEntries.length) {
    session.persistedEntryCount = persistedEntries.length;
    changed = true;
  }

  const nextTitle = normalizeSessionTitle(record.title || session.title || '新会话');
  if (nextTitle !== (session.title || '')) {
    session.title = nextTitle;
    changed = true;
  }

  const nextPreview = normalizeSessionPreviewText(
    record.preview || deriveSessionPreviewFromEntries(persistedEntries, session.preview || '')
  );
  if (nextPreview !== (session.preview || '')) {
    session.preview = nextPreview;
    changed = true;
  }

  return changed;
}

function getPendingSessionBackupIds(sessions) {
  return new Set(
    [...sessions]
      .filter((session) => session && typeof session === 'object' && hasPendingSessionEntryBackup(session))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, SESSION_PENDING_BACKUP_LIMIT)
      .map((session) => session.id)
      .filter(Boolean)
  );
}

function isSameSessionEntry(left, right) {
  return Boolean(
    left &&
    right &&
    left.role === right.role &&
    left.text === right.text
  );
}

function normalizeSessionEntryTextForMerge(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function isSimilarSessionEntry(left, right) {
  if (!left || !right || left.role !== right.role) return false;
  if (left.text === right.text) return true;

  const leftText = normalizeSessionEntryTextForMerge(left.text);
  const rightText = normalizeSessionEntryTextForMerge(right.text);
  if (!leftText || !rightText) return false;
  if (leftText === rightText) return true;

  return false;
}

function findSessionOverlap(base, next, compareFn) {
  const maxOverlap = Math.min(base.length, next.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    let matched = true;
    for (let i = 0; i < size; i += 1) {
      const left = base[base.length - size + i];
      const right = next[i];
      if (!compareFn(left, right)) {
        matched = false;
        break;
      }
    }
    if (matched) return size;
  }
  return 0;
}

function findSessionCommonPrefix(base, next, compareFn) {
  const maxCommon = Math.min(base.length, next.length);
  let size = 0;
  while (size < maxCommon) {
    if (!compareFn(base[size], next[size])) break;
    size += 1;
  }
  return size;
}

function areSessionEntryListsEquivalent(left, right) {
  const leftEntries = normalizeSessionEntries(left, Number.POSITIVE_INFINITY);
  const rightEntries = normalizeSessionEntries(right, Number.POSITIVE_INFINITY);
  if (leftEntries.length !== rightEntries.length) return false;
  for (let i = 0; i < leftEntries.length; i += 1) {
    if (!isSimilarSessionEntry(leftEntries[i], rightEntries[i])) {
      return false;
    }
  }
  return true;
}

function collapseContinuationEntriesByProtocol(entries) {
  // Strict continuation handling: only merge assistant fragments that carry a complete token marker set.
  const source = normalizeSessionEntries(entries, Number.POSITIVE_INFINITY);
  if (source.length === 0) return [];

  const collapsed = [];
  const mergedTokens = new Set();
  const findLastAssistantIndex = () => {
    for (let i = collapsed.length - 1; i >= 0; i -= 1) {
      if (collapsed[i]?.role === 'assistant') return i;
    }
    return -1;
  };

  for (const entry of source) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.role === 'user' && isInternalContinuationRequestText(entry.text)) {
      continue;
    }

    if (entry.role === 'assistant') {
      const continuationPayload = extractContinuationPayload(entry.text, {
        requireComplete: false,
        preserveWhitespace: true
      });
      if (continuationPayload && typeof continuationPayload.content === 'string') {
        const token = toSafeString(continuationPayload.token);
        const continuationText = String(continuationPayload.content || '');
        const isCompleteContinuation = continuationPayload.isComplete === true
          && continuationPayload.hasAckMarker === true
          && continuationPayload.hasEndMarker === true;

        if (token && mergedTokens.has(token)) {
          continue;
        }

        if (isCompleteContinuation && continuationText) {
          const assistantIndex = findLastAssistantIndex();
          if (assistantIndex >= 0) {
            collapsed[assistantIndex] = {
              role: 'assistant',
              text: appendContinuationWithOverlap(collapsed[assistantIndex].text, continuationText, {
                isFinalChunk: true
              })
            };
          } else {
            collapsed.push({ role: 'assistant', text: continuationText });
          }
          if (token) mergedTokens.add(token);
          continue;
        }
      }
    }
    collapsed.push(entry);
  }

  return normalizeSessionEntries(collapsed, Number.POSITIVE_INFINITY);
}

function collapseContinuationFragmentsForHistory(entries) {
  const source = collapseContinuationEntriesByProtocol(entries);
  if (source.length === 0) return [];

  const collapsed = [];
  const mergedContinuationContentByToken = new Map();
  const findLastAssistantIndex = () => {
    for (let i = collapsed.length - 1; i >= 0; i -= 1) {
      if (collapsed[i]?.role === 'assistant') return i;
    }
    return -1;
  };

  for (const entry of source) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.role === 'user' && isInternalContinuationRequestText(entry.text)) {
      continue;
    }

    if (entry.role !== 'assistant') {
      collapsed.push(entry);
      continue;
    }

    const continuationPayload = extractContinuationPayloadForHistory(entry.text);
    if (!continuationPayload || continuationPayload.hasStartMarker !== true || typeof continuationPayload.content !== 'string') {
      const stripped = stripContinuationMarkersForHistory(entry.text);
      const strippedText = String(stripped || '').trim();
      if (strippedText && strippedText !== String(entry.text || '').trim()) {
        const assistantIndex = findLastAssistantIndex();
        if (assistantIndex >= 0) {
          collapsed[assistantIndex] = {
            role: 'assistant',
            text: appendContinuationWithOverlap(collapsed[assistantIndex].text, strippedText, {
              isFinalChunk: false
            })
          };
        } else {
          collapsed.push({ role: 'assistant', text: strippedText });
        }
        continue;
      }
      collapsed.push(entry);
      continue;
    }

    const token = toSafeString(continuationPayload.token);
    const isCompleteContinuation = continuationPayload.isComplete === true
      && continuationPayload.hasAckMarker === true
      && continuationPayload.hasEndMarker === true;
    let continuationText = String(continuationPayload.content || '');
    if (!continuationText) continue;

    if (isCompleteContinuation && token && typeof getCompletedContinuationContent === 'function') {
      const exactContent = getCompletedContinuationContent(token);
      if (typeof exactContent === 'string') {
        continuationText = exactContent;
      }
    }

    let appendText = continuationText;
    if (token) {
      const previousTokenContent = String(mergedContinuationContentByToken.get(token) || '');
      if (previousTokenContent) {
        if (continuationText.startsWith(previousTokenContent)) {
          appendText = continuationText.slice(previousTokenContent.length);
        } else if (previousTokenContent.startsWith(continuationText)) {
          appendText = '';
        } else {
          const mergedTokenContent = appendContinuationWithOverlap(previousTokenContent, continuationText, {
            isFinalChunk: isCompleteContinuation
          });
          appendText = mergedTokenContent.startsWith(previousTokenContent)
            ? mergedTokenContent.slice(previousTokenContent.length)
            : continuationText;
          continuationText = mergedTokenContent;
        }
      }
    }

    const assistantIndex = findLastAssistantIndex();
    if (assistantIndex >= 0) {
      if (appendText) {
        collapsed[assistantIndex] = {
          role: 'assistant',
          text: appendContinuationWithOverlap(collapsed[assistantIndex].text, appendText, {
            isFinalChunk: isCompleteContinuation
          })
        };
      }
    } else {
      collapsed.push({ role: 'assistant', text: continuationText });
    }

    if (token) {
      const previousTokenContent = String(mergedContinuationContentByToken.get(token) || '');
      if (!previousTokenContent || continuationText.startsWith(previousTokenContent)) {
        mergedContinuationContentByToken.set(token, continuationText);
      } else if (!previousTokenContent.startsWith(continuationText)) {
        mergedContinuationContentByToken.set(
          token,
          appendContinuationWithOverlap(previousTokenContent, continuationText, {
            isFinalChunk: isCompleteContinuation
          })
        );
      }
    }
  }

  return normalizeSessionEntries(collapsed, Number.POSITIVE_INFINITY);
}

function mergeSessionEntries(existingEntries, incomingEntries) {
  const base = collapseContinuationEntriesByProtocol(existingEntries);
  const next = collapseContinuationEntriesByProtocol(incomingEntries);
  if (base.length === 0) return next;
  if (next.length === 0) return base;

  let overlap = findSessionOverlap(base, next, isSameSessionEntry);
  if (overlap === 0) {
    overlap = findSessionOverlap(base, next, isSimilarSessionEntry);
  }

  if (overlap >= next.length) {
    return base;
  }
  if (overlap > 0) {
    return base.concat(next.slice(overlap));
  }

  // Fallback: if both snapshots share a stable prefix but diverge later,
  // prefer replacing the divergent tail instead of duplicating the full transcript.
  const commonPrefix = findSessionCommonPrefix(base, next, isSimilarSessionEntry);
  if (commonPrefix >= 2 && next.length >= base.length - 1) {
    return collapseContinuationEntriesByProtocol(base.slice(0, commonPrefix).concat(next.slice(commonPrefix)));
  }

  return collapseContinuationEntriesByProtocol(base.concat(next));
}

function extractTextFromMessage(message) {
  if (!message || typeof message !== 'object') return '';
  if (typeof message.text === 'string') return message.text;
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.parts)) {
    return message.parts
      .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function stripInjectedPrompt(text) {
  const source = String(text || '');
  const trimmed = source.trim();
  if (!trimmed) return '';

  const normalized = source.trimStart();
  const looksLikeInjectedPrompt = normalized.startsWith('**Your Capabilities and Role:**');
  if (!looksLikeInjectedPrompt) {
    return trimmed;
  }

  const anchors = [
    '下面是用户的提问：',
    '以下是用户的问题：',
    'Here is the user question:',
    'Below is the user question:'
  ];

  for (const anchor of anchors) {
    const idx = normalized.indexOf(anchor);
    if (idx >= 0) {
      const stripped = normalized.slice(idx + anchor.length).trim();
      if (stripped) return stripped;
    }
  }
  return trimmed;
}

function isInternalContinuationRequestText(text) {
  const source = String(text || '').trimStart();
  if (!source) return false;
  return source.startsWith(CONTINUE_REQUEST_PREFIX);
}

function escapeRegexLiteral(source) {
  return String(source || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasContinuationProtocolMarkers(text) {
  return /TM_CONTINUE_(?:ACK|START|END)/i.test(String(text || ''));
}

function stripContinuationProtocolMarkers(text) {
  const source = String(text || '');
  if (!source) return '';
  return source
    .replace(/\\?\[TM_CONTINUE_ACK[:：][^\]\r\n]+\\?\]/gi, '')
    .replace(/\\?\[TM_CONTINUE_START[:：][^\]\r\n]+\\?\]/gi, '')
    .replace(/\\?\[TM_CONTINUE_END[:：][^\]\r\n]+\\?\]/gi, '');
}

function stripContinuationMarkersForHistory(text) {
  return sanitizeAssistantContinuationText(text, {
    preserveWhitespace: true
  });
}

function extractLooseContinuationPayload(text, options = {}) {
  const source = String(text || '');
  if (!source) return null;
  const requireComplete = options?.requireComplete === true;
  const preserveWhitespace = options?.preserveWhitespace !== false;
  const startMatch = source.match(/\\?\[TM_CONTINUE_START[:：]\s*([^\]\r\n\\]{1,160})\s*\\?\]/i);
  if (!startMatch || typeof startMatch.index !== 'number') return null;
  const token = String(startMatch[1] || '').trim();
  if (!isSafeContinuationToken(token)) return null;

  const startMarker = startMatch[0];
  const contentStart = startMatch.index + startMarker.length;
  const escapedToken = escapeRegexLiteral(token);
  const endRe = new RegExp(`\\\\?\\[TM_CONTINUE_END[:：]\\s*${escapedToken}\\s*\\\\?\\]`, 'i');
  const endMatch = endRe.exec(source.slice(contentStart));
  const hasEndMarker = Boolean(endMatch);
  const ackRe = new RegExp(`\\\\?\\[TM_CONTINUE_ACK[:：]\\s*${escapedToken}\\s*\\\\?\\]`, 'i');
  const hasAckMarker = ackRe.test(source);
  const isComplete = hasEndMarker && hasAckMarker;
  if (requireComplete && !isComplete) return null;
  const contentEnd = hasEndMarker
    ? contentStart + Number(endMatch.index)
    : source.length;

  return {
    token,
    content: preserveWhitespace
      ? source.slice(contentStart, contentEnd)
      : source.slice(contentStart, contentEnd).trim(),
    hasStartMarker: true,
    hasEndMarker,
    hasAckMarker,
    isComplete
  };
}

function isSafeContinuationToken(token) {
  return /^[a-z0-9_-]{4,80}$/i.test(String(token || ''));
}

function findContinuationMarker(source, markerPrefix, { fromIndex = 0, expectedToken = '' } = {}) {
  const text = String(source || '');
  let cursor = Math.max(0, fromIndex);
  while (cursor < text.length) {
    const startIndex = text.indexOf(markerPrefix, cursor);
    if (startIndex < 0) return null;
    const tokenStart = startIndex + markerPrefix.length;
    const tokenEnd = text.indexOf(CONTINUE_MARKER_SUFFIX, tokenStart);
    if (tokenEnd < 0) return null;
    const token = text.slice(tokenStart, tokenEnd).trim();
    const matched = isSafeContinuationToken(token)
      && (!expectedToken || token === expectedToken);
    if (matched) {
      return {
        token,
        startIndex,
        endIndex: tokenEnd + CONTINUE_MARKER_SUFFIX.length
      };
    }
    cursor = tokenEnd + 1;
  }
  return null;
}

function extractContinuationPayload(text, options = {}) {
  const source = String(text || '');
  if (!source) return null;

  const requireComplete = options?.requireComplete === true;
  const preserveWhitespace = options?.preserveWhitespace !== false;
  const startMarker = findContinuationMarker(source, CONTINUE_START_PREFIX);
  if (!startMarker) {
    return extractLooseContinuationPayload(source, options);
  }

  const endMarker = findContinuationMarker(source, CONTINUE_END_PREFIX, {
    fromIndex: startMarker.endIndex,
    expectedToken: startMarker.token
  });
  const ackMarker = findContinuationMarker(source, CONTINUE_ACK_PREFIX, {
    fromIndex: 0,
    expectedToken: startMarker.token
  });
  const isComplete = Boolean(ackMarker && endMarker);
  if (requireComplete && !isComplete) {
    return extractLooseContinuationPayload(source, options);
  }

  const contentStart = startMarker.endIndex;
  const contentEnd = endMarker ? endMarker.startIndex : source.length;
  const rawContent = source.slice(contentStart, contentEnd);
  return {
    token: startMarker.token,
    content: preserveWhitespace ? rawContent : rawContent.trim(),
    hasEndMarker: Boolean(endMarker),
    hasAckMarker: Boolean(ackMarker),
    hasStartMarker: true,
    isComplete,
    markers: {
      ackMarker,
      startMarker,
      endMarker
    }
  };
}

function extractContinuationPayloadForHistory(text) {
  return extractLooseContinuationPayload(text, {
    requireComplete: false,
    preserveWhitespace: true
  });
}

function sanitizeAssistantContinuationText(text, options = {}) {
  const source = String(text || '');
  if (!source) return '';

  const preserveWhitespace = options?.preserveWhitespace !== false;
  const payload = extractContinuationPayload(source, {
    requireComplete: false,
    preserveWhitespace
  });
  if (payload && payload.hasStartMarker === true) {
    return String(payload.content || '');
  }

  if (!hasContinuationProtocolMarkers(source)) {
    return source;
  }

  return stripContinuationProtocolMarkers(source);
}

function normalizeContinuationSessionKey(rawSessionKey) {
  const key = normalizeApiConversationKey(rawSessionKey);
  return typeof key === 'string' ? key : '';
}

function getPendingContinuationSession(sessionKey, { create = false } = {}) {
  const key = normalizeContinuationSessionKey(sessionKey);
  if (!key) return null;
  if (!state.pendingContinuationBySession || typeof state.pendingContinuationBySession !== 'object') {
    if (!create) return null;
    state.pendingContinuationBySession = {};
  }
  const existing = state.pendingContinuationBySession[key];
  if (existing && typeof existing === 'object' && Array.isArray(existing.fragments)) {
    return existing;
  }
  if (!create) return null;
  const bucket = {
    fragments: [],
    updatedAt: Date.now()
  };
  state.pendingContinuationBySession[key] = bucket;
  return bucket;
}

function clearPendingContinuationSession(sessionKey) {
  const key = normalizeContinuationSessionKey(sessionKey);
  if (!key) return;
  if (!state.pendingContinuationBySession || typeof state.pendingContinuationBySession !== 'object') return;
  delete state.pendingContinuationBySession[key];
}

function rememberCompletedContinuationToken(token) {
  const safeToken = toSafeString(token);
  if (!safeToken) return;
  const list = Array.isArray(state.completedContinuationTokens)
    ? state.completedContinuationTokens
    : [];
  if (!Array.isArray(state.completedContinuationTokens)) {
    state.completedContinuationTokens = list;
  }
  if (list.includes(safeToken)) return;
  list.push(safeToken);
  if (list.length > 200) {
    const trimmed = list.slice(list.length - 200);
    state.completedContinuationTokens = trimmed;
    const contentByToken = state.completedContinuationContentByToken;
    if (contentByToken && typeof contentByToken === 'object') {
      const keepSet = new Set(trimmed);
      Object.keys(contentByToken).forEach((key) => {
        if (!keepSet.has(key)) delete contentByToken[key];
      });
    }
  }
}

function isCompletedContinuationToken(token) {
  const safeToken = toSafeString(token);
  if (!safeToken) return false;
  if (!Array.isArray(state.completedContinuationTokens)) return false;
  return state.completedContinuationTokens.includes(safeToken);
}

function rememberCompletedContinuationContent(token, content) {
  const safeToken = toSafeString(token);
  if (!safeToken) return;
  if (!state.completedContinuationContentByToken || typeof state.completedContinuationContentByToken !== 'object') {
    state.completedContinuationContentByToken = {};
  }
  state.completedContinuationContentByToken[safeToken] = String(content || '');
  rememberCompletedContinuationToken(safeToken);
}

function getCompletedContinuationContent(token) {
  const safeToken = toSafeString(token);
  if (!safeToken) return null;
  const map = state.completedContinuationContentByToken;
  if (!map || typeof map !== 'object') return null;
  if (!Object.prototype.hasOwnProperty.call(map, safeToken)) return null;
  return typeof map[safeToken] === 'string' ? map[safeToken] : String(map[safeToken] || '');
}

function appendPendingContinuationFragment(sessionKey, payload) {
  if (!payload || typeof payload !== 'object') return false;
  const token = toSafeString(payload.token);
  if (!isSafeContinuationToken(token)) return false;
  const content = String(payload.content || '');
  if (!content) return false;

  const bucket = getPendingContinuationSession(sessionKey, { create: true });
  if (!bucket) return false;
  const fragments = Array.isArray(bucket.fragments) ? bucket.fragments : [];
  bucket.fragments = fragments;

  const isComplete = payload.isComplete === true
    && payload.hasAckMarker === true
    && payload.hasEndMarker === true;
  const now = Date.now();
  const existingIndex = fragments.findIndex((item) => toSafeString(item?.token) === token);

  if (existingIndex >= 0) {
    const existing = fragments[existingIndex];
    const existingContent = String(existing?.content || '');
    let nextContent = existingContent;

    if (content.startsWith(existingContent)) {
      nextContent = content;
    } else if (!existingContent.startsWith(content)) {
      nextContent = appendContinuationWithOverlap(existingContent, content, {
        isFinalChunk: isComplete
      });
    }

    const nextComplete = existing?.isComplete === true || isComplete;
    const changed = nextContent !== existingContent || nextComplete !== (existing?.isComplete === true);
    fragments[existingIndex] = {
      token,
      content: nextContent,
      isComplete: nextComplete,
      appendedAt: now
    };
    bucket.updatedAt = now;
    return changed;
  }

  fragments.push({
    token,
    content,
    isComplete,
    appendedAt: now
  });
  bucket.updatedAt = now;
  return true;
}

function flushPendingContinuationSession(sessionKey, options = {}) {
  const key = normalizeContinuationSessionKey(sessionKey);
  if (!key) {
    return { content: '', tokens: [], fragments: [] };
  }
  const includeIncomplete = options?.includeIncomplete === true;
  const bucket = getPendingContinuationSession(key, { create: false });
  if (!bucket || !Array.isArray(bucket.fragments) || bucket.fragments.length === 0) {
    clearPendingContinuationSession(key);
    return { content: '', tokens: [], fragments: [] };
  }

  let flushEndIndex = -1;
  for (let i = bucket.fragments.length - 1; i >= 0; i -= 1) {
    if (bucket.fragments[i]?.isComplete === true) {
      flushEndIndex = i;
      break;
    }
  }
  if (flushEndIndex < 0) {
    if (includeIncomplete && bucket.fragments.length > 0) {
      flushEndIndex = bucket.fragments.length - 1;
    } else {
      return { content: '', tokens: [], fragments: [] };
    }
  }
  if (flushEndIndex < 0) {
    return { content: '', tokens: [], fragments: [] };
  }

  const tokens = [];
  const fragments = [];
  let content = '';
  for (let i = 0; i <= flushEndIndex; i += 1) {
    const item = bucket.fragments[i];
    const token = toSafeString(item?.token);
    const fragmentContent = String(item?.content || '');
    const isComplete = item?.isComplete === true;
    if (!token || !fragmentContent) continue;
    tokens.push(token);
    fragments.push({
      token,
      content: fragmentContent,
      isComplete
    });
    content = appendContinuationWithOverlap(content, fragmentContent, {
      isFinalChunk: i === flushEndIndex
    });
  }

  const remaining = bucket.fragments.slice(flushEndIndex + 1).filter((item) => {
    const token = toSafeString(item?.token);
    const fragmentContent = String(item?.content || '');
    return Boolean(token && fragmentContent);
  });
  if (remaining.length > 0) {
    bucket.fragments = remaining;
    bucket.updatedAt = Date.now();
  } else {
    clearPendingContinuationSession(key);
  }
  return { content, tokens, fragments };
}

function parseContinuationFenceLine(line) {
  const source = String(line || '');
  const match = source.match(/^[ \t]{0,3}(`{3,}|~{3,})([^\r\n]*)$/);
  if (!match) return null;

  const marker = match[1];
  const suffix = match[2] || '';
  return {
    markerChar: marker[0],
    markerLength: marker.length,
    infoText: suffix.trim(),
    isBare: suffix.trim().length === 0,
    normalizedLine: `${marker}${suffix.trimEnd()}`
  };
}

function analyzeContinuationFenceState(text) {
  const normalized = String(text || '').replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const trailingFence = lines.length > 0
    ? parseContinuationFenceLine(lines[lines.length - 1])
    : null;
  let activeFence = null;
  let linesSinceOpenFence = 0;

  for (const line of lines) {
    const fence = parseContinuationFenceLine(line);
    if (!fence) {
      if (activeFence) linesSinceOpenFence += 1;
      continue;
    }

    if (!activeFence) {
      activeFence = {
        markerChar: fence.markerChar,
        markerLength: fence.markerLength,
        normalizedLine: fence.normalizedLine
      };
      linesSinceOpenFence = 0;
      continue;
    }

    const closesActiveFence = fence.isBare
      && fence.markerChar === activeFence.markerChar
      && fence.markerLength >= activeFence.markerLength;
    if (closesActiveFence) {
      activeFence = null;
      linesSinceOpenFence = 0;
      continue;
    }

    linesSinceOpenFence += 1;
  }

  return {
    insideFence: Boolean(activeFence),
    openFenceChar: activeFence ? activeFence.markerChar : '',
    openFenceLength: activeFence ? activeFence.markerLength : 0,
    openFenceLine: activeFence ? activeFence.normalizedLine : '',
    linesSinceOpenFence: activeFence ? linesSinceOpenFence : 0,
    trailingFence
  };
}

function parseLeadingContinuationFence(text) {
  const source = String(text || '');
  if (!source) return null;

  const lineMatch = source.match(/^([^\r\n]*)(?:\r?\n|$)/);
  if (!lineMatch) return null;

  const fence = parseContinuationFenceLine(lineMatch[1]);
  if (!fence) return null;

  return {
    ...fence,
    endIndex: lineMatch[0].length
  };
}

function getLastNonEmptyContinuationLine(text) {
  const normalized = String(text || '').replace(/\r\n?/g, '\n').trimEnd();
  if (!normalized) return '';
  const lines = normalized.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = String(lines[i] || '');
    if (line.trim()) return line;
  }
  return '';
}

function looksLikeCodeContinuationFragment(text) {
  const source = String(text || '');
  if (!source) return false;
  const normalized = source.replace(/^\s+/, '');
  if (!normalized) return false;
  if (/^([\-+*/%|&<>=!?.,:;)\]}]|=>|::)/.test(normalized)) return true;
  if (/^(<\/?[a-z][^>\n]*>|[a-z_$][\w$]*\s*(?:[.(\[]|[=+\-*/%|&<>!?]))/i.test(normalized)) return true;
  return false;
}

function looksLikeIncompleteCodeTail(text) {
  const lastLine = getLastNonEmptyContinuationLine(text).trim();
  if (!lastLine) return false;
  if (/[=+\-*/%|&<>!?:.,([{]$/.test(lastLine)) return true;
  if (!/[;)}\]`]$/.test(lastLine)) {
    if (/\b(if|for|while|switch|return|const|let|var|function|class|catch|try)\b/i.test(lastLine)) {
      return true;
    }
  }
  return false;
}

function mergeContinuationWithOverlap(base, addition) {
  const maxOverlap = Math.min(420, base.length, addition.length);
  for (let size = maxOverlap; size >= 18; size -= 1) {
    if (base.endsWith(addition.slice(0, size))) {
      return `${base}${addition.slice(size)}`;
    }
  }
  return `${base}${addition}`;
}

function repairContinuationFenceBoundary(baseText, continuationText, { isFinalChunk = false } = {}) {
  const base = String(baseText || '');
  const addition = String(continuationText || '');
  if (!base || !addition) return addition;

  const baseFenceState = analyzeContinuationFenceState(base);
  const leadingFence = parseLeadingContinuationFence(addition);
  if (!leadingFence) return addition;

  const removeLeadingFence = () => {
    const removedHead = addition.slice(0, leadingFence.endIndex);
    const rest = addition.slice(leadingFence.endIndex);
    const removedHadLineBreak = /\r?\n$/.test(removedHead);
    if (removedHadLineBreak && !base.endsWith('\n') && !rest.startsWith('\n')) {
      return `\n${rest}`;
    }
    return rest;
  };

  if (baseFenceState.insideFence) {
    const sameAsOpenFenceLine = Boolean(baseFenceState.openFenceLine)
      && leadingFence.normalizedLine === baseFenceState.openFenceLine;
    if (sameAsOpenFenceLine) {
      return removeLeadingFence();
    }

    const closesCurrentFence = leadingFence.isBare
      && leadingFence.markerChar === baseFenceState.openFenceChar
      && leadingFence.markerLength >= baseFenceState.openFenceLength;
    if (closesCurrentFence && baseFenceState.linesSinceOpenFence === 0) {
      return removeLeadingFence();
    }

    if (closesCurrentFence) {
      const withoutLeadingFence = removeLeadingFence();
      const likelyMidLineCut = !base.endsWith('\n');
      const likelyCodeContinuation = looksLikeCodeContinuationFragment(withoutLeadingFence);
      const likelyIncompleteTail = looksLikeIncompleteCodeTail(base);
      if (likelyMidLineCut || (likelyCodeContinuation && likelyIncompleteTail)) {
        return withoutLeadingFence;
      }
    }
    return addition;
  }

  if (!isFinalChunk || !leadingFence.isBare) {
    return addition;
  }

  const trailingFence = baseFenceState.trailingFence;
  const sameAsTrailingFence = Boolean(
    trailingFence
      && trailingFence.isBare
      && trailingFence.markerChar === leadingFence.markerChar
      && trailingFence.markerLength === leadingFence.markerLength
  );
  if (!sameAsTrailingFence) {
    return addition;
  }

  const withoutLeadingFence = removeLeadingFence();
  const keepWithBoundaryNewline = !base.endsWith('\n') && !addition.startsWith('\n')
    ? `\n${addition}`
    : addition;
  const mergedWithFence = mergeContinuationWithOverlap(base, keepWithBoundaryNewline);
  const mergedWithoutFence = mergeContinuationWithOverlap(base, withoutLeadingFence);
  const withFenceState = analyzeContinuationFenceState(mergedWithFence);
  const withoutFenceState = analyzeContinuationFenceState(mergedWithoutFence);

  if (withFenceState.insideFence && !withoutFenceState.insideFence) {
    return withoutLeadingFence;
  }

  if (!withFenceState.insideFence && withoutFenceState.insideFence) {
    return keepWithBoundaryNewline;
  }

  return keepWithBoundaryNewline;
}

function ensureContinuationFenceClosed(text) {
  const source = String(text || '');
  if (!source) return '';

  const fenceState = analyzeContinuationFenceState(source);
  if (!fenceState.insideFence) return source;

  const closeFence = fenceState.openFenceChar
    ? fenceState.openFenceChar.repeat(Math.max(3, fenceState.openFenceLength))
    : '```';
  return `${source}${source.endsWith('\n') ? '' : '\n'}${closeFence}`;
}

function appendContinuationWithOverlap(baseText, continuationText, { isFinalChunk = false } = {}) {
  const base = String(baseText || '');
  const addition = String(continuationText || '');
  if (!base) return addition;
  if (!addition) return base;
  const repaired = repairContinuationFenceBoundary(base, addition, { isFinalChunk });
  return mergeContinuationWithOverlap(base, repaired);
}

function buildEntriesFromApiMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const entries = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const rawText = extractTextFromMessage(message);
    if (!rawText) continue;

    const text = message.role === 'user'
      ? stripInjectedPrompt(rawText)
      : rawText.trim();
    if (!text) continue;
    if (message.role === 'user' && isInternalContinuationRequestText(text)) continue;
    entries.push({ role: message.role, text });
  }
  return collapseContinuationEntriesByProtocol(entries);
}

function buildAssistantTextFromSseEvents(events) {
  if (!Array.isArray(events) || events.length === 0) return '';
  let fullText = '';
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    if (event.type === 'text-delta' && typeof event.delta === 'string') {
      fullText += event.delta;
    }
  }
  return fullText;
}

function deriveApiConversationKey(payload) {
  const requestId = payload?.request?.id;
  if (typeof requestId === 'string' && requestId.trim()) {
    return normalizeApiConversationKey(requestId);
  }
  if (typeof payload?.sessionKey === 'string' && payload.sessionKey.trim()) {
    return normalizeApiConversationKey(payload.sessionKey);
  }
  const seed = `${payload?.url || ''}|${Date.now()}|${Math.random().toString(36).slice(2, 8)}`;
  return normalizeApiConversationKey(shortHash(seed));
}

function normalizeApiConversationKey(rawKey) {
  const key = typeof rawKey === 'string' ? rawKey.trim() : '';
  if (!key) return '';
  return key.startsWith('api:') ? key : `api:${key}`;
}

function upsertSession(snapshot, { mergeEntries = false } = {}) {
  let target = state.sessions.find((item) => item.conversationKey === snapshot.conversationKey);
  const now = Date.now();
  const routePath = snapshot.routePath || getCurrentRoutePath();

  if (!target) {
    target = {
      id: createSessionId(),
      createdAt: now
    };
    state.sessions.unshift(target);
  }

  target.conversationKey = snapshot.conversationKey;
  target.routePath = routePath;
  const incomingEntries = collapseContinuationEntriesByProtocol(snapshot.entries);
  target.entries = mergeEntries
    ? mergeSessionEntries(target.entries, incomingEntries)
    : incomingEntries;
  target.title = normalizeSessionTitle(snapshot.title || target.title || '新会话');
  target.preview = normalizeSessionPreviewText(snapshot.preview || target.preview || '');
  syncSessionDerivedFields(target, target.entries, { replaceEntries: true });
  target.hash = snapshot.hash || '';
  target.updatedAt = now;
  target.createdAt = target.createdAt || now;

  const trimmed = trimStoredSessions();
  if (trimmed) {
    void prunePersistedSessionEntriesByActiveSessions();
  }
  state.activeSessionId = target.id;
  persistSessionEntriesToDbSoon(target);
  return target;
}

function upsertSessionFromApiRequest(payload) {
  if (!payload || typeof payload !== 'object') return;
  const request = payload.request && typeof payload.request === 'object'
    ? payload.request
    : null;
  if (!request) return;

  const conversationKey = deriveApiConversationKey({
    sessionKey: payload.sessionKey,
    request,
    url: payload.url
  });
  const entries = buildEntriesFromApiMessages(request.messages);
  const lastUser = [...entries].reverse().find((entry) => entry.role === 'user')?.text || '';
  const title = normalizeSessionTitle(lastUser || '新会话');
  const preview = normalizeSessionPreviewText(lastUser || '等待回答…');

  const target = upsertSession({
    conversationKey,
    routePath: '',
    title,
    preview,
    entries,
    hash: shortHash(`${conversationKey}|${Date.now()}`)
  }, { mergeEntries: true });

  state.pendingApiSessions[conversationKey] = target.id;
  state.lastSessionSyncHash = shortHash(`${conversationKey}|${target.updatedAt}`);

  renderSessionSidebar();
  persistSessionsSoon(120);
}

function finalizeSessionFromApiStream(payload) {
  if (!payload || typeof payload !== 'object') return;
  const conversationKey = normalizeApiConversationKey(payload.sessionKey);
  if (!conversationKey) return;
  const mappedId = state.pendingApiSessions[conversationKey];
  let target = null;

  if (mappedId) {
    target = state.sessions.find((session) => session.id === mappedId) || null;
  }
  if (!target) {
    target = state.sessions.find((session) => session.conversationKey === conversationKey) || null;
  }
  if (!target) return;

  const sseEvents = Array.isArray(payload.sseEvents)
    ? payload.sseEvents.filter((event) => event && typeof event === 'object')
    : [];
  const rawAssistantText = typeof payload.assistantText === 'string'
    ? payload.assistantText
    : buildAssistantTextFromSseEvents(sseEvents);
  const assistantText = sanitizeAssistantContinuationText(rawAssistantText, {
    preserveWhitespace: true
  });
  const aggregateAssistantText = typeof payload.aggregateAssistantText === 'string'
    ? payload.aggregateAssistantText
    : '';
  const streamHasDoneEvent = payload.receivedDoneEvent === true;
  const interruptedByToolCode = payload.cutByToolCode === true;
  const continuationPayload = extractContinuationPayload(rawAssistantText, {
    requireComplete: false,
    preserveWhitespace: true
  });
  let toolScanText = '';

  if (interruptedByToolCode) {
    clearPendingContinuationSession(conversationKey);
  }

  if (assistantText) {
    const entries = Array.isArray(target.entries) ? [...target.entries] : [];
    let continuationMerged = false;
    if (!interruptedByToolCode && continuationPayload) {
      const appended = appendPendingContinuationFragment(conversationKey, continuationPayload);
      continuationMerged = appended || (continuationPayload.hasStartMarker === true && !streamHasDoneEvent);
      const shouldFlushPending = continuationPayload.isComplete === true || streamHasDoneEvent;
      if (shouldFlushPending) {
        const flushed = flushPendingContinuationSession(conversationKey, {
          includeIncomplete: streamHasDoneEvent
        });
        if (flushed.content) {
          let assistantIndex = -1;
          for (let i = entries.length - 1; i >= 0; i -= 1) {
            if (entries[i]?.role === 'assistant') {
              assistantIndex = i;
              break;
            }
          }

          if (assistantIndex >= 0) {
            const mergedText = appendContinuationWithOverlap(entries[assistantIndex].text, flushed.content, {
              isFinalChunk: true
            });
            entries[assistantIndex] = { role: 'assistant', text: mergedText };
            target.entries = collapseContinuationEntriesByProtocol(entries);
            target.preview = normalizeSessionPreviewText(mergedText);
            toolScanText = mergedText;
          } else {
            entries.push({ role: 'assistant', text: flushed.content });
            target.entries = collapseContinuationEntriesByProtocol(entries);
            target.preview = normalizeSessionPreviewText(flushed.content);
            toolScanText = flushed.content;
          }

          if (Array.isArray(flushed.fragments) && flushed.fragments.length > 0) {
            for (const fragment of flushed.fragments) {
              if (fragment?.isComplete !== true) continue;
              rememberCompletedContinuationContent(fragment?.token, fragment?.content);
            }
          } else {
            for (const token of flushed.tokens) {
              rememberCompletedContinuationToken(token);
            }
          }
          continuationMerged = true;
        }
      }
    }

    if (!continuationMerged && entries.length > 0 && entries[entries.length - 1].role === 'assistant') {
      clearPendingContinuationSession(conversationKey);
      entries[entries.length - 1] = { role: 'assistant', text: assistantText };
      target.entries = collapseContinuationEntriesByProtocol(entries);
      target.preview = normalizeSessionPreviewText(assistantText);
      toolScanText = assistantText;
    } else if (!continuationMerged) {
      clearPendingContinuationSession(conversationKey);
      entries.push({ role: 'assistant', text: assistantText });
      target.entries = collapseContinuationEntriesByProtocol(entries);
      target.preview = normalizeSessionPreviewText(assistantText);
      toolScanText = assistantText;
    }
  }

  const normalizedAggregateToolScanText = String(aggregateAssistantText || '').trim();
  if (normalizedAggregateToolScanText && !hasContinuationProtocolMarkers(normalizedAggregateToolScanText)) {
    if (!toolScanText || interruptedByToolCode || normalizedAggregateToolScanText.length >= toolScanText.length) {
      toolScanText = normalizedAggregateToolScanText;
    }
  }

  if (toolScanText && typeof maybeExecuteToolCodeFromMergedAssistant === 'function') {
    maybeExecuteToolCodeFromMergedAssistant({
      sessionKey: conversationKey,
      assistantText: toolScanText
    });
  }

  target.updatedAt = Date.now();
  target.hash = shortHash(`${target.conversationKey}|${target.updatedAt}`);
  state.lastSessionSyncHash = shortHash(`${target.conversationKey}|${target.updatedAt}`);
  delete state.pendingApiSessions[conversationKey];
  persistSessionEntriesToDbSoon(target);

  renderSessionSidebar();
  persistSessionsSoon(120);
}

function syncSessionHistoryFromDom() {
  if (SESSION_CAPTURE_MODE === 'api') return;
  if (!isPluginEnabled) return;
  if (!state.sessionsLoaded) return;
  if (state.streaming) return;

  const root = getActiveCenteredElement() || state.shellStage || document.querySelector('#root') || document.querySelector('#main-content') || document.body;
  if (!root) return;

  const entries = collectConversationEntries(root);
  if (entries.length === 0) return;

  const firstUser = entries.find((entry) => entry.role === 'user')?.text || '';
  const lastEntry = entries[entries.length - 1];
  const routePath = getCurrentRoutePath();
  const conversationKey = deriveConversationKey(routePath, firstUser);
  const hashSeed = `${conversationKey}|${entries.map((entry) => `${entry.role}:${entry.text}`).join('|')}`;
  const snapshotHash = shortHash(hashSeed);
  if (snapshotHash === state.lastSessionSyncHash) return;

  const title = normalizeSessionTitle(firstUser || lastEntry?.text || '新会话');
  const preview = normalizeSessionPreviewText(lastEntry?.text || '');
  upsertSession({
    conversationKey,
    routePath,
    title,
    preview,
    entries,
    hash: snapshotHash
  });

  state.lastSessionSyncHash = snapshotHash;
  renderSessionSidebar();
  persistSessionsSoon();
}

function scheduleSessionSync(delay = SESSION_SYNC_DEBOUNCE_MS) {
  if (!isPluginEnabled) return;
  clearSessionSyncTimer();
  state.sessionSyncTimer = setTimeout(() => {
    state.sessionSyncTimer = null;
    syncSessionHistoryFromDom();
  }, Math.max(0, delay));
}

function serializeSessionsForStorage(sessions) {
  if (!Array.isArray(sessions)) return [];
  const pendingBackupIds = getPendingSessionBackupIds(sessions);

  return sessions
    .filter((session) => session && typeof session === 'object')
    .map((session) => {
      const id = typeof session.id === 'string' ? session.id : createSessionId();
      const persistedEntryCount = Math.max(0, getSessionPersistedEntryCount(session));
      const includeBackup = pendingBackupIds.has(id);
      const normalizedEntries = normalizeSessionEntries(session.entries, Number.POSITIVE_INFINITY);
      const entryCount = Math.max(getSessionEntryCount(session), persistedEntryCount);
      const backupEntries = includeBackup
        ? normalizedEntries
        : [];
      const payload = {
        id,
        conversationKey: typeof session.conversationKey === 'string' ? session.conversationKey : '',
        routePath: typeof session.routePath === 'string' ? session.routePath : '',
        title: normalizedEntries.length > 0
          ? deriveSessionTitleFromEntries(normalizedEntries, session.title || '新会话')
          : normalizeSessionTitle(session.title || '新会话'),
        preview: normalizedEntries.length > 0
          ? deriveSessionPreviewFromEntries(normalizedEntries, session.preview || '')
          : normalizeSessionPreviewText(session.preview || ''),
        entryCount,
        persistedEntryCount,
        hash: typeof session.hash === 'string' ? session.hash : '',
        createdAt: Number.isFinite(session.createdAt) ? session.createdAt : Date.now(),
        updatedAt: Number.isFinite(session.updatedAt) ? session.updatedAt : Date.now()
      };
      if (backupEntries.length > 0) {
        payload.entryBackup = backupEntries;
      }
      return payload;
    });
}

function loadSessionStore() {
  chrome.storage.local.get({ [SESSION_STORAGE_KEY]: null }, (result) => {
    const payload = result?.[SESSION_STORAGE_KEY];
    const storageVersion = Number(payload?.version) || 0;
    const list = Array.isArray(payload?.sessions) ? payload.sessions : [];
    const hasLegacyApiPayload = list.some((session) => session && typeof session === 'object' && Object.prototype.hasOwnProperty.call(session, 'api'));
    const hasLegacyEntryPayload = list.some((session) => session && typeof session === 'object' && Array.isArray(session.entries));

    state.sessions = list
      .filter((session) => session && typeof session === 'object')
      .map((session) => {
        const backupEntries = Array.isArray(session.entryBackup)
          ? normalizeSessionEntries(session.entryBackup, Number.POSITIVE_INFINITY)
          : normalizeSessionEntries(session.entries, SESSION_STORAGE_ENTRY_CACHE_COUNT);
        const rawPersistedEntryCount = Number.isFinite(session.persistedEntryCount) && session.persistedEntryCount > 0
          ? session.persistedEntryCount
          : 0;
        const entryCount = Number.isFinite(session.entryCount) && session.entryCount > 0
          ? Math.max(session.entryCount, backupEntries.length, rawPersistedEntryCount)
          : Math.max(backupEntries.length, rawPersistedEntryCount);

        return {
          id: typeof session.id === 'string' ? session.id : createSessionId(),
          conversationKey: typeof session.conversationKey === 'string' ? session.conversationKey : '',
          routePath: typeof session.routePath === 'string' ? session.routePath : '',
          title: backupEntries.length > 0
            ? deriveSessionTitleFromEntries(backupEntries, session.title || '新会话')
            : normalizeSessionTitle(session.title || '新会话'),
          preview: backupEntries.length > 0
            ? deriveSessionPreviewFromEntries(backupEntries, session.preview || '')
            : normalizeSessionPreviewText(session.preview || ''),
          entries: backupEntries,
          entryCount,
          persistedEntryCount: Math.min(rawPersistedEntryCount, entryCount),
          hash: typeof session.hash === 'string' ? session.hash : '',
          createdAt: Number.isFinite(session.createdAt) ? session.createdAt : Date.now(),
          updatedAt: Number.isFinite(session.updatedAt) ? session.updatedAt : Date.now()
        };
      });

    const trimmed = trimStoredSessions();
    state.sessions.forEach((session) => {
      if (hasPendingSessionEntryBackup(session)) {
        reconcileSessionPersistenceSoon(session);
      }
    });
    state.pendingApiSessions = {};
    const storedActiveSessionId = typeof payload?.activeSessionId === 'string' ? payload.activeSessionId : '';
    state.activeSessionId = state.sessions.some((session) => session.id === storedActiveSessionId)
      ? storedActiveSessionId
      : state.sessions[0]?.id || null;
    state.historyModalSessionId = null;
    ensureSessionRenderCount(getHistorySessions().length);
    state.sessionsLoaded = true;
    void prunePersistedSessionEntriesByActiveSessions();

    renderSessionSidebar();
    if (trimmed || hasLegacyApiPayload || hasLegacyEntryPayload || storageVersion < SESSION_STORAGE_SCHEMA_VERSION) {
      persistSessionsSoon(0);
    }
    if (isPluginEnabled && SESSION_CAPTURE_MODE !== 'api') {
      scheduleSessionSync(420);
    }
  });
}

function updateShellTopOffset() {
  const header = document.querySelector('header, div.flex-none.title-bar, div[class*="title-bar"], header.border-border.bg-background.sticky');
  const fallback = 48;
  let topOffset = fallback;

  if (header) {
    const rect = header.getBoundingClientRect();
    if (rect.height > 0) {
      topOffset = Math.min(96, Math.max(44, Math.round(rect.height)));
    }
  }

  document.documentElement.style.setProperty('--tm-shell-top', `${topOffset}px`);
}

function setBodyEnabledClass(enabled) {
  if (!document.body) return;
  document.body.classList.toggle('tm-toolbox-enabled', enabled);
}
