// Core constants, state, timers, and shared helpers

'use strict';

let isPluginEnabled = true;
let isThinkingInjectionEnabled = false;
let isAutoContinueFromCutoffEnabled = true;
let globalPromptInstruction = '';
let initCalled = false;

const BRIDGE_SOURCE_CONTENT = 'cursor-toolbox-content';
const BRIDGE_SOURCE_PAGE = 'cursor-toolbox-page-hook';

const LAYOUT_TARGET_SELECTOR = '.App, .MuiDrawer-root, div.flex.flex-col.h-full';
const LAYOUT_FALLBACK_SELECTOR = '#root, div.MuiBox-root, div.w-full.h-full';
const LAYOUT_AUTOCLICK_SELECTOR = 'button[aria-label*="展开"], button[aria-label*="Expand"], button[aria-label*="sidebar"], button[aria-label*="menu"]';
const CHAT_AUTOCLICK_SELECTOR = 'button[aria-label*="sidebar"]';
const SEND_BTN_SELECTORS = [
  'button.mantine-ActionIcon-root[type="button"]',
  'button[type="submit"]',
  'button[data-disabled="true"] ~ button, button.mantine-ActionIcon-root'
];
const TEXTAREA_SELECTOR = 'textarea#message-input, textarea[data-testid="message-input"], textarea[placeholder*="question"], textarea[placeholder*="输入"]';
const CHAT_VIEWPORT_SELECTOR = '[data-testid="virtuoso-scroller"], [data-virtuoso-scroller], .overflow-hidden.h-full, #root';
const USER_MESSAGE_BUBBLE_SELECTOR = 'div.group\\/message.msg-block, div[class*="msg-block"], div[data-index]';
const USER_MESSAGE_TEXT_SELECTOR = '.msg-content, .break-words, div[class*="msg-content"]';
const USER_MESSAGE_MARK_ATTR = 'data-tm-user-message-marked';
const BUTTON_BASE_SELECTOR = 'button[type="button"], button.mantine-ActionIcon-root';
const PROSE_CONTAINER_SELECTOR = '.msg-content, .break-words, [class*="msg-content"], .prose, [class^="prose-"], [class*=" prose-"]';

const MAX_AUTO_EXPAND_ATTEMPTS = 4;
const RECENT_PROSE_SCAN_LIMIT = 6;
const RECONCILE_DEBOUNCE_MS = 220;
const OBSERVER_IDLE_TIMEOUT_MS = 10000;
const STARTUP_RECOVERY_INTERVAL_MS = 500;
const STARTUP_RECOVERY_MAX_ATTEMPTS = 40;
const SESSION_STORAGE_KEY = 'tm_local_chat_sessions_v1';
const THINKING_INJECTION_STORAGE_KEY = 'tm_thinking_injection_enabled_v1';
const GLOBAL_PROMPT_INSTRUCTION_STORAGE_KEY = 'tm_global_prompt_instruction_v1';
const MCP_CONFIG_STORAGE_KEY = 'tm_mcp_config_v1';
const MCP_ENABLED_TOOLS_STORAGE_KEY = 'tm_mcp_enabled_tools_v1';
const MAX_LOCAL_SESSIONS = 40;
const SESSION_PAGE_SIZE = 10;
const SESSION_CAPTURE_MODE = 'api';
const SESSION_SYNC_DEBOUNCE_MS = 260;
const SESSION_PERSIST_DEBOUNCE_MS = 550;
const MAX_SESSION_ENTRY_COUNT = 60;
const MAX_SESSION_ENTRY_TEXT = 1800;
const MCP_TOOL_POLICY_DEFAULT_MAX_RETRIES = 5;
const MCP_TOOL_POLICY_DEFAULT_TIMEOUT_MS = 60 * 1000;
const MCP_TOOL_POLICY_DEFAULT_RESULT_MAX_CHARS = 0;
const MCP_TOOL_POLICY_DEFAULT_MAX_AUTO_ROUNDS = 0;
const MCP_TOOL_POLICY_MAX_AUTO_ROUNDS = 1000;
const MCP_TOOL_POLICY_MAX_RESULT_MAX_CHARS = 2 * 1000 * 1000;
const SHELL_MOBILE_BREAKPOINT = 920;
const CONTINUE_REQUEST_PREFIX = '[TM_CONTINUE_REQUEST]';
const CONTINUE_ACK_PREFIX = '[TM_CONTINUE_ACK:';
const CONTINUE_START_PREFIX = '[TM_CONTINUE_START:';
const CONTINUE_END_PREFIX = '[TM_CONTINUE_END:';
const CONTINUE_MARKER_SUFFIX = ']';

