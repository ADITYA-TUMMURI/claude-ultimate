/**
 * ui/banner.js
 * Phase 3: Warning Banner + Model Badge Overlay + Reset Countdown
 *
 * Loaded as the last content script. Depends on:
 *   - lib/storage.js  (Storage global)
 *   - lib/timer.js    (CountdownTimer global)
 *   - content.js      (defines checkWarningThresholds / restartCountdown stubs)
 *
 * Responsibilities:
 *   1. Warning banner — yellow at ≥80% daily usage, red at ≥95%
 *      Dismissible per-session (stored in dismissedWarnings.sessionWarn)
 *   2. Model badge — fixed overlay top-right, always shows current model
 *   3. Reset countdown — two lines in sidebar: "Session: 2h 15m", "Weekly: 3d 4h"
 *      Powered by CountdownTimer, wired to resetTimestamps from storage
 *
 * Overrides the stub functions in content.js by re-assigning them on the
 * window object so content.js's storage.onChange calls the real implementations.
 */

'use strict';

// ── Module state ──────────────────────────────────────────────────────────────

const BannerState = {
  sessionPct:      0,      // % of daily limit used this session
  dismissed80:     false,  // yellow banner dismissed this session
  dismissed95:     false,  // red banner dismissed this session
  currentModel:    '',
  sessionTimerId:  null,   // CountdownTimer ID for session reset
  weeklyTimerId:   null,   // CountdownTimer ID for weekly reset
};

// ── Threshold constants ────────────────────────────────────────────────────────

const WARN_YELLOW = 80;  // %
const WARN_RED    = 95;  // %

// ── 1. Warning Banner ─────────────────────────────────────────────────────────

function getBanner() {
  return document.getElementById('cext-warning-banner');
}

function createBanner(level) {
  // Remove any existing banner first
  removeBanner();

  const banner = document.createElement('div');
  banner.id = 'cext-warning-banner';
  banner.setAttribute('role', 'alert');
  banner.setAttribute('aria-live', 'polite');

  const icon = level === 'red' ? '🔴' : '⚠️';
  const pctStr = BannerState.sessionPct.toFixed(1);

  // Text node — never use innerHTML with dynamic data
  const msg = document.createElement('span');
  msg.className = 'cext-banner-msg';
  msg.textContent = level === 'red'
    ? `${icon}  Critical: ${pctStr}% of daily token limit reached. Claude may stop responding soon.`
    : `${icon}  Warning: ${pctStr}% of daily token limit used. Approaching your limit.`;

  const dismiss = document.createElement('button');
  dismiss.id = 'cext-dismiss-banner';
  dismiss.setAttribute('aria-label', 'Dismiss warning');
  dismiss.textContent = '×';
  dismiss.addEventListener('click', async () => {
    removeBanner();
    BannerState.dismissed80 = true;
    if (level === 'red') BannerState.dismissed95 = true;
    try {
      const dw = await Storage.get('dismissedWarnings') || {};
      dw.sessionWarn = true;
      if (level === 'red') dw.weeklyWarn = true;
      await Storage.set('dismissedWarnings', dw);
    } catch (err) {
      console.warn('[ClaudeExt:Banner] dismiss storage error:', err);
    }
  });

  banner.appendChild(msg);
  banner.appendChild(dismiss);

  // Set level class after building
  banner.className = level === 'red'
    ? 'cext-banner cext-banner-red'
    : 'cext-banner cext-banner-yellow';

  // Insert before <body>'s first child so it's above page content
  document.body.insertBefore(banner, document.body.firstChild);
  return banner;
}

function removeBanner() {
  const b = getBanner();
  if (b) b.remove();
}

/**
 * Check current usage percentages and show/update/hide the banner.
 * Called by storage.onChange for both tokenCount and usageLimits.
 */
async function checkWarningThresholdsFull() {
  try {
    // Load fresh dismissal state
    const dw = await Storage.get('dismissedWarnings') || {};
    BannerState.dismissed80 = dw.sessionWarn  === true;
    BannerState.dismissed95 = dw.weeklyWarn   === true;

    const data = await Storage.getMultiple(['tokenCount', 'usageLimits']);
    const tc = data.tokenCount;
    const ul = data.usageLimits;

    if (!tc || !ul || !ul.daily_limit) {
      // No limit data yet — hide any stale banner
      removeBanner();
      return;
    }

    const pct = (tc.session / ul.daily_limit) * 100;
    BannerState.sessionPct = pct;

    const existing = getBanner();

    if (pct >= WARN_RED) {
      if (BannerState.dismissed95) {
        removeBanner();
        return;
      }
      // Show red if not already showing red
      if (!existing || !existing.classList.contains('cext-banner-red')) {
        createBanner('red');
      }
    } else if (pct >= WARN_YELLOW) {
      if (BannerState.dismissed80) {
        removeBanner();
        return;
      }
      // Show yellow if not already showing any banner
      if (!existing) {
        createBanner('yellow');
      }
    } else {
      // Under threshold — remove if present
      removeBanner();
    }
  } catch (err) {
    console.warn('[ClaudeExt:Banner] checkWarningThresholds error:', err);
  }
}

// ── 2. Model Badge Overlay ────────────────────────────────────────────────────

function initModelBadgeOverlay() {
  if (document.getElementById('cext-model-overlay')) return;

  const overlay = document.createElement('div');
  overlay.id = 'cext-model-overlay';
  overlay.setAttribute('aria-label', 'Current Claude model');
  overlay.title = 'Current model — updated on each message';

  const dot = document.createElement('span');
  dot.className = 'cext-model-dot';
  dot.id = 'cext-model-dot';

  const label = document.createElement('span');
  label.className = 'cext-model-label';
  label.id = 'cext-model-label';
  label.textContent = '—';

  overlay.appendChild(dot);
  overlay.appendChild(label);
  document.body.appendChild(overlay);
}

