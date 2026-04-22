/**
 * lib/sse-parser.js
 * Parses Claude SSE stream frames into structured data objects.
 *
 * Claude's SSE stream emits frames in this sequence:
 *   message_start   → input_tokens, model
 *   content_block_start / content_block_delta  → streaming text
 *   message_delta   → cumulative output_tokens, stop_reason
 *   message_stop    → end of stream
 *
 * This module is imported by service-worker.js (ES module context)
 * and also loaded as a content script so content.js can use it.
 */

'use strict';

// ── Raw SSE buffer → array of parsed frame objects ───────────────────────────

/**
 * Split and parse a raw SSE buffer (may contain multiple frames).
 * Each frame is separated by "\n\n".
 *
 * @param {string} buffer - Raw SSE text (one or more frames)
 * @returns {Array<{type: string, [key: string]: any}>}
 */
function parseSSEBuffer(buffer) {
  const results = [];
  const blocks = buffer.split(/\n\n+/);

  for (const block of blocks) {
    if (!block.trim()) continue;

    let eventType = null;
    let dataLine = null;

    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) {
        eventType = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        dataLine = line.slice(6).trim();
      }
    }

    if (!dataLine || dataLine === '[DONE]') continue;

    try {
      const obj = JSON.parse(dataLine);
      // Prefer explicit event: field; fall back to type field inside data
      if (eventType && !obj.type) obj.type = eventType;
      results.push(obj);
    } catch (_) {
      // Malformed JSON — skip silently
    }
  }

  return results;
}

// ── Typed extractors ─────────────────────────────────────────────────────────

/**
 * Parse a message_start event object.
 * Returns null if the object is not a valid message_start.
 *
 * @param {object|string} raw - Parsed SSE object OR raw data string
 * @returns {{messageId: string, model: string, usage: {input_tokens: number, output_tokens: number}} | null}
 */
function parseMessageStart(raw) {
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!obj || obj.type !== 'message_start') return null;

    const msg = obj.message || {};
    return {
      messageId:    msg.id         ?? null,
      model:        msg.model      ?? null,
      usage: {
        input_tokens:  msg.usage?.input_tokens  ?? 0,
        output_tokens: msg.usage?.output_tokens ?? 0,
      },
    };
  } catch (_) {
    return null;
  }
}

/**
 * Parse a message_delta event object.
 * Returns null if not a valid message_delta with usage data.
 *
 * @param {object|string} raw
 * @returns {{output_tokens: number, stop_reason: string|null} | null}
 */
function parseMessageDelta(raw) {
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!obj || obj.type !== 'message_delta') return null;

    return {
      output_tokens: obj.usage?.output_tokens ?? 0,
      stop_reason:   obj.delta?.stop_reason   ?? null,
    };
  } catch (_) {
    return null;
  }
}

/**
 * Generic usage extractor — works on any SSE object that has a usage field.
 * Used as a fallback when event type is ambiguous.
 *
 * @param {object|string} raw
 * @returns {{input_tokens: number, output_tokens: number} | null}
 */
function extractUsage(raw) {
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!obj) return null;

    // message_start nests usage inside message
    const usage = obj.usage ?? obj.message?.usage ?? null;
    if (!usage) return null;

    return {
      input_tokens:  usage.input_tokens  ?? 0,
      output_tokens: usage.output_tokens ?? 0,
    };
  } catch (_) {
    return null;
  }
}

/**
 * Extract model string from any SSE object that contains it.
 *
 * @param {object|string} raw
 * @returns {string|null}
 */
function extractModel(raw) {
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!obj) return null;
    return obj.model ?? obj.message?.model ?? null;
  } catch (_) {
    return null;
  }
}

/**
 * High-level: process a complete SSE buffer and return an array of
 * typed action descriptors ready for the service worker to act on.
 *
 * @param {string} buffer
 * @returns {Array<{action: string, [key: string]: any}>}
 */
function processSSEBuffer(buffer) {
  const frames = parseSSEBuffer(buffer);
  const actions = [];

  for (const frame of frames) {
    switch (frame.type) {
      case 'message_start': {
        const parsed = parseMessageStart(frame);
        if (parsed) {
          actions.push({ action: 'MESSAGE_START', ...parsed });
        }
        break;
      }
      case 'message_delta': {
        const parsed = parseMessageDelta(frame);
        if (parsed) {
          actions.push({ action: 'MESSAGE_DELTA', ...parsed });
        }
        break;
      }
      case 'message_stop':
        actions.push({ action: 'MESSAGE_STOP' });
        break;
      default:
        break;
    }
  }

  return actions;
}
