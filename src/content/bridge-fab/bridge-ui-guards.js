// Bridge UI guards: copy fallback, tokenizer suppression, and UI hiding

'use strict';

function markNodeHidden(node) {
  if (!node || !node.classList || node.id === 'tm-header-disclaimer') return;
  node.classList.add('tm-hidden-by-toolbox');
}

function normalizeButtonText(button) {
  if (!button) return '';
  return (button.textContent || '').replace(/\s+/g, ' ').trim();
}

function getButtonSignalText(button) {
  if (!button) return '';

  const className = typeof button.className === 'string' ? button.className : '';
  const signals = [
    button.getAttribute('aria-label') || '',
    button.getAttribute('title') || '',
    button.getAttribute('data-tooltip') || '',
    button.getAttribute('data-tooltip-content') || '',
    button.id || '',
    className,
    normalizeButtonText(button)
  ].join(' ');

  return normalizeSpace(signals);
}

function isLikelyCodeCopyButton(button, codeNode = null) {
  if (!button) return false;
  const signalText = getButtonSignalText(button);
  if (/(copy|copied|clipboard|复制|已复制|拷贝)/i.test(signalText)) return true;

  if (!codeNode) return false;
  const isIconOnly = !normalizeButtonText(button) && Boolean(button.querySelector('svg'));
  if (!isIconOnly) return false;

  return Boolean(
    button.closest('.shiki, [data-rehype-pretty-code-fragment], [class*="code-block"], [class*="codeBlock"], pre') ||
    button.parentElement?.querySelector?.('pre, .shiki, [data-rehype-pretty-code-fragment], [class*="code-block"], [class*="codeBlock"]')
  );
}

function findNearbyCodeNode(button, maxDepth = 9) {
  if (!button) return null;

  const codeBlockSelector = 'pre, .shiki, [data-rehype-pretty-code-fragment], [class*="code-block"], [class*="codeBlock"]';

  let scope = button.parentElement;
  let depth = 0;
  while (scope && scope !== document.body && depth < maxDepth) {
    const blocks = scope.querySelectorAll(codeBlockSelector);
    if (blocks.length > 0) {
      const buttonRect = typeof button.getBoundingClientRect === 'function' ? button.getBoundingClientRect() : null;
      let bestNode = null;
      let bestDistance = Number.POSITIVE_INFINITY;

      for (const block of blocks) {
        if (button.contains(block)) continue;
        const codeNode = block.querySelector('pre code, code') || (block.matches('pre') ? block : null);
        if (!codeNode) continue;
        if (!buttonRect || typeof codeNode.getBoundingClientRect !== 'function') {
          return codeNode;
        }

        const rect = codeNode.getBoundingClientRect();
        const distance = Math.abs(rect.top - buttonRect.top) + Math.abs(rect.left - buttonRect.left);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestNode = codeNode;
        }
      }

      if (bestNode) return bestNode;
    }

    scope = scope.parentElement;
    depth += 1;
  }

  return null;
}

