/**
 * service-worker.js
 * Persistent background for Claude Ultimate extension.
 *
 * Responsibilities:
 *  - Initialize storage with defaults on install/update
 *  - Route messages from content script (SSE events, etc.)
 *  - Poll /usage endpoint every 30 min via chrome.alarms
 *  - Own all chrome.storage.local writes for state
 *
 * IMPORTANT: All listeners registered synchronously at top level.
 * No global mutable state — everything persisted to storage.
 */

'use strict';

// ── Constants ────────────────────────────────────────────────────────────────

const ALARM_POLL_USAGE = 'pollUsage';
const USAGE_URL = 'https://claude.ai/api/usage';
const USAGE_POLL_INTERVAL_MINUTES = 30;

const ALLOWED_MESSAGE_TYPES = new Set([
  'SSE_MESSAGE_START',
  'SSE_MESSAGE_DELTA',
  'SSE_STREAM_END',
  'SEND_INTERCEPT',
  'GET_STATE',
  'UPDATE_SETTING',
]);

// ── Default schema (mirrors lib/storage.js) ──────────────────────────────────

const StorageDefaults = {
  tokenCount: { session: 0, weekly: 0, lastUpdated: 0 },
  streamingActive: false,
  usageLimits: {
    daily_limit: 0,
    used_today: 0,
    weekly_limit: 0,
    used_this_week: 0,
    last_fetch_time: 0,
  },
  resetTimestamps: { session: 0, weekly: 0 },
  dismissedWarnings: { sessionWarn: false, weeklyWarn: false },
  currentModel: '',
  currentConversationId: '',
  instructionsPrependedThisChat: false,
  selectedMode: null,
  modePresets: {
    caveman: "Explain like I'm 5 years old. Use simple words.",
    bullet: 'Respond in bullet points only.',
    noPreamble: 'No intro/outro. Just the answer.',
    technical: 'Use technical jargon. Assume expert knowledge.',
    concise: 'Keep it under 2 sentences.',
  },
  customInstructions: '',
  responseLengthMode: 'medium',
  responseLengthModes: {
    short: 'Keep your response to 2-3 sentences.',
    medium: 'Respond in 3-5 sentences.',
    detailed: 'Provide a thorough, detailed response with examples.',
  },
  trimmerEnabled: true,
  promptTemplates: {
    debug: 'Debug this code and explain the issue:\n\n```\n[YOUR CODE]\n```',
    blog: 'Write a blog post about [TOPIC]:\nTarget audience: [AUDIENCE]\nTone: [TONE]',
    email: 'Draft a professional email:\nTo: [RECIPIENT]\nSubject: [SUBJECT]\nTone: [TONE]',
    explain: 'Explain [CONCEPT] in a way that a [AUDIENCE] would understand.',
    code: 'Write a [LANGUAGE] function that [REQUIREMENT].',
  },
  lastExportTime: 0,
  keyboardBindings: {
    'Ctrl+Shift+N': 'newChat',
    'Ctrl+Shift+E': 'copyPassport',
    'Ctrl+Shift+M': 'exportMarkdown',
    'Ctrl+Shift+T': 'toggleTrimmer',
    'Ctrl+Shift+1': 'modeShort',
    'Ctrl+Shift+2': 'modeMedium',
    'Ctrl+Shift+3': 'modeDetailed',
  },
  conversationTags: {},
};

