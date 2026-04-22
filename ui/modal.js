/**
 * ui/modal.js
 * Phase 4: Custom Instructions Modal + Mode Presets Control Panel
 *
 * Injects control buttons into the sidebar's #cext-actions slot.
 * Opens a full-screen modal overlay for editing custom instructions.
 *
 * Depends on: lib/storage.js (Storage global)
 * Loaded after: ui/banner.js
 */

'use strict';

// ── State ──────────────────────────────────────────────────────────────────────

const ModalState = {
  selectedMode: null,
  responseLengthMode: 'medium',
  trimmerEnabled: true,
  customInstructions: '',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function showToast(message, durationMs = 2000) {
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
  toast._timer = setTimeout(() => {
    toast.classList.remove('cext-toast-show');
  }, durationMs);
}

// ── Sidebar Controls (injected into #cext-actions) ────────────────────────────

function buildSidebarControls() {
  const actionsEl = document.getElementById('cext-actions');
  if (!actionsEl) return;

  actionsEl.innerHTML = '';

  // ── Section: Mode Presets ────────────────────────────────────────────────
  const modeSection = document.createElement('div');
  modeSection.className = 'cext-control-section';

  const modeTitle = document.createElement('div');
  modeTitle.className = 'cext-control-title';
  modeTitle.textContent = 'Response Style';
  modeSection.appendChild(modeTitle);

  const modeGrid = document.createElement('div');
  modeGrid.className = 'cext-mode-grid';
  modeGrid.id = 'cext-mode-grid';

  const modes = [
    { key: 'bullet',      label: '• Bullet' },
    { key: 'noPreamble',  label: '⚡ Direct' },
    { key: 'technical',   label: '⚙ Technical' },
    { key: 'caveman',     label: '🪨 Simple' },
    { key: 'concise',     label: '✂ Concise' },
  ];

  for (const { key, label } of modes) {
    const btn = document.createElement('button');
    btn.className = 'cext-mode-btn';
    btn.dataset.mode = key;
    btn.textContent = label;
    btn.title = `Toggle "${label}" response style`;
    btn.addEventListener('click', () => toggleMode(key));
    modeGrid.appendChild(btn);
  }

  modeSection.appendChild(modeGrid);
  actionsEl.appendChild(modeSection);

  // ── Section: Response Length ─────────────────────────────────────────────
  const lenSection = document.createElement('div');
  lenSection.className = 'cext-control-section';

  const lenTitle = document.createElement('div');
  lenTitle.className = 'cext-control-title';
  lenTitle.textContent = 'Response Length';
  lenSection.appendChild(lenTitle);

  const lenRow = document.createElement('div');
  lenRow.className = 'cext-length-row';
  lenRow.id = 'cext-length-row';

  const lengths = [
    { key: 'short',    label: 'Short' },
    { key: 'medium',   label: 'Medium' },
    { key: 'detailed', label: 'Detailed' },
  ];

  for (const { key, label } of lengths) {
    const btn = document.createElement('button');
    btn.className = 'cext-length-btn';
    btn.dataset.length = key;
    btn.textContent = label;
    btn.addEventListener('click', () => setResponseLength(key));
    lenRow.appendChild(btn);
  }

  lenSection.appendChild(lenRow);
  actionsEl.appendChild(lenSection);

  // ── Section: Trimmer toggle ──────────────────────────────────────────────
  const trimRow = document.createElement('div');
  trimRow.className = 'cext-toggle-row';

  const trimLabel = document.createElement('span');
  trimLabel.className = 'cext-toggle-label';
  trimLabel.textContent = '✂ Prompt Trimmer';
  trimLabel.title = 'Removes filler words and redundant text before sending';

  const trimToggle = document.createElement('button');
  trimToggle.className = 'cext-pill-toggle';
  trimToggle.id = 'cext-trimmer-toggle';
  trimToggle.setAttribute('aria-pressed', String(ModalState.trimmerEnabled));
  trimToggle.textContent = ModalState.trimmerEnabled ? 'ON' : 'OFF';
  trimToggle.addEventListener('click', toggleTrimmer);

  trimRow.appendChild(trimLabel);
  trimRow.appendChild(trimToggle);
  actionsEl.appendChild(trimRow);

  // ── Section: Custom Instructions button ──────────────────────────────────
  const instrBtn = document.createElement('button');
  instrBtn.className = 'cext-btn';
  instrBtn.id = 'cext-open-instructions-btn';
  instrBtn.textContent = '📝 Custom Instructions';
  instrBtn.title = 'Edit instructions prepended to every new chat';
  instrBtn.addEventListener('click', openInstructionsModal);
  actionsEl.appendChild(instrBtn);

  // Apply initial state
  syncControlState();
}

// ── State sync → DOM ──────────────────────────────────────────────────────────

function syncControlState() {
  // Mode buttons
  document.querySelectorAll('.cext-mode-btn').forEach(btn => {
    btn.classList.toggle('cext-mode-btn--active', btn.dataset.mode === ModalState.selectedMode);
  });

  // Length buttons
  document.querySelectorAll('.cext-length-btn').forEach(btn => {
    btn.classList.toggle('cext-length-btn--active', btn.dataset.length === ModalState.responseLengthMode);
  });

  // Trimmer toggle
  const trimToggle = document.getElementById('cext-trimmer-toggle');
  if (trimToggle) {
    trimToggle.classList.toggle('cext-pill-toggle--on', ModalState.trimmerEnabled);
    trimToggle.setAttribute('aria-pressed', String(ModalState.trimmerEnabled));
    trimToggle.textContent = ModalState.trimmerEnabled ? 'ON' : 'OFF';
  }
}

// ── Action handlers ───────────────────────────────────────────────────────────

async function toggleMode(key) {
  // Toggle: clicking active mode turns it off
  const newMode = ModalState.selectedMode === key ? null : key;
  ModalState.selectedMode = newMode;
  try {
    await Storage.set('selectedMode', newMode);
  } catch (err) {
    console.warn('[ClaudeExt:Modal] toggleMode error:', err);
  }
  syncControlState();
  showToast(newMode ? `Mode: ${key}` : 'Mode: off');
}

async function setResponseLength(key) {
  ModalState.responseLengthMode = key;
  try {
    await Storage.set('responseLengthMode', key);
  } catch (err) {
    console.warn('[ClaudeExt:Modal] setResponseLength error:', err);
  }
  syncControlState();
  showToast(`Length: ${key}`);
}

async function toggleTrimmer() {
  ModalState.trimmerEnabled = !ModalState.trimmerEnabled;
  try {
    await Storage.set('trimmerEnabled', ModalState.trimmerEnabled);
  } catch (err) {
    console.warn('[ClaudeExt:Modal] toggleTrimmer error:', err);
  }
  syncControlState();
  showToast(`Trimmer: ${ModalState.trimmerEnabled ? 'on' : 'off'}`);
}

// ── Custom Instructions Modal ─────────────────────────────────────────────────

function openInstructionsModal() {
  if (document.getElementById('cext-modal-overlay')) return; // already open

  // ── Overlay backdrop ─────────────────────────────────────────────────────
  const overlay = document.createElement('div');
  overlay.id = 'cext-modal-overlay';
  overlay.className = 'cext-modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Custom Instructions Editor');

  // Close on backdrop click
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeInstructionsModal();
  });

  // ── Modal box ────────────────────────────────────────────────────────────
  const modal = document.createElement('div');
  modal.className = 'cext-modal';

  // Header
  const header = document.createElement('div');
  header.className = 'cext-modal-header';

  const title = document.createElement('h3');
  title.textContent = '📝 Custom Instructions';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'cext-close';
  closeBtn.setAttribute('aria-label', 'Close modal');
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', closeInstructionsModal);

  header.appendChild(title);
  header.appendChild(closeBtn);

  // Description
  const desc = document.createElement('p');
  desc.className = 'cext-modal-desc';
  desc.textContent = 'These instructions are prepended to your first message in every new chat.';

  // Textarea
  const textarea = document.createElement('textarea');
  textarea.id = 'cext-instructions-textarea';
  textarea.className = 'cext-modal-textarea';
  textarea.placeholder = 'e.g. "You are a senior software engineer. Always use TypeScript. Prefer functional patterns."';
  textarea.rows = 6;
  textarea.value = ModalState.customInstructions;
  textarea.spellcheck = true;

  // Character count
  const charCount = document.createElement('div');
  charCount.className = 'cext-char-count';
  charCount.textContent = `${textarea.value.length} chars`;

  textarea.addEventListener('input', () => {
    charCount.textContent = `${textarea.value.length} chars`;
  });

  // Preset quick-fills
  const quickSection = document.createElement('div');
  quickSection.className = 'cext-quick-fills';

  const quickLabel = document.createElement('div');
  quickLabel.className = 'cext-quick-label';
  quickLabel.textContent = 'Quick presets:';
  quickSection.appendChild(quickLabel);

  const quickFills = [
    { label: 'Code Expert',   text: 'You are an expert software engineer. Always write clean, well-documented code. Prefer TypeScript.' },
    { label: 'Be Concise',    text: 'Be concise and direct. Skip introductions. Answer immediately.' },
    { label: 'ELI5',          text: 'Explain everything as if I am 5 years old. Use simple words and analogies.' },
    { label: 'Step by Step',  text: 'Always break down your response step by step. Number each step clearly.' },
  ];

  const quickRow = document.createElement('div');
  quickRow.className = 'cext-quick-row';

  for (const { label, text } of quickFills) {
    const chip = document.createElement('button');
    chip.className = 'cext-quick-chip';
    chip.textContent = label;
    chip.title = text.slice(0, 80) + '…';
    chip.addEventListener('click', () => {
      textarea.value = text;
      textarea.dispatchEvent(new Event('input'));
    });
    quickRow.appendChild(chip);
  }
  quickSection.appendChild(quickRow);

  // Footer actions
  const footer = document.createElement('div');
  footer.className = 'cext-modal-footer';

  const clearBtn = document.createElement('button');
  clearBtn.className = 'cext-btn cext-btn-subtle';
  clearBtn.textContent = 'Clear';
  clearBtn.addEventListener('click', () => {
    textarea.value = '';
    textarea.dispatchEvent(new Event('input'));
  });

  const saveBtn = document.createElement('button');
  saveBtn.className = 'cext-modal-save-btn';
  saveBtn.id = 'cext-modal-save-btn';
  saveBtn.textContent = 'Save Instructions';
  saveBtn.addEventListener('click', async () => {
    const val = textarea.value.trim();
    try {
      await Storage.setMultiple({
        customInstructions: val,
        instructionsPrependedThisChat: false, // reset so next message gets them
      });
      ModalState.customInstructions = val;
      saveBtn.textContent = '✓ Saved!';
      saveBtn.classList.add('cext-modal-save-btn--saved');
      setTimeout(() => {
        saveBtn.textContent = 'Save Instructions';
        saveBtn.classList.remove('cext-modal-save-btn--saved');
        closeInstructionsModal();
      }, 900);
    } catch (err) {
      console.warn('[ClaudeExt:Modal] save error:', err);
      saveBtn.textContent = '✗ Error';
    }
  });

  footer.appendChild(clearBtn);
  footer.appendChild(saveBtn);

  // Assemble
  modal.appendChild(header);
  modal.appendChild(desc);
  modal.appendChild(textarea);
  modal.appendChild(charCount);
  modal.appendChild(quickSection);
  modal.appendChild(footer);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // Focus textarea
  requestAnimationFrame(() => textarea.focus());
}