function extractCodeText(codeNode) {
  if (!codeNode) return '';
  const raw = codeNode.innerText || codeNode.textContent || '';
  return raw
    .replace(/\u00A0/g, ' ')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

async function writeClipboardText(text) {
  if (typeof text !== 'string' || text.length === 0) return false;

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_error) {
      // fallback below
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'readonly');
  textarea.style.position = 'fixed';
  textarea.style.top = '-9999px';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
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

function showCopyFeedback(button) {
  if (!button) return;
  const prevTitle = button.getAttribute('title');
  const prevAriaLabel = button.getAttribute('aria-label');

  button.setAttribute('title', '已复制');
  button.setAttribute('aria-label', '已复制');

  if (button.__tmCopyFeedbackTimer) {
    clearTimeout(button.__tmCopyFeedbackTimer);
  }
  button.__tmCopyFeedbackTimer = setTimeout(() => {
    if (!button.isConnected) return;
    if (prevTitle === null) button.removeAttribute('title');
    else button.setAttribute('title', prevTitle);

    if (prevAriaLabel === null) button.removeAttribute('aria-label');
    else button.setAttribute('aria-label', prevAriaLabel);
  }, 1200);
}

function tryHandleCodeCopyFallback(event) {
  if (event.type !== 'click') return;
  if (!(event.target instanceof Element)) return;

  const button = event.target.closest('button');
  if (!button) return;
  if (button.closest('#tm-history-modal')) return;

  const codeNode = findNearbyCodeNode(button);
  if (!codeNode) return;
  if (!isLikelyCodeCopyButton(button, codeNode)) return;

  event.preventDefault();
  event.stopPropagation();
  if (typeof event.stopImmediatePropagation === 'function') {
    event.stopImmediatePropagation();
  }

  const codeText = extractCodeText(codeNode);
  if (!codeText) return;
  if (button.dataset.tmCopyFallbackBusy === '1') return;

  button.dataset.tmCopyFallbackBusy = '1';
  void writeClipboardText(codeText)
    .then((copied) => {
      if (copied) showCopyFeedback(button);
    })
    .finally(() => {
      if (button.isConnected) {
        delete button.dataset.tmCopyFallbackBusy;
      }
    });
}

function isTokenizerButton(button) {
  if (!button || !button.matches?.(BUTTON_BASE_SELECTOR)) return false;
  return TOKENIZER_BUTTON_TEXT_RE.test(normalizeButtonText(button));
}

function hideButtonsByTextPattern(root, pattern) {
  if (!root) return;
  const buttons = root.querySelectorAll(BUTTON_BASE_SELECTOR);
  for (const button of buttons) {
    if (!pattern.test(normalizeButtonText(button))) continue;
    markNodeHidden(button);
  }
}

function hideTokenizerButtons(root = document.body, { force = false } = {}) {
  const now = Date.now();
  if (!force && now - state.lastTokenizerSweepAt < 1500) return;
  state.lastTokenizerSweepAt = now;
  hideButtonsByTextPattern(root, TOKENIZER_BUTTON_TEXT_RE);
}

function onGlobalButtonPointerDown(event) {
  if (!isPluginEnabled) return;
  if (!(event.target instanceof Element)) return;

  tryHandleCodeCopyFallback(event);

  const button = event.target.closest(BUTTON_BASE_SELECTOR);
  if (!button || !isTokenizerButton(button)) return;

  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
}

function elementFromNode(node) {
  if (!node) return null;
  if (node instanceof Element) return node;
  return node.parentElement || null;
}

function nodeHasInteractiveDescendants(node) {
  if (!(node instanceof Element)) return false;
  if (node.matches('button, input, textarea, form, [role="button"], [data-slot="button"]')) return true;
  return Boolean(node.querySelector('button, input, textarea, form, [role="button"], [data-slot="button"]'));
}

function isProseOnlyMutationBatch(mutations) {
  let hasMeaningfulChange = false;

  for (const mutation of mutations) {
    if (mutation.type !== 'childList') continue;
    if (mutation.addedNodes.length === 0 && mutation.removedNodes.length === 0) continue;

    hasMeaningfulChange = true;
    const targetEl = elementFromNode(mutation.target);
    if (!targetEl || !targetEl.closest(PROSE_CONTAINER_SELECTOR)) {
      return false;
    }

    for (const node of mutation.addedNodes) {
      if (nodeHasInteractiveDescendants(node)) return false;
      const el = elementFromNode(node);
      if (el && !el.closest(PROSE_CONTAINER_SELECTOR)) return false;
    }

    for (const node of mutation.removedNodes) {
      if (nodeHasInteractiveDescendants(node)) return false;
    }
  }

  return hasMeaningfulChange;
}

function hideStaticLayoutElements() {
  const centeredEl = getActiveCenteredElement();
  document.querySelectorAll('main').forEach((mainEl) => {
    if (centeredEl && mainEl.contains(centeredEl)) return;
    markNodeHidden(mainEl);
  });
}

function hideInterferingUi(root, { force = false } = {}) {
  if (!root) return;
  const now = Date.now();
  if (!force && now - state.lastInterferingUiSweepAt < 1200) return;
  state.lastInterferingUiSweepAt = now;

  // Chatbox-specific: no sidebar toggle or col-resize elements to hide
}
