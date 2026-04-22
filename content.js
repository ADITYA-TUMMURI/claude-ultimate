/**
 * content.js
 * Runs in ISOLATED world on https://claude.ai/*
 * (lib/storage.js is loaded before this file via content_scripts order)
 *
 * Responsibilities:
 *  - Bridge: validate + forward postMessages from MAIN-world injected script → SW
 *  - DOM: detect new chat via URL / pushState changes
 *  - DOM: intercept send button
 *  - UI: initialise sidebar, banner, model badge, countdown
 *  - Reactivity: chrome.storage.onChanged → re-render UI
 */

'use strict';

// ── Constants ────────────────────────────────────────────────────────────────

const ALLOWED_ORIGIN = 'https://claude.ai';
const SOURCE_TAG = 'CLAUDE_EXT';

const ALLOWED_RELAY_TYPES = new Set([
  'SSE_MESSAGE_START',
  'SSE_MESSAGE_DELTA',
  'SSE_STREAM_END',
]);

// ── 1. postMessage Bridge ────────────────────────────────────────────────────

window.addEventListener('message', (event) => {
  // Security: strict origin + source checks
  if (event.origin !== ALLOWED_ORIGIN) return;
  if (!event.data || event.data.source !== SOURCE_TAG) return;
  if (!ALLOWED_RELAY_TYPES.has(event.data.type)) return;

  try {
    chrome.runtime.sendMessage({
      type: event.data.type,
      payload: event.data.payload ?? {},
    }, (response) => {
      // Suppress "no listener" errors during SW sleep/wake
      if (chrome.runtime.lastError) { /* expected */ }
    });
  } catch (err) {
    // Extension context invalidated (e.g., extension reloaded mid-session)
    console.warn('[ClaudeExt:Content] sendMessage error:', err.message);
  }
});

// ── 2. Storage Change → UI Updates ──────────────────────────────────────────

Storage.onChange((changes) => {
  if (changes.tokenCount)          updateTokenUI(changes.tokenCount.newValue);
  if (changes.usageLimits)         updateUsageBars(changes.usageLimits.newValue);
  if (changes.currentModel)        updateModelBadge(changes.currentModel.newValue);
  if (changes.resetTimestamps)     restartCountdown(changes.resetTimestamps.newValue);
  if (changes.tokenCount || changes.usageLimits) checkWarningThresholds();
});

// ── 3. URL / New Chat Detection ──────────────────────────────────────────────

function extractConversationId(pathname) {
  const match = pathname.match(/\/chat\/([a-f0-9-]{8,})/i);
  return match ? match[1] : null;
}

async function onRouteChange() {
  const convId = extractConversationId(location.pathname);

  try {
    const stored = await Storage.get('currentConversationId');
    if (convId !== stored) {
      await Storage.setMultiple({
        currentConversationId: convId || '',
        instructionsPrependedThisChat: false,
      });
    }
  } catch (_) {
    // silent — don't block UI on storage error
  }
}

// Override pushState to catch SPA navigation
(function patchHistory() {
  const origPushState = history.pushState.bind(history);
  const origReplaceState = history.replaceState.bind(history);

  history.pushState = function (...args) {
    origPushState(...args);
    onRouteChange();
  };
  history.replaceState = function (...args) {
    origReplaceState(...args);
    onRouteChange();
  };
  window.addEventListener('popstate', onRouteChange);
})();

// ── 4. Send Button Intercept ─────────────────────────────────────────────────

let _sendInterceptObserver = null;

function initSendIntercept() {
  if (_sendInterceptObserver) return;

  _sendInterceptObserver = new MutationObserver(() => {
    const sendBtn = findSendButton();
    if (!sendBtn || sendBtn.dataset.extIntercepted) return;
    sendBtn.dataset.extIntercepted = 'true';

    sendBtn.addEventListener('click', handleSendClick, true); // capture phase
  });

  _sendInterceptObserver.observe(document.body, { childList: true, subtree: true });
}

