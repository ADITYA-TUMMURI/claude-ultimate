/**
 * fetch-override.js
 * Runs in MAIN world (world: "MAIN", document_start).
 * Intercepts both EventSource and fetch() on claude.ai,
 * parses SSE frames, and forwards events to the ISOLATED
 * content script via window.postMessage.
 *
 * Message envelope:
 *   { source: 'CLAUDE_EXT', type: string, payload: object }
 */

(function () {
  'use strict';

  const SOURCE = 'CLAUDE_EXT';

  /** Post a typed message to the ISOLATED content script. */
  function relay(type, payload) {
    window.postMessage({ source: SOURCE, type, payload }, '*');
  }

  /**
   * Parse a raw SSE buffer into an array of parsed JSON objects.
   * Claude sends frames like:
   *   event: message_start\ndata: {...}\n\n
   * We only care about the data lines.
   */
  function parseSSEBuffer(buffer) {
    const results = [];
    const blocks = buffer.split(/\n\n+/);
    for (const block of blocks) {
      let eventType = null;
      let dataStr = null;
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) eventType = line.slice(7).trim();
        if (line.startsWith('data: ')) dataStr = line.slice(6).trim();
      }
      if (dataStr) {
        try {
          const parsed = JSON.parse(dataStr);
          if (eventType) parsed._sseEvent = eventType;
          results.push(parsed);
        } catch (_) { /* not JSON, skip */ }
      }
    }
    return results;
  }

  /** Dispatch parsed SSE objects as relay messages. */
  function dispatchSSEObject(obj) {
    const type = obj.type || obj._sseEvent;
    switch (type) {
      case 'message_start': {
        const msg = obj.message || {};
        relay('SSE_MESSAGE_START', {
          messageId: msg.id || null,
          model: msg.model || null,
          usage: {
            input_tokens: msg.usage?.input_tokens ?? 0,
            output_tokens: msg.usage?.output_tokens ?? 0,
          },
        });
        break;
      }
      case 'message_delta': {
        relay('SSE_MESSAGE_DELTA', {
          usage: {
            output_tokens: obj.usage?.output_tokens ?? 0,
          },
          stop_reason: obj.delta?.stop_reason ?? null,
        });
        break;
      }
      case 'message_stop':
        relay('SSE_STREAM_END', {});
        break;
      default:
        break;
    }
  }

  // ── 1. Intercept EventSource ─────────────────────────────────────────────

  const OriginalEventSource = window.EventSource;

  function PatchedEventSource(url, options) {
    const es = new OriginalEventSource(url, options);

    const origAEL = es.addEventListener.bind(es);
    es.addEventListener = function (type, listener, opts) {
      const wrapped = function (event) {
        if (type === 'message' || type === '') {
          try {
            const parsed = JSON.parse(event.data);
            dispatchSSEObject(parsed);
          } catch (_) { /* not JSON */ }
        }
        return listener.call(this, event);
      };
      return origAEL(type, wrapped, opts);
    };

    // Also patch the onmessage setter
    let _onmessage = null;
    Object.defineProperty(es, 'onmessage', {
      get() { return _onmessage; },
      set(fn) {
        _onmessage = fn;
        origAEL('message', function (event) {
          try {
            const parsed = JSON.parse(event.data);
            dispatchSSEObject(parsed);
          } catch (_) {}
          if (fn) fn.call(es, event);
        });
      },
    });

    return es;
  }

  // Copy static members
  PatchedEventSource.CONNECTING = OriginalEventSource.CONNECTING;
  PatchedEventSource.OPEN = OriginalEventSource.OPEN;
  PatchedEventSource.CLOSED = OriginalEventSource.CLOSED;
  PatchedEventSource.prototype = OriginalEventSource.prototype;

  window.EventSource = PatchedEventSource;

  // ── 2. Intercept fetch() ─────────────────────────────────────────────────

  const SSE_URL_PATTERNS = [
    '/api/organizations/',   // covers /api/organizations/.../completion
    '/completion',
    '/chat_conversations',
  ];

  function isSSEUrl(url) {
    try {
      const u = typeof url === 'string' ? url : url instanceof URL ? url.href : url?.url ?? '';
      return SSE_URL_PATTERNS.some(p => u.includes(p));
    } catch (_) {
      return false;
    }
  }

  const originalFetch = window.fetch;

  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);

    const url = args[0];
    if (!isSSEUrl(url)) return response;

    // Only tap responses that look like SSE (text/event-stream)
    const ct = response.headers.get('content-type') || '';
    if (!ct.includes('event-stream') && !ct.includes('text/plain')) {
      return response;
    }

    const clone = response.clone();

    // Consume clone in background — do NOT await, return original immediately
    (async () => {
      try {
        const reader = clone.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            relay('SSE_STREAM_END', {});
            break;
          }
          buffer += decoder.decode(value, { stream: true });

          // Split on double-newline SSE frame boundaries
          const parts = buffer.split('\n\n');
          buffer = parts.pop(); // keep incomplete trailing frame

          for (const part of parts) {
            const objects = parseSSEBuffer(part + '\n\n');
            for (const obj of objects) {
              dispatchSSEObject(obj);
            }
          }
        }
      } catch (err) {
        // Silently ignore — page still works normally via original response
      }
    })();

    return response;
  };

})();
