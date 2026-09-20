'use strict';

// The window summary says the loop stopped for two seconds. The watchdog says
// nothing instrumented was running when it did. Both are true at once, which
// leaves the question the operator actually has -- what was it doing? -- with
// no answer at all.
//
// On one Hub that cost three production deploys and ten disproved hypotheses
// before /proc showed the main thread burning CPU outside any measured call.
// The V8 sampler can answer this directly, because it runs on its own thread
// and keeps sampling while the main thread is stuck. This module drives it
// from inside the process, so there is no debugger port to open on a
// production host and no signal to send to a live PID.

// Reading samples out of V8 means stopping the profile, and that runs on the
// main thread: on the production Hub a cut of one window measured around
// 170 ms. Measured 2026-09-20, twenty seconds of profile cut in 6.9 ms at 1 ms
// sampling and 6.3 ms at 5 ms -- so the cost tracks how long the profile ran,
// not how many samples it holds, and coarsening the interval would buy
// resolution away for nothing.
const DEFAULT_SAMPLING_INTERVAL_US = 1000;
const DEFAULT_TOP_FRAMES = 3;
const DEFAULT_STACK_DEPTH = 5;
// A sample that lands outside the stall says nothing about it, but the mapping
// from profile time to loop time is a linear estimate, so the edges are
// approximate. A small margin keeps the first and last samples of the stall.
const WINDOW_MARGIN_MS = 20;

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function frameLabel(callFrame) {
  const name = callFrame.functionName || '(anonymous)';
  if (!callFrame.url) return name;
  const file = callFrame.url.split('/').pop();
  return `${name} ${file}:${callFrame.lineNumber + 1}`;
}

/**
 * What the main thread was executing during a stall, from a V8 CPU profile.
 *
 * Pure on purpose: the hard part is the arithmetic on samples and time deltas,
 * and that deserves tests that do not need an inspector session.
 *
 * `startedAtMs` is the loop clock reading taken when the profile was started,
 * which is what maps profile time onto the stall window.
 */
function summariseStallSamples(profile, {
  startedAtMs, fromMs, toMs,
  topFrames = DEFAULT_TOP_FRAMES, stackDepth = DEFAULT_STACK_DEPTH,
} = {}) {
  const samples = profile?.samples;
  const timeDeltas = profile?.timeDeltas;
  if (!Array.isArray(samples) || !Array.isArray(timeDeltas) || !samples.length) {
    return { samples: 0, totalMs: 0, frames: [] };
  }

  const nodeById = new Map();
  const parentOf = new Map();
  for (const node of profile.nodes || []) {
    nodeById.set(node.id, node);
    for (const child of node.children || []) parentOf.set(child, node.id);
  }

  const windowStart = fromMs - WINDOW_MARGIN_MS;
  const windowEnd = toMs + WINDOW_MARGIN_MS;
  const selfMsById = new Map();
  let elapsedMs = 0;
  let counted = 0;
  let totalMs = 0;
  for (let i = 0; i < samples.length; i++) {
    const deltaMs = (timeDeltas[i] || 0) / 1000;
    elapsedMs += deltaMs;
    const atMs = startedAtMs + elapsedMs;
    if (atMs < windowStart) continue;
    if (atMs > windowEnd) break;
    counted += 1;
    totalMs += deltaMs;
    const id = samples[i];
    selfMsById.set(id, (selfMsById.get(id) || 0) + deltaMs);
  }

  const frames = [...selfMsById.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topFrames)
    .map(([id, ms]) => {
      const stack = [];
      let cursor = id;
      while (cursor != null && stack.length < stackDepth) {
        const node = nodeById.get(cursor);
        if (!node?.callFrame) break;
        stack.push(frameLabel(node.callFrame));
        cursor = parentOf.get(cursor);
      }
      return { selfMs: round(ms), stack };
    });

  return { samples: counted, totalMs: round(totalMs), frames };
}

/**
 * A rolling CPU profile that can be cut open at the moment of a stall.
 *
 * The profile runs continuously and is stopped -- "cut" -- when something
 * wants to know what happened in a given span. Stopping is the only way to
 * read samples out of V8, so every cut also starts a fresh profile. Cutting on
 * each window boundary as well keeps the retained samples bounded.
 */
function createStallSampler(deps = {}) {
  const now = deps.now || (() => require('node:perf_hooks').performance.now());
  const createSession = deps.createSession || (() => {
    // Required lazily: a Hub that never turns this on should not pay for the
    // inspector module, and some builds do not ship it at all.
    const { Session } = require('node:inspector');
    return new Session();
  });

  let session = null;
  let startedAtMs = 0;
  let running = false;
  let cutting = false;
  let samplingIntervalUs = DEFAULT_SAMPLING_INTERVAL_US;

  function post(method, params) {
    return new Promise((resolve, reject) => {
      session.post(method, params, (err, result) => (err ? reject(err) : resolve(result)));
    });
  }

  async function beginProfile() {
    startedAtMs = now();
    await post('Profiler.start');
    running = true;
  }

  async function start({ samplingIntervalUs: interval } = {}) {
    if (session) return true;
    samplingIntervalUs = interval || DEFAULT_SAMPLING_INTERVAL_US;
    try {
      session = createSession();
      session.connect();
      await post('Profiler.enable');
      await post('Profiler.setSamplingInterval', { interval: samplingIntervalUs });
      await beginProfile();
      return true;
    } catch {
      // A diagnostic must never be the thing that breaks the server.
      try { session?.disconnect(); } catch { /* already gone */ }
      session = null;
      running = false;
      return false;
    }
  }

  /**
   * Stop the profile, summarise the given span, and start profiling again.
   * Returns null when there is nothing to report, including when a cut is
   * already in progress -- two stalls in a row should not stack up sessions.
   *
   * The returned `cutMs` is what this cost the loop. A diagnostic that stops
   * the thing it is measuring has to say so, in the same line as its finding,
   * or the next reader spends an afternoon chasing its own instrument.
   */
  async function cut({ fromMs, toMs, summarise = true } = {}) {
    if (!session || !running || cutting) return null;
    cutting = true;
    const profileStartedAtMs = startedAtMs;
    const cutBeganAt = now();
    try {
      const { profile } = await post('Profiler.stop');
      running = false;
      const summary = summarise
        ? summariseStallSamples(profile, { startedAtMs: profileStartedAtMs, fromMs, toMs })
        : null;
      await beginProfile();
      if (!summary) return { cutMs: round(now() - cutBeganAt) };
      return { ...summary, cutMs: round(now() - cutBeganAt) };
    } catch {
      running = false;
      return null;
    } finally {
      cutting = false;
    }
  }

  function stop() {
    if (!session) return;
    try { session.post('Profiler.stop', () => {}); } catch { /* already gone */ }
    try { session.disconnect(); } catch { /* already gone */ }
    session = null;
    running = false;
    cutting = false;
  }

  return { start, cut, stop, isRunning: () => running };
}

module.exports = {
  createStallSampler,
  summariseStallSamples,
  DEFAULT_SAMPLING_INTERVAL_US,
};
