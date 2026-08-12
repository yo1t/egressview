#!/usr/bin/env node
'use strict';

/**
 * Measures how many agents a Hub can take before the people using it notice.
 *
 * Throughput on its own is the wrong number. Ingest writes to SQLite
 * synchronously, on the same event loop that answers the web UI, which is the
 * exact structure that produced the P2-87 outage: one slow statement held the
 * loop and the whole site went down. So this benchmark measures ingest and the
 * UI at the same time, and the UI latency is what decides whether a load is
 * acceptable.
 *
 * Run it against a throwaway Hub, never production:
 *
 *   PORT=3011 DEMO_MODE=true DEMO_ADMIN_TOKEN=bench \
 *   EGRESSVIEW_DB_PATH=/tmp/bench.db node server.js
 *
 *   node scripts/benchmark-agent-ingest.js --agents 40 --seconds 15
 */

const DEFAULTS = {
  base: process.env.BENCH_BASE || 'http://127.0.0.1:3011',
  adminToken: process.env.BENCH_ADMIN_TOKEN || 'bench',
  agents: 40,
  seconds: 15,
  batch: 200,
};

function parseArgs(argv) {
  const options = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    const value = argv[i + 1];
    if (!(key in options)) throw new Error(`unknown option: ${argv[i]}`);
    options[key] = typeof options[key] === 'number' ? Number(value) : value;
  }
  if (!Number.isInteger(options.agents) || options.agents < 1) throw new Error('--agents must be a positive integer');
  if (!Number.isInteger(options.seconds) || options.seconds < 1) throw new Error('--seconds must be a positive integer');
  return options;
}

const options = parseArgs(process.argv.slice(2));
const API = `${options.base.replace(/\/$/, '')}/api`;
const ADMIN = { 'X-Admin-Token': options.adminToken, 'Content-Type': 'application/json' };

if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(options.base)) {
  // A benchmark writes hundreds of thousands of fabricated observations. Those
  // are indistinguishable from real ones once stored.
  console.error(`[bench] refusing to run against ${options.base}: this writes junk observations, so it only targets a local throwaway Hub.`);
  process.exit(2);
}

async function json(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { error: text.slice(0, 200) }; }
}

// Enrolment is deliberately rate limited per address, and that limit is not the
// thing being measured here. Waiting it out keeps a large run possible without
// weakening the defence that matters.
async function postWithBackoff(url, init, attempts = 6) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const res = await fetch(url, init);
    if (res.status !== 429) return res;
    const retryAfter = Number(res.headers.get('Retry-After'));
    await res.text();
    await new Promise((resolve) => setTimeout(resolve, (Number.isFinite(retryAfter) ? retryAfter : 5) * 1000));
  }
  throw new Error('still rate limited after waiting; lower --agents or widen the window');
}

async function enrol(index) {
  const issued = await json(await postWithBackoff(`${API}/agents/enrollment-tokens`, { method: 'POST', headers: ADMIN, body: '{}' }));
  if (!issued.code) throw new Error(`could not issue a code for agent ${index}: ${JSON.stringify(issued)}`);
  const metadata = { platform: 'macos', hostName: `bench-${index}`, osVersion: '26.5.2', agentVersion: 'bench' };
  const applied = await json(await postWithBackoff(`${API}/agent/enrollment-requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: issued.code, agent: metadata }),
  }));
  if (!applied.requestId) throw new Error(`could not apply for agent ${index}: ${JSON.stringify(applied)}`);
  await fetch(`${API}/agents/enrollment-requests/${applied.requestId}/approve`, { method: 'POST', headers: ADMIN, body: '{}' });
  const claimed = await json(await fetch(`${API}/agent/enrollment-requests/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: applied.requestId, claimSecret: applied.claimSecret }),
  }));
  if (!claimed.token) throw new Error(`could not claim for agent ${index}: ${JSON.stringify(claimed)}`);
  return { token: claimed.token, hostName: metadata.hostName };
}

