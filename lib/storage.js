/**
 * lib/storage.js
 * Thin, validated wrapper around chrome.storage.local.
 * Loaded as a content script before content.js so Storage
 * is available as a global in the ISOLATED world.
 *
 * Also exports StorageDefaults — single source of truth
 * for initial values, referenced by service-worker.js too.
 */

// ── Default schema ───────────────────────────────────────────────────────────
const StorageDefaults = {
  tokenCount: { session: 0, weekly: 0, lastUpdated: 0 },
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
  customInstructionsEnabled: true,
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
    email:
      'Draft a professional email:\nTo: [RECIPIENT]\nSubject: [SUBJECT]\nTone: [TONE]',
    explain:
      'Explain [CONCEPT] in a way that a [AUDIENCE] would understand.',
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

// ── Storage API ──────────────────────────────────────────────────────────────
const Storage = {
  /**
   * Get a single key. Returns the stored value or the default if missing.
   * @param {string} key
   * @returns {Promise<any>}
   */
  async get(key) {
    try {
      const result = await chrome.storage.local.get(key);
      if (chrome.runtime.lastError) {
        console.warn('[ClaudeExt:Storage] get error:', chrome.runtime.lastError.message);
        return StorageDefaults[key] ?? null;
      }
      return result[key] ?? StorageDefaults[key] ?? null;
    } catch (err) {
      console.warn('[ClaudeExt:Storage] get exception:', err);
      return StorageDefaults[key] ?? null;
    }
  },

  /**
   * Get multiple keys at once.
   * @param {string[]} keys
   * @returns {Promise<object>}
   */
  async getMultiple(keys) {
    try {
      const result = await chrome.storage.local.get(keys);
      if (chrome.runtime.lastError) {
        console.warn('[ClaudeExt:Storage] getMultiple error:', chrome.runtime.lastError.message);
      }
      // Fill missing keys with defaults
      const out = {};
      for (const k of keys) {
        out[k] = result[k] ?? StorageDefaults[k] ?? null;
      }
      return out;
    } catch (err) {
      console.warn('[ClaudeExt:Storage] getMultiple exception:', err);
      const out = {};
      for (const k of keys) out[k] = StorageDefaults[k] ?? null;
      return out;
    }
  },

  /**
   * Set a single key.
   * @param {string} key
   * @param {any} value
   */
  async set(key, value) {
    try {
      await chrome.storage.local.set({ [key]: value });
      if (chrome.runtime.lastError) {
        console.warn('[ClaudeExt:Storage] set error:', chrome.runtime.lastError.message);
      }
    } catch (err) {
      console.warn('[ClaudeExt:Storage] set exception:', err);
    }
  },

  /**
   * Set multiple keys at once.
   * @param {object} obj
   */
  async setMultiple(obj) {
    try {
      await chrome.storage.local.set(obj);
      if (chrome.runtime.lastError) {
        console.warn('[ClaudeExt:Storage] setMultiple error:', chrome.runtime.lastError.message);
      }
    } catch (err) {
      console.warn('[ClaudeExt:Storage] setMultiple exception:', err);
    }
  },

  /**
   * Subscribe to storage changes. Callback receives (changes, area).
   * @param {function} callback
   */
  onChange(callback) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      try {
        callback(changes);
      } catch (err) {
        console.warn('[ClaudeExt:Storage] onChange callback error:', err);
      }
    });
  },

  // ── Tag helpers ──────────────────────────────────────────────────────────────

  /**
   * Get tags for a specific conversation.
   * @param {string} conversationId
   * @returns {Promise<string[]>}
   */
  async getTags(conversationId) {
    try {
      const all = await this.get('conversationTags');
      return Array.isArray(all?.[conversationId]) ? all[conversationId] : [];
    } catch (err) {
      console.warn('[ClaudeExt:Storage] getTags error:', err);
      return [];
    }
  },

  /**
   * Add a tag to a conversation (no-op if duplicate or limit reached).
   * @param {string} conversationId
   * @param {string} tag
   * @returns {Promise<{ok: boolean, reason?: string}>}
   */
  async addTag(conversationId, tag) {
    const trimmed = (tag || '').trim();
    if (!trimmed)                    return { ok: false, reason: 'empty' };
    if (trimmed.length > 20)         return { ok: false, reason: 'too_long' };

    try {
      const all  = (await this.get('conversationTags')) || {};
      const tags = Array.isArray(all[conversationId]) ? all[conversationId] : [];

      // Case-insensitive duplicate check
      if (tags.some(t => t.toLowerCase() === trimmed.toLowerCase())) {
        return { ok: false, reason: 'duplicate' };
      }
      if (tags.length >= 10) return { ok: false, reason: 'limit' };

      all[conversationId] = [...tags, trimmed];
      await this.set('conversationTags', all);
      return { ok: true };
    } catch (err) {
      console.warn('[ClaudeExt:Storage] addTag error:', err);
      return { ok: false, reason: 'error' };
    }
  },

  /**
   * Remove a tag from a conversation.
   * @param {string} conversationId
   * @param {string} tag
   * @returns {Promise<boolean>}
   */
  async removeTag(conversationId, tag) {
    try {
      const all  = (await this.get('conversationTags')) || {};
      const tags = Array.isArray(all[conversationId]) ? all[conversationId] : [];
      all[conversationId] = tags.filter(t => t !== tag);
      await this.set('conversationTags', all);
      return true;
    } catch (err) {
      console.warn('[ClaudeExt:Storage] removeTag error:', err);
      return false;
    }
  },

  /**
   * Get the full conversationTags object (all conversations).
   * @returns {Promise<object>}
   */
  async getAllConversationTags() {
    try {
      return (await this.get('conversationTags')) || {};
    } catch (err) {
      console.warn('[ClaudeExt:Storage] getAllConversationTags error:', err);
      return {};
    }
  },
};
