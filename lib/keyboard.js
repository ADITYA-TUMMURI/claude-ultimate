/**
 * lib/keyboard.js
 * Global keyboard shortcut dispatcher for Claude Ultimate.
 *
 * Design:
 *  - Single document keydown listener — no conflicts, easy to debug
 *  - Shortcuts never fire inside the compose textarea or any editable
 *  - Reads keyboardBindings from storage.local — user-rebindable
 *  - Actions are pure functions registered into an ACTION_MAP
 *  - Exposes: initKeyboardListeners(), rebindKey(combo, action)
 *
 * Depends on: lib/storage.js (Storage global)
 * Loaded after: ui/modal.js
 */

'use strict';

// ── Action registry ───────────────────────────────────────────────────────────

/**
 * All available actions. Each is a zero-arg async function.
 * Modules can register additional actions via KeyboardShortcuts.register().
 */
const ACTION_MAP = {

  // ── Navigation ─────────────────────────────────────────────────────────────

  async newChat() {
    // Click claude.ai's "New chat" button (several possible selectors)
    const selectors = [
      'button[aria-label="New chat"]',
      'a[href="/new"]',
      '[data-testid="new-chat-button"]',
      'a[href^="/chat/new"]',
      'button[title="New chat"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        el.click();
        _toast('New chat →');
        return;
      }
    }
    // Fallback: navigate directly
    window.location.href = '/new';
    _toast('New chat →');
  },

  // ── Feature triggers (fulfilled by later phases) ───────────────────────────

  copyPassport() {
    // Phase 6: context passport — calls the handler registered by export.js
    if (typeof window._cextCopyPassport === 'function') {
      window._cextCopyPassport();
    } else {
      _toast('Context Passport: coming soon');
    }
  },

  exportMarkdown() {
    // Phase 6: markdown export
    if (typeof window._cextExportMarkdown === 'function') {
      window._cextExportMarkdown();
    } else {
      _toast('Export Markdown: coming soon');
    }
  },

  // ── Trimmer ────────────────────────────────────────────────────────────────

  async toggleTrimmer() {
    try {
      const current = await Storage.get('trimmerEnabled');
      const next = !current;
      await Storage.set('trimmerEnabled', next);
      _toast(`Trimmer: ${next ? 'ON' : 'OFF'}`);
      // Sync modal UI if it's open
      if (typeof window._cextSyncModalState === 'function') {
        window._cextSyncModalState({ trimmerEnabled: next });
      }
    } catch (err) {
      console.warn('[ClaudeExt:Keyboard] toggleTrimmer error:', err);
    }
  },

  // ── Response length presets ────────────────────────────────────────────────

  async modeShort() {
    await _setLength('short');
  },

  async modeMedium() {
    await _setLength('medium');
  },

  async modeDetailed() {
    await _setLength('detailed');
  },

  // ── Template picker ───────────────────────────────────────────────────────

  openTemplates() {
    if (typeof window._cextOpenTemplates === 'function') {
      window._cextOpenTemplates();
    } else {
      _toast('Templates: loading…');
    }
  },
};

// ── Private helpers ───────────────────────────────────────────────────────────

async function _setLength(mode) {
  try {
    await Storage.set('responseLengthMode', mode);
    _toast(`Length: ${mode}`);
    if (typeof window._cextSyncModalState === 'function') {
      window._cextSyncModalState({ responseLengthMode: mode });
    }
  } catch (err) {
    console.warn('[ClaudeExt:Keyboard] setLength error:', err);
  }
}

function _toast(msg) {
  // Reuse the modal.js toast singleton if present, otherwise create one
  let toast = document.getElementById('cext-toast-singleton');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'cext-toast-singleton';
    toast.className = 'cext-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('cext-toast-show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('cext-toast-show'), 1800);
}

// ── Combo normaliser ──────────────────────────────────────────────────────────

/**
 * Normalise a KeyboardEvent into a combo string like "Ctrl+Shift+N".
 * Meta key on Mac maps to Ctrl for consistency.
 *
 * @param {KeyboardEvent} e
 * @returns {string}
 */
