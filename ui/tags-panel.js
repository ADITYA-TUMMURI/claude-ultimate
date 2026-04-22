/**
 * ui/tags-panel.js
 * Phase 7: Per-Conversation Tag System
 *
 * Injects a tags panel into the sidebar below the model section.
 * Tags are stored per conversation ID in chrome.storage.local.conversationTags.
 *
 * Responsibilities:
 *  - Render current conversation's tags as coloured pill buttons
 *  - "+" button opens an inline text input to add a tag
 *  - Enter / Tab → save tag; Escape → cancel
 *  - "×" on each pill → remove tag
 *  - Reacts to URL changes (pushState/popstate) → loads tags for new conversation
 *  - Reacts to storage.onChanged → instant cross-tab sync
 *  - Validates: no empty, no duplicates (case-insensitive), max 10, max 20 chars
 *
 * Depends on: lib/storage.js (Storage global, tag helpers)
 * Loaded after: ui/templates-modal.js
 */

'use strict';

// ── State ──────────────────────────────────────────────────────────────────────

const TagsState = {
  conversationId: '',    // current conversation UUID
  tags:           [],    // string[] — current conversation's tags
  inputOpen:      false, // whether the add-tag input is visible
};

// ── Color hashing ─────────────────────────────────────────────────────────────

/**
 * Deterministically map a tag string to one of 12 distinct hues.
 * Uses a simple djb2-style hash so the same tag always gets the same colour.
 * @param {string} tag
 * @returns {string} HSL colour string
 */
function tagColor(tag) {
  const HUES = [210, 280, 160, 40, 0, 300, 180, 60, 340, 100, 240, 20];
  let hash = 5381;
  for (let i = 0; i < tag.length; i++) {
    hash = ((hash << 5) + hash) ^ tag.charCodeAt(i);
    hash = hash >>> 0; // keep unsigned 32-bit
  }
  const hue = HUES[hash % HUES.length];
  return `hsl(${hue}, 70%, 62%)`;
}

/**
 * Return a very subtle background for a tag pill (10% opacity of its colour).
 */
function tagBg(tag) {
  const HUES = [210, 280, 160, 40, 0, 300, 180, 60, 340, 100, 240, 20];
  let hash = 5381;
  for (let i = 0; i < tag.length; i++) {
    hash = ((hash << 5) + hash) ^ tag.charCodeAt(i);
    hash = hash >>> 0;
  }
  const hue = HUES[hash % HUES.length];
  return `hsla(${hue}, 70%, 62%, 0.12)`;
}

// ── DOM helpers ───────────────────────────────────────────────────────────────

function getTagsContainer() {
  return document.getElementById('cext-tags-container');
}

function getAddTagInput() {
  return document.getElementById('cext-add-tag-input');
}

// ── Core render ───────────────────────────────────────────────────────────────

/**
 * Full re-render of the tags row inside the panel.
 * This is idempotent — safe to call on every state change.
 */
function renderTagsPanel() {
  const container = getTagsContainer();
  if (!container) return;

  container.innerHTML = '';

  const isNewChat = !TagsState.conversationId ||
    location.pathname === '/new' ||
    location.pathname === '/';

  // ── Tag pills ──────────────────────────────────────────────────────────────
  for (const tag of TagsState.tags) {
    container.appendChild(buildTagPill(tag));
  }

  // ── Add tag input (shown when inputOpen) ──────────────────────────────────
  if (TagsState.inputOpen && !isNewChat) {
    container.appendChild(buildAddTagInput());
    // Focus after inserting
    requestAnimationFrame(() => {
      const input = getAddTagInput();
      if (input) input.focus();
    });
  }

  // ── "+" button ─────────────────────────────────────────────────────────────
  if (!isNewChat && TagsState.tags.length < 10 && !TagsState.inputOpen) {
    const addBtn = document.createElement('button');
    addBtn.className = 'cext-tag-add-btn';
    addBtn.id = 'cext-tag-add-btn';
    addBtn.setAttribute('aria-label', 'Add tag');
    addBtn.title = `Add tag (${TagsState.tags.length}/10)`;
    addBtn.textContent = '+';
    addBtn.addEventListener('click', openTagInput);
    container.appendChild(addBtn);
  }

  // ── Empty state ────────────────────────────────────────────────────────────
  if (TagsState.tags.length === 0 && !TagsState.inputOpen && !isNewChat) {
    const hint = document.createElement('span');
    hint.className = 'cext-tags-hint';
    hint.textContent = 'No tags yet';
    container.insertBefore(hint, container.firstChild);
  }

  // ── New-chat state ─────────────────────────────────────────────────────────
  if (isNewChat) {
    const hint = document.createElement('span');
    hint.className = 'cext-tags-hint';
    hint.textContent = 'Tags available after first message';
    container.appendChild(hint);
  }

  // Update the tag count display
  const countEl = document.getElementById('cext-tags-count');
  if (countEl) {
    countEl.textContent = isNewChat ? '' : `${TagsState.tags.length}/10`;
    countEl.style.opacity = TagsState.tags.length === 0 ? '0' : '1';
  }
}

