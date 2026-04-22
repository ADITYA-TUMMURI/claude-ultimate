/**
 * ui/sidebar.js
 * Self-contained sidebar module for Claude Ultimate.
 * Loaded as a content script after lib/storage.js and content.js.
 *
 * Enhances the sidebar skeleton injected by content.js with:
 *  - Rich token counter display (session + weekly with formatted numbers)
 *  - Animated progress bars (session % of daily limit, weekly % of weekly limit)
 *  - Model badge
 *  - Per-message delta display ("+ 1,234 tokens")
 *  - Streaming indicator (pulsing dot during active SSE)
 *  - Reset countdown (implemented in Phase 3; stubs here)
 *
 * Design contract:
 *  - Never uses innerHTML with user/external data (only static template strings)
 *  - All DOM updates go through dedicated render functions
 *  - Subscribes to chrome.storage.onChanged — never polls
 */

'use strict';

// ── Module state (ephemeral — never stored) ───────────────────────────────────

const SidebarState = {
  sessionTokens:  0,
  weeklyTokens:   0,
  dailyLimit:     0,
  weeklyLimit:    0,
  model:          '',
  streaming:      false,
  lastDelta:      0,         // tokens added in most recent message
  deltaTimer:     null,      // timeout to fade out delta display
};

// ── DOM element refs (populated by initSidebarModule) ────────────────────────

const El = {};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n) {
  return Number.isFinite(n) ? n.toLocaleString() : '0';
}

function pct(value, max) {
  if (!max || max <= 0) return 0;
  return Math.min(100, Math.max(0, (value / max) * 100));
}

function hslForPct(p) {
  // Green (120°) → Yellow (60°) → Red (0°)
  const hue = Math.max(0, 120 - p * 1.2);
  return `hsl(${hue}, 85%, 55%)`;
}

// ── Core render functions ─────────────────────────────────────────────────────

function renderSessionBar() {
  if (!El.sessionBar) return;
  const p = pct(SidebarState.sessionTokens, SidebarState.dailyLimit);
  El.sessionBar.value = p;
  El.sessionBar.style.setProperty('--bar-color', hslForPct(p));
  El.sessionBarPct.textContent = SidebarState.dailyLimit > 0
    ? `${p.toFixed(1)}%`
    : '';
}

function renderWeeklyBar() {
  if (!El.weeklyBar) return;
  const p = pct(SidebarState.weeklyTokens, SidebarState.weeklyLimit);
  El.weeklyBar.value = p;
  El.weeklyBar.style.setProperty('--bar-color', hslForPct(p));
  El.weeklyBarPct.textContent = SidebarState.weeklyLimit > 0
    ? `${p.toFixed(1)}%`
    : '';
}

function renderCounts() {
  if (El.sessionCount) {
    El.sessionCount.textContent = fmt(SidebarState.sessionTokens);
  }
  if (El.weeklyCount) {
    El.weeklyCount.textContent = fmt(SidebarState.weeklyTokens);
  }
  if (El.dailyLimitLabel) {
    El.dailyLimitLabel.textContent = SidebarState.dailyLimit > 0
      ? `/ ${fmt(SidebarState.dailyLimit)}`
      : '';
  }
  if (El.weeklyLimitLabel) {
    El.weeklyLimitLabel.textContent = SidebarState.weeklyLimit > 0
      ? `/ ${fmt(SidebarState.weeklyLimit)}`
      : '';
  }
}

function renderModel() {
  if (!El.modelBadge) return;
  const model = SidebarState.model;
  El.modelBadge.textContent = model || '—';
  El.modelBadge.title = model || 'Unknown model';

  // Abbreviate long model names for badge display
  if (model && model.length > 20) {
    El.modelBadge.textContent = model.replace('claude-', '').replace(/-\d{8}$/, '');
  }
}

function renderStreamingDot() {
  if (!El.streamDot) return;
  El.streamDot.classList.toggle('cext-streaming', SidebarState.streaming);
}