function _normaliseCombo(e) {
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey)               parts.push('Alt');
  if (e.shiftKey)             parts.push('Shift');

  // Normalise key label
  let key = e.key;
  if (key === ' ')            key = 'Space';
  if (key.length === 1)       key = key.toUpperCase();

  parts.push(key);
  return parts.join('+');
}

// ── Binding state ─────────────────────────────────────────────────────────────

/** Current bindings: combo → action name */
let _bindings = {};

async function _loadBindings() {
  try {
    const stored = await Storage.get('keyboardBindings');
    _bindings = stored || {};
  } catch (err) {
    console.warn('[ClaudeExt:Keyboard] loadBindings error:', err);
    _bindings = {};
  }
}

// ── Main keydown handler ──────────────────────────────────────────────────────

function _onKeydown(e) {
  // Never fire inside editable areas
  const active = document.activeElement;
  if (!active) return;

  const tag = active.tagName;
  const isEditable =
    tag === 'TEXTAREA' ||
    tag === 'INPUT'    ||
    active.contentEditable === 'true' ||
    active.isContentEditable;

  if (isEditable) return;

  // Skip if modifier-only keydown (Shift alone, Ctrl alone, etc.)
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;

  // Only act on shortcuts that include Ctrl/Meta (prevents accidental triggers)
  if (!e.ctrlKey && !e.metaKey) return;

  // Skip Ctrl+Enter — claude.ai uses that to send
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') return;

  const combo  = _normaliseCombo(e);
  const action = _bindings[combo];

  if (!action) return;

  const fn = ACTION_MAP[action];
  if (!fn) {
    console.warn('[ClaudeExt:Keyboard] unknown action:', action, 'for combo:', combo);
    return;
  }

  e.preventDefault();
  e.stopPropagation();

  Promise.resolve(fn()).catch(err =>
    console.warn('[ClaudeExt:Keyboard] action error:', action, err)
  );
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Initialise the keyboard listener. Must be called once.
 * Loads bindings from storage and starts listening.
 */
async function initKeyboardListeners() {
  await _loadBindings();

  // Re-load bindings whenever user changes them in popup/settings
  Storage.onChange((changes) => {
    if (changes.keyboardBindings) {
      _bindings = changes.keyboardBindings.newValue || {};
    }
  });

  document.addEventListener('keydown', _onKeydown, { capture: true });
  console.debug('[ClaudeExt:Keyboard] Initialised. Bindings:', Object.keys(_bindings).length);
}

/**
 * Programmatically rebind a key combo.
 * @param {string} combo  - e.g. "Ctrl+Shift+N"
 * @param {string} action - e.g. "newChat"
 */
async function rebindKey(combo, action) {
  if (!ACTION_MAP[action]) {
    console.warn('[ClaudeExt:Keyboard] rebindKey: unknown action:', action);
    return;
  }
  _bindings[combo] = action;
  try {
    await Storage.set('keyboardBindings', _bindings);
  } catch (err) {
    console.warn('[ClaudeExt:Keyboard] rebindKey storage error:', err);
  }
}

/**
 * Register a new action (for later-phase modules).
 * @param {string}   name  - Action identifier
 * @param {function} fn    - Zero-arg (async) function
 */
function registerAction(name, fn) {
  if (typeof fn !== 'function') {
    console.warn('[ClaudeExt:Keyboard] registerAction: fn must be a function');
    return;
  }
  ACTION_MAP[name] = fn;
}

/**
 * Trigger an action by name programmatically.
 * @param {string} action
 */
function triggerAction(action) {
  const fn = ACTION_MAP[action];
  if (!fn) {
    console.warn('[ClaudeExt:Keyboard] triggerAction: unknown action:', action);
    return;
  }
  Promise.resolve(fn()).catch(err =>
    console.warn('[ClaudeExt:Keyboard] triggerAction error:', action, err)
  );
}

// ── Expose as global ──────────────────────────────────────────────────────────

const KeyboardShortcuts = {
  init:           initKeyboardListeners,
  rebind:         rebindKey,
  register:       registerAction,
  trigger:        triggerAction,
  getBindings:    () => ({ ..._bindings }),
  normaliseCombo: _normaliseCombo,
};

// ── Boot ──────────────────────────────────────────────────────────────────────

initKeyboardListeners();
