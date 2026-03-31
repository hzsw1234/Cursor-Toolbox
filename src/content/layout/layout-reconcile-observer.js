// Layout reconcile/observer: user bubble markers, reconcile loop, DOM observer, and route patch

'use strict';

const USER_MESSAGE_CONTINUE_REQUEST_MARK_ATTR = 'data-tm-user-message-continue-request';
const USER_MESSAGE_CONTINUE_REQUEST_CLASS = 'tm-user-message-bubble--continue-request';

function resolveUserMessageTextContainer(bubble) {
  if (!bubble || bubble.nodeType !== Node.ELEMENT_NODE) return null;

  const direct = bubble.querySelector(USER_MESSAGE_TEXT_SELECTOR);
  if (direct instanceof HTMLElement) return direct;

  const fallbackSelectors = [
    '.msg-content',
    '.break-words',
    '[class*="break-words"]',
    '.w-full.overflow-hidden.break-words',
    '[class*="break-words"][class*="text-sm"]',
    '.whitespace-pre-wrap'
  ];
  for (const selector of fallbackSelectors) {
    const node = bubble.querySelector(selector);
    if (node instanceof HTMLElement) return node;
  }

  const prose = bubble.querySelector(PROSE_CONTAINER_SELECTOR);
  if (prose instanceof HTMLElement) return prose;

  return bubble instanceof HTMLElement ? bubble : null;
}

function isLikelyUserMessageBubble(bubble) {
  if (!bubble || bubble.nodeType !== Node.ELEMENT_NODE) return false;
  if (!bubble.matches(USER_MESSAGE_BUBBLE_SELECTOR)) return false;
  if (bubble.closest('.tm-thinking-block')) return false;
  if (!resolveUserMessageTextContainer(bubble)) return false;

  const inChatViewport = bubble.closest(CHAT_VIEWPORT_SELECTOR);
  return Boolean(inChatViewport);
}

function extractMcpToolResultPayload(rawText) {
  const normalized = String(rawText || '').replace(/\r\n/g, '\n').trim();
  if (!normalized.startsWith(TM_LAYOUT_MCP_TOOL_RESULT_PREFIX)) return null;
  const payload = normalized.slice(TM_LAYOUT_MCP_TOOL_RESULT_PREFIX.length).trimStart();
  return payload || normalized;
}

function detectMcpToolResultStatus(payload) {
  const text = String(payload || '');
  const match = text.match(/(?:^|\n)\s*status\s*:\s*([^\n]+)/i);
  if (!match) return 'unknown';

  const normalized = String(match[1] || '').trim().toLowerCase();
  if (!normalized) return 'unknown';
  if (normalized.startsWith('ok') || normalized === 'success' || normalized === 'true') return 'ok';
  if (normalized.startsWith('error') || normalized.startsWith('fail') || normalized === 'false') return 'error';
  return 'unknown';
}

function ensureMcpToolResultUserBubble(bubble) {
  if (!bubble || bubble.nodeType !== Node.ELEMENT_NODE) return;

  const textContainer = resolveUserMessageTextContainer(bubble);
  if (!(textContainer instanceof HTMLElement)) return;

  const existingBlock = textContainer.querySelector('.tm-mcp-tool-result-block');
  if (existingBlock) {
    bubble.classList.add(USER_MESSAGE_MCP_RESULT_CLASS);
    bubble.setAttribute(USER_MESSAGE_MCP_RESULT_MARK_ATTR, '1');
    return;
  }

  const payload = extractMcpToolResultPayload(textContainer.textContent || '');
  if (!payload) {
    bubble.classList.remove(USER_MESSAGE_MCP_RESULT_CLASS);
    bubble.removeAttribute(USER_MESSAGE_MCP_RESULT_MARK_ATTR);
    return;
  }
  const status = detectMcpToolResultStatus(payload);

  const wrapper = document.createElement('div');
  wrapper.className = 'tm-tool-code-block tm-mcp-tool-result-block';
  wrapper.classList.add(`is-status-${status}`);

  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.className = 'tm-tool-code-summary tm-tool-code-summary--result';

  const summaryMain = document.createElement('span');
  summaryMain.className = 'tm-tool-summary-main';
  summaryMain.textContent = '工具返回结果';

  const summaryMeta = document.createElement('span');
  summaryMeta.className = 'tm-tool-summary-meta';
  summaryMeta.textContent = status === 'ok'
    ? '点击展开 · 成功'
    : status === 'error'
      ? '点击展开 · 失败'
      : '点击展开';

  summary.appendChild(summaryMain);
  summary.appendChild(summaryMeta);

  const content = document.createElement('div');
  content.className = 'tm-tool-code-content tm-mcp-tool-result-content';

  const pre = document.createElement('pre');
  pre.textContent = payload;
  content.appendChild(pre);

  details.appendChild(summary);
  details.appendChild(content);
  wrapper.appendChild(details);

  textContainer.textContent = '';
  textContainer.appendChild(wrapper);
  bubble.classList.add(USER_MESSAGE_MCP_RESULT_CLASS);
  bubble.setAttribute(USER_MESSAGE_MCP_RESULT_MARK_ATTR, '1');
}

