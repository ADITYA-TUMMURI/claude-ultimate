/**
 * lib/message-processor.js
 * Pure functions for message transformation pipeline.
 * No side effects. No storage calls. No DOM access.
 *
 * Pipeline order (applied by processMessage):
 *   1. customInstructions  — prepend once per new chat
 *   2. responseLength      — prepend length directive
 *   3. modePreset          — prepend style directive
 *   4. trim                — clean up filler/duplicates (code blocks preserved)
 */

'use strict';

// ── Filler word list ──────────────────────────────────────────────────────────

const FILLER_WORDS = [
  'like',
  'uhh',
  'uhm',
  'umm',
  'hmm',
  'basically',
  'actually',
  'literally',
  'you know',
  'i mean',
  'sort of',
  'kind of',
  'right',
  'so yeah',
  'anyway',
];

// Pre-compile the filler regex (word-boundary aware, multi-word phrases first)
// Sort by length descending so multi-word phrases match before single words
const _fillerPattern = FILLER_WORDS
  .slice()
  .sort((a, b) => b.length - a.length)
  .map(w => w.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&'))
  .join('|');

const _fillerRegex = new RegExp(`\\b(?:${_fillerPattern})\\b`, 'gi');

// ── Code block / URL extraction ────────────────────────────────────────────────

/**
 * Split text into segments: [{ raw, isProtected }]
 * Protected segments = fenced code blocks (``` ... ```) and URLs.
 * Trimmer will skip protected segments entirely.
 *
 * @param {string} text
 * @returns {Array<{raw: string, isProtected: boolean}>}
 */
function segmentText(text) {
  // Match fenced code blocks (``` or ~~~) and inline code (`...`)
  // Also match bare URLs (http/https)
  const protectedPattern = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`|https?:\/\/\S+)/g;

  const segments = [];
  let lastIndex = 0;
  let match;

  while ((match = protectedPattern.exec(text)) !== null) {
    // Text before this protected block
    if (match.index > lastIndex) {
      segments.push({ raw: text.slice(lastIndex, match.index), isProtected: false });
    }
    segments.push({ raw: match[0], isProtected: true });
    lastIndex = match.index + match[0].length;
  }

  // Remaining tail
  if (lastIndex < text.length) {
    segments.push({ raw: text.slice(lastIndex), isProtected: false });
  }

  return segments;
}

// ── Core transformations ──────────────────────────────────────────────────────

/**
 * Trim a plain-text segment (no code blocks or URLs inside).
 * @param {string} text
 * @returns {string}
 */
function trimSegment(text) {
  return text
    .replace(_fillerRegex, '')                  // remove filler words
    .replace(/([!?.:])\1+/g, '$1')             // !!! → !   ???  → ?
    .replace(/\b(\w+)(\s+\1)+\b/gi, '$1')      // duplicate adjacent words
    .replace(/[ \t]{2,}/g, ' ')                // collapse horizontal whitespace
    .replace(/\n{3,}/g, '\n\n');               // max two consecutive newlines
}

/**
 * Trim a message, preserving code blocks and URLs.
 * @param {string} message
 * @returns {string}
 */
function trim(message) {
  if (!message) return '';
  const segments = segmentText(message);
  return segments
    .map(seg => seg.isProtected ? seg.raw : trimSegment(seg.raw))
    .join('')
    .trim();
}

/**
 * Prepend instruction to message with double-newline separator.
 * Returns unchanged message if instruction is empty.
 *
 * @param {string} instruction
 * @param {string} message
 * @returns {string}
 */
function prepend(instruction, message) {
  const instr = (instruction || '').trim();
  if (!instr) return message;
  return `${instr}\n\n${message}`;
}

/**
 * Apply a mode preset instruction (caveman, bullet, noPreamble, etc.)
 *
 * @param {string|null} mode      - Key into presets object (e.g. "bullet")
 * @param {string}      message
 * @param {object}      presets   - Map of mode key → instruction string
 * @returns {string}
 */
function applyModePreset(mode, message, presets) {
  if (!mode || !presets || typeof presets !== 'object') return message;
  const instruction = presets[mode];
  if (!instruction) return message;
  return prepend(instruction, message);
}

/**
 * Apply a response length directive (short, medium, detailed).
 *
 * @param {string|null} mode   - "short" | "medium" | "detailed"
 * @param {string}      message
 * @param {object}      modes  - Map of mode key → instruction string
 * @returns {string}
 */
function applyResponseLength(mode, message, modes) {
  if (!mode || !modes || typeof modes !== 'object') return message;
  const instruction = modes[mode];
  if (!instruction) return message;
  return prepend(instruction, message);
}

// ── Full pipeline ─────────────────────────────────────────────────────────────

/**
 * Run the full message transformation pipeline.
 *
 * @param {string} rawText  - User's original message text
 * @param {object} settings - Pulled from chrome.storage.local:
 *   {
 *     customInstructions:          string,
 *     instructionsPrependedThisChat: bool,
 *     selectedMode:                string|null,
 *     modePresets:                 object,
 *     responseLengthMode:          string|null,
 *     responseLengthModes:         object,
 *     trimmerEnabled:              bool,
 *   }
 * @returns {{ text: string, prepended: boolean }}
 *   text      - Processed message
 *   prepended - Whether customInstructions were added this call
 */
function processMessage(rawText, settings) {
  if (!rawText || !rawText.trim()) {
    return { text: rawText, prepended: false };
  }

  let text = rawText;
  let prepended = false;

  // Step 1: Trim first (clean up user's text before prepending instructions)
  if (settings.trimmerEnabled) {
    text = trim(text);
  }

  // Step 2: Mode preset (e.g. "Respond in bullet points only.")
  if (settings.selectedMode && settings.modePresets) {
    text = applyModePreset(settings.selectedMode, text, settings.modePresets);
  }

  // Step 3: Response length (e.g. "Respond in 3-5 sentences.")
  if (settings.responseLengthMode && settings.responseLengthModes) {
    text = applyResponseLength(settings.responseLengthMode, text, settings.responseLengthModes);
  }

  // Step 4: Custom instructions — only on first message of each new chat
  if (
    settings.customInstructions &&
    settings.customInstructions.trim() &&
    !settings.instructionsPrependedThisChat
  ) {
    text = prepend(settings.customInstructions, text);
    prepended = true;
  }

  return { text, prepended };
}

// ── Expose as global (content script context, no ES module) ──────────────────

const MessageProcessor = { trim, prepend, applyModePreset, applyResponseLength, processMessage };
