'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Worker } = require('node:worker_threads');
const { startStartupListener } = require('../../src/startup-listener');

test('startup listener responds during initialization and releases its port', async () => {
  const startup = await startStartupListener({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${startup.port}`;
  try {
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });

    const ready = await fetch(`${base}/readyz`);
    assert.equal(ready.status, 503);
    assert.equal((await ready.json()).status, 'not_ready');

    const page = await fetch(base, { headers: { 'Accept-Language': 'ja' } });
    assert.equal(page.status, 503);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.match(page.headers.get('content-security-policy'), /style-src 'nonce-/);
    const pageHtml = await page.text();
    assert.match(pageHtml, /設定を読み込んでいます/);
    assert.match(pageHtml, /http-equiv="refresh" content="5"/);

    startup.setPhase('migration', { step: 2, total: 3, version: 30 });
    const migrated = await fetch(base, { headers: { 'Accept-Language': 'en' } });
    const migratedHtml = await migrated.text();
    assert.match(migratedHtml, /Updating the database/);
    assert.match(migratedHtml, /Step 2 of 3 \(v30\)/);

    startup.setPhase('migration-verify', { mode: 'full', readBase: null, expectedBytes: null });
    const verifying = await fetch(base, { headers: { 'Accept-Language': 'ja' } });
    assert.match(await verifying.text(), /移行したデータベースを確認しています/);

    const api = await fetch(`${base}/api/connections`);
    assert.equal(api.status, 503);
    assert.deepEqual(await api.json(), { error: 'Hub is starting' });

    const post = await fetch(`${base}/api/config`, { method: 'POST' });
    assert.equal(post.status, 503);
  } finally {
    await startup.stop();
  }

  const server = http.createServer((_req, res) => res.end('ready'));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(startup.port, '127.0.0.1', resolve);
  });
  try {
    assert.equal(await (await fetch(base)).text(), 'ready');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('startup listener refuses a port already in use', async () => {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(
      startStartupListener({ port: server.address().port, host: '127.0.0.1' }),
      /EADDRINUSE/
    );
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('startup listener answers while the main thread is blocked', async () => {
  const startup = await startStartupListener({ port: 0, host: '127.0.0.1' });
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const requester = new Worker(`
    const { workerData } = require('node:worker_threads');
    const state = new Int32Array(workerData.signal);
    fetch(workerData.url).then(response => {
      Atomics.store(state, 0, response.status === 503 ? 1 : -1);
      Atomics.notify(state, 0);
    }).catch(() => {
      Atomics.store(state, 0, -1);
      Atomics.notify(state, 0);
    });
  `, { eval: true, workerData: { signal: signal.buffer, url: `http://127.0.0.1:${startup.port}/` } });
  try {
    const result = Atomics.wait(signal, 0, 0, 5000);
    assert.equal(result, 'ok', 'the listener must answer without the main event loop');
    assert.equal(Atomics.load(signal, 0), 1);
  } finally {
    await requester.terminate();
    await startup.stop();
  }
});