function ensureContinuationRequestUserBubble(bubble) {
  if (!bubble || bubble.nodeType !== Node.ELEMENT_NODE) return;
  const textContainer = resolveUserMessageTextContainer(bubble);
  const rawText = String(textContainer?.textContent || '').trimStart();
  const isContinuationRequest = rawText.startsWith(CONTINUE_REQUEST_PREFIX);

  bubble.classList.toggle(USER_MESSAGE_CONTINUE_REQUEST_CLASS, isContinuationRequest);
  if (isContinuationRequest) {
    bubble.setAttribute(USER_MESSAGE_CONTINUE_REQUEST_MARK_ATTR, '1');
  } else {
    bubble.removeAttribute(USER_MESSAGE_CONTINUE_REQUEST_MARK_ATTR);
  }
}

function collectMcpResultBubbleCandidates(root) {
  const scope = root || getActiveCenteredElement() || document.body;
  if (!scope) return [];

  const candidates = new Set();
  const textSelectors = [
    USER_MESSAGE_TEXT_SELECTOR,
    '[class*="break-words"]',
    '.whitespace-pre-wrap',
    '.prose'
  ].join(', ');
  const textNodes = scope.querySelectorAll(textSelectors);

  for (const node of textNodes) {
    if (!(node instanceof HTMLElement)) continue;
    const source = String(node.textContent || '').replace(/\r\n/g, '\n').trimStart();
    if (!source.startsWith(TM_LAYOUT_MCP_TOOL_RESULT_PREFIX)) continue;

    const bubble = node.closest(USER_MESSAGE_BUBBLE_SELECTOR)
      || node.closest('div[class*="rounded"][class*="border"]')
      || node.closest('div[class*="msg-block"]')
      || node.closest('article, li, [data-message-id], [data-role], [data-index]');
    if (!(bubble instanceof Element)) continue;
    if (!bubble.closest(CHAT_VIEWPORT_SELECTOR)) continue;
    candidates.add(bubble);
  }

  return Array.from(candidates);
}

function ensureUserMessageMarkers(root = null) {
  const effectiveRoot = root || getActiveCenteredElement() || document.body;
  if (!effectiveRoot) return;

  const selector = `${USER_MESSAGE_BUBBLE_SELECTOR}:not([${USER_MESSAGE_MARK_ATTR}])`;
  const candidates = effectiveRoot.querySelectorAll(selector);

  for (const bubble of candidates) {
    if (!isLikelyUserMessageBubble(bubble)) continue;
    bubble.setAttribute(USER_MESSAGE_MARK_ATTR, '1');
    bubble.classList.add('tm-user-message-bubble');
  }

  const mcpResultCandidates = collectMcpResultBubbleCandidates(effectiveRoot);
  for (const bubble of mcpResultCandidates) {
    if (!(bubble instanceof Element)) continue;
    bubble.setAttribute(USER_MESSAGE_MARK_ATTR, '1');
    bubble.classList.add('tm-user-message-bubble');
  }

  const markedBubbles = effectiveRoot.querySelectorAll(`.tm-user-message-bubble[${USER_MESSAGE_MARK_ATTR}]`);
  for (const bubble of markedBubbles) {
    ensureContinuationRequestUserBubble(bubble);
    ensureMcpToolResultUserBubble(bubble);
  }
}

