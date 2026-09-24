'use strict';

const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

const PHASES = Object.freeze({
  configuration: { en: 'Reading configuration', ja: '設定を読み込んでいます' },
  database: { en: 'Checking the database', ja: 'データベースを確認しています' },
  migration: { en: 'Updating the database', ja: 'データベースを移行しています' },
  initializing: { en: 'Loading records and starting collectors', ja: '記録を読み込み、収集を開始しています' },
});

function renderPage(phase, startedAt, language, nonce) {
  const ja = language === 'ja';
  const title = ja ? 'EgressView Hub を起動しています' : 'Starting EgressView Hub';
  const detail = PHASES[phase]?.[language] || PHASES.configuration[language];
  const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const wait = ja ? 'この画面は自動的に更新されます。準備ができるまでお待ちください。'
    : 'This page refreshes automatically. Please wait until the Hub is ready.';
  const time = ja ? `経過時間: ${elapsed}秒` : `Elapsed: ${elapsed}s`;
  return `<!doctype html><html lang="${language}"><head><meta charset="utf-8">`
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta http-equiv="refresh" content="5"><title>EgressView Hub</title>'
    + `<style nonce="${nonce}">body{font-family:ui-sans-serif,system-ui,sans-serif;background:#101925;color:#edf5ff;`
    + 'min-height:100vh;display:grid;place-items:center;margin:0;padding:1.5rem;box-sizing:border-box}'
    + 'main{max-width:38rem;border:1px solid #35526b;border-radius:1rem;padding:2rem;background:#172738}'
    + 'h1{font-size:1.7rem;margin:0 0 1.5rem}strong{color:#78d7eb}p{line-height:1.7}'
    + 'small{color:#a5b9c8}</style></head><body><main>'
    + `<h1>${title}</h1><p role="status"><strong>${detail}</strong></p><p>${wait}</p>`
    + `<small>${time}</small></main></body></html>`;
}

function startWorkerListener({ port, host, tlsOptions, subpath }) {
  let phase = 'configuration';
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
    return res.end(renderPage(phase, startedAt, language, nonce));
  }

  server.on('error', error => parentPort.postMessage({ type: 'error', message: error.message }));
  parentPort.on('message', message => {
    if (message.type === 'phase' && PHASES[message.phase]) phase = message.phase;
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
        setPhase(phase) { if (PHASES[phase]) worker.postMessage({ type: 'phase', phase }); },
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

module.exports = { startStartupListener, PHASES };
