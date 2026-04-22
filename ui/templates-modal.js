/**
 * ui/templates-modal.js
 * Phase 5: Prompt Template Library
 *
 * Responsibilities:
 *  1. Inject a small "Templates" button near the claude.ai compose box
 *     (uses MutationObserver to wait for compose box DOM readiness)
 *  2. On click: open a modal grid showing all prompt templates
 *  3. On template select: fill compose textarea, position cursor at
 *     first [PLACEHOLDER], then close modal (without submitting)
 *  4. Allow adding custom templates (name + body)
 *  5. Allow deleting custom templates (built-ins can't be deleted)
 *  6. Persist custom templates in chrome.storage.local.promptTemplates
 *
 * Depends on: lib/storage.js (Storage global), lib/keyboard.js (KeyboardShortcuts)
 * Loaded after: lib/keyboard.js
 */

'use strict';

// ── Built-in template definitions ─────────────────────────────────────────────

const BUILTIN_TEMPLATES = {
  debug: {
    label: '🐛 Debug',
    body: 'Debug this code and explain the issue:\n\n```\n[YOUR CODE]\n```',
    hint: 'Paste code to debug',
  },
  review: {
    label: '🔍 Code Review',
    body: 'Review this code for bugs, performance, and best practices:\n\n```\n[CODE]\n```',
    hint: 'Get expert code review',
  },
  explain: {
    label: '📚 Explain',
    body: 'Explain [CONCEPT] to a [AUDIENCE].',
    hint: 'Explain anything clearly',
  },
  code: {
    label: '💻 Write Code',
    body: 'Write a [LANGUAGE] function that [REQUIREMENT].',
    hint: 'Generate code from spec',
  },
  blog: {
    label: '✍️ Blog Post',
    body: 'Write a blog post about [TOPIC]:\nTarget audience: [AUDIENCE]\nTone: [TONE]',
    hint: 'Draft a blog post',
  },
  email: {
    label: '📧 Email',
    body: 'Draft a professional email:\nTo: [RECIPIENT]\nSubject: [SUBJECT]\nContext: [CONTEXT]',
    hint: 'Draft a professional email',
  },
  summarise: {
    label: '📝 Summarise',
    body: 'Summarise the following in [LENGTH] bullet points, focusing on key takeaways:\n\n[TEXT]',
    hint: 'Summarise any content',
  },
  compare: {
    label: '⚖️ Compare',
    body: 'Compare [OPTION_A] vs [OPTION_B]:\n- Pros and cons of each\n- Best use case for each\n- Your recommendation',
    hint: 'Side-by-side comparison',
  },
};

// ── State ──────────────────────────────────────────────────────────────────────

let _customTemplates = {};
let _triggerObserver = null;
let _triggerBtn      = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

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

/**
 * Insert template text into the composebox.
 * For contenteditable: use execCommand for undo-stack compat.
 * Then position cursor at first [PLACEHOLDER].
 */
function fillComposebox(text) {
  const box = findComposebox();
  if (!box) return;

  if (box.contentEditable === 'true') {
    box.focus();
    // Select all existing content then replace
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, text);
  } else {
    // Standard textarea
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    )?.set;
    if (setter) setter.call(box, text);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // Position cursor at first [PLACEHOLDER]
  requestAnimationFrame(() => moveCursorToFirstPlaceholder(box, text));
}

/**
 * Move cursor to the start of the first [PLACEHOLDER] in the text.
 */