function clearUserMessageMarkers() {
  document.querySelectorAll(`.tm-user-message-bubble[${USER_MESSAGE_MARK_ATTR}]`).forEach((el) => {
    el.classList.remove('tm-user-message-bubble');
    el.classList.remove(USER_MESSAGE_MCP_RESULT_CLASS);
    el.classList.remove(USER_MESSAGE_CONTINUE_REQUEST_CLASS);
    el.removeAttribute(USER_MESSAGE_MARK_ATTR);
    el.removeAttribute(USER_MESSAGE_MCP_RESULT_MARK_ATTR);
    el.removeAttribute(USER_MESSAGE_CONTINUE_REQUEST_MARK_ATTR);
  });
}

const CHAT_VIEWPORT_CANDIDATE_SELECTOR = '[data-testid="virtuoso-scroller"], [data-virtuoso-scroller], [data-slot="scroll-area-viewport"], [data-radix-scroll-area-viewport], #main-content, .overflow-hidden.h-full';
const CHAT_SCROLLBAR_SELECTOR = '[data-slot="scroll-area-scrollbar"], [data-radix-scroll-area-scrollbar]';
const CHAT_SCROLL_THUMB_SELECTOR = '[data-slot="scroll-area-thumb"], [data-radix-scroll-area-thumb]';

function collectChatViewportCandidates(root = null) {
  const scope = root || getActiveCenteredElement() || document.body;
  if (!(scope instanceof Element)) return [];

  const candidates = new Set();
  const addCandidate = (node) => {
    if (!(node instanceof HTMLElement)) return;
    if (scope !== node && !scope.contains(node)) return;
    candidates.add(node);
  };

  const messageRoots = scope.querySelectorAll('[aria-label="Chat messages"], [data-testid="virtuoso-item-list"], [data-testid="virtuoso-scroller"]');
  for (const messageRoot of messageRoots) {
    const viewport = messageRoot.closest(CHAT_VIEWPORT_CANDIDATE_SELECTOR) || messageRoot;
    addCandidate(viewport);
  }

  if (scope.matches('#main-content') && scope.querySelector('[aria-label="Chat messages"], [data-testid="virtuoso-item-list"]')) {
    addCandidate(scope);
  }

  const nestedMain = scope.querySelector('#main-content, #root');
  if (nestedMain instanceof HTMLElement && nestedMain.querySelector('[aria-label="Chat messages"], [data-testid="virtuoso-item-list"]')) {
    addCandidate(nestedMain);
  }

  if (candidates.size === 0) {
    const fallbackViewports = scope.querySelectorAll('[data-slot="scroll-area-viewport"], [data-radix-scroll-area-viewport]');
    for (const viewport of fallbackViewports) {
      if (!(viewport instanceof HTMLElement)) continue;
      if (!viewport.querySelector(USER_MESSAGE_BUBBLE_SELECTOR) && !viewport.querySelector(PROSE_CONTAINER_SELECTOR)) continue;
      addCandidate(viewport);
    }
  }

  return Array.from(candidates);
}

function scoreChatViewportCandidate(viewport) {
  if (!(viewport instanceof HTMLElement)) return Number.NEGATIVE_INFINITY;
  const rect = viewport.getBoundingClientRect();
  if (rect.width < 140 || rect.height < 120) return Number.NEGATIVE_INFINITY;

  let score = 0;
  if (viewport.matches('#main-content, #root')) score += 8;
  if (viewport.querySelector('[aria-label="Chat messages"], [data-testid="virtuoso-item-list"]')) score += 24;
  if (viewport.querySelector(USER_MESSAGE_BUBBLE_SELECTOR)) score += 8;
  if (viewport.querySelector(PROSE_CONTAINER_SELECTOR)) score += 6;

  const style = window.getComputedStyle(viewport);
  const overflowY = `${style.overflowY || ''} ${style.overflow || ''}`.toLowerCase();
  if (overflowY.includes('auto') || overflowY.includes('scroll')) score += 10;

  const scrollRange = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  score += Math.min(18, scrollRange / 80);
  score += Math.min(12, (rect.width * rect.height) / 70000);
  return score;
}

function resolvePrimaryChatViewport(root = null) {
  const candidates = collectChatViewportCandidates(root);
  if (candidates.length === 0) return null;

  let best = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const candidate of candidates) {
    const score = scoreChatViewportCandidate(candidate);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return bestScore === Number.NEGATIVE_INFINITY ? null : best;
}

