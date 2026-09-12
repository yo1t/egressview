'use strict';

/**
 * Runs a long piece of synchronous work in slices, letting the event loop
 * breathe between them.
 *
 * Node answers the web UI on the same thread that writes to SQLite, so a
 * synchronous run of any length is a period in which the site returns nothing
 * at all. Measured on production 2026-09-12: one router poll spent 1.9 seconds
 * inside `recordConnections`, and the profiler's event-loop watchdog reported
 * stalls up to 52.6 seconds across the window. Average CPU over the same two
 * hours was 13%. The machine was not busy; it was blocked.
 *
 * The slice is chosen by **time, not by count**. How many connections a router
 * returns varies with the site and how much each one costs varies with the
 * machine, so a fixed count would be right on one Hub and wrong on the next.
 * Each slice is measured and the next one is resized to hit the target, which
 * makes the tuning a property of the run rather than a constant somebody has
 * to maintain (P3-112).
 */

/// How long one uninterrupted slice may take.
///
/// 50ms. The profiler's event-loop p95 is 20.6ms on the Hub this was measured
/// on, so a slice of this size is within the variation the UI already lives
/// with, while being long enough that the yields themselves do not dominate.
const DEFAULT_TARGET_MS = 50;

/// Bounds on the resizing, so one unusually fast or slow slice cannot send the
/// next one to either extreme -- a single item that happened to be cheap must
/// not produce a slice of ten thousand.
const MIN_SLICE = 25;
const MAX_SLICE = 5_000;

/// Hands control back to the event loop.
///
/// `setImmediate` rather than `setTimeout(0)`: it runs after the I/O the loop
/// already has pending, which is the point -- the waiting HTTP responses go
/// out before the next slice starts.
const defaultYield = () => new Promise(resolve => setImmediate(resolve));

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

/**
 * @param {Array} items
 * @param {(slice: Array) => void} processSlice called with each slice in order
 * @returns {Promise<{slices: number, longestMs: number}>}
 */
async function runInSlices(items, {
  processSlice,
  targetMs = DEFAULT_TARGET_MS,
  initialSlice = 200,
  yieldToLoop = defaultYield,
  now = () => performance.now(),
} = {}) {
  if (typeof processSlice !== 'function') throw new TypeError('processSlice is required');
  if (!(targetMs > 0)) throw new TypeError('targetMs must be positive');
  if (!items?.length) return { slices: 0, longestMs: 0 };

  let size = clamp(Math.round(initialSlice), MIN_SLICE, MAX_SLICE);
  let index = 0;
  let slices = 0;
  let longestMs = 0;
  while (index < items.length) {
    const slice = items.slice(index, index + size);
    const began = now();
    processSlice(slice);
    const took = now() - began;
    longestMs = Math.max(longestMs, took);
    slices += 1;
    index += slice.length;
    // Resized from what this slice actually cost. A slice that took no
    // measurable time gives no information, so it is treated as the smallest
    // time worth dividing by rather than as zero.
    size = clamp(Math.round(size * targetMs / Math.max(took, 0.1)), MIN_SLICE, MAX_SLICE);
    if (index < items.length) await yieldToLoop();
  }
  return { slices, longestMs };
}

module.exports = { runInSlices, DEFAULT_TARGET_MS, MIN_SLICE, MAX_SLICE };