function moveCursorToFirstPlaceholder(box, text) {
  const idx = text.indexOf('[');
  if (idx === -1) return;

  try {
    if (box.contentEditable === 'true') {
      // Walk text nodes to find character offset
      const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
      let offset = 0;
      let targetNode = null;
      let targetOffset = 0;

      while (walker.nextNode()) {
        const node = walker.currentNode;
        const len = node.textContent.length;
        if (offset + len > idx) {
          targetNode   = node;
          targetOffset = idx - offset;
          break;
        }
        offset += len;
      }

      if (targetNode) {
        const range = document.createRange();
        const sel   = window.getSelection();

        // Find closing bracket for the placeholder
        const end = text.indexOf(']', idx);
        const endOffset = end !== -1 ? targetOffset + (end - idx + 1) : targetOffset;
        const safeEnd = Math.min(endOffset, targetNode.textContent.length);

        range.setStart(targetNode, targetOffset);
        range.setEnd(targetNode, safeEnd);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    } else {
      box.setSelectionRange(idx, text.indexOf(']', idx) + 1);
    }
    box.focus();
  } catch (_) {
    // Cursor positioning failed — box is still filled, no big deal
  }
}

// ── Template trigger button ───────────────────────────────────────────────────

function createTriggerButton() {
  if (_triggerBtn && document.body.contains(_triggerBtn)) return;

  _triggerBtn = document.createElement('button');
  _triggerBtn.id = 'cext-template-trigger';
  _triggerBtn.className = 'cext-template-trigger';
  _triggerBtn.title = 'Prompt Templates (Ctrl+Shift+P)';
  _triggerBtn.setAttribute('aria-label', 'Open prompt template library');

  // Icon: stacked lines ≡
  const icon = document.createElement('span');
  icon.className = 'cext-template-trigger-icon';
  icon.textContent = '⌨';
  _triggerBtn.appendChild(icon);

  const label = document.createElement('span');
  label.className = 'cext-template-trigger-label';
  label.textContent = 'Templates';
  _triggerBtn.appendChild(label);

  _triggerBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openTemplatesModal();
  });

  document.body.appendChild(_triggerBtn);
}

function positionTriggerButton() {
  // The button is fixed-positioned via CSS, anchored below the sidebar.
  // No dynamic positioning needed — CSS handles it.
}

/**
 * Watch for composebox availability and inject the trigger button.
 */
function initTemplateTrigger() {
  if (_triggerObserver) return;

  // Try immediately
  if (findComposebox()) {
    createTriggerButton();
    return;
  }

  // Wait for composebox
  _triggerObserver = new MutationObserver(() => {
    if (findComposebox() && !document.getElementById('cext-template-trigger')) {
      createTriggerButton();
    }
  });

  _triggerObserver.observe(document.body, { childList: true, subtree: true });
}

// ── Templates modal ───────────────────────────────────────────────────────────

function openTemplatesModal() {
  if (document.getElementById('cext-templates-overlay')) return;

  const overlay = document.createElement('div');
  overlay.id = 'cext-templates-overlay';
  overlay.className = 'cext-modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Prompt Template Library');

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeTemplatesModal();
  });

  const modal = document.createElement('div');
  modal.className = 'cext-modal cext-templates-modal';

  // Header
  const header = document.createElement('div');
  header.className = 'cext-modal-header';

  const title = document.createElement('h3');
  title.textContent = '⌨ Prompt Templates';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'cext-close';
  closeBtn.setAttribute('aria-label', 'Close templates');
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', closeTemplatesModal);

  header.appendChild(title);
  header.appendChild(closeBtn);
  modal.appendChild(header);

  // Search bar
  const searchWrap = document.createElement('div');
  searchWrap.className = 'cext-template-search-wrap';

  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.className = 'cext-template-search';
  searchInput.placeholder = 'Search templates…';
  searchInput.id = 'cext-template-search';
  searchInput.setAttribute('autocomplete', 'off');
  searchWrap.appendChild(searchInput);
  modal.appendChild(searchWrap);

  // Template grid container
  const gridWrap = document.createElement('div');
  gridWrap.id = 'cext-template-grid-wrap';
  modal.appendChild(gridWrap);

  // Add custom template form
  const addSection = buildAddTemplateForm();
  modal.appendChild(addSection);

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // Render initial grid
  renderTemplateGrid(gridWrap, '');

  // Wire search
  searchInput.addEventListener('input', () => {
    renderTemplateGrid(gridWrap, searchInput.value.trim().toLowerCase());
  });

  // Focus search
  requestAnimationFrame(() => searchInput.focus());
}