// ── Install / Update ─────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
  try {
    // Populate only keys that don't already exist (preserve user settings on update)
    const existing = await chrome.storage.local.get(null);
    if (chrome.runtime.lastError) {
      console.error('[ClaudeExt:SW] onInstalled get error:', chrome.runtime.lastError.message);
      return;
    }

    const toSet = {};
    for (const [key, defaultValue] of Object.entries(StorageDefaults)) {
      if (!(key in existing)) {
        toSet[key] = defaultValue;
      }
    }

    if (Object.keys(toSet).length > 0) {
      await chrome.storage.local.set(toSet);
      if (chrome.runtime.lastError) {
        console.error('[ClaudeExt:SW] onInstalled set error:', chrome.runtime.lastError.message);
      }
    }

    // Create repeating alarm (idempotent — Chrome replaces existing alarm with same name)
    await chrome.alarms.create(ALARM_POLL_USAGE, {
      periodInMinutes: USAGE_POLL_INTERVAL_MINUTES,
    });

    // First poll immediately on install
    if (details.reason === 'install') {
      await pollUsageEndpoint();
    }

    console.debug('[ClaudeExt:SW] Installed/updated. Defaults set:', Object.keys(toSet));
  } catch (err) {
    console.error('[ClaudeExt:SW] onInstalled error:', err);
  }
});

// ── Alarm Handler ────────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_POLL_USAGE) {
    await pollUsageEndpoint();
  }
});

// ── Message Router ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Validate structure
  if (!message || typeof message.type !== 'string') return false;
  if (!ALLOWED_MESSAGE_TYPES.has(message.type)) return false;
  // Only accept messages from our extension's content scripts
  if (!sender.tab) return false;

  const payload = message.payload ?? {};

  switch (message.type) {
    case 'SSE_MESSAGE_START':
      handleSSEMessageStart(payload).catch(console.error);
      break;

    case 'SSE_MESSAGE_DELTA':
      handleSSEMessageDelta(payload).catch(console.error);
      break;

    case 'SSE_STREAM_END':
      handleSSEStreamEnd().catch(console.error);
      break;

    case 'SEND_INTERCEPT':
      handleSendIntercept(payload).catch(console.error);
      break;

    case 'GET_STATE':
      // Async response — return true to keep channel open
      handleGetState(payload, sendResponse);
      return true;

    case 'UPDATE_SETTING':
      handleUpdateSetting(payload).catch(console.error);
      break;
  }

  return false; // synchronous cases
});

// ── SSE Handlers ─────────────────────────────────────────────────────────────

/** Deduplicate: track the last seen message ID to avoid double-counting. */
let _lastProcessedMessageId = null;

async function handleSSEMessageStart(payload) {
  const { messageId, model, usage } = payload;

  // Deduplicate by message ID (SSE retry may re-send message_start)
  if (messageId && messageId === _lastProcessedMessageId) {
    return;
  }
  _lastProcessedMessageId = messageId || null;

  try {
    const result = await chrome.storage.local.get(['tokenCount']);
    if (chrome.runtime.lastError) throw new Error(chrome.runtime.lastError.message);

    const tc = result.tokenCount || { ...StorageDefaults.tokenCount };
    tc.session = (tc.session || 0) + (usage?.input_tokens ?? 0);
    tc.weekly = (tc.weekly || 0) + (usage?.input_tokens ?? 0);
    tc.lastUpdated = Date.now();

    const updates = { tokenCount: tc, streamingActive: true };
    if (model) updates.currentModel = model;

    await chrome.storage.local.set(updates);
    if (chrome.runtime.lastError) throw new Error(chrome.runtime.lastError.message);

    console.debug('[ClaudeExt:SW] message_start — model:', model, '| input_tokens:', usage?.input_tokens);
  } catch (err) {
    console.error('[ClaudeExt:SW] handleSSEMessageStart error:', err);
  }
}

async function handleSSEMessageDelta(payload) {
  const outputTokens = payload?.usage?.output_tokens ?? 0;
  if (outputTokens === 0) return;

  try {
    const result = await chrome.storage.local.get(['tokenCount']);
    if (chrome.runtime.lastError) throw new Error(chrome.runtime.lastError.message);

    const tc = result.tokenCount || { ...StorageDefaults.tokenCount };
    tc.session = (tc.session || 0) + outputTokens;
    tc.weekly = (tc.weekly || 0) + outputTokens;
    tc.lastUpdated = Date.now();

    await chrome.storage.local.set({ tokenCount: tc });
    if (chrome.runtime.lastError) throw new Error(chrome.runtime.lastError.message);
  } catch (err) {
    console.error('[ClaudeExt:SW] handleSSEMessageDelta error:', err);
  }
}