const DISCLAIMER_TEXT = '仅供学习参考，请勿违法使用';
const PLACEHOLDER_TEXT = `请输入你的问题，${DISCLAIMER_TEXT}`;
const TOKENIZER_BUTTON_TEXT_RE = /^tokenizer\s+/i;

const processedThinkingContainers = new WeakSet();

const state = {
  pageHookReady: false,
  streaming: false,
  streamContinuation: {
    active: false,
    sessionKey: '',
    anchorToken: '',
    tailText: '',
    toolCallInProgress: false,
    pendingToolCallToken: '',
    toolCallOpenTokens: [],
    toolCallTrackerSessionKey: '',
    updatedAt: 0,
    chainCount: 0
  },
  pendingContinuationBySession: {},
  completedContinuationTokens: [],
  completedContinuationContentByToken: {},

  centered: false,
  centeredElement: null,
  centeredPlaceholder: null,
  centeredOriginalStyle: null,
  underlayHost: null,
  prevBodyOverflow: '',
  prevHtmlOverflow: '',

  autoExpandAttempts: 0,
  autoExpandTimer: null,
  startupRecoveryTimer: null,
  startupRecoveryAttempts: 0,
  lastTokenizerSweepAt: 0,
  lastInterferingUiSweepAt: 0,

  reconcileTimer: null,
  domObserver: null,
  domObserverRoot: null,
  domObserverIdleTimer: null,

  thinkingRenderTimer: null,
  thinkingNeedsFullScan: false,
  toolCodeRenderTimer: null,
  toolCodeNeedsFullScan: false,

  historyPatched: false,

  shellHost: null,
  shellSidebar: null,
  shellStage: null,
  shellMenuOpen: false,

  sessionsLoaded: false,
  sessions: [],
  activeSessionId: null,
  historyModalSessionId: null,
  historyModalKeyListenerBound: false,
  sessionsRenderCount: SESSION_PAGE_SIZE,
  sessionPagingBusy: false,
  pendingApiSessions: {},
  sessionSyncTimer: null,
  sessionPersistTimer: null,
  lastSessionSyncHash: '',

  mcpConfig: {
    servers: [],
    toolPolicy: {
      maxRetries: MCP_TOOL_POLICY_DEFAULT_MAX_RETRIES,
      timeoutMs: MCP_TOOL_POLICY_DEFAULT_TIMEOUT_MS,
      resultMaxChars: MCP_TOOL_POLICY_DEFAULT_RESULT_MAX_CHARS,
      maxAutoRounds: MCP_TOOL_POLICY_DEFAULT_MAX_AUTO_ROUNDS
    },
    updatedAt: 0
  },
  mcpEnabledToolsByServer: {},
  mcpPanelOpen: false,
  mcpPanelBusy: false,
  mcpDiscoveredToolsByServer: {},
  mcpExpandedServerIds: new Set(),
  mcpAutoRoundCount: 0,
  mcpAutoInFlight: false,
  mcpPendingExecutionPayload: null,
  mcpPendingExecutionFingerprint: '',
  mcpLastToolHash: '',
  mcpLastToolSessionKey: '',
  mcpLastToolExecutedAt: 0,
  mcpMergedToolTriggerLastFingerprint: '',
  mcpMergedToolTriggerLastAt: 0,
  mcpLastToolEventFingerprint: '',
  mcpLastToolEventAt: 0,
  mcpToolFormatRetryLastFingerprint: '',
  mcpToolFormatRetryLastAt: 0,
  mcpToolFormatRetryInFlightFingerprint: '',
  mcpToolFormatRetryInFlightPromise: null,
  mcpToolRunActive: false,
  mcpToolRunOperationId: '',
  mcpToolRunToolRef: '',
  mcpToolRunStartedAt: 0,
  mcpToolRunTimer: null,
  mcpToolRunPauseRequested: false,
  mcpToolRunCancelNoticeSent: false,
  mcpToolRunCancelNoticeOperationId: '',
  mcpToolRunCancelRequestedOperationId: '',
  mcpToolRunCancelNoticeInFlightOperationId: '',
  mcpToolRunCancelNoticePromise: null
};

function runInit() {
  if (initCalled) return;
  initCalled = true;
  init();
}