function captureChatViewportScrollSnapshot(root = null) {
  const viewport = resolvePrimaryChatViewport(root);
  if (!(viewport instanceof HTMLElement)) return null;

  const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  const scrollTop = Math.max(0, viewport.scrollTop);
  return {
    scrollTop,
    wasNearBottom: maxScrollTop - scrollTop <= 20
  };
}

function restoreChatViewportScrollSnapshot(snapshot, root = null, { conservative = false } = {}) {
  if (!snapshot || typeof snapshot !== 'object') return;
  const viewport = resolvePrimaryChatViewport(root);
  if (!(viewport instanceof HTMLElement)) return;

  const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  const targetScrollTop = snapshot.wasNearBottom
    ? maxScrollTop
    : Math.min(Math.max(0, Number(snapshot.scrollTop) || 0), maxScrollTop);
  if (!Number.isFinite(targetScrollTop)) return;

  if (conservative) {
    if (snapshot.wasNearBottom) {
      if (viewport.scrollTop >= maxScrollTop - 2) return;
    } else if (viewport.scrollTop > 2) {
      return;
    }
  }

  if (Math.abs(viewport.scrollTop - targetScrollTop) <= 1) return;
  viewport.scrollTop = targetScrollTop;
}

function tagChatMessageScrollParts(root = null) {
  const scope = root || getActiveCenteredElement() || document.body;
  if (!scope) return;

  const viewport = resolvePrimaryChatViewport(scope);
  const previousViewports = Array.from(document.querySelectorAll('.tm-chat-scroll-viewport'));
  if (!(viewport instanceof HTMLElement)) {
    previousViewports.forEach((el) => el.classList.remove('tm-chat-scroll-viewport'));
    document.querySelectorAll('.tm-chat-scrollbar').forEach((el) => el.classList.remove('tm-chat-scrollbar'));
    document.querySelectorAll('.tm-chat-scroll-thumb').forEach((el) => el.classList.remove('tm-chat-scroll-thumb'));
    return;
  }

  previousViewports.forEach((el) => {
    if (el !== viewport) {
      el.classList.remove('tm-chat-scroll-viewport');
    }
  });

  viewport.classList.add('tm-chat-scroll-viewport');
  const container = viewport.parentElement;
  if (!container) return;

  document.querySelectorAll('.tm-chat-scrollbar').forEach((el) => {
    if (!container.contains(el)) {
      el.classList.remove('tm-chat-scrollbar');
    }
  });
  document.querySelectorAll('.tm-chat-scroll-thumb').forEach((el) => {
    if (!container.contains(el)) {
      el.classList.remove('tm-chat-scroll-thumb');
    }
  });

  container.querySelectorAll(CHAT_SCROLLBAR_SELECTOR).forEach((scrollbar) => {
    scrollbar.classList.add('tm-chat-scrollbar');
  });
  container.querySelectorAll(CHAT_SCROLL_THUMB_SELECTOR).forEach((thumb) => {
    thumb.classList.add('tm-chat-scroll-thumb');
  });
}

function reconcileUi(reason = 'manual') {
  if (!isPluginEnabled || state.streaming) return;
  if (!document.body) return;

  const shouldPreserveChatScroll = reason !== 'route_change';
  const preReconcileRoot = getActiveCenteredElement() || document.body;
  const chatScrollSnapshot = shouldPreserveChatScroll
    ? captureChatViewportScrollSnapshot(preReconcileRoot)
    : null;

  updateShellTopOffset();
  setBodyEnabledClass(true);
  document.querySelectorAll('#main-content.tm-hidden-by-toolbox').forEach((el) => {
    el.classList.remove('tm-hidden-by-toolbox');
  });
  ensureHeaderModifications();
  ensureInputPlaceholder();
  hideTokenizerButtons(document.body, { force: reason !== 'dom_mutation' });

  const centered = ensureCenteredLayout();
  if (!centered) {
    scheduleAutoExpand(180, false);
  } else {
    hideStaticLayoutElements();
  }

  if (typeof syncShellResponsiveLayout === 'function') {
    syncShellResponsiveLayout({ reason });
  }
  ensureFabNearSendButton();
  ensureThinkingToggleNearModel();

  const centeredRoot = getActiveCenteredElement();
  if (centeredRoot) {
    hideInterferingUi(centeredRoot, { force: reason !== 'dom_mutation' });
  }

  const uiRoot = centeredRoot || document.body;
  ensureUserMessageMarkers(uiRoot);
  tagChatMessageScrollParts(uiRoot);
  if (chatScrollSnapshot) {
    restoreChatViewportScrollSnapshot(chatScrollSnapshot, uiRoot);
    requestAnimationFrame(() => {
      if (!isPluginEnabled || state.streaming) return;
      restoreChatViewportScrollSnapshot(chatScrollSnapshot, getActiveCenteredElement() || document.body, {
        conservative: true
      });
    });
  }
  startDomObserver();
  scheduleSessionSync(320);

  if (reason === 'route_change') {
    state.autoExpandAttempts = 0;
  }
}

