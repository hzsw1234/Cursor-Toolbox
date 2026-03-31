// Layout core: centering, auto-expand, disclaimer/header, and input placeholder

'use strict';

const DISCLAIMER_TYPING_FORWARD_DELAY_MS = 86;
const DISCLAIMER_TYPING_BACKWARD_DELAY_MS = 48;
const DISCLAIMER_TYPING_PAUSE_AFTER_FULL_MS = 1150;
const DISCLAIMER_TYPING_PAUSE_AFTER_EMPTY_MS = 420;
const TM_LAYOUT_MCP_TOOL_RESULT_PREFIX = '[MCP_TOOL_RESULT]';
const USER_MESSAGE_MCP_RESULT_MARK_ATTR = 'data-tm-user-message-mcp-result';
const USER_MESSAGE_MCP_RESULT_CLASS = 'tm-user-message-bubble--mcp-result';

function findLayoutTarget() {
  const centeredEl = getActiveCenteredElement();
  if (centeredEl) return centeredEl;

  const candidates = new Set();

  document.querySelectorAll(LAYOUT_TARGET_SELECTOR).forEach((el) => {
    candidates.add(el);
  });
  document.querySelectorAll(LAYOUT_FALLBACK_SELECTOR).forEach((el) => {
    candidates.add(el);
  });

  const textarea = document.querySelector(TEXTAREA_SELECTOR);
  if (textarea) {
    collectLayoutCandidatesFromAncestors(textarea, candidates);
  }

  const sendBtn = findSendButton();
  if (sendBtn) {
    collectLayoutCandidatesFromAncestors(sendBtn, candidates);
  }

  const toggleBtn = document.querySelector('button[aria-label*="sidebar"], button[aria-label*="menu"]');
  if (toggleBtn) {
    collectLayoutCandidatesFromAncestors(toggleBtn, candidates);
  }

  const separatorFallback = document.querySelector('div[role="separator"]')?.parentElement?.parentElement;
  if (separatorFallback) {
    candidates.add(separatorFallback);
  }

  let best = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const candidate of candidates) {
    const score = scoreLayoutCandidate(candidate);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return bestScore >= 8 ? best : null;
}

function ensureCenteredLayout() {
  const centeredEl = getActiveCenteredElement();
  const target = centeredEl || findLayoutTarget();
  if (!target || !document.body) return false;

  updateShellTopOffset();
  ensureChatShell();
  if (!state.shellStage) return false;

  if (state.centered && centeredEl && centeredEl !== target) {
    restoreCenteredLayout({ keepShell: true });
  }

  if (state.centered && centeredEl === target) {
    if (target.parentNode !== state.shellStage) {
      state.shellStage.appendChild(target);
    }
    target.classList.add('tm-centered50');
    hideInterferingUi(target, { force: true });
    renderSessionSidebar();
    return true;
  }

  state.centeredElement = target;
  state.centeredOriginalStyle = target.getAttribute('style');
  state.centeredPlaceholder = document.createComment('tm-center50-placeholder');

  if (target.parentNode) {
    target.parentNode.insertBefore(state.centeredPlaceholder, target.nextSibling);
    if (target.parentNode instanceof Element) {
      state.underlayHost = target.parentNode;
      state.underlayHost.classList.add('tm-shell-underlay-hidden');
    }
  }

  state.shellStage.appendChild(target);
  target.classList.add('tm-centered50');

  state.prevBodyOverflow = document.body.style.overflow || '';
  state.prevHtmlOverflow = document.documentElement.style.overflow || '';
  document.body.style.overflow = '';
  document.documentElement.style.overflow = '';

  hideInterferingUi(target, { force: true });
  state.centered = true;
  renderSessionSidebar();
  return true;
}

function restoreCenteredLayout({ keepShell = false } = {}) {
  const el = state.centeredElement;
  if (el) {
    el.classList.remove('tm-centered50');

    if (state.centeredOriginalStyle === null) {
      el.removeAttribute('style');
    } else {
      el.setAttribute('style', state.centeredOriginalStyle);
    }

    if (state.centeredPlaceholder?.parentNode) {
      state.centeredPlaceholder.parentNode.insertBefore(el, state.centeredPlaceholder);
      state.centeredPlaceholder.remove();
    }
  }

  if (state.centeredPlaceholder?.parentNode) {
    state.centeredPlaceholder.remove();
  }

  if (state.underlayHost) {
    state.underlayHost.classList.remove('tm-shell-underlay-hidden');
    state.underlayHost = null;
  }

  if (!keepShell && state.shellHost) {
    state.shellHost.remove();
    state.shellHost = null;
    state.shellSidebar = null;
    state.shellStage = null;
    removeHistoryModal();
  }

  if (document.body) {
    document.body.style.overflow = state.prevBodyOverflow;
  }
  document.documentElement.style.overflow = state.prevHtmlOverflow;

  state.centered = false;
  state.centeredElement = null;
  state.centeredPlaceholder = null;
  state.centeredOriginalStyle = null;
  state.underlayHost = null;
}

function tryAutoExpand(force = false) {
  if (!isPluginEnabled || state.streaming) return false;
  if (!force && state.autoExpandAttempts >= MAX_AUTO_EXPAND_ATTEMPTS) return false;

  const btn = document.querySelector(LAYOUT_AUTOCLICK_SELECTOR) || document.querySelector(CHAT_AUTOCLICK_SELECTOR);
  if (btn && !btn.disabled) {
    try {
      btn.click();
      state.autoExpandAttempts = 0;
      return true;
    } catch (_error) {
      // ignore
    }
  }

  state.autoExpandAttempts = Math.min(state.autoExpandAttempts + 1, MAX_AUTO_EXPAND_ATTEMPTS);
  return false;
}

