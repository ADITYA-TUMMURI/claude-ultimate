/**
 * lib/timer.js
 * Lightweight countdown timer engine using requestAnimationFrame.
 * Zero server calls — all arithmetic against Date.now().
 *
 * Usage (content script context):
 *   const id = CountdownTimer.start(targetMs, (formatted, remaining) => {
 *     el.textContent = formatted;
 *   });
 *   CountdownTimer.stop(id);
 *
 * Supports multiple independent concurrent timers via IDs.
 */

'use strict';

const CountdownTimer = (() => {

  /** @type {Map<string, {target: number, cb: function, rafId: number|null}>} */
  const _timers = new Map();
  let _nextId = 1;

  // ── Formatting ─────────────────────────────────────────────────────────────

  /**
   * Format remaining milliseconds into a human-readable string.
   *
   * Rules:
   *   ≥ 2 days  →  "3d 4h"
   *   ≥ 1 hour  →  "2h 15m"
   *   ≥ 1 min   →  "45m 30s"
   *   < 1 min   →  "30s"
   *   ≤ 0       →  "now"
   *
   * @param {number} ms - Remaining milliseconds (may be negative)
   * @returns {string}
   */
  function formatRemaining(ms) {
    if (ms <= 0) return 'now';

    const totalSec = Math.floor(ms / 1000);
    const days  = Math.floor(totalSec / 86400);
    const hours = Math.floor((totalSec % 86400) / 3600);
    const mins  = Math.floor((totalSec % 3600) / 60);
    const secs  = totalSec % 60;

    if (days >= 2) return `${days}d ${hours}h`;
    if (days === 1) return `${days}d ${hours}h`;
    if (hours >= 1) return `${hours}h ${mins}m`;
    if (mins >= 1) return `${mins}m ${secs}s`;
    return `${secs}s`;
  }

  // ── Core tick loop ─────────────────────────────────────────────────────────

  function _tick(id) {
    const entry = _timers.get(id);
    if (!entry) return; // timer was stopped

    const remaining = entry.target - Date.now();
    const formatted = formatRemaining(remaining);

    try {
      entry.cb(formatted, remaining);
    } catch (err) {
      console.warn('[ClaudeExt:Timer] callback error for', id, err);
    }

    if (remaining > 0) {
      // Schedule next tick — aim for ~1s updates but use rAF for accuracy
      entry.rafId = requestAnimationFrame(() => _tick(id));
    } else {
      // Timer expired — fire once more with "now" then auto-stop
      _timers.delete(id);
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Start a countdown timer.
   *
   * @param {number} targetMs - Target unix timestamp in milliseconds
   * @param {function(formatted: string, remainingMs: number): void} onTick
   *   Called immediately and then approximately every second.
   * @returns {string} Timer ID (pass to stop() to cancel)
   */
  function start(targetMs, onTick) {
    if (typeof targetMs !== 'number' || !Number.isFinite(targetMs)) {
      console.warn('[ClaudeExt:Timer] start() — invalid targetMs:', targetMs);
      return null;
    }
    if (typeof onTick !== 'function') {
      console.warn('[ClaudeExt:Timer] start() — onTick must be a function');
      return null;
    }

    const id = String(_nextId++);
    _timers.set(id, { target: targetMs, cb: onTick, rafId: null });

    // Kick off immediately (on next animation frame)
    requestAnimationFrame(() => _tick(id));

    return id;
  }

  /**
   * Stop a running countdown timer.
   * @param {string|null} id - Timer ID returned by start(), or null (no-op)
   */
  function stop(id) {
    if (!id) return;
    const entry = _timers.get(id);
    if (entry?.rafId) cancelAnimationFrame(entry.rafId);
    _timers.delete(id);
  }

  /**
   * Stop all running timers (e.g., on extension unload / route change).
   */
  function stopAll() {
    for (const [id, entry] of _timers) {
      if (entry.rafId) cancelAnimationFrame(entry.rafId);
    }
    _timers.clear();
  }

  /**
   * Format helper exposed for direct use.
   * @param {number} ms
   * @returns {string}
   */
  function format(ms) {
    return formatRemaining(ms);
  }

  return { start, stop, stopAll, format };

})();