async function handleSSEStreamEnd() {
  _lastProcessedMessageId = null;
  try {
    await chrome.storage.local.set({ streamingActive: false });
    if (chrome.runtime.lastError) throw new Error(chrome.runtime.lastError.message);
    console.debug('[ClaudeExt:SW] stream ended');
  } catch (err) {
    console.error('[ClaudeExt:SW] handleSSEStreamEnd error:', err);
  }
}

// ── Send Intercept Handler ───────────────────────────────────────────────────

async function handleSendIntercept(payload) {
  // Log or act on the fact that a message was sent
  // (e.g., mark instructionsPrependedThisChat)
  try {
    if (payload.instructionsPrepended) {
      await chrome.storage.local.set({ instructionsPrependedThisChat: true });
      if (chrome.runtime.lastError) throw new Error(chrome.runtime.lastError.message);
    }
  } catch (err) {
    console.error('[ClaudeExt:SW] handleSendIntercept error:', err);
  }
}

// ── Get State Handler ────────────────────────────────────────────────────────

async function handleGetState(payload, sendResponse) {
  const keys = Array.isArray(payload.keys) ? payload.keys : Object.keys(StorageDefaults);
  try {
    const result = await chrome.storage.local.get(keys);
    if (chrome.runtime.lastError) {
      sendResponse({ error: chrome.runtime.lastError.message });
      return;
    }
    sendResponse({ data: result });
  } catch (err) {
    console.error('[ClaudeExt:SW] handleGetState error:', err);
    sendResponse({ error: err.message });
  }
}

// ── Update Setting Handler ───────────────────────────────────────────────────

async function handleUpdateSetting(payload) {
  if (!payload.key || typeof payload.key !== 'string') return;
  // Security: only allow known keys
  if (!(payload.key in StorageDefaults)) {
    console.warn('[ClaudeExt:SW] Unknown setting key:', payload.key);
    return;
  }
  try {
    await chrome.storage.local.set({ [payload.key]: payload.value });
    if (chrome.runtime.lastError) throw new Error(chrome.runtime.lastError.message);
  } catch (err) {
    console.error('[ClaudeExt:SW] handleUpdateSetting error:', err);
  }
}

// ── Usage Endpoint Polling ───────────────────────────────────────────────────

async function pollUsageEndpoint() {
  try {
    const resp = await fetch(USAGE_URL, {
      credentials: 'include',
      headers: { 'Accept': 'application/json' },
    });

    if (!resp.ok) {
      // 429 = rate limited, 401 = not logged in — both are expected
      console.warn('[ClaudeExt:SW] /usage response:', resp.status);
      return;
    }

    const data = await resp.json();

    // Normalise — field names may vary; use best guesses + fallbacks
    const limits = {
      daily_limit:     data.daily_limit      ?? data.message_limit?.day   ?? 0,
      used_today:      data.used_today        ?? data.messages_today       ?? 0,
      weekly_limit:    data.weekly_limit      ?? data.message_limit?.week  ?? 0,
      used_this_week:  data.used_this_week    ?? data.messages_this_week   ?? 0,
      last_fetch_time: Date.now(),
    };

    const resets = {
      session: data.reset_at       ? new Date(data.reset_at).getTime()       : 0,
      weekly:  data.weekly_reset_at ? new Date(data.weekly_reset_at).getTime() : 0,
    };

    await chrome.storage.local.set({ usageLimits: limits, resetTimestamps: resets });
    if (chrome.runtime.lastError) throw new Error(chrome.runtime.lastError.message);

    console.debug('[ClaudeExt:SW] Usage updated:', limits);
  } catch (err) {
    // Non-fatal — extension works without /usage data
    console.warn('[ClaudeExt:SW] pollUsageEndpoint failed:', err.message);
  }
}