function closeTemplatesModal() {
  const overlay = document.getElementById('cext-templates-overlay');
  if (overlay) overlay.remove();
}

/**
 * Render the template cards into the grid container,
 * optionally filtered by a search query.
 */
function renderTemplateGrid(container, query) {
  container.innerHTML = '';

  const all = {
    ...BUILTIN_TEMPLATES,
    ...Object.fromEntries(
      Object.entries(_customTemplates).map(([k, v]) => [
        k,
        typeof v === 'string' ? { label: `★ ${k}`, body: v, hint: 'Custom template', custom: true } : { ...v, custom: true },
      ])
    ),
  };

  const entries = Object.entries(all).filter(([key, tpl]) => {
    if (!query) return true;
    return (
      key.toLowerCase().includes(query) ||
      tpl.label.toLowerCase().includes(query) ||
      tpl.body.toLowerCase().includes(query) ||
      (tpl.hint || '').toLowerCase().includes(query)
    );
  });

  if (entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'cext-template-empty';
    empty.textContent = 'No templates match your search.';
    container.appendChild(empty);
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'cext-template-grid';

  for (const [key, tpl] of entries) {
    const card = buildTemplateCard(key, tpl);
    grid.appendChild(card);
  }

  container.appendChild(grid);
}

function buildTemplateCard(key, tpl) {
  const card = document.createElement('div');
  card.className = 'cext-template-card';
  card.setAttribute('role', 'button');
  card.setAttribute('tabindex', '0');
  card.title = tpl.hint || tpl.body.slice(0, 60);

  const cardLabel = document.createElement('h4');
  cardLabel.textContent = tpl.label || key;
  card.appendChild(cardLabel);

  const cardHint = document.createElement('p');
  cardHint.textContent = tpl.hint || tpl.body.slice(0, 50) + (tpl.body.length > 50 ? '…' : '');
  card.appendChild(cardHint);

  // Preview first line of body
  const preview = document.createElement('code');
  preview.className = 'cext-template-preview';
  const firstLine = tpl.body.split('\n')[0];
  preview.textContent = firstLine.length > 45 ? firstLine.slice(0, 45) + '…' : firstLine;
  card.appendChild(preview);

  // Delete button (custom templates only)
  if (tpl.custom) {
    const delBtn = document.createElement('button');
    delBtn.className = 'cext-template-del-btn';
    delBtn.setAttribute('aria-label', `Delete template: ${tpl.label}`);
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      delete _customTemplates[key];
      try {
        await Storage.set('promptTemplates', {
          ...getBuiltinBodies(),
          ..._customTemplates,
        });
      } catch (err) {
        console.warn('[ClaudeExt:Templates] delete error:', err);
      }
      card.remove();
    });
    card.appendChild(delBtn);
  }

  // Use template on click / Enter
  function useTemplate() {
    fillComposebox(tpl.body);
    closeTemplatesModal();
  }

  card.addEventListener('click', useTemplate);
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      useTemplate();
    }
  });

  return card;
}