function renderDelta() {
  if (!El.deltaDisplay) return;
  if (SidebarState.lastDelta > 0) {
    El.deltaDisplay.textContent = `+${fmt(SidebarState.lastDelta)}`;
    El.deltaDisplay.classList.add('cext-delta-visible');

    clearTimeout(SidebarState.deltaTimer);
    SidebarState.deltaTimer = setTimeout(() => {
      if (El.deltaDisplay) {
        El.deltaDisplay.classList.remove('cext-delta-visible');
      }
    }, 3000);
  }
}

function renderAll() {
  renderCounts();
  renderSessionBar();
  renderWeeklyBar();
  renderModel();
  renderStreamingDot();
}

// ── Data update handlers (called by storage.onChanged + init) ─────────────────

function applyTokenCount(tc) {
  if (!tc) return;
  const prevSession = SidebarState.sessionTokens;
  SidebarState.sessionTokens = tc.session ?? 0;
  SidebarState.weeklyTokens  = tc.weekly  ?? 0;

  // Calculate per-render delta
  const delta = SidebarState.sessionTokens - prevSession;
  if (delta > 0) {
    SidebarState.lastDelta = delta;
    renderDelta();
  }

  renderCounts();
  renderSessionBar();
  renderWeeklyBar();
}

function applyUsageLimits(ul) {
  if (!ul) return;
  SidebarState.dailyLimit  = ul.daily_limit   ?? 0;
  SidebarState.weeklyLimit = ul.weekly_limit  ?? 0;

  // Also pull live-usage values if available (from /usage endpoint)
  // These supplement the SSE-derived session count
  renderCounts();
  renderSessionBar();
  renderWeeklyBar();
}

function applyModel(model) {
  if (model == null) return;
  SidebarState.model = model;
  renderModel();
}

function applyStreaming(active) {
  SidebarState.streaming = active;
  renderStreamingDot();
}

// ── Export handler helpers ────────────────────────────────────────────────────

function showSidebarToast(message, durationMs = 2000) {
  let toast = document.getElementById('cext-toast-singleton');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'cext-toast-singleton';
    toast.className = 'cext-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('cext-toast-show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('cext-toast-show'), durationMs);
}

/**
 * Set a button into a temporary feedback state.
 * @param {HTMLButtonElement} btn
 * @param {string} label    - Temporary label text
 * @param {string} cssClass - CSS class to add
 * @param {number} ms       - Duration before restoring
 * @param {string} origLabel
 */
function flashButton(btn, label, cssClass, ms, origLabel) {
  if (!btn) return;
  btn.disabled = true;
  const iconSpan = btn.querySelector('.cext-btn-icon');
  const textSpan = btn.querySelector('span:not(.cext-btn-icon)');
  if (textSpan) textSpan.textContent = label;
  btn.classList.add(cssClass);
  setTimeout(() => {
    btn.disabled = false;
    btn.classList.remove(cssClass);
    if (textSpan) textSpan.textContent = origLabel;
  }, ms);
}

async function handleCopyPassport() {
  const btn = document.getElementById('cext-passport-btn');

  // Guard: check DomScraper and MarkdownConverter are loaded
  if (typeof DomScraper === 'undefined' || typeof MarkdownConverter === 'undefined') {
    showSidebarToast('⚠ Scraper not loaded yet');
    return;
  }

  try {
    const turns = DomScraper.scrapeConversation();

    if (turns.length === 0) {
      showSidebarToast('⚠ No conversation found');
      return;
    }

    const model = SidebarState.model || await Storage.get('currentModel') || 'unknown';
    const conversationId = DomScraper.getConversationId();

    const passport = MarkdownConverter.toPassport(turns, { conversationId, model });

    await navigator.clipboard.writeText(passport);

    flashButton(btn, 'Copied!', 'cext-export-btn--success', 2000, 'Copy Passport');
    showSidebarToast(`📋 Passport copied! (${turns.length} turns)`, 2000);

  } catch (err) {
    console.error('[ClaudeExt:Sidebar] handleCopyPassport error:', err);
    flashButton(btn, 'Error!', 'cext-export-btn--error', 2000, 'Copy Passport');
    showSidebarToast('⚠ Failed to copy passport');
  }
}

