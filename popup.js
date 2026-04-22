/**
 * popup.js
 * Claude Ultimate — Settings Popup
 *
 * Manages 5 settings tabs:
 *  1. Instructions (custom instructions + trimmer + response length)
 *  2. Modes (edit mode preset instruction strings)
 *  3. Templates (view/add/delete custom prompt templates)
 *  4. Keyboard (view + rebind keyboard shortcuts)
 *  5. Tags (overview of all tagged conversations)
 *
 * Reads/writes chrome.storage.local directly (no Storage wrapper
 * since popup runs in extension context, not content script context).
 */

'use strict';

// ── Default values (mirrors StorageDefaults in lib/storage.js) ────────────────

const DEFAULTS = {
  customInstructions:           '',
  customInstructionsEnabled:    true,
  responseLengthMode:           'medium',
  trimmerEnabled:               true,
  selectedMode:                 null,
  modePresets: {
    caveman:    "Explain like I'm 5 years old. Use simple words.",
    bullet:     'Respond in bullet points only.',
    noPreamble: 'No intro/outro. Just the answer.',
    technical:  'Use technical jargon. Assume expert knowledge.',
    concise:    'Keep it under 2 sentences.',
  },
  promptTemplates: {
    debug:    'Debug this code and explain the issue:\n\n```\n[YOUR CODE]\n```',
    review:   'Review this code for bugs, performance, and best practices:\n\n```\n[CODE]\n```',
    explain:  'Explain [CONCEPT] to a [AUDIENCE].',
    code:     'Write a [LANGUAGE] function that [REQUIREMENT].',
    blog:     'Write a blog post about [TOPIC]:\nTarget audience: [AUDIENCE]\nTone: [TONE]',
    email:    'Draft a professional email:\nTo: [RECIPIENT]\nSubject: [SUBJECT]\nContext: [CONTEXT]',
  },
  keyboardBindings: {
    'Ctrl+Shift+N': 'newChat',
    'Ctrl+Shift+E': 'copyPassport',
    'Ctrl+Shift+M': 'exportMarkdown',
    'Ctrl+Shift+T': 'toggleTrimmer',
    'Ctrl+Shift+1': 'modeShort',
    'Ctrl+Shift+2': 'modeMedium',
    'Ctrl+Shift+3': 'modeDetailed',
    'Ctrl+Shift+P': 'openTemplates',
  },
  tokenCount:   { session: 0, weekly: 0 },
  currentModel: '',
  conversationTags: {},
};

const ACTION_LABELS = {
  newChat:        'New chat',
  copyPassport:   'Copy context passport',
  exportMarkdown: 'Export markdown',
  toggleTrimmer:  'Toggle trimmer',
  modeShort:      'Set length: Short',
  modeMedium:     'Set length: Medium',
  modeDetailed:   'Set length: Detailed',
  openTemplates:  'Open templates',
};

// ── Utility ───────────────────────────────────────────────────────────────────

function fmt(n) {
  return Number.isFinite(n) ? n.toLocaleString() : '0';
}

async function storageGet(keys) {
  try {
    const result = await chrome.storage.local.get(keys);
    if (chrome.runtime.lastError) {
      // Suppress — return defaults
      return {};
    }
    return result || {};
  } catch (_) {
    return {};
  }
}

async function storageSet(obj) {
  try {
    await chrome.storage.local.set(obj);
    if (chrome.runtime.lastError) {
      return false;
    }
    return true;
  } catch (_) {
    return false;
  }
}

function showStatus(el, msg, type = 'ok', ms = 2200) {
  if (!el) return;
  el.textContent = msg;
  el.className = `status-msg ${type}`;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => {
    el.textContent = '';
    el.className = 'status-msg';
  }, ms);
}

// ── Tab navigation ────────────────────────────────────────────────────────────

function initTabs() {
  const tabBtns = document.querySelectorAll('.tab-btn');
  const panels  = document.querySelectorAll('.tab-panel');

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;

      tabBtns.forEach(b => {
        b.classList.toggle('active', b.dataset.tab === target);
        b.setAttribute('aria-selected', String(b.dataset.tab === target));
      });
      panels.forEach(p => {
        p.classList.toggle('active', p.id === `tab-${target}`);
      });
    });
  });
}

// ── Usage strip ───────────────────────────────────────────────────────────────

