'use strict';

const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

const { bytesRead } = require('./startup-progress');

const PHASES = Object.freeze({
  configuration: { en: 'Reading configuration', ja: '設定を読み込んでいます' },
  database: { en: 'Checking the database', ja: 'データベースを確認しています' },
  'migration-backup': {
    en: 'Copying the database before updating it', ja: '移行の前に、データベースの複製を作っています',
  },
  migration: { en: 'Updating the database', ja: 'データベースを移行しています' },
  'migration-verify': { en: 'Checking the updated database', ja: '移行したデータベースを確認しています' },
  initializing: { en: 'Loading records and starting collectors', ja: '記録を読み込み、収集を開始しています' },
});

function gigabytes(bytes) {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

/**
 * The line under the phase that says how far it has got (P3-173), or ''.
 *
 * For a check: how much has been read since it began, and -- when an earlier
 * check of the same kind left a measure -- that as a share of what it read,
 * scaled to today's file. Never 100% before it ends: the estimate is an
 * estimate, and a check reading more than last time is still running.
 * For a migration: which step of how many.
 */
function progressLine(phase, detail, language, readNow = bytesRead()) {
  const ja = language === 'ja';
  if (!detail) return '';
  if (phase === 'migration' && detail.step && detail.total) {
    return ja
      ? `${detail.total}段中${detail.step}段目（v${detail.version}）`
      : `Step ${detail.step} of ${detail.total} (v${detail.version})`;
  }
  if (detail.readBase == null || readNow == null) return '';
  const read = Math.max(0, readNow - detail.readBase);
  if (!(detail.expectedBytes > 0)) {
    return ja ? `読み込んだデータ: ${gigabytes(read)}` : `Read so far: ${gigabytes(read)}`;
  }
  const percent = Math.min(99, Math.floor((read / detail.expectedBytes) * 100));
  return ja
    ? `読み込んだデータ: ${gigabytes(read)}／目安 ${gigabytes(detail.expectedBytes)}（約${percent}%）`
    : `Read so far: ${gigabytes(read)} of about ${gigabytes(detail.expectedBytes)} (about ${percent}%)`;
}

function renderPage(phase, startedAt, language, nonce, detail = null) {
  const ja = language === 'ja';
  const title = ja ? 'EgressView Hub を起動しています' : 'Starting EgressView Hub';
  const phaseText = PHASES[phase]?.[language] || PHASES.configuration[language];
  const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const wait = ja ? 'この画面は自動的に更新されます。準備ができるまでお待ちください。'
    : 'This page refreshes automatically. Please wait until the Hub is ready.';
  const time = ja ? `経過時間: ${elapsed}秒` : `Elapsed: ${elapsed}s`;
  const progress = progressLine(phase, detail, language);
  return `<!doctype html><html lang="${language}"><head><meta charset="utf-8">`
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta http-equiv="refresh" content="5"><title>EgressView Hub</title>'
    + `<style nonce="${nonce}">body{font-family:ui-sans-serif,system-ui,sans-serif;background:#101925;color:#edf5ff;`
    + 'min-height:100vh;display:grid;place-items:center;margin:0;padding:1.5rem;box-sizing:border-box}'
    + 'main{max-width:38rem;border:1px solid #35526b;border-radius:1rem;padding:2rem;background:#172738}'
    + 'h1{font-size:1.7rem;margin:0 0 1.5rem}strong{color:#78d7eb}p{line-height:1.7}'
    + 'small{color:#a5b9c8}</style></head><body><main>'
    + `<h1>${title}</h1><p role="status"><strong>${phaseText}</strong>`
    + `${progress ? `<br><span>${progress}</span>` : ''}</p><p>${wait}</p>`
    + `<small>${time}</small></main></body></html>`;
}

function startWorkerListener({ port, host, tlsOptions, subpath }) {
  let phase = 'configuration';
  let detail = null;
  const startedAt = Date.now();
  const server = tlsOptions ? https.createServer(tlsOptions, handle) : http.createServer(handle);

  function handle(req, res) {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch {
      res.writeHead(400);
      return res.end();
    }
    const pathname = subpath && url.pathname.startsWith(`${subpath}/`)
      ? url.pathname.slice(subpath.length) : url.pathname;
    const language = /\bja\b/i.test(req.headers['accept-language'] || '') ? 'ja' : 'en';
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const nonce = crypto.randomBytes(16).toString('base64');
    res.setHeader('Content-Security-Policy', `default-src 'none'; style-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`);
    if (tlsOptions) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (pathname === '/healthz' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ status: 'ok' }));
    }
    if (pathname === '/readyz' && req.method === 'GET') {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ status: 'not_ready', reasons: ['startup'] }));
    }
    res.setHeader('Retry-After', '5');
    if (req.method !== 'GET' || pathname === '/api' || pathname.startsWith('/api/') || pathname.startsWith('/socket.io/')) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: 'Hub is starting' }));
    }
    res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(renderPage(phase, startedAt, language, nonce, detail));
  }

  server.on('error', error => parentPort.postMessage({ type: 'error', message: error.message }));
  parentPort.on('message', message => {
    if (message.type === 'phase' && PHASES[message.phase]) {
      phase = message.phase;
      detail = message.detail ?? null;
    }
    if (message.type === 'stop') {
      server.close(() => parentPort.postMessage({ type: 'stopped' }));
      server.closeAllConnections();
    }
  });
  server.listen(port, host, () => {
    parentPort.postMessage({ type: 'listening', port: server.address().port });
  });
}

function startStartupListener({ port, host, tlsOptions = null, subpath = '' }) {
  const workerTls = tlsOptions && {
    key: tlsOptions.key.toString('utf8'),
    cert: tlsOptions.cert.toString('utf8'),
  };
  const worker = new Worker(__filename, {
    workerData: { port, host, tlsOptions: workerTls, subpath },
  });
  return new Promise((resolve, reject) => {
    let listening = false;
    const onError = error => {
      if (!listening) {
        worker.terminate();
        reject(error);
      }
    };
    worker.once('error', onError);
    worker.once('exit', code => {
      if (!listening) reject(new Error(`Startup listener exited (${code})`));
    });
    worker.on('message', message => {
      if (message.type === 'error') return onError(new Error(message.message));
      if (message.type !== 'listening') return;
      listening = true;
      worker.removeListener('error', onError);
      resolve({
        port: message.port,
        setPhase(phase, detail = null) {
          if (PHASES[phase]) worker.postMessage({ type: 'phase', phase, detail });
        },
        stop() {
          return new Promise((done, fail) => {
            worker.once('error', fail);
            worker.on('message', function onMessage(reply) {
              if (reply.type !== 'stopped') return;
              worker.off('message', onMessage);
              worker.terminate().then(done, fail);
            });
            worker.postMessage({ type: 'stop' });
          });
        },
      });
    });
  });
}

if (!isMainThread) startWorkerListener(workerData);

module.exports = { startStartupListener, PHASES, progressLine };