function updateModelOverlay(model) {
  const label = document.getElementById('cext-model-label');
  const dot   = document.getElementById('cext-model-dot');
  if (!label) return;

  BannerState.currentModel = model || '';

  if (!model) {
    label.textContent = '—';
    if (dot) dot.className = 'cext-model-dot';
    return;
  }

  // Display: strip date suffix (20241022), abbreviate "claude-" prefix
  let display = model
    .replace(/-\d{8}$/, '')          // remove date stamps like -20241022
    .replace(/^claude-/, '');         // remove "claude-" prefix for brevity

  label.textContent = display;
  label.title = model; // full name on hover
  if (dot) dot.className = 'cext-model-dot cext-model-dot-active';
}

// ── 3. Reset Countdown ────────────────────────────────────────────────────────

function restartCountdownFull(timestamps) {
  if (!timestamps) return;

  // Stop any existing timers
  CountdownTimer.stop(BannerState.sessionTimerId);
  CountdownTimer.stop(BannerState.weeklyTimerId);
  BannerState.sessionTimerId = null;
  BannerState.weeklyTimerId  = null;

  const sessionEl = document.getElementById('cext-countdown-session');
  const weeklyEl  = document.getElementById('cext-countdown-weekly');

  // Session reset countdown
  if (timestamps.session && timestamps.session > Date.now()) {
    BannerState.sessionTimerId = CountdownTimer.start(
      timestamps.session,
      (formatted, remaining) => {
        if (sessionEl) {
          sessionEl.textContent = `Session resets: ${formatted}`;
          sessionEl.classList.toggle('cext-countdown-urgent', remaining < 3600_000);
        }
      }
    );
  } else if (sessionEl) {
    sessionEl.textContent = 'Session reset: —';
  }

  // Weekly reset countdown
  if (timestamps.weekly && timestamps.weekly > Date.now()) {
    BannerState.weeklyTimerId = CountdownTimer.start(
      timestamps.weekly,
      (formatted, remaining) => {
        if (weeklyEl) {
          weeklyEl.textContent = `Weekly resets: ${formatted}`;
          weeklyEl.classList.toggle('cext-countdown-urgent', remaining < 3600_000);
        }
      }
    );
  } else if (weeklyEl) {
    weeklyEl.textContent = 'Weekly reset: —';
  }
}

// ── 4. Storage Wiring ─────────────────────────────────────────────────────────

Storage.onChange((changes) => {
  // Re-check banner thresholds when token counts or limits change
  if (changes.tokenCount || changes.usageLimits) {
    checkWarningThresholdsFull();
  }

  // Update model overlay
  if (changes.currentModel) {
    updateModelOverlay(changes.currentModel.newValue);
  }

  // Re-wire countdown if timestamps update
  if (changes.resetTimestamps) {
    restartCountdownFull(changes.resetTimestamps.newValue);
  }

  // If dismissed warnings are cleared externally (e.g., new session), re-check
  if (changes.dismissedWarnings) {
    const dw = changes.dismissedWarnings.newValue || {};
    BannerState.dismissed80 = dw.sessionWarn === true;
    BannerState.dismissed95 = dw.weeklyWarn  === true;
    checkWarningThresholdsFull();
  }

  // Also update the sidebar model badge (redundant safety for sidebar.js)
  if (changes.currentModel) {
    const badge = document.getElementById('cext-model-badge');
    if (badge) badge.textContent = changes.currentModel.newValue || '—';
  }
});

// ── 5. New chat → reset dismissals ────────────────────────────────────────────

Storage.onChange((changes) => {
  if (changes.currentConversationId) {
    // New chat detected — clear dismissed state for session warn
    BannerState.dismissed80 = false;
    BannerState.dismissed95 = false;
    Storage.get('dismissedWarnings').then(dw => {
      const updated = { ...(dw || {}), sessionWarn: false };
      Storage.set('dismissedWarnings', updated);
    }).catch(() => {});
    // Re-check whether banner should reappear
    checkWarningThresholdsFull();
  }
});

// ── 6. Initialise ─────────────────────────────────────────────────────────────

async function initBannerModule() {
  try {
    initModelBadgeOverlay();

    // Load initial state
    const data = await Storage.getMultiple([
      'tokenCount',
      'usageLimits',
      'currentModel',
      'resetTimestamps',
      'dismissedWarnings',
    ]);

    // Restore dismissal state
    const dw = data.dismissedWarnings || {};
    BannerState.dismissed80 = dw.sessionWarn === true;
    BannerState.dismissed95 = dw.weeklyWarn  === true;

    // Model overlay
    updateModelOverlay(data.currentModel || '');

    // Threshold check
    await checkWarningThresholdsFull();

    // Countdown
    if (data.resetTimestamps) {
      restartCountdownFull(data.resetTimestamps);
    }

    console.debug('[ClaudeExt:Banner] Initialised — session%:', BannerState.sessionPct.toFixed(1));
  } catch (err) {
    console.error('[ClaudeExt:Banner] init error:', err);
  }
}

// ── 7. Expose overrides for content.js stubs ──────────────────────────────────
// content.js calls these by name on the window; overriding here means
// future storage.onChange callbacks in content.js route to the real impl.

window._cextCheckWarningThresholds = checkWarningThresholdsFull;
window._cextRestartCountdown       = restartCountdownFull;

// ── Boot ──────────────────────────────────────────────────────────────────────

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initBannerModule);
} else {
  initBannerModule();
}