async function loadUsageStrip() {
  const data = await storageGet(['tokenCount', 'currentModel']);
  const tc    = data.tokenCount   || DEFAULTS.tokenCount;
  const model = data.currentModel || '';

  const stripSession = document.getElementById('strip-session');
  const stripWeekly  = document.getElementById('strip-weekly');
  const stripModel   = document.getElementById('strip-model');

  if (stripSession) stripSession.textContent = fmt(tc.session || 0);
  if (stripWeekly)  stripWeekly.textContent  = fmt(tc.weekly  || 0);
  if (stripModel)   stripModel.textContent   =
    model ? model.replace('claude-', '').replace(/-\d{8}$/, '') : '—';
}

// ── Tab 1: Instructions ───────────────────────────────────────────────────────

async function initInstructionsTab() {
  const elEnabled  = document.getElementById('instr-enabled');
  const elText     = document.getElementById('instr-text');
  const elSave     = document.getElementById('instr-save');
  const elStatus   = document.getElementById('instr-status');
  const elTrimmer  = document.getElementById('trimmer-toggle');

  const data = await storageGet([
    'customInstructions',
    'customInstructionsEnabled',
    'trimmerEnabled',
    'responseLengthMode',
  ]);

  // Populate fields
  elText.value     = data.customInstructions          ?? DEFAULTS.customInstructions;
  elEnabled.checked = data.customInstructionsEnabled  ?? DEFAULTS.customInstructionsEnabled;
  elTrimmer.checked = data.trimmerEnabled             ?? DEFAULTS.trimmerEnabled;

  const currentLen = data.responseLengthMode || DEFAULTS.responseLengthMode;
  _setActiveLengthBtn(currentLen);

  // ── Length buttons ────────────────────────────────────────────────────────
  document.querySelectorAll('[data-length]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const len = btn.dataset.length;
      _setActiveLengthBtn(len);
      await storageSet({ responseLengthMode: len });
    });
  });

  // ── Trimmer instant-save ─────────────────────────────────────────────────
  elTrimmer.addEventListener('change', async () => {
    await storageSet({ trimmerEnabled: elTrimmer.checked });
  });

  // ── Save instructions ────────────────────────────────────────────────────
  elSave.addEventListener('click', async () => {
    elSave.disabled = true;
    const ok = await storageSet({
      customInstructions:          elText.value.trim(),
      customInstructionsEnabled:   elEnabled.checked,
      instructionsPrependedThisChat: false, // force re-prepend on next chat
    });
    showStatus(elStatus, ok ? '✓ Saved' : '✗ Error saving', ok ? 'ok' : 'err');
    elSave.disabled = false;
  });
}

function _setActiveLengthBtn(mode) {
  document.querySelectorAll('[data-length]').forEach(b => {
    const isActive = b.dataset.length === mode;
    b.style.background     = isActive ? 'rgba(167,139,250,0.15)' : '';
    b.style.color          = isActive ? '#a78bfa'                 : '';
    b.style.borderColor    = isActive ? 'rgba(167,139,250,0.4)'   : '';
  });
}

// ── Tab 2: Modes ──────────────────────────────────────────────────────────────

async function initModesTab() {
  const grid   = document.getElementById('preset-grid');
  const saveBtn = document.getElementById('modes-save');
  const status = document.getElementById('modes-status');

  const data = await storageGet(['modePresets']);
  const presets = data.modePresets || DEFAULTS.modePresets;

  // Build editable rows
  grid.innerHTML = '';
  const keys = Object.keys(DEFAULTS.modePresets);
  for (const key of keys) {
    const row = document.createElement('div');
    row.className = 'preset-row';

    const keyEl = document.createElement('div');
    keyEl.className = 'preset-key';
    keyEl.textContent = key;

    const input = document.createElement('textarea');
    input.rows = 2;
    input.id = `preset-${key}`;
    input.setAttribute('aria-label', `Preset instruction for ${key} mode`);
    input.value = presets[key] || DEFAULTS.modePresets[key] || '';

    row.appendChild(keyEl);
    row.appendChild(input);
    grid.appendChild(row);
  }

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    const updated = {};
    for (const key of keys) {
      const el = document.getElementById(`preset-${key}`);
      if (el) updated[key] = el.value.trim() || DEFAULTS.modePresets[key];
    }
    const ok = await storageSet({ modePresets: updated });
    showStatus(status, ok ? '✓ Saved' : '✗ Error', ok ? 'ok' : 'err');
    saveBtn.disabled = false;
  });
}

// ── Tab 3: Templates ──────────────────────────────────────────────────────────

const BUILTIN_KEYS = ['debug', 'review', 'explain', 'code', 'blog', 'email', 'summarise', 'compare'];