async function handleExportMarkdown() {
  const btn = document.getElementById('cext-export-md-btn');

  if (typeof DomScraper === 'undefined' || typeof MarkdownConverter === 'undefined') {
    showSidebarToast('⚠ Scraper not loaded yet');
    return;
  }

  try {
    flashButton(btn, 'Scraping…', '', 8000, 'Export MD');

    const turns = DomScraper.scrapeConversation();

    if (turns.length === 0) {
      flashButton(btn, 'Empty!', 'cext-export-btn--error', 2000, 'Export MD');
      showSidebarToast('⚠ No conversation found');
      return;
    }

    const model = SidebarState.model || await Storage.get('currentModel') || 'unknown';
    const conversationId = DomScraper.getConversationId();

    const markdown = MarkdownConverter.toMarkdown(turns, { conversationId, model });
    const filename  = MarkdownConverter.makeFilename(conversationId);

    MarkdownConverter.downloadAsFile(markdown, filename);

    flashButton(btn, 'Downloading…', 'cext-export-btn--success', 2500, 'Export MD');
    showSidebarToast(`⬇ Downloading: ${filename}`, 2500);

  } catch (err) {
    console.error('[ClaudeExt:Sidebar] handleExportMarkdown error:', err);
    flashButton(btn, 'Error!', 'cext-export-btn--error', 2000, 'Export MD');
    showSidebarToast('⚠ Export failed');
  }
}

// ── DOM construction ──────────────────────────────────────────────────────────