function scheduleAutoExpand(delay = 0, force = false) {
  clearAutoExpandTimer();
  state.autoExpandTimer = setTimeout(() => {
    state.autoExpandTimer = null;
    void tryAutoExpand(force);
  }, delay);
}

function stopHeaderDisclaimerTypewriter(disclaimer) {
  if (!disclaimer) return;
  if (typeof disclaimer._tmStopTypewriter === 'function') {
    disclaimer._tmStopTypewriter();
  }
  delete disclaimer._tmStopTypewriter;
}

function startHeaderDisclaimerTypewriter(disclaimer, textNode) {
  if (!disclaimer || !textNode) return;
  if (disclaimer.dataset.tmTypewriterReady === '1') return;

  disclaimer.dataset.tmTypewriterReady = '1';
  textNode.textContent = DISCLAIMER_TEXT;

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  let timer = null;
  let index = 0;
  let deleting = false;
  let stopped = false;

  const clearTimer = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
  };

  const schedule = (delay) => {
    clearTimer();
    timer = setTimeout(tick, Math.max(0, delay));
  };

  const tick = () => {
    if (stopped || !disclaimer.isConnected || !isPluginEnabled) {
      clearTimer();
      textNode.textContent = DISCLAIMER_TEXT;
      return;
    }

    if (!deleting) {
      index = Math.min(DISCLAIMER_TEXT.length, index + 1);
      textNode.textContent = DISCLAIMER_TEXT.slice(0, index);
      if (index >= DISCLAIMER_TEXT.length) {
        deleting = true;
        schedule(DISCLAIMER_TYPING_PAUSE_AFTER_FULL_MS);
        return;
      }
      schedule(DISCLAIMER_TYPING_FORWARD_DELAY_MS + (index % 4 === 0 ? 24 : 0));
      return;
    }

    index = Math.max(0, index - 1);
    textNode.textContent = DISCLAIMER_TEXT.slice(0, index);
    if (index <= 0) {
      deleting = false;
      schedule(DISCLAIMER_TYPING_PAUSE_AFTER_EMPTY_MS);
      return;
    }
    schedule(DISCLAIMER_TYPING_BACKWARD_DELAY_MS);
  };

  disclaimer._tmStopTypewriter = () => {
    stopped = true;
    clearTimer();
    textNode.textContent = DISCLAIMER_TEXT;
    delete disclaimer.dataset.tmTypewriterReady;
  };

  textNode.textContent = '';
  schedule(320);
}

function ensureHeaderDisclaimer(rightArea) {
  if (!rightArea) return;

  const existing = rightArea.querySelector('#tm-header-disclaimer');
  if (existing) {
    const textNode = existing.querySelector('.tm-header-disclaimer-text');
    if (textNode) {
      startHeaderDisclaimerTypewriter(existing, textNode);
    }
    return;
  }

  const disclaimer = document.createElement('div');
  disclaimer.id = 'tm-header-disclaimer';
  disclaimer.setAttribute('role', 'note');
  disclaimer.setAttribute('aria-label', DISCLAIMER_TEXT);

  const icon = document.createElement('span');
  icon.className = 'tm-header-disclaimer-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
      <line x1="12" y1="9" x2="12" y2="13"></line>
      <line x1="12" y1="17" x2="12.01" y2="17"></line>
    </svg>
  `.trim();

  const typing = document.createElement('span');
  typing.className = 'tm-header-disclaimer-typing';

  const textNode = document.createElement('span');
  textNode.className = 'tm-header-disclaimer-text';
  textNode.textContent = DISCLAIMER_TEXT;

  const caret = document.createElement('span');
  caret.className = 'tm-header-disclaimer-caret';
  caret.setAttribute('aria-hidden', 'true');

  typing.appendChild(textNode);
  typing.appendChild(caret);
  disclaimer.appendChild(icon);
  disclaimer.appendChild(typing);

  rightArea.appendChild(disclaimer);
  stopHeaderDisclaimerTypewriter(disclaimer);
  startHeaderDisclaimerTypewriter(disclaimer, textNode);
}

function ensureHeaderModifications() {
  const header = document.querySelector('header, div.flex-none.title-bar, div[class*="title-bar"]');
  if (!header) return false;

  const rightArea = header.querySelector('div[class*="justify-end"], div:last-child');
  if (rightArea) {
    const existing = rightArea.querySelector('#tm-header-disclaimer');
    if (!existing) {
      ensureHeaderDisclaimer(rightArea);
    }
  }

  return true;
}

function ensureInputPlaceholder() {
  const textarea = document.querySelector(TEXTAREA_SELECTOR);
  if (!textarea) return false;

  if (textarea.dataset.tmOriginalPlaceholder === undefined) {
    textarea.dataset.tmOriginalPlaceholder = textarea.placeholder || '';
  }

  if (textarea.placeholder !== PLACEHOLDER_TEXT) {
    textarea.placeholder = PLACEHOLDER_TEXT;
  }

  return true;
}

function restoreInputPlaceholder() {
  document.querySelectorAll('textarea[data-tm-original-placeholder]').forEach((textarea) => {
    textarea.placeholder = textarea.dataset.tmOriginalPlaceholder || '';
    delete textarea.dataset.tmOriginalPlaceholder;
  });
}