function buildTagPill(tag) {
  const pill = document.createElement('span');
  pill.className = 'cext-tag-pill';
  pill.style.setProperty('--tag-color', tagColor(tag));
  pill.style.setProperty('--tag-bg',    tagBg(tag));
  pill.title = tag;

  const label = document.createElement('span');
  label.className = 'cext-tag-pill-label';
  label.textContent = tag;

  const removeBtn = document.createElement('button');
  removeBtn.className = 'cext-tag-remove';
  removeBtn.setAttribute('aria-label', `Remove tag: ${tag}`);
  removeBtn.textContent = '×';
  removeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    handleRemoveTag(tag);
  });

  pill.appendChild(label);
  pill.appendChild(removeBtn);
  return pill;
}

function buildAddTagInput() {
  const wrap = document.createElement('div');
  wrap.className = 'cext-tag-input-wrap';

  const input = document.createElement('input');
  input.type = 'text';
  input.id = 'cext-add-tag-input';
  input.className = 'cext-tag-input';
  input.placeholder = 'tag name…';
  input.maxLength = 20;
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('spellcheck', 'false');

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      handleSaveTag(input.value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeTagInput();
    }
  });

  // Also save on blur (clicking away)
  input.addEventListener('blur', () => {
    // Short delay so click events on pills can fire first
    setTimeout(() => {
      if (input.value.trim()) {
        handleSaveTag(input.value);
      } else {
        closeTagInput();
      }
    }, 150);
  });

  // Character counter
  const counter = document.createElement('span');
  counter.className = 'cext-tag-char-counter';
  counter.textContent = '0/20';

  input.addEventListener('input', () => {
    const len = input.value.length;
    counter.textContent = `${len}/20`;
    counter.style.color = len >= 18 ? '#ef4444' : 'rgba(255,255,255,0.3)';
  });

  wrap.appendChild(input);
  wrap.appendChild(counter);
  return wrap;
}

// ── Event handlers ────────────────────────────────────────────────────────────

function openTagInput() {
  TagsState.inputOpen = true;
  renderTagsPanel();
}

function closeTagInput() {
  TagsState.inputOpen = false;
  renderTagsPanel();
}

async function handleSaveTag(raw) {
  const tag = (raw || '').trim();
  TagsState.inputOpen = false;

  if (!tag) {
    renderTagsPanel();
    return;
  }

  // Client-side validation before the storage call
  if (tag.length > 20) {
    showTagFeedback('Tag too long (max 20 chars)', 'error');
    renderTagsPanel();
    return;
  }

  const duplicate = TagsState.tags.some(t => t.toLowerCase() === tag.toLowerCase());
  if (duplicate) {
    showTagFeedback('Tag already exists', 'warn');
    renderTagsPanel();
    return;
  }

  if (TagsState.tags.length >= 10) {
    showTagFeedback('Max 10 tags per conversation', 'warn');
    renderTagsPanel();
    return;
  }

  // Optimistic update
  TagsState.tags = [...TagsState.tags, tag];
  renderTagsPanel();

  // Persist (storage.onChange will fire and confirm)
  const result = await Storage.addTag(TagsState.conversationId, tag);
  if (!result.ok) {
    // Roll back on failure
    TagsState.tags = TagsState.tags.filter(t => t !== tag);
    renderTagsPanel();
    showTagFeedback(
      result.reason === 'duplicate' ? 'Already exists' :
      result.reason === 'limit'     ? 'Max 10 tags'    :
      result.reason === 'too_long'  ? 'Max 20 chars'   : 'Error saving tag',
      'error'
    );
  }
}

async function handleRemoveTag(tag) {
  // Optimistic update
  const prev = TagsState.tags;
  TagsState.tags = TagsState.tags.filter(t => t !== tag);
  renderTagsPanel();

  // Persist
  const ok = await Storage.removeTag(TagsState.conversationId, tag);
  if (!ok) {
    // Roll back
    TagsState.tags = prev;
    renderTagsPanel();
    showTagFeedback('Error removing tag', 'error');
  }
}

// ── Feedback toast ────────────────────────────────────────────────────────────

function showTagFeedback(message, level = 'info') {
  // Reuse the singleton toast
  let toast = document.getElementById('cext-toast-singleton');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'cext-toast-singleton';
    toast.className = 'cext-toast';
    document.body.appendChild(toast);
  }
  const prefix = level === 'error' ? '⚠ ' : level === 'warn' ? '⚡ ' : '';
  toast.textContent = prefix + message;
  toast.classList.add('cext-toast-show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('cext-toast-show'), 2000);
}