function buildSidebarHTML() {
  // Replace the Phase 1 skeleton entirely with a richer version
  const sidebar = document.getElementById('cext-sidebar');
  if (!sidebar) return;

  // Clear existing content
  sidebar.innerHTML = '';

  const panel = document.createElement('div');
  panel.className = 'cext-panel';

  // Header
  const header = document.createElement('div');
  header.className = 'cext-header';
  header.innerHTML = `
    <div class="cext-header-left">
      <span class="cext-stream-dot" id="cext-stream-dot"></span>
      <span class="cext-logo">⚡ Claude Ultimate</span>
    </div>
    <button class="cext-collapse" id="cext-collapse-btn" aria-label="Toggle panel">−</button>
  `;
  panel.appendChild(header);

  // Body
  const body = document.createElement('div');
  body.className = 'cext-body';
  body.id = 'cext-panel-body';

  // ── Token Usage Section ────────────────────────────────────────────────────
  const tokenSection = document.createElement('section');
  tokenSection.className = 'cext-section';

  const sectionTitle = document.createElement('div');
  sectionTitle.className = 'cext-section-header';
  sectionTitle.innerHTML = `
    <h4 class="cext-section-title">Token Usage</h4>
    <span class="cext-delta" id="cext-delta-display"></span>
  `;
  tokenSection.appendChild(sectionTitle);

  // Session row
  const sessionRow = document.createElement('div');
  sessionRow.className = 'cext-stat-row';
  sessionRow.innerHTML = `
    <span class="cext-label">Session</span>
    <div class="cext-count-group">
      <span class="cext-count" id="cext-session-count">0</span>
      <span class="cext-limit-label" id="cext-daily-limit-label"></span>
    </div>
  `;
  tokenSection.appendChild(sessionRow);

  const sessionBarWrap = document.createElement('div');
  sessionBarWrap.className = 'cext-bar-wrap';
  sessionBarWrap.innerHTML = `
    <progress class="cext-progress cext-progress-session" id="cext-session-bar" value="0" max="100"></progress>
    <span class="cext-bar-pct" id="cext-session-bar-pct"></span>
  `;
  tokenSection.appendChild(sessionBarWrap);

  // Weekly row
  const weeklyRow = document.createElement('div');
  weeklyRow.className = 'cext-stat-row';
  weeklyRow.innerHTML = `
    <span class="cext-label">Weekly</span>
    <div class="cext-count-group">
      <span class="cext-count" id="cext-weekly-count">0</span>
      <span class="cext-limit-label" id="cext-weekly-limit-label"></span>
    </div>
  `;
  tokenSection.appendChild(weeklyRow);

  const weeklyBarWrap = document.createElement('div');
  weeklyBarWrap.className = 'cext-bar-wrap';
  weeklyBarWrap.innerHTML = `
    <progress class="cext-progress cext-progress-weekly" id="cext-weekly-bar" value="0" max="100"></progress>
    <span class="cext-bar-pct" id="cext-weekly-bar-pct"></span>
  `;
  tokenSection.appendChild(weeklyBarWrap);

  body.appendChild(tokenSection);

  // ── Model Section ──────────────────────────────────────────────────────────
  const modelSection = document.createElement('section');
  modelSection.className = 'cext-section';
  modelSection.innerHTML = `
    <div class="cext-stat-row">
      <span class="cext-label">Model</span>
      <span class="cext-badge" id="cext-model-badge">—</span>
    </div>
  `;
  body.appendChild(modelSection);

  // ── Reset Countdown Section (stub — Phase 3 fills in) ─────────────────────
  const countdownSection = document.createElement('section');
  countdownSection.className = 'cext-section';
  countdownSection.id = 'cext-countdown-section';
  countdownSection.innerHTML = `
    <h4 class="cext-section-title">Resets</h4>
    <div class="cext-countdown" id="cext-countdown-session">Session: —</div>
    <div class="cext-countdown" id="cext-countdown-weekly">Weekly: —</div>
  `;
  body.appendChild(countdownSection);

  // ── Actions Slot (later phases add buttons here) ───────────────────────────
  const actionsSection = document.createElement('section');
  actionsSection.className = 'cext-section cext-actions';
  actionsSection.id = 'cext-actions';
  body.appendChild(actionsSection);

  // ── Reset session button ───────────────────────────────────────────────────
  const resetBtn = document.createElement('button');
  resetBtn.className = 'cext-btn cext-btn-subtle';
  resetBtn.id = 'cext-reset-session-btn';
  resetBtn.textContent = '↺ Reset session count';
  resetBtn.title = 'Clear the session token counter';
  resetBtn.addEventListener('click', async () => {
    try {
      const tc = await Storage.get('tokenCount') || { session: 0, weekly: 0, lastUpdated: 0 };
      tc.session = 0;
      tc.lastUpdated = Date.now();
      await Storage.set('tokenCount', tc);
      SidebarState.sessionTokens = 0;
      SidebarState.lastDelta = 0;
      renderAll();
    } catch (err) {
      console.warn('[ClaudeExt:Sidebar] reset error:', err);
    }
  });
  actionsSection.appendChild(resetBtn);

  // ── Export Divider ─────────────────────────────────────────────────────────
  const exportDivider = document.createElement('div');
  exportDivider.className = 'cext-divider';
  actionsSection.appendChild(exportDivider);

  const exportTitle = document.createElement('div');
  exportTitle.className = 'cext-control-title';
  exportTitle.textContent = 'Export';
  actionsSection.appendChild(exportTitle);

  // ── Copy Context Passport button ───────────────────────────────────────────
  const passportBtn = document.createElement('button');
  passportBtn.className = 'cext-btn cext-export-btn';
  passportBtn.id = 'cext-passport-btn';
  passportBtn.innerHTML = '<span class="cext-btn-icon">📋</span><span>Copy Passport</span>';
  passportBtn.title = 'Copy a compact conversation summary to clipboard (Ctrl+Shift+E)';
  passportBtn.addEventListener('click', handleCopyPassport);
  actionsSection.appendChild(passportBtn);

  // ── Export Markdown button ─────────────────────────────────────────────────
  const exportMdBtn = document.createElement('button');
  exportMdBtn.className = 'cext-btn cext-export-btn';
  exportMdBtn.id = 'cext-export-md-btn';
  exportMdBtn.innerHTML = '<span class="cext-btn-icon">⬇</span><span>Export MD</span>';
  exportMdBtn.title = 'Download full conversation as Markdown file (Ctrl+Shift+M)';
  exportMdBtn.addEventListener('click', handleExportMarkdown);
  actionsSection.appendChild(exportMdBtn);

  panel.appendChild(body);
  sidebar.appendChild(panel);

  // Wire collapse button
  const collapseBtn = document.getElementById('cext-collapse-btn');
  const panelBody   = document.getElementById('cext-panel-body');
  if (collapseBtn && panelBody) {
    collapseBtn.addEventListener('click', () => {
      const collapsed = panelBody.style.display === 'none';
      panelBody.style.display = collapsed ? '' : 'none';
      collapseBtn.textContent = collapsed ? '−' : '+';
      collapseBtn.setAttribute('aria-label', collapsed ? 'Collapse panel' : 'Expand panel');
    });
  }
}