async function initTemplatesTab() {
  await renderTemplateList();

  const addBtn   = document.getElementById('add-template-btn');
  const nameEl   = document.getElementById('new-tpl-name');
  const bodyEl   = document.getElementById('new-tpl-body');
  const statusEl = document.getElementById('template-status');

  addBtn.addEventListener('click', async () => {
    const name = nameEl.value.trim();
    const body = bodyEl.value.trim();

    if (!name) { nameEl.focus(); return; }
    if (!body) { bodyEl.focus(); return; }

    const key = name.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_');
    if (!key) return;

    const data = await storageGet(['promptTemplates']);
    const templates = { ...(data.promptTemplates || {}), [key]: body };
    const ok = await storageSet({ promptTemplates: templates });

    if (ok) {
      showStatus(statusEl, '✓ Template added', 'ok');
      nameEl.value = '';
      bodyEl.value = '';
      await renderTemplateList();
    } else {
      showStatus(statusEl, '✗ Error saving', 'err');
    }
  });
}

async function renderTemplateList() {
  const list = document.getElementById('template-list');
  if (!list) return;

  const data = await storageGet(['promptTemplates']);
  const templates = data.promptTemplates || DEFAULTS.promptTemplates;

  list.innerHTML = '';

  for (const [key, val] of Object.entries(templates)) {
    const body = typeof val === 'string' ? val : (val.body || '');
    const isBuiltin = BUILTIN_KEYS.includes(key);

    const row = document.createElement('div');
    row.className = 'template-row';

    const nameEl = document.createElement('span');
    nameEl.className = 'template-row-name';
    nameEl.textContent = key;
    nameEl.title = key;

    const previewEl = document.createElement('span');
    previewEl.className = 'template-row-preview';
    previewEl.textContent = body.split('\n')[0].slice(0, 50);
    previewEl.title = body.slice(0, 120);

    row.appendChild(nameEl);
    row.appendChild(previewEl);

    if (!isBuiltin) {
      const delBtn = document.createElement('button');
      delBtn.className = 'template-del-btn';
      delBtn.setAttribute('aria-label', `Delete template: ${key}`);
      delBtn.textContent = '×';
      delBtn.addEventListener('click', async () => {
        const d = await storageGet(['promptTemplates']);
        const t = { ...(d.promptTemplates || {}) };
        delete t[key];
        await storageSet({ promptTemplates: t });
        await renderTemplateList();
      });
      row.appendChild(delBtn);
    } else {
      const builtinBadge = document.createElement('span');
      builtinBadge.style.cssText = 'font-size:8px;color:rgba(255,255,255,0.2);flex-shrink:0';
      builtinBadge.textContent = 'built-in';
      row.appendChild(builtinBadge);
    }

    list.appendChild(row);
  }

  if (Object.keys(templates).length === 0) {
    list.innerHTML = '<p style="font-size:11px;color:var(--text-muted)">No templates yet.</p>';
  }
}

// ── Tab 4: Keyboard shortcuts ─────────────────────────────────────────────────

let _recordingBtn  = null;
let _recordingCombo = null;
let _currentBindings = {};

async function initKeyboardTab() {
  const data = await storageGet(['keyboardBindings']);
  _currentBindings = { ...DEFAULTS.keyboardBindings, ...(data.keyboardBindings || {}) };
  renderKeyboardTable();
}

function renderKeyboardTable() {
  const tbody = document.querySelector('#kbd-table tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  for (const [combo, action] of Object.entries(_currentBindings)) {
    const tr = document.createElement('tr');

    const tdCombo = document.createElement('td');
    tdCombo.style.width = '130px';
    const comboEl = document.createElement('code');
    comboEl.className = 'kbd-combo';
    comboEl.id = `kbd-combo-${action}`;
    comboEl.textContent = combo;
    tdCombo.appendChild(comboEl);

    const tdAction = document.createElement('td');
    tdAction.className = 'kbd-action';
    tdAction.textContent = ACTION_LABELS[action] || action;

    const tdBtn = document.createElement('td');
    tdBtn.style.textAlign = 'right';
    const rebindBtn = document.createElement('button');
    rebindBtn.className = 'kbd-rebind-btn';
    rebindBtn.dataset.action = action;
    rebindBtn.setAttribute('aria-label', `Rebind ${ACTION_LABELS[action] || action}`);
    rebindBtn.textContent = 'Rebind';
    rebindBtn.addEventListener('click', () => startRecording(rebindBtn, action, comboEl));
    tdBtn.appendChild(rebindBtn);

    tr.appendChild(tdCombo);
    tr.appendChild(tdAction);
    tr.appendChild(tdBtn);
    tbody.appendChild(tr);
  }
}