function closeInstructionsModal() {
  const overlay = document.getElementById('cext-modal-overlay');
  if (overlay) overlay.remove();
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────────
// Escape key: close instructions modal (safe to handle here as it's modal-specific)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeInstructionsModal();
  }
});

// All other shortcuts (Ctrl+Shift+T/1/2/3/N/etc.) are handled by lib/keyboard.js.
// Expose a sync hook so keyboard.js can update modal UI after storage writes.
window._cextSyncModalState = function(patch) {
  let needsSync = false;
  if ('trimmerEnabled' in patch) {
    ModalState.trimmerEnabled = patch.trimmerEnabled;
    needsSync = true;
  }
  if ('responseLengthMode' in patch) {
    ModalState.responseLengthMode = patch.responseLengthMode;
    needsSync = true;
  }
  if ('selectedMode' in patch) {
    ModalState.selectedMode = patch.selectedMode;
    needsSync = true;
  }
  if (needsSync) syncControlState();
};

// ── Storage reactivity ────────────────────────────────────────────────────────

Storage.onChange((changes) => {
  let needsSync = false;
  if (changes.selectedMode) {
    ModalState.selectedMode = changes.selectedMode.newValue;
    needsSync = true;
  }
  if (changes.responseLengthMode) {
    ModalState.responseLengthMode = changes.responseLengthMode.newValue;
    needsSync = true;
  }
  if (changes.trimmerEnabled !== undefined) {
    ModalState.trimmerEnabled = changes.trimmerEnabled.newValue;
    needsSync = true;
  }
  if (changes.customInstructions) {
    ModalState.customInstructions = changes.customInstructions.newValue || '';
  }
  if (needsSync) syncControlState();
});

// ── Init ──────────────────────────────────────────────────────────────────────

async function initModalModule() {
  try {
    const data = await Storage.getMultiple([
      'selectedMode',
      'responseLengthMode',
      'trimmerEnabled',
      'customInstructions',
    ]);

    ModalState.selectedMode       = data.selectedMode       ?? null;
    ModalState.responseLengthMode = data.responseLengthMode ?? 'medium';
    ModalState.trimmerEnabled     = data.trimmerEnabled     ?? true;
    ModalState.customInstructions = data.customInstructions ?? '';

    buildSidebarControls();
    console.debug('[ClaudeExt:Modal] Initialised. Mode:', ModalState.selectedMode, '| Length:', ModalState.responseLengthMode);
  } catch (err) {
    console.error('[ClaudeExt:Modal] init error:', err);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initModalModule);
} else {
  initModalModule();
}