function clearAutoExpandTimer() {
  if (!state.autoExpandTimer) return;
  clearTimeout(state.autoExpandTimer);
  state.autoExpandTimer = null;
}

function clearStartupRecoveryTimer() {
  if (!state.startupRecoveryTimer) return;
  clearTimeout(state.startupRecoveryTimer);
  state.startupRecoveryTimer = null;
}

function clearReconcileTimer() {
  if (!state.reconcileTimer) return;
  clearTimeout(state.reconcileTimer);
  state.reconcileTimer = null;
}

function clearThinkingRenderTimer() {
  if (!state.thinkingRenderTimer) return;
  clearTimeout(state.thinkingRenderTimer);
  state.thinkingRenderTimer = null;
}

function clearToolCodeRenderTimer() {
  if (!state.toolCodeRenderTimer) return;
  clearTimeout(state.toolCodeRenderTimer);
  state.toolCodeRenderTimer = null;
}

function clearSessionSyncTimer() {
  if (!state.sessionSyncTimer) return;
  clearTimeout(state.sessionSyncTimer);
  state.sessionSyncTimer = null;
}

function clearSessionPersistTimer() {
  if (!state.sessionPersistTimer) return;
  clearTimeout(state.sessionPersistTimer);
  state.sessionPersistTimer = null;
}

function shortHash(input) {
  const text = String(input ?? '');
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function normalizeSpace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function sanitizeTextFragment(text, maxLen = 260) {
  const collapsed = normalizeSpace(text);
  if (collapsed.length <= maxLen) return collapsed;
  return `${collapsed.slice(0, maxLen - 1)}…`;
}

function isShellMobileViewport() {
  const width = Math.max(
    window.innerWidth || 0,
    document.documentElement?.clientWidth || 0
  );
  return width > 0 && width <= SHELL_MOBILE_BREAKPOINT;
}

function getCurrentRoutePath() {
  return `${window.location.pathname || ''}${window.location.search || ''}${window.location.hash || ''}`;
}

function getRouteConversationId(routePath) {
  const pathOnly = String(routePath || '').split('?')[0].split('#')[0];
  const match = pathOnly.match(/\/(?:chat|session)\/([^/]+)/i);
  if (!match || !match[1]) return null;
  return match[1];
}

function deriveConversationKey(routePath, firstUserText = '') {
  const routeId = getRouteConversationId(routePath);
  if (routeId) return `chat:${routeId}`;
  const seed = sanitizeTextFragment(firstUserText || '', 140);
  return `draft:${shortHash(`${routePath}|${seed}`)}`;
}

function createSessionId() {
  return `tm-session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatSessionTime(ts) {
  if (!Number.isFinite(ts)) return '';
  const deltaMs = Date.now() - ts;
  if (deltaMs < 60 * 1000) return '刚刚';
  if (deltaMs < 60 * 60 * 1000) return `${Math.floor(deltaMs / 60000)} 分钟前`;
  if (deltaMs < 24 * 60 * 60 * 1000) return `${Math.floor(deltaMs / 3600000)} 小时前`;
  return new Date(ts).toLocaleDateString('zh-CN', {
    month: '2-digit',
    day: '2-digit'
  });
}

function trimStoredSessions() {
  if (state.sessions.length <= MAX_LOCAL_SESSIONS) return false;
  state.sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  state.sessions = state.sessions.slice(0, MAX_LOCAL_SESSIONS);
  if (!state.sessions.some((item) => item.id === state.activeSessionId)) {
    state.activeSessionId = state.sessions[0]?.id || null;
  }
  return true;
}

function persistSessionsSoon(delay = SESSION_PERSIST_DEBOUNCE_MS) {
  if (!state.sessionsLoaded) return;
  clearSessionPersistTimer();
  state.sessionPersistTimer = setTimeout(() => {
    state.sessionPersistTimer = null;
    trimStoredSessions();
    const sessionsPayload = typeof serializeSessionsForStorage === 'function'
      ? serializeSessionsForStorage(state.sessions)
      : state.sessions;
    chrome.storage.local.set({
      [SESSION_STORAGE_KEY]: {
        version: typeof getSessionStorageSchemaVersion === 'function'
          ? getSessionStorageSchemaVersion()
          : 1,
        sessions: sessionsPayload,
        activeSessionId: state.activeSessionId
      }
    }, () => {
      if (!chrome.runtime?.lastError) return;
      console.warn('[Cursor Toolbox] Failed to persist local sessions:', chrome.runtime.lastError.message);
    });
  }, Math.max(0, delay));
}