function findSendButton() {
  const selectors = [
    'button[aria-label="Send Message"]',
    'button[aria-label="Send"]',
    'button[data-testid="send-button"]',
    'button[type="submit"]',
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

async function handleSendClick(event) {
  // Guard: only intercept real send clicks, not our own re-fired synthetic click
  if (event._cextProcessed) return;

  const textarea = findComposebox();
  if (!textarea) return;

  const original = getComposboxText(textarea);
  if (!original.trim()) return;

  try {
    const settings = await Storage.getMultiple([
      'customInstructions',
      'customInstructionsEnabled',
      'instructionsPrependedThisChat',
      'selectedMode',
      'modePresets',
      'responseLengthMode',
      'responseLengthModes',
      'trimmerEnabled',
    ]);

    // Respect the popup enable/disable toggle
    if (settings.customInstructionsEnabled === false) {
      settings.customInstructions = '';
    }

    const { text: processed, prepended } = MessageProcessor.processMessage(original, settings);

    if (processed !== original) {
      event.preventDefault();
      event.stopImmediatePropagation();

      setComposerText(textarea, processed);

      // Persist that custom instructions were prepended this chat
      if (prepended) {
        await Storage.set('instructionsPrependedThisChat', true);
        try {
          chrome.runtime.sendMessage(
            { type: 'SEND_INTERCEPT', payload: { instructionsPrepended: true } },
            () => { if (chrome.runtime.lastError) {} }
          );
        } catch (_) {}
      }

      // Re-fire click with guard flag so we don't intercept our own event
      setTimeout(() => {
        const btn = findSendButton();
        if (!btn) return;
        const syntheticClick = new MouseEvent('click', { bubbles: true, cancelable: true });
        syntheticClick._cextProcessed = true;
        btn.dispatchEvent(syntheticClick);
      }, 50);
    }
    // If processed === original, fall through — browser handles the click normally
  } catch (_) {
    // On error: do not block send — let the event propagate
  }
}

function findComposebox() {
  const selectors = [
    '[contenteditable="true"][class*="ProseMirror"]',
    '[contenteditable="true"]',
    'textarea[placeholder]',
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function getComposboxText(el) {
  return el.contentEditable === 'true' ? (el.innerText || '') : (el.value || '');
}

function setComposerText(el, text) {
  if (el.contentEditable === 'true') {
    el.innerText = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    )?.set;
    if (nativeInputValueSetter) nativeInputValueSetter.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

// ── 5. Message Processor ─────────────────────────────────────────────────────
// Phase 4: delegates to lib/message-processor.js (MessageProcessor global).
// Fallback inline implementation keeps the extension working if message-processor.js
// somehow fails to load.

function processMessage(text, settings) {
  if (typeof MessageProcessor !== 'undefined') {
    return MessageProcessor.processMessage(text, settings);
  }
  // Fallback: passthrough
  return { text, prepended: false };
}

function trimPrompt(text) {
  const fillerRegex = /\b(like|uhh|umm|hmm|basically|actually|literally|you know|i mean|sort of|kind of)\b/gi;
  return text
    .replace(fillerRegex, '')                    // strip filler
    .replace(/([!?.])\1+/g, '$1')               // !!! → !
    .replace(/\b(\w+)(\s+\1)+\b/gi, '$1')       // duplicate words
    .replace(/[ \t]{2,}/g, ' ')                  // collapse spaces
    .replace(/\n{3,}/g, '\n\n')                  // collapse blank lines
    .trim();
}

// ── 6. UI Skeleton ───────────────────────────────────────────────────────────
// Full UI built in Phase 2 (sidebar.js) and Phase 3 (banner.js).
// Here we define the stub functions content.js calls so later
// phases can override them without changing this file.

let _countdownRaf = null;

function updateTokenUI(tokenCount) {
  const el = document.getElementById('cext-session-count');
  if (el && tokenCount) el.textContent = (tokenCount.session || 0).toLocaleString();
}

function updateUsageBars(limits) {
  const sessionBar = document.getElementById('cext-session-bar');
  if (sessionBar && limits?.daily_limit) {
    sessionBar.value = Math.min(100, (limits.used_today / limits.daily_limit) * 100);
  }
  const weeklyBar = document.getElementById('cext-weekly-bar');
  if (weeklyBar && limits?.weekly_limit) {
    weeklyBar.value = Math.min(100, (limits.used_this_week / limits.weekly_limit) * 100);
  }
}

function updateModelBadge(model) {
  const el = document.getElementById('cext-model-badge');
  if (el && model) el.textContent = model;
}

function checkWarningThresholds() {
  // Delegates to Phase 3 banner.js implementation (set after that script loads)
  if (typeof window._cextCheckWarningThresholds === 'function') {
    window._cextCheckWarningThresholds();
  }
}

function restartCountdown(timestamps) {
  // Delegates to Phase 3 banner.js implementation (set after that script loads)
  if (typeof window._cextRestartCountdown === 'function') {
    window._cextRestartCountdown(timestamps);
  }
}

// ── 7. Sidebar Bootstrap ─────────────────────────────────────────────────────

function initSidebar() {
  if (document.getElementById('cext-sidebar')) return;

  const sidebar = document.createElement('div');
  sidebar.id = 'cext-sidebar';
  sidebar.setAttribute('aria-label', 'Claude Ultimate Panel');
  sidebar.innerHTML = `
    <div class="cext-panel">
      <div class="cext-header">
        <span class="cext-logo">⚡ Claude Ultimate</span>
        <button class="cext-collapse" id="cext-collapse-btn" aria-label="Collapse panel">−</button>
      </div>
      <div class="cext-body" id="cext-panel-body">
        <!-- Token Usage -->
        <section class="cext-section">
          <h4 class="cext-section-title">Token Usage</h4>
          <div class="cext-stat-row">
            <span class="cext-label">Session</span>
            <span class="cext-count" id="cext-session-count">0</span>
          </div>
          <progress class="cext-progress" id="cext-session-bar" value="0" max="100"></progress>
          <div class="cext-stat-row">
            <span class="cext-label">Weekly</span>
            <span class="cext-count" id="cext-weekly-count">0</span>
          </div>
          <progress class="cext-progress" id="cext-weekly-bar" value="0" max="100"></progress>
        </section>

        <!-- Model -->
        <section class="cext-section">
          <div class="cext-stat-row">
            <span class="cext-label">Model</span>
            <span class="cext-badge" id="cext-model-badge">—</span>
          </div>
        </section>

        <!-- Countdown -->
        <section class="cext-section" id="cext-countdown-section">
          <h4 class="cext-section-title">Resets</h4>
          <div id="cext-countdown-session" class="cext-countdown">Session: —</div>
          <div id="cext-countdown-weekly" class="cext-countdown">Weekly: —</div>
        </section>

        <!-- Actions placeholder (populated in later phases) -->
        <section class="cext-section cext-actions" id="cext-actions">
        </section>
      </div>
    </div>
  `;

  document.body.appendChild(sidebar);

  // Collapse toggle
  document.getElementById('cext-collapse-btn').addEventListener('click', () => {
    const body = document.getElementById('cext-panel-body');
    const btn = document.getElementById('cext-collapse-btn');
    if (body.style.display === 'none') {
      body.style.display = '';
      btn.textContent = '−';
    } else {
      body.style.display = 'none';
      btn.textContent = '+';
    }
  });
}

// ── 8. Init ──────────────────────────────────────────────────────────────────

async function init() {
  try {
    initSidebar();
    initSendIntercept();
    await onRouteChange();

    // Populate initial UI from storage
    const data = await Storage.getMultiple([
      'tokenCount', 'usageLimits', 'currentModel', 'resetTimestamps'
    ]);
    if (data.tokenCount)      updateTokenUI(data.tokenCount);
    if (data.usageLimits)     updateUsageBars(data.usageLimits);
    if (data.currentModel)    updateModelBadge(data.currentModel);
    if (data.resetTimestamps) restartCountdown(data.resetTimestamps);
  } catch (err) {
    console.error('[ClaudeExt:Content] init error:', err);
  }
}

// Wait for DOM to be ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