// ── Conversation tracking ─────────────────────────────────────────────────────

function extractConversationId() {
  const match = location.pathname.match(/\/chat\/([a-f0-9-]{8,})/i);
  return match ? match[1] : '';
}

async function onConversationChange() {
  const newId = extractConversationId();

  if (newId === TagsState.conversationId) return; // no change

  TagsState.conversationId = newId;
  TagsState.inputOpen = false;

  // Load tags for new conversation (or empty array for /new)
  if (newId) {
    TagsState.tags = await Storage.getTags(newId);
  } else {
    TagsState.tags = [];
  }

  renderTagsPanel();
  console.debug('[ClaudeExt:Tags] Conversation changed →', newId || '(new/none)',
    `| tags: [${TagsState.tags.join(', ')}]`);
}

// ── Sidebar section injection ─────────────────────────────────────────────────

/**
 * Inject the tags section into the sidebar.
 * Called after the sidebar HTML is built (sidebar.js runs first).
 */
function injectTagsSection() {
  // Don't double-inject
  if (document.getElementById('cext-tags-section')) return;

  // Target: the sidebar panel body
  const panelBody = document.getElementById('cext-panel-body');
  if (!panelBody) return;

  // Build the tags section
  const section = document.createElement('section');
  section.className = 'cext-section';
  section.id = 'cext-tags-section';

  // Section header row
  const headerRow = document.createElement('div');
  headerRow.className = 'cext-tags-header';

  const titleEl = document.createElement('h4');
  titleEl.className = 'cext-section-title';
  titleEl.textContent = 'Tags';

  const countEl = document.createElement('span');
  countEl.className = 'cext-tags-count-badge';
  countEl.id = 'cext-tags-count';
  countEl.textContent = '';

  headerRow.appendChild(titleEl);
  headerRow.appendChild(countEl);
  section.appendChild(headerRow);

  // Tags container (pills + input live here)
  const container = document.createElement('div');
  container.className = 'cext-tags-container';
  container.id = 'cext-tags-container';
  section.appendChild(container);

  // Insert before the actions section (#cext-actions)
  const actionsSection = document.getElementById('cext-actions');
  if (actionsSection) {
    panelBody.insertBefore(section, actionsSection);
  } else {
    panelBody.appendChild(section);
  }
}

// ── Storage reactivity ────────────────────────────────────────────────────────

Storage.onChange((changes) => {
  if (!changes.conversationTags) return;

  const newAll = changes.conversationTags.newValue || {};
  const convId = TagsState.conversationId;
  if (!convId) return;

  const freshTags = Array.isArray(newAll[convId]) ? newAll[convId] : [];

  // Only re-render if the tags actually changed (avoid loop from own writes)
  const same = JSON.stringify(freshTags) === JSON.stringify(TagsState.tags);
  if (!same) {
    TagsState.tags = freshTags;
    renderTagsPanel();
  }
});

// ── URL change hook ───────────────────────────────────────────────────────────
// content.js already patches pushState/replaceState + popstate.
// We additionally listen to the custom ROUTE_CHANGE postMessage
// that content.js fires, OR poll via a simple check.

/**
 * Poll for conversation ID changes.
 * This is a lightweight 500ms poll that only triggers when the path actually changed.
 * Used as a backup to the pushState patch.
 */
let _lastPath = location.pathname;

function startRoutePoller() {
  setInterval(() => {
    if (location.pathname !== _lastPath) {
      _lastPath = location.pathname;
      onConversationChange();
    }
  }, 500);
}

// Also hook into the window-level pushState patch if available
const _origPushState = history.pushState.bind(history);
history.pushState = function (...args) {
  _origPushState(...args);
  onConversationChange();
};

const _origReplaceState = history.replaceState.bind(history);
history.replaceState = function (...args) {
  _origReplaceState(...args);
  onConversationChange();
};

window.addEventListener('popstate', onConversationChange);

// ── Init ──────────────────────────────────────────────────────────────────────

async function initTagsModule() {
  // Wait for sidebar to be ready
  let attempts = 0;
  const waitForSidebar = () => new Promise((resolve) => {
    const check = () => {
      if (document.getElementById('cext-panel-body') || attempts++ > 20) {
        resolve();
      } else {
        setTimeout(check, 150);
      }
    };
    check();
  });

  await waitForSidebar();

  injectTagsSection();

  // Load initial conversation
  TagsState.conversationId = extractConversationId();
  if (TagsState.conversationId) {
    TagsState.tags = await Storage.getTags(TagsState.conversationId);
  }

  renderTagsPanel();
  startRoutePoller();

  console.debug('[ClaudeExt:Tags] Initialised.',
    'Conv:', TagsState.conversationId || '(none)',
    '| Tags:', TagsState.tags);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initTagsModule);
} else {
  initTagsModule();
}