function scheduleReconcile(reason = 'manual', delay = RECONCILE_DEBOUNCE_MS) {
  if (!isPluginEnabled || state.streaming) return;
  if (state.reconcileTimer) return;

  state.reconcileTimer = setTimeout(() => {
    state.reconcileTimer = null;
    reconcileUi(reason);
  }, delay);
}

function resetDomObserverIdleTimer() {
  if (state.domObserverIdleTimer) {
    clearTimeout(state.domObserverIdleTimer);
  }

  state.domObserverIdleTimer = setTimeout(() => {
    if (!isPluginEnabled || state.streaming) return;
    stopDomObserver();
  }, OBSERVER_IDLE_TIMEOUT_MS);
}

function startDomObserver() {
  if (!isPluginEnabled || state.streaming) return;
  if (!document.body) return;

  const observeRoot = getActiveCenteredElement() || document.querySelector('#root') || document.querySelector('#main-content') || document.body;
  if (!isConnectedElement(observeRoot)) return;
  if (state.domObserver && state.domObserverRoot === observeRoot) return;
  if (state.domObserver) {
    stopDomObserver();
  }

  state.domObserver = new MutationObserver((mutations) => {
    if (!isPluginEnabled || state.streaming) return;

    let hasChildMutation = false;
    for (const mutation of mutations) {
      if (mutation.type === 'childList' && (mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0)) {
        hasChildMutation = true;
        break;
      }
    }
    if (!hasChildMutation) return;

    // AI 流式输出会频繁改写 prose 内容，跳过这类纯文本流更新，避免反复触发重型 reconcile。
    if (isProseOnlyMutationBatch(mutations)) {
      resetDomObserverIdleTimer();
      return;
    }

    scheduleReconcile('dom_mutation');
    resetDomObserverIdleTimer();
  });

  state.domObserver.observe(observeRoot, {
    childList: true,
    subtree: true
  });
  state.domObserverRoot = observeRoot;

  resetDomObserverIdleTimer();
}

function stopDomObserver() {
  if (state.domObserver) {
    state.domObserver.disconnect();
    state.domObserver = null;
  }
  state.domObserverRoot = null;

  if (state.domObserverIdleTimer) {
    clearTimeout(state.domObserverIdleTimer);
    state.domObserverIdleTimer = null;
  }
}

function onRouteChanged() {
  if (!isPluginEnabled) return;

  closeHistorySummaryModal();
  state.autoExpandAttempts = 0;
  state.lastSessionSyncHash = '';
  kickstartFeatureRecovery('route_change');
  scheduleReconcile('route_change', 80);
  scheduleSessionSync(260);
}

function patchHistoryOnce() {
  if (state.historyPatched) return;
  state.historyPatched = true;

  const wrapMethod = (methodName) => {
    const original = history[methodName];
    if (typeof original !== 'function') return;

    history[methodName] = function patchedHistoryMethod(...args) {
      const result = original.apply(this, args);
      window.dispatchEvent(new Event('tm-toolbox-route-change'));
      return result;
    };
  };

  wrapMethod('pushState');
  wrapMethod('replaceState');

  window.addEventListener('popstate', () => {
    window.dispatchEvent(new Event('tm-toolbox-route-change'));
  });

  window.addEventListener('hashchange', () => {
    window.dispatchEvent(new Event('tm-toolbox-route-change'));
  });

  window.addEventListener('tm-toolbox-route-change', onRouteChanged);
}