function buildAddTemplateForm() {
  const section = document.createElement('div');
  section.className = 'cext-add-template-section';

  const toggle = document.createElement('button');
  toggle.className = 'cext-add-template-toggle';
  toggle.textContent = '+ Add custom template';

  const form = document.createElement('div');
  form.className = 'cext-add-template-form';
  form.style.display = 'none';

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'cext-template-name-input';
  nameInput.placeholder = 'Template name (e.g. "Refactor")';
  nameInput.maxLength = 40;

  const bodyTextarea = document.createElement('textarea');
  bodyTextarea.className = 'cext-modal-textarea';
  bodyTextarea.placeholder = 'Template body… use [PLACEHOLDERS] for fillable spots';
  bodyTextarea.rows = 4;

  const saveBtn = document.createElement('button');
  saveBtn.className = 'cext-modal-save-btn';
  saveBtn.textContent = 'Save Template';
  saveBtn.style.marginTop = '8px';

  saveBtn.addEventListener('click', async () => {
    const name = nameInput.value.trim();
    const body = bodyTextarea.value.trim();

    if (!name) { nameInput.focus(); return; }
    if (!body) { bodyTextarea.focus(); return; }

    // Sanitise key: alphanumeric + underscore only
    const key = name.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_');
    if (!key) return;

    _customTemplates[key] = { label: `★ ${name}`, body, hint: `Custom: ${name}`, custom: true };

    try {
      await Storage.set('promptTemplates', {
        ...getBuiltinBodies(),
        ..._customTemplates,
      });
      saveBtn.textContent = '✓ Saved!';
      nameInput.value = '';
      bodyTextarea.value = '';
      setTimeout(() => {
        saveBtn.textContent = 'Save Template';
        // Refresh grid
        const gridWrap = document.getElementById('cext-template-grid-wrap');
        if (gridWrap) renderTemplateGrid(gridWrap, '');
        form.style.display = 'none';
        toggle.textContent = '+ Add custom template';
      }, 800);
    } catch (err) {
      console.warn('[ClaudeExt:Templates] save error:', err);
      saveBtn.textContent = '✗ Error';
    }
  });

  form.appendChild(nameInput);
  form.appendChild(bodyTextarea);
  form.appendChild(saveBtn);

  toggle.addEventListener('click', () => {
    const open = form.style.display !== 'none';
    form.style.display = open ? 'none' : 'block';
    toggle.textContent = open ? '+ Add custom template' : '− Cancel';
    if (!open) nameInput.focus();
  });

  section.appendChild(toggle);
  section.appendChild(form);
  return section;
}

/** Return built-in template bodies for storage merge. */
function getBuiltinBodies() {
  const out = {};
  for (const [k, v] of Object.entries(BUILTIN_TEMPLATES)) {
    out[k] = v.body;
  }
  return out;
}

// ── Load custom templates from storage ───────────────────────────────────────

async function loadCustomTemplates() {
  try {
    const stored = await Storage.get('promptTemplates') || {};
    // Custom templates = those NOT in BUILTIN_TEMPLATES
    _customTemplates = {};
    for (const [k, v] of Object.entries(stored)) {
      if (!BUILTIN_TEMPLATES[k]) {
        _customTemplates[k] = typeof v === 'string'
          ? { label: `★ ${k}`, body: v, hint: `Custom: ${k}`, custom: true }
          : { ...v, custom: true };
      }
    }
  } catch (err) {
    console.warn('[ClaudeExt:Templates] loadCustomTemplates error:', err);
  }
}

// ── Keyboard shortcut integration ─────────────────────────────────────────────

// Register Ctrl+Shift+P → open templates
// (keyboard.js must be loaded before this)
if (typeof KeyboardShortcuts !== 'undefined') {
  KeyboardShortcuts.register('openTemplates', () => openTemplatesModal());

  // Add Ctrl+Shift+P to bindings if not already present
  Storage.get('keyboardBindings').then(bindings => {
    const b = bindings || {};
    if (!b['Ctrl+Shift+P']) {
      b['Ctrl+Shift+P'] = 'openTemplates';
      Storage.set('keyboardBindings', b);
    }
  }).catch(() => {});
}

// Also expose for keyboard.js ACTION_MAP reference
window._cextOpenTemplates = openTemplatesModal;

// ── Escape key: close templates modal ────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('cext-templates-overlay')) {
    closeTemplatesModal();
  }
}, { capture: true });

// ── Storage reactivity ────────────────────────────────────────────────────────
Storage.onChange((changes) => {
  if (changes.promptTemplates) {
    loadCustomTemplates();
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────

async function initTemplatesModule() {
  await loadCustomTemplates();
  initTemplateTrigger();
  console.debug('[ClaudeExt:Templates] Initialised. Custom templates:', Object.keys(_customTemplates).length);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initTemplatesModule);
} else {
  initTemplatesModule();
}