function startRecording(btn, action, comboEl) {
  // Cancel any existing recording
  if (_recordingBtn) {
    _recordingBtn.textContent = 'Rebind';
    _recordingBtn.classList.remove('recording');
  }

  _recordingBtn   = btn;
  _recordingCombo = null;
  btn.textContent = 'Press keys…';
  btn.classList.add('recording');

  const onKeydown = async (e) => {
    // Skip modifier-only
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;

    e.preventDefault();
    e.stopPropagation();

    const parts = [];
    if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
    if (e.altKey)               parts.push('Alt');
    if (e.shiftKey)             parts.push('Shift');
    let key = e.key;
    if (key.length === 1)       key = key.toUpperCase();
    parts.push(key);

    const newCombo = parts.join('+');

    // Remove old binding for this action, add new one
    for (const [k, v] of Object.entries(_currentBindings)) {
      if (v === action) delete _currentBindings[k];
    }
    _currentBindings[newCombo] = action;

    // Persist
    const ok = await storageSet({ keyboardBindings: _currentBindings });

    // Update UI
    comboEl.textContent = newCombo;
    btn.textContent = ok ? '✓' : '✗';
    btn.classList.remove('recording');

    setTimeout(() => {
      btn.textContent = 'Rebind';
    }, 1500);

    document.removeEventListener('keydown', onKeydown, { capture: true });
    _recordingBtn = null;
  };

  document.addEventListener('keydown', onKeydown, { capture: true });

  // Auto-cancel after 8s
  setTimeout(() => {
    if (_recordingBtn === btn) {
      btn.textContent = 'Rebind';
      btn.classList.remove('recording');
      document.removeEventListener('keydown', onKeydown, { capture: true });
      _recordingBtn = null;
    }
  }, 8000);
}

// ── Tab 5: Tags ───────────────────────────────────────────────────────────────

async function initTagsTab() {
  await renderTagsOverview();

  const clearBtn = document.getElementById('clear-all-tags-btn');
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      if (!confirm('Clear ALL tags from all conversations?')) return;
      await storageSet({ conversationTags: {} });
      await renderTagsOverview();
    });
  }
}

async function renderTagsOverview() {
  const container = document.getElementById('tag-stats');
  if (!container) return;

  const data = await storageGet(['conversationTags']);
  const all  = data.conversationTags || {};
  const convIds = Object.keys(all);

  if (convIds.length === 0) {
    container.innerHTML = '<p style="font-size:11px;color:var(--text-muted)">No tags yet. Open a conversation and add tags from the sidebar.</p>';
    return;
  }

  // Collect all unique tags and their counts
  const tagCounts = {};
  let totalTagged = 0;

  for (const tags of Object.values(all)) {
    if (Array.isArray(tags) && tags.length > 0) {
      totalTagged++;
      for (const t of tags) {
        tagCounts[t] = (tagCounts[t] || 0) + 1;
      }
    }
  }

  const uniqueTags = Object.keys(tagCounts).sort();

  container.innerHTML = '';

  const summary = document.createElement('p');
  summary.style.cssText = 'font-size:11px;color:var(--text-muted);margin-bottom:10px';
  summary.textContent = `${totalTagged} conversation${totalTagged !== 1 ? 's' : ''} tagged · ${uniqueTags.length} unique tag${uniqueTags.length !== 1 ? 's' : ''}`;
  container.appendChild(summary);

  const chipsWrap = document.createElement('div');
  chipsWrap.className = 'tag-stats-row';

  for (const tag of uniqueTags) {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    chip.title = `Used in ${tagCounts[tag]} conversation${tagCounts[tag] !== 1 ? 's' : ''}`;

    const label = document.createTextNode(tag);
    const countBadge = document.createElement('span');
    countBadge.className = 'tag-chip-count';
    countBadge.textContent = tagCounts[tag];

    chip.appendChild(label);
    chip.appendChild(countBadge);
    chipsWrap.appendChild(chip);
  }

  container.appendChild(chipsWrap);
}

// ── Storage live updates ──────────────────────────────────────────────────────

function watchStorage() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    // Refresh usage strip on any token/model change
    if (changes.tokenCount || changes.currentModel) {
      loadUsageStrip();
    }
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  try {
    initTabs();
    await loadUsageStrip();
    watchStorage();

    // Init all tabs in parallel (they operate on separate storage keys)
    await Promise.all([
      initInstructionsTab(),
      initModesTab(),
      initTemplatesTab(),
      initKeyboardTab(),
      initTagsTab(),
    ]);
  } catch (err) {
    // Silent failure — popup still renders, just with defaults
  }
});