function cacheElements() {
  El.sessionCount     = document.getElementById('cext-session-count');
  El.weeklyCount      = document.getElementById('cext-weekly-count');
  El.sessionBar       = document.getElementById('cext-session-bar');
  El.weeklyBar        = document.getElementById('cext-weekly-bar');
  El.sessionBarPct    = document.getElementById('cext-session-bar-pct');
  El.weeklyBarPct     = document.getElementById('cext-weekly-bar-pct');
  El.dailyLimitLabel  = document.getElementById('cext-daily-limit-label');
  El.weeklyLimitLabel = document.getElementById('cext-weekly-limit-label');
  El.modelBadge       = document.getElementById('cext-model-badge');
  El.streamDot        = document.getElementById('cext-stream-dot');
  El.deltaDisplay     = document.getElementById('cext-delta-display');
}

// ── Tracking active stream for the streaming dot ──────────────────────────────

let _streamEndTimer = null;

function markStreamStart() {
  clearTimeout(_streamEndTimer);
  applyStreaming(true);
}

function markStreamEnd() {
  // Brief delay so the dot doesn't flicker off instantly
  _streamEndTimer = setTimeout(() => applyStreaming(false), 800);
}

// ── Public initialiser ────────────────────────────────────────────────────────

async function initSidebarModule() {
  // Ensure the container exists (content.js creates it first, but sidebar.js
  // loads after, so it may already be there — rebuild it with richer DOM)
  if (!document.getElementById('cext-sidebar')) {
    // Container not yet in DOM — create it
    const container = document.createElement('div');
    container.id = 'cext-sidebar';
    container.setAttribute('aria-label', 'Claude Ultimate Panel');
    document.body.appendChild(container);
  }

  buildSidebarHTML();
  cacheElements();

  // ── Load initial state from storage ─────────────────────────────────────
  try {
    const data = await Storage.getMultiple(['tokenCount', 'usageLimits', 'currentModel']);
    applyTokenCount(data.tokenCount);
    applyUsageLimits(data.usageLimits);
    applyModel(data.currentModel);
  } catch (err) {
    console.warn('[ClaudeExt:Sidebar] initial load error:', err);
  }

  renderAll();

  // ── Subscribe to storage changes ─────────────────────────────────────────
  Storage.onChange((changes) => {
    if (changes.tokenCount)  applyTokenCount(changes.tokenCount.newValue);
    if (changes.usageLimits) applyUsageLimits(changes.usageLimits.newValue);
    if (changes.currentModel) applyModel(changes.currentModel.newValue);

    // Streaming dot — triggered by SSE events stored in streamingActive key
    if (changes.streamingActive) {
      if (changes.streamingActive.newValue) markStreamStart();
      else markStreamEnd();
    }
  });

  console.debug('[ClaudeExt:Sidebar] Initialised');

  // ── Expose export handlers for keyboard.js ─────────────────────────────
  window._cextCopyPassport    = handleCopyPassport;
  window._cextExportMarkdown  = handleExportMarkdown;
}

// ── Kick off ──────────────────────────────────────────────────────────────────

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSidebarModule);
} else {
  initSidebarModule();
}