function envelope(hostName, batch) {
  const now = new Date().toISOString();
  return JSON.stringify({
    schemaVersion: 1,
    batchId: crypto.randomUUID(),
    sentAt: now,
    agent: { platform: 'macos', hostName, osVersion: '26.5.2', agentVersion: 'bench' },
    observations: Array.from({ length: batch }, (_, k) => ({
      observationId: crypto.randomUUID(),
      networkProtocol: 'tcp',
      // Documentation ranges only (RFC 5737), so a stored batch can never be
      // mistaken for a real destination.
      localAddress: `192.0.2.${(k % 254) + 1}`,
      localPort: 40000 + (k % 20000),
      remoteAddress: `198.51.100.${(k % 254) + 1}`,
      remotePort: 443,
      processID: 1000 + k,
      processName: `bench-proc-${k % 40}`,
      bundleID: null,
      firstObservedAt: now,
      lastObservedAt: now,
      bytesIn: '1024',
      bytesOut: '2048',
      collector: 'network-extension',
      confidence: 'exact',
    })),
  });
}

const percentile = (values, p) => (values.length
  ? values.slice().sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))]
  : 0);

async function measure(agents, seconds, batch) {
  const deadline = Date.now() + seconds * 1000;
  const ingest = [];
  const ui = [];
  let accepted = 0;
  let throttled = 0;
  let failed = 0;
  let probing = true;

  // The reading an operator would actually feel: a small authenticated GET,
  // sampled ten times a second for the whole run.
  const probe = (async () => {
    while (probing) {
      const started = performance.now();
      try {
        // The body has to be consumed. An unread response keeps its connection
        // checked out, and the wait for the next free one lands in this
        // measurement as if the server had been slow.
        await (await fetch(`${API}/agents/ingest-metrics`, { headers: ADMIN })).text();
        ui.push(performance.now() - started);
      } catch { /* a refused probe is measured by the run failing, not here */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  })();

  await Promise.all(agents.map(async (agent) => {
    while (Date.now() < deadline) {
      const started = performance.now();
      let res;
      try {
        res = await fetch(`${API}/agent/ingest`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${agent.token}`, 'Content-Type': 'application/json' },
          body: envelope(agent.hostName, batch),
        });
      } catch (error) {
        failed += 1;
        continue;
      }
      ingest.push(performance.now() - started);
      await res.text();
      if (res.ok) accepted += 1;
      else if (res.status === 429) {
        throttled += 1;
        // Honour the backoff the way the real agent does, so the numbers
        // describe a Hub under load rather than a client ignoring it.
        const retryAfter = Number(res.headers.get('Retry-After'));
        await new Promise((resolve) => setTimeout(resolve, Number.isFinite(retryAfter) ? retryAfter * 1000 : 1000));
      } else failed += 1;
    }
  }));

  probing = false;
  await probe;

  return {
    agents: agents.length,
    accepted,
    throttled,
    failed,
    observationsPerSecond: Math.round((accepted * batch) / seconds),
    ingestP50: Math.round(percentile(ingest, 0.5)),
    ingestP95: Math.round(percentile(ingest, 0.95)),
    uiP50: Math.round(percentile(ui, 0.5)),
    uiP95: Math.round(percentile(ui, 0.95)),
    uiMax: Math.round(Math.max(0, ...ui)),
  };
}

(async () => {
  const enrolled = [];
  for (let i = 0; i < options.agents; i += 1) {
    // Enrolment is rate limited per address on purpose, so this stays serial
    // and slow. It is setup, not part of the measurement.
    enrolled.push(await enrol(i));
  }
  process.stderr.write(`[bench] enrolled ${enrolled.length} agents\n`);

  // Cleared right before the run so the histogram describes the load and not
  // the enrolment that preceded it.
  await json(await fetch(`${API}/agents/ingest-metrics?resetDelay=1`, { headers: ADMIN }));
  const result = await measure(enrolled, options.seconds, options.batch);
  const metrics = await json(await fetch(`${API}/agents/ingest-metrics`, { headers: ADMIN }));

  console.log(JSON.stringify({
    ...result,
    seconds: options.seconds,
    batch: options.batch,
    maxInFlight: metrics.maxInFlight,
    eventLoopDelayMs: metrics.eventLoopDelayMs,
    limits: metrics.limits,
  }, null, 2));

  // Event loop delay is the acceptance test, not throughput and not the HTTP
  // round trip measured above -- that one also carries this process's own load,
  // which is heavy enough to look like server latency. Past 250 ms the Hub is
  // visibly hesitating for whoever is using the web UI.
  const delayP95 = metrics.eventLoopDelayMs?.p95 ?? 0;
  if (delayP95 > 250) {
    process.stderr.write(`[bench] event loop delay p95 was ${delayP95} ms under ${result.agents} agents; this load is not acceptable\n`);
    process.exit(1);
  }
})().catch((error) => {
  process.stderr.write(`[bench] ${error.message}\n`);
  process.exit(1);
});
