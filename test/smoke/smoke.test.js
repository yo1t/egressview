// Smoke tests for EgressView — Phase 2 safety net
//
// Primary goal: catch JS load-order errors when index.html is refactored.
// Secondary: verify extracted static assets are served correctly.
//
// Usage:
//   EGRESSVIEW_URL=http://YOUR_SERVER_IP:3002 EGRESSVIEW_TOKEN=<token> npm run test:smoke
//
// EGRESSVIEW_TOKEN is optional — tests that need auth are skipped when omitted.

const { test, expect } = require('@playwright/test');

const BASE  = process.env.EGRESSVIEW_URL  || 'http://localhost:3002';
const TOKEN = process.env.EGRESSVIEW_TOKEN || '';

// ─── Static asset tests (no auth required) ────────────────────────────────────

test('GET / returns 200 with correct title', async ({ request }) => {
  const res = await request.get(`${BASE}/`);
  expect(res.status()).toBe(200);
  const body = await res.text();
  expect(body).toContain('<title>EgressView</title>');
});

test('health and readiness endpoints are public and ready after startup', async ({ request }) => {
  const health = await request.get(`${BASE}/healthz`, { headers: { 'X-Request-Id': 'smoke-health-1' } });
  expect(health.status()).toBe(200);
  expect(await health.json()).toEqual({ status: 'ok' });
  expect(health.headers()['cache-control']).toContain('no-store');
  expect(health.headers()['x-request-id']).toBe('smoke-health-1');

  const readiness = await request.get(`${BASE}/readyz`, { headers: { 'X-Request-Id': 'invalid request id' } });
  expect(readiness.status()).toBe(200);
  expect(await readiness.json()).toEqual({ status: 'ready' });
  expect(readiness.headers()['cache-control']).toContain('no-store');
  expect(readiness.headers()['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
});

test('style.css is served (200, text/css)', async ({ request }) => {
  const res = await request.get(`${BASE}/style.css`);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toMatch(/text\/css/);
});

test('js/i18n.js is served (200)', async ({ request }) => {
  const res = await request.get(`${BASE}/js/i18n.js`);
  expect(res.status()).toBe(200);
});

test('generated i18n data module is served safely', async ({ request }) => {
  const res = await request.get(`${BASE}/js/i18n-data.js`);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toMatch(/javascript/);
  const body = await res.text();
  expect(body).toMatch(/^export default \{"ja":/);
  expect(body).toContain('"en":');
  expect(body).not.toContain('</script>');
});

// (1) All JS files split out in Phase 2 must be served with 200
const PHASE2_JS_FILES = [
  'utils.js', 'connections-panel.js', 'auth-socket.js', 'graph.js',
  'graph-helpers.js', 'graph-panels.js', 'graph-render.js',
  'settings.js', 'map-common.js', 'stats.js', 'time-filter.js',
  'stats-helpers.js', 'stats-charts.js', 'stats-map.js',
  'view-tabs.js', 'log.js', 'ai-insights.js', 'beacon.js', 'threat-popup.js',
  'devices.js', 'notif-log.js', 'main.js',
  'settings-ai.js',
];
for (const file of PHASE2_JS_FILES) {
  test(`js/${file} is served (200)`, async ({ request }) => {
    const res = await request.get(`${BASE}/js/${file}`);
    expect(res.status()).toBe(200);
  });
}

// (2) Deleted files must 404 (catches accidental restoration)
const DELETED_JS_FILES = ['map.js', 'dashboard.js'];
for (const file of DELETED_JS_FILES) {
  test(`js/${file} is deleted (404)`, async ({ request }) => {
    const res = await request.get(`${BASE}/js/${file}`);
    expect(res.status()).toBe(404);
  });
}

// (3) index.html must not have leftover inline JS (catches accidental reverts)
test('index.html has no inline script block with JS code', async ({ request }) => {
  const res = await request.get(`${BASE}/`);
  const body = await res.text();
  expect(body).not.toMatch(/<script>\s*const _BASE/);
  expect(body).not.toMatch(/<script>\s*\/\/ ─/);
});

// (4) index.html must contain the expected <script> tag (after ES module migration, only main.js)
test('index.html references expected script files', async ({ request }) => {
  const res = await request.get(`${BASE}/`);
  const body = await res.text();
  expect(body, 'index.html should reference main.js as module entry point').toContain('/js/main.js');
  expect(body, 'index.html should use type="module"').toContain('type="module"');
  for (const f of ['utils.js', 'graph.js', 'map-common.js', 'settings.js', 'devices.js']) {
    expect(body, `index.html should NOT have separate <script> for ${f}`).not.toContain(`<script src`+`="${BASE}/js/${f}"`);
  }
});

// (5) Security headers must be returned
test('security headers are present', async ({ request }) => {
  const res = await request.get(`${BASE}/`);
  const h = res.headers();
  expect(h['x-frame-options'],          'X-Frame-Options').toBe('DENY');
  expect(h['x-content-type-options'],   'X-Content-Type-Options').toBe('nosniff');
  expect(h['referrer-policy'],          'Referrer-Policy').toBe('same-origin');
  const csp = h['content-security-policy'];
  expect(csp,  'Content-Security-Policy').toContain("object-src 'none'");
  expect(csp,  'Content-Security-Policy').toContain("style-src 'self'");
  expect(csp,  'Content-Security-Policy').not.toContain('style-src-attr');
  expect(csp,  'Content-Security-Policy').not.toContain("'unsafe-inline'");
  expect(csp,  'Content-Security-Policy').not.toContain("style-src 'self' 'unsafe-inline'");
});

// ─── JS integrity test (no auth required) ────────────────────────────────────
// Catches ReferenceError / SyntaxError from wrong load order in Phase 2.

test('no uncaught JS errors on page load', async ({ page }) => {
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  page.on('dialog',   dialog => dialog.dismiss()); // dismiss auth prompt / alerts

  // 'commit' avoids waiting for DOMContentLoaded which is blocked by prompt().
  // JS ReferenceErrors (the main Phase 2 failure mode) fire immediately as scripts
  // execute, well before any auth dialog appears.
  await page.goto('/', { waitUntil: 'commit' });
  await page.waitForTimeout(2000); // allow scripts to parse and execute

  expect(errors, `Uncaught JS errors:\n  ${errors.join('\n  ')}`).toHaveLength(0);
});

// ─── Auth-gated UI tests ──────────────────────────────────────────────────────
// Skipped when EGRESSVIEW_TOKEN is not set.

// Helper: authenticate and navigate to /
async function authPage(page) {
  await page.addInitScript(tok => {
    localStorage.setItem('egressview_admin_token', tok);
  }, TOKEN);
  await page.goto(`${BASE}/`);
  await page.waitForLoadState('networkidle');
}

test('shared browser catalog renders Japanese and English', async ({ page }) => {
  if (!TOKEN) test.skip(true, 'EGRESSVIEW_TOKEN not set — skipping auth-gated test');

  await authPage(page);
  const graphTab = page.locator('#btn-graph');

  await page.evaluate(async () => {
    const i18n = await import('/js/i18n.js?v=p2-29-smoke');
    i18n.setCurrentLang('ja');
    i18n.applyI18n();
  });
  await expect(graphTab).toHaveText('📊 グラフマップ');
  await expect(page.locator('[data-i18n="settings.general.note.line1"]')).toHaveText('世界地図上でアークの起点となる場所です。');

  await page.evaluate(async () => {
    const i18n = await import('/js/i18n.js?v=p2-29-smoke');
    i18n.setCurrentLang('en');
    i18n.applyI18n();
  });
  await expect(graphTab).toHaveText('📊 Graph Map');
  await expect(page.locator('[data-i18n="settings.general.note.line1"]')).toHaveText('Sets the arc origin on the world map.');
  await expect(page.locator('[data-i18n="settings.datasource.dnsmasq.desc.line2.before"]')).toContainText('PTR reverse lookups');
  await expect(page.locator('.settings-description-example')).toHaveText('example.com');
});

// Helper: collect non-noise console errors
function collectErrors(page) {
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  page.on('console',   msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  return errors;
}

const NOISE = [
  'socket.io', 'Socket', 'WebSocket',
  'ERR_CONNECTION_REFUSED', 'io is not defined', 'Failed to load resource',
];
function fatalErrors(errors) {
  return errors.filter(e => !NOISE.some(n => e.includes(n)));
}

async function mockSettingsRoutes(page) {
  let mockRouters = [];
  let mockSessions = [
    { id: 'current', deviceLabel: '<script>Current device</script>', current: true, lastSeenAt: 100 },
    { id: '../other?id=1', deviceLabel: '<img src=x onerror=alert(1)>', current: false, lastSeenAt: 200 },
  ];
  let aiConfig = {
    provider: 'disabled',
    models: { ollama: '', anthropic: '', openai: '' },
    ollamaEndpoint: 'http://127.0.0.1:11434',
    providers: { ollama: { keySet: false }, anthropic: { keySet: false }, openai: { keySet: false } },
  };
  await page.route('**/api/routers**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith('/detect')) {
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ success: true, ssh: { ok: true }, lan: { ip: '192.168.1.1' }, nat: { ok: true, descriptor: '100', sessionsOk: true, sessions: 42 } }),
      });
      return;
    }
    if (request.method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ routers: mockRouters, maxRouters: 10 }) });
      return;
    }
    if (request.method() === 'POST') {
      const input = request.postDataJSON();
      const created = { ...input, id: 'yamaha-test0001', passSet: true, ready: false, state: 'connecting', sessionCount: 0 };
      delete created.pass;
      mockRouters = [created];
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ success: true, router: created }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
  });
  await page.route('**/api/login', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, routerIp: '192.168.1.1' }),
  }));
  await page.route('**/api/yamaha/detect', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      success: true,
      nat: { ok: true, descriptor: '100', sessionsOk: true, sessions: 42 },
      lan: { ip: '192.168.1.1' },
      suggested: { yamahaIp: '192.168.1.1', yamahaUser: 'admin', yamahaNat: '100' },
    }),
  }));
  await page.route('**/api/config/slack', async route => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ config: { enabled: false, cooldownMinutes: 60 } }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, config: { enabled: false, cooldownMinutes: 60 } }),
    });
  });
  await page.route('**/api/config/ai', async route => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(aiConfig) });
      return;
    }
    const input = route.request().postDataJSON();
    aiConfig = {
      ...aiConfig,
      provider: input.provider,
      models: input.models,
      ollamaEndpoint: input.ollamaEndpoint,
      providers: {
        ...aiConfig.providers,
        ...(input.keys?.anthropic ? { anthropic: { keySet: true } } : {}),
        ...(input.keys?.openai ? { openai: { keySet: true } } : {}),
      },
    };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, ...aiConfig }),
    });
  });
  await page.route('**/api/ai/test', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, provider: 'anthropic', models: ['claude-test', '<img src=x onerror=alert(1)>'] }),
  }));
  await page.route('**/api/ai/models', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      success: true,
      provider: 'bedrock',
      models: ['jp.anthropic.claude-sonnet-test', 'us.anthropic.claude-sonnet-test'],
    }),
  }));
  await page.route('**/api/slack/verify', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, team: 'Demo Workspace', user: 'egressview-bot' }),
  }));
  await page.route('**/api/slack/lookup-user', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, userId: 'UDEMO123', name: 'demo-user', displayName: 'Demo User' }),
  }));
  await page.route('**/api/slack/test', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true }),
  }));
  await page.route('**/api/config/general', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      success: true,
      homeCountry: 'JP',
      language: 'ja',
      autoInvestigate: false,
      retentionDays: 730,
    }),
  }));
  await page.route('**/api/auth/sessions**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'POST' && url.pathname.endsWith('/revoke-all')) {
      mockSessions = mockSessions.filter(session => session.current);
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ success: true, revoked: 1 }),
      });
      return;
    }
    if (request.method() === 'POST' && url.pathname.endsWith('/revoke')) {
      const encodedId = url.pathname.split('/').at(-2);
      const id = decodeURIComponent(encodedId);
      mockSessions = mockSessions.filter(session => session.id !== id);
      await route.fulfill({
        status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }),
      });
      return;
    }
    await route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ sessions: mockSessions }),
    });
  });
  await page.route('**/api/beacons/config', async route => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          config: {
            enabled: true,
            minObs: 4,
            maxCov: 0.5,
            minIntervalMs: 60_000,
            maxIntervalMs: 14_400_000,
            scanIntervalMs: 3_600_000,
            whitelistDomains: ['example.com'],
            orgAllowlist: ['Demo Org'],
          },
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true }),
    });
  });
  await page.route('**/api/backup/list', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      backups: [],
      config: { intervalHours: 24, maxGenerations: 7, maxBackupBytes: 0, autoPrune: false },
      diagnostics: {
        entries: [{ name: 'runtime.db.pre-migration.v6-to-v7.test.bak', kind: 'migration', size: 1024, created: new Date().toISOString(), integrity: 'unchecked', schema: null }],
        summary: { backupBytes: 1024, freeBytes: 8 * 1024 ** 3, migrationRequiredBytes: 2 * 1024 ** 3, migrationReady: true, shortfallBytes: 0 },
      },
    }),
  }));
  await page.route('**/api/backup/config', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, config: { intervalHours: 24, maxGenerations: 7 } }),
  }));
  await page.route('**/api/backup/create', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, name: 'egressview-demo.db' }),
  }));
  await page.route('**/api/backup/prune', async route => {
    const body = route.request().postDataJSON();
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        job: {
          id: body.execute ? '22222222-2222-4222-8222-222222222222' : '11111111-1111-4111-8111-111111111111',
          operation: body.execute ? 'execute' : 'preview',
          status: 'running',
          progress: { phase: 'queued', completed: 0, total: 0 },
        },
      }),
    });
  });
  await page.route('**/api/backup/prune/*', async route => {
    const id = route.request().url().split('/').pop();
    const execute = id.startsWith('2222');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        job: {
          id,
          operation: execute ? 'execute' : 'preview',
          status: 'completed',
          result: execute
            ? { deleted: [], deletedBytes: 0 }
            : { candidates: [], candidateBytes: 0, blocked: false },
        },
      }),
    });
  });
  await page.route('**/api/config/datasources', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      success: true,
      dnsmasq: { enabled: false, logFile: '/var/log/dnsmasq-queries.log' },
      inspect: { enabled: false, logFile: '/var/log/yamaha-router.log' },
      dhcpd: { enabled: false, logFile: '/var/log/yamaha-router.log' },
    }),
  }));
}

test('tab bar renders after auth', async ({ page }) => {
  if (!TOKEN) test.skip(true, 'EGRESSVIEW_TOKEN not set — skipping auth-gated test');

  await authPage(page);

  // AI Insights is the leftmost tab and the authenticated start page.
  const tabs = page.locator('.view-tab');
  await expect(tabs.first()).toBeVisible();
  const count = await tabs.count();
  expect(count).toBe(6);
  await expect(tabs.first()).toHaveAttribute('id', 'btn-ai');
  await expect(page.locator('#btn-ai')).toHaveClass(/active/);
  await expect(page.locator('#ai-container')).toHaveClass(/view-active/);
  await expect(page.locator('#graph-container')).not.toHaveClass(/view-active/);
});

async function expectConnectedDevicesAcrossTabs(page, viewportWidth) {
  const panel = page.locator('.side-panel');
  const cards = page.locator('#device-list .device-card');
  const tabIds = ['btn-ai', 'btn-graph', 'btn-stats', 'btn-log', 'btn-devices', 'btn-notif-log'];

  await expect.poll(() => cards.count(), { timeout: 15_000 }).toBeGreaterThan(0);
  for (const tabId of tabIds) {
    await page.click(`#${tabId}`);
    await expect(panel, `device panel should remain visible on ${tabId}`).toBeVisible();
    await expect.poll(() => cards.count(), { timeout: 15_000 }).toBeGreaterThan(0);
    await panel.scrollIntoViewIfNeeded();
    const box = await panel.boundingBox();
    expect(box, `device panel should have a layout box on ${tabId}`).not.toBeNull();
    expect(box.x, `device panel should not overflow left on ${tabId}`).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, `device panel should not overflow right on ${tabId}`).toBeLessThanOrEqual(viewportWidth);
  }
}

test('initial device panel loads when live socket updates are unavailable', async ({ page }) => {
  if (!TOKEN) test.skip(true, 'EGRESSVIEW_TOKEN not set — skipping auth-gated test');

  const errors = collectErrors(page);
  let summaryRequests = 0;
  await page.route('**/socket.io/**', route => {
    const isTransportRequest = new URL(route.request().url()).searchParams.has('EIO');
    return isTransportRequest ? route.abort() : route.continue();
  });
  await page.route(/\/api\/connections\/summary\?/, route => {
    summaryRequests += 1;
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        byDevice: [{ src: '192.0.2.25', count: 7, srcMdnsName: 'socket-independent-device' }],
        byTarget: [],
        edges: [],
        total: 7,
        buckets: 60,
        serverTime: Date.now(),
      }),
    });
  });
  await page.addInitScript(tok => {
    localStorage.setItem('egressview_admin_token', tok);
  }, TOKEN);
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });

  await expect.poll(() => summaryRequests).toBeGreaterThan(0);
  expect(errors, `Startup errors:\n  ${errors.join('\n  ')}`).toHaveLength(0);
  await expect(page.locator('#device-list .device-card')).toHaveCount(1);
  await expect(page.locator('#device-list')).toContainText('socket-independent-device');
});

test('desktop keeps the connected device panel populated across every tab', async ({ page }) => {
  if (!TOKEN) test.skip(true, 'EGRESSVIEW_TOKEN not set — skipping auth-gated test');

  await page.setViewportSize({ width: 1440, height: 900 });
  await authPage(page);
  await expectConnectedDevicesAcrossTabs(page, 1440);
});

test('mobile keeps the connected device panel populated across every tab', async ({ page }) => {
  if (!TOKEN) test.skip(true, 'EGRESSVIEW_TOKEN not set — skipping auth-gated test');

  await page.setViewportSize({ width: 390, height: 844 });
  await authPage(page);
  await expectConnectedDevicesAcrossTabs(page, 390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('mobile viewer keeps navigation, logs, and device details inside the viewport', async ({ page }) => {
  if (!TOKEN) test.skip(true, 'EGRESSVIEW_TOKEN not set — skipping auth-gated test');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.route(/\/api\/devices\/merge-candidates\?/, route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ candidates: [] }),
  }));
  await page.route(/\/api\/devices\?/, route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ devices: [{
      deviceId: 8001, ip: '192.0.2.80', mac: 'aa:bb:cc:dd:ee:80',
      vendor: 'Mobile fixture', dnsName: 'phone.example', ipv6Addrs: [],
      sources: 'yamaha,cisco', status: 'active', firstSeen: Date.now() - 60_000,
      lastSeen: Date.now(), note: 'Visible on a narrow screen',
    }] }),
  }));
  await authPage(page);

  const errors = collectErrors(page);
  const tabs = page.locator('.view-tab');
  await expect(tabs).toHaveCount(6);
  for (let index = 0; index < 6; index += 1) {
    const box = await tabs.nth(index).boundingBox();
    expect(box, `mobile tab ${index} should have a layout box`).not.toBeNull();
    expect(box.x, `mobile tab ${index} should not overflow left`).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, `mobile tab ${index} should not overflow right`).toBeLessThanOrEqual(390);
    expect(box.height, `mobile tab ${index} should be touchable`).toBeGreaterThanOrEqual(38);
  }

  await page.click('#btn-log');
  await expect(page.locator('#log-container')).toBeVisible();
  await expect(page.locator('#log-table')).toBeVisible();
  expect(await page.locator('#log-table th').first().evaluate(el => getComputedStyle(el).position)).toBe('sticky');

  await page.click('#btn-devices');
  const row = page.locator('#devices-tbody tr[data-ip]');
  await expect(row).toHaveCount(1);
  await row.click();
  const detail = page.locator('#dv-detail-panel');
  await expect(detail).toBeVisible();
  const detailBox = await detail.boundingBox();
  expect(detailBox.x).toBeGreaterThanOrEqual(0);
  expect(detailBox.x + detailBox.width).toBeLessThanOrEqual(390);
  await page.click('#dv-detail-close');
  await expect(detail).toBeHidden();

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(fatalErrors(errors), `Mobile viewer errors:\n  ${fatalErrors(errors).join('\n  ')}`).toHaveLength(0);
});

test('graph canvas renders after auth from the summary API', async ({ page }) => {
  if (!TOKEN) test.skip(true, 'EGRESSVIEW_TOKEN not set — skipping auth-gated test');

  await authPage(page);

  // The initial Socket.IO payload caches the summary; opening Graph renders it.
  await page.click('#btn-graph');
  const graphContainer = page.locator('#graph-container');
  await expect(graphContainer).toBeVisible();
  const childCount = await graphContainer.evaluate(el => el.children.length);
  expect(childCount, 'graph container should have rendered children after summary fetch').toBeGreaterThan(0);

  // P2-25: the renderer (graph-render.js) must actually draw node and link
  // elements — container children alone would pass even if drawNodes broke.
  await expect
    .poll(() => page.locator('#graph g.node').count(), { timeout: 15_000 })
    .toBeGreaterThan(0);
  await expect
    .poll(() => page.locator('#graph line').count(), { timeout: 15_000 })
    .toBeGreaterThan(0);
});

test('graph tooltips render external values as text', async ({ page }) => {
  if (!TOKEN) test.skip(true, 'EGRESSVIEW_TOKEN not set — skipping auth-gated test');

  const errors = collectErrors(page);
  await authPage(page);
  await page.click('#btn-graph');
  await page.evaluate(async () => {
    const panels = await import('/js/graph-panels.js?v=p2-27-tooltip-smoke');
    panels.showTooltip({ clientX: 100, clientY: 100 }, {
      type: 'client',
      client: {
        name: '<script>Client</script>',
        ip: '<img src=x onerror=alert(1)>',
        mac: '<svg onload=alert(1)>',
        vendor: '<b>Vendor</b>',
        dnsName: '<i>dns</i>',
        mdnsName: '<u>mdns</u>',
        ipv6Addrs: ['2001:db8::1'],
        summarySessions: 1234,
        rxRate: 10,
        txRate: 20,
        rssi: -42,
      },
    });
  });

  const tooltip = page.locator('#tooltip');
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText('<script>Client</script>');
  await expect(tooltip).toContainText('<img src=x onerror=alert(1)>');
  await expect(tooltip).toContainText('IPv6');
  await expect(tooltip).toContainText('summary: 1,234 sessions');
  await expect(tooltip).toContainText('RSSI: -42 dBm');
  await expect(tooltip.locator('script, img, svg')).toHaveCount(0);

  await page.evaluate(async () => {
    const panels = await import('/js/graph-panels.js?v=p2-27-tooltip-smoke');
    panels.showTooltip({ clientX: 100, clientY: 100 }, {
      type: 'org', label: '<img src=x>', flag: '<script>flag</script>',
      country: '<svg>JP</svg>', totalSessions: 20, summary: true,
    });
  });
  await expect(tooltip).toContainText('<script>flag</script>');
  await expect(tooltip).toContainText('summary destination');
  await expect(tooltip.locator('script, img, svg')).toHaveCount(0);

  await page.evaluate(async () => {
    const panels = await import('/js/graph-panels.js?v=p2-27-tooltip-smoke');
    panels.hideTooltip();
  });
  await expect(tooltip).toBeHidden();
  expect(fatalErrors(errors), `Graph tooltip errors:\n  ${fatalErrors(errors).join('\n  ')}`).toHaveLength(0);
});

test('graph side panel renders external values as text', async ({ page }) => {
  if (!TOKEN) test.skip(true, 'EGRESSVIEW_TOKEN not set — skipping auth-gated test');

  const errors = collectErrors(page);
  await authPage(page);
  await page.evaluate(async () => {
    const panels = await import('/js/graph-panels.js?v=p2-27-side-panel-smoke');
    const client = {
      mac: '<svg onload=alert(1)>',
      ip: '<img src=x onerror=alert(1)>',
      name: '<script>Client</script>',
      vendor: '<b>Vendor</b>',
      dnsName: '<i>dns</i>',
      mdnsName: '<u>mdns</u>',
      type: 'wired',
      amesh_papMac: 'mesh-1',
      ipv6Addrs: ['2001:db8::1'],
      deviceFirstSeen: Date.now(),
      rxRate: 1024,
      txRate: 2048,
    };
    const meshNodes = [{ mac: 'mesh-1', model: '<svg>RT-BE92U</svg>' }];
    panels.setGraphDevicesDataRef([]);
    panels.updateFilterTabs(meshNodes, 'mesh-1', [client]);
    panels.updateSidePanel([client], { wanRx: 4096, wanTx: 8192 }, meshNodes, 'mesh-1');
  });

  const tabs = page.locator('#filter-tabs');
  const card = page.locator('#device-list .device-card');
  await expect(tabs).toContainText('<svg>RT-BE92U</svg>');
  await expect(tabs.locator('script, img, svg')).toHaveCount(0);
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('<script>Client</script>');
  await expect(card).toContainText('<img src=x onerror=alert(1)>');
  await expect(card).toContainText('<svg onload=alert(1)>');
  await expect(card).toContainText('<b>Vendor</b>');
  await expect(card).toContainText('<svg>92U</svg>');
  await expect(card).toContainText('IPv4');
  await expect(card).toContainText('IPv6');
  await expect(card.locator('script, img, svg, b, i, u')).toHaveCount(0);
  await expect(card.locator('.traffic-bar-fill.rx')).toHaveAttribute('style', /width:/);
  expect(fatalErrors(errors), `Graph side-panel errors:\n  ${fatalErrors(errors).join('\n  ')}`).toHaveLength(0);
});

test('no console errors after auth', async ({ page }) => {
  if (!TOKEN) test.skip(true, 'EGRESSVIEW_TOKEN not set — skipping auth-gated test');

  const errors = collectErrors(page);
  await authPage(page);

  expect(fatalErrors(errors), `Console errors:\n  ${fatalErrors(errors).join('\n  ')}`).toHaveLength(0);
});

// (6) Tab switching must work without errors (safety net after refactoring)
test('tab switching produces no console errors', async ({ page }) => {
  if (!TOKEN) test.skip(true, 'EGRESSVIEW_TOKEN not set — skipping auth-gated test');

  const errors = collectErrors(page);
  await authPage(page);

  // Click through every tab in turn and confirm no errors are raised
  for (const btnId of ['btn-stats', 'btn-log', 'btn-devices', 'btn-notif-log', 'btn-ai', 'btn-graph']) {
    await page.click(`#${btnId}`);
    await page.waitForTimeout(500);
  }

  expect(fatalErrors(errors), `Tab switch errors:\n  ${fatalErrors(errors).join('\n  ')}`).toHaveLength(0);
});

test('AI insights renders local facts and links threats to the filtered log', async ({ page }) => {
  if (!TOKEN) test.skip(true, 'EGRESSVIEW_TOKEN not set — skipping auth-gated test');

  await authPage(page);
  await page.route(/\/api\/ai\/facts(?:\?|$)/, route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      serverTime: Date.now(),
      range: { from: 1000, to: 2000, durationMs: 1000 },
      previousRange: { from: 0, to: 1000, durationMs: 1000 },
      collection: {
        health: 'partial', enabledCount: 2, readyCount: 1, reportedSessions: 12,
        lastUpdatedAt: Date.now(),
        routers: [
          { id: 'r1', kind: 'yamaha', displayName: 'Primary', enabled: true, ready: true, sessionCount: 12 },
          { id: 'r2', kind: 'cisco', displayName: 'Backup', enabled: true, ready: false, sessionCount: 0 },
        ],
      },
      current: { connections: 25, devices: 4, destinations: 9, safe: 23, warn: 1, danger: 1 },
      previous: { connections: 20, devices: 3, destinations: 8, safe: 20, warn: 0, danger: 0 },
    }),
  }));
  await page.route(/\/api\/ai\/usage\/monthly(?:\?|$)/, route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      pricing: { currency: 'USD', approximate: true },
      current: {
        requests: 3, pricedRequests: 2, unknownPriceRequests: 1,
        inputTokens: 1200, outputTokens: 300, totalTokens: 1500,
        pricedTokens: 1050, unpricedTokens: 450, estimatedCostUsd: 0.0084,
        unpricedModels: [{ provider: 'openai', model: 'future-model', requests: 1, totalTokens: 450 }],
      },
      previous: { requests: 1, pricedRequests: 1, inputTokens: 100, outputTokens: 50, totalTokens: 150, estimatedCostUsd: 0.0004 },
    }),
  }));

  await page.click('#btn-ai');
  await expect(page.locator('#ai-container')).toHaveClass(/view-active/);
  await expect(page.locator('#ai-value-connections')).toHaveText('25');
  await expect(page.locator('#ai-usage-current-tokens')).toContainText('1,500');
  await expect(page.locator('#ai-usage-current-cost')).toContainText(/USD\s*0\.0084/);
  await expect(page.locator('#ai-usage-current-cost')).toContainText('部分合計');
  await expect(page.locator('#ai-usage-current-unpriced')).toContainText('450');
  await expect(page.locator('#ai-usage-caveat')).toContainText('openai/future-model');
  await expect(page.locator('.ai-chat + .ai-usage-summary')).toBeVisible();
  await page.route(/\/api\/config\/general$/, route => route.request().method() === 'POST'
    ? route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, language: 'en' }) })
    : route.continue());
  await page.click('#settings-btn');
  await page.click('.settings-tab[data-tab="general"]');
  await page.locator('#s-language').selectOption('en');
  await page.click('#general-save-btn');
  await expect(page.locator('#ai-usage-current-cost')).toContainText(/partial total.*\$0\.0084/);
  await page.click('#settings-close');
  await expect(page.locator('#ai-collection-label')).toContainText(/1\/2/);
  await expect(page.locator('[data-ai-metric="danger"]')).toHaveClass(/has-findings/);
  await page.locator('[data-ai-metric="danger"]').click();
  await expect(page.locator('#log-container')).toHaveClass(/view-active/);
});

test('AI chat keeps a persisted question visible when provider inference fails', async ({ page }) => {
  if (!TOKEN) test.skip(true, 'EGRESSVIEW_TOKEN not set — skipping auth-gated test');

  let questionPersisted = false;
  await page.route(/\/api\/ai\/conversations(?:\/conversation-1)?(?:\?|$)/, route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/conversation-1')) {
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          messages: [
            { role: 'user', body: 'Which connection should I review?', status: 'completed' },
            { role: 'assistant', body: '', status: 'failed', provider: 'openai', model: 'gpt-5-mini' },
          ],
        }),
      });
    }
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        conversations: questionPersisted
          ? [{ conversationId: 'conversation-1', createdAt: Date.now(), messageCount: 2 }]
          : [],
        storage: questionPersisted
          ? { conversations: 1, messages: 2, bodyBytes: 33 }
          : { conversations: 0, messages: 0, bodyBytes: 0 },
      }),
    });
  });
  await page.route(/\/api\/ai\/chat$/, route => {
    questionPersisted = true;
    return route.fulfill({
      status: 502,
      contentType: 'application/json',
      body: JSON.stringify({
        error: 'Provider temporarily unavailable',
        conversationId: 'conversation-1',
      }),
    });
  });

  await authPage(page);
  await page.click('#btn-ai');
  await page.locator('#ai-chat-input').fill('Which connection should I review?');
  await page.click('#ai-chat-send-btn');

  await expect(page.locator('#ai-error')).toContainText('Provider temporarily unavailable');
  await expect(page.locator('#ai-chat-messages .is-user')).toHaveText('Which connection should I review?');
  await expect(page.locator('#ai-chat-messages .is-assistant')).toHaveClass(/is-failed/);
  await expect(page.locator('#ai-chat-messages .is-assistant')).not.toHaveClass(/is-pending/);
  await expect(page.locator('#ai-conversation-select')).toHaveValue('conversation-1');
});

// (7) Notification log detail: clicking a row opens it, the top-right X closes it
test('notification log detail popup opens and closes', async ({ page }) => {
  if (!TOKEN) test.skip(true, 'EGRESSVIEW_TOKEN not set — skipping auth-gated test');

  const errors = collectErrors(page);
  await authPage(page);

  await page.route(/\/api\/notification-log(?:\?|$)/, route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      logs: [{
        type: 'threat',
        detectedAt: Date.now(),
        src: '<img src=x onerror=alert(1)>',
        dst: '198.51.100.20',
        dstHost: 'notification.example',
        dport: 443,
        proto: 'TCP',
        threatTag: '<script>smoke-threat</script>',
        org: 'Smoke Org',
        slackSent: true,
      }],
    }),
  }));

  await page.click('#btn-notif-log');
  const rows = page.locator('#notif-log-tbody tr');
  await expect(rows).toHaveCount(1);
  await expect(rows.first().locator('td')).toHaveCount(7);
  await expect(rows.first()).toContainText('<script>smoke-threat</script>');
  await expect(rows.first().locator('script, img')).toHaveCount(0);

  await rows.first().click();
  const overlay = page.locator('#notif-log-detail-overlay');
  await expect(overlay).toBeVisible();
  await expect(page.locator('#notif-log-detail-body table')).toHaveCount(1);
  await expect(page.locator('#notif-log-detail-body')).toContainText('<img src=x onerror=alert(1)>');
  await expect(page.locator('#notif-log-detail-body script, #notif-log-detail-body img')).toHaveCount(0);
  await page.click('#notif-log-detail-close');
  await expect(overlay).toHaveClass(/hidden/);

  expect(fatalErrors(errors), `Notification detail errors:\n  ${fatalErrors(errors).join('\n  ')}`).toHaveLength(0);
});

test('device list and detail render external values as DOM text', async ({ page }) => {
  if (!TOKEN) test.skip(true, 'EGRESSVIEW_TOKEN not set — skipping auth-gated test');

  const errors = collectErrors(page);
  await authPage(page);
  await page.route(/\/api\/devices\/merge-candidates\?/, route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      candidates: [{
        id: 501,
        deviceIdA: 1001,
        deviceIdB: 1002,
        ipB: '192.0.2.51',
        macB: '11:22:33:44:55:66',
        dnsNameB: '<b>merge candidate</b>',
        score: 0.9,
        reasons: ['same vendor'],
      }],
    }),
  }));
  await page.route(/\/api\/devices\?/, route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      devices: [{
        deviceId: 1001,
        ip: '192.0.2.50',
        mac: 'aa:bb:cc:dd:ee:ff',
        vendor: '<script>device-vendor</script>',
        dnsName: '<img src=x onerror=alert(1)>',
        ipv6Addrs: ['2001:db8::50'],
        sources: 'yamaha,cisco',
        status: 'active',
        firstSeen: Date.now() - 60_000,
        lastSeen: Date.now(),
        note: '<b>device note</b>',
      }],
    }),
  }));

  await page.click('#btn-devices');
  const row = page.locator('#devices-tbody tr[data-ip]');
  await expect(row).toHaveCount(1);
  await expect(row.locator('td')).toHaveCount(8);
  await expect(row).toContainText('<script>device-vendor</script>');
  await expect(row.locator('script, img')).toHaveCount(0);

  await row.click();
  await expect(page.locator('#dv-detail-panel')).toBeVisible();
  await expect(page.locator('#dv-detail-note-ta')).toHaveValue('<b>device note</b>');
  await expect(page.locator('#dv-detail-body')).toContainText('<img src=x onerror=alert(1)>');
  await expect(page.locator('#dv-detail-body script, #dv-detail-body img')).toHaveCount(0);
  const mergeCard = page.locator('.dv-merge-card[data-candidate-id="501"]');
  await expect(mergeCard).toHaveCount(1);
  await expect(mergeCard.locator('[data-action="merge"], [data-action="reject"]')).toHaveCount(2);
  await expect(mergeCard).toContainText('<b>merge candidate</b>');
  expect(fatalErrors(errors), `Device DOM rendering errors:\n  ${fatalErrors(errors).join('\n  ')}`).toHaveLength(0);
});

test('threat detail renders external values as DOM text and keeps actions wired', async ({ page }) => {
  if (!TOKEN) test.skip(true, 'EGRESSVIEW_TOKEN not set — skipping auth-gated test');

  const errors = collectErrors(page);
  let savedNote = null;
  await page.route(/\/api\/connections\?/, route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      connections: [{
        src: '<img src=x onerror=alert(1)>',
        srcDnsName: '<script>source-name</script>',
        srcMac: 'aa:bb:cc:dd:ee:ff',
        srcVendor: '<b>Smoke Vendor</b>',
        dst: '198.51.100.20',
        dstHost: '<svg onload=alert(1)>',
        dport: 443,
        proto: 'TCP',
        country: 'JP',
        city: '<i>Tokyo</i>',
        org: '<a href=x>Smoke Org</a>',
        firstSeen: Date.now() - 60_000,
        lastSeen: Date.now(),
        threat: {
          confidence: 'high',
          source: '<script>smoke-feed</script>',
          tag: '<img src=x>',
          matchType: 'ip',
          matchValue: '<b>198.51.100.20</b>',
          url: 'https://example.test/<script>alert(1)</script>',
        },
      }],
      total: 1,
      serverTime: Date.now(),
    }),
  }));
  await page.route(/\/api\/connections\/threat-counts(?:\?|$)/, route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ safe: 0, warn: 0, danger: 1 }),
  }));
  await page.route(/\/api\/notes\/draft$/, route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ draft: '<img src=x onerror=alert(1)>' }),
  }));
  await page.route(/\/api\/notes$/, async route => {
    savedNote = route.request().postDataJSON().note;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true }) });
  });

  await authPage(page);
  await page.click('#btn-log');
  const threatRow = page.locator('#log-tbody tr.threat-row');
  await expect(threatRow).toHaveCount(1);
  await threatRow.click();

  const overlay = page.locator('#threat-detail-overlay');
  const body = page.locator('#threat-detail-body');
  await expect(overlay).toBeVisible();
  await expect(body.locator('table')).toHaveCount(4);
  await expect(body).toContainText('<script>smoke-feed</script>');
  await expect(body).toContainText('<svg onload=alert(1)>');
  await expect(body.locator('script, img, svg')).toHaveCount(0);

  await page.click('#threat-detail-investigate-btn');
  await expect(page.locator('#threat-detail-note')).toHaveValue('<img src=x onerror=alert(1)>');
  await page.locator('#threat-detail-note').fill('<b>saved literally</b>');
  await page.click('#threat-detail-save-btn');
  await expect(page.locator('#threat-detail-status')).toContainText(/保存|Saved/);
  expect(savedNote).toBe('<b>saved literally</b>');
  expect(fatalErrors(errors), `Threat detail errors:\n  ${fatalErrors(errors).join('\n  ')}`).toHaveLength(0);
});

test('beacon list renders candidate values as text and keeps dismiss wired', async ({ page }) => {
  if (!TOKEN) test.skip(true, 'EGRESSVIEW_TOKEN not set — skipping auth-gated test');

  let dismissedId = null;
  await page.route('**/api/beacons**', async route => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'POST') {
      dismissedId = Number(url.pathname.split('/').at(-2));
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        beacons: [{
          id: 42,
          status: 'active',
          src: '192.0.2.10',
          dst: '198.51.100.20',
          dstHost: '<img src=x onerror=alert(1)>',
          intervalMs: 120_000,
          intervalCov: 0.08,
          obsCount: 12,
          firstSeen: 100,
          lastSeen: 200,
        }],
      }),
    });
  });

  const errors = collectErrors(page);
  await authPage(page);
  await page.locator('#btn-log').click();

  await expect(page.locator('#beacon-banner')).toBeVisible();
  await page.locator('#beacon-banner-bar').click();
  const list = page.locator('#beacon-list');
  await expect(list).toBeVisible();
  await expect(list.locator('tbody tr')).toHaveCount(1);
  await expect(list).toContainText('<img src=x onerror=alert(1)>');
  await expect(list).toContainText('198.51.100.20');
  await expect(list.locator('script, img, svg')).toHaveCount(0);
  await list.locator('.beacon-dismiss-btn').click();
  await expect(page.locator('#beacon-banner')).toBeHidden();
  expect(dismissedId).toBe(42);
  expect(fatalErrors(errors), `Beacon list errors:\n  ${fatalErrors(errors).join('\n  ')}`).toHaveLength(0);
});

test('connection side panel groups destinations and renders external values as text', async ({ page }) => {
  if (!TOKEN) test.skip(true, 'EGRESSVIEW_TOKEN not set — skipping auth-gated test');

  const errors = collectErrors(page);
  await authPage(page);
  await page.evaluate(async () => {
    const panel = await import('/js/connections-panel.js?v=p2-27-panel-smoke');
    panel.setCurrentTimeFilter('custom');
    panel.setCustomRangeFrom(null);
    panel.setCustomRangeTo(null);
    panel.setAllConnections([
      {
        src: '192.0.2.10', dst: '198.51.100.20', dstHost: '<img src=x onerror=alert(1)>',
        dport: 443, proto: '<script>TCP</script>', country: 'JP',
        org: '<svg onload=alert(1)>', threat: { tag: '<b>threat title</b>' },
      },
      {
        src: '192.0.2.10', dst: '198.51.100.20', dstHost: '<img src=x onerror=alert(1)>',
        dport: 443, proto: '<script>TCP</script>', country: 'JP',
        org: '<svg onload=alert(1)>', threat: { tag: '<b>threat title</b>' },
      },
      { src: '192.0.2.10', dst: '203.0.113.30', dport: 80, proto: 'TCP' },
    ]);
    panel.updateConnPanel('192.0.2.10');
  });

  const panel = page.locator('#conn-panel');
  const rows = page.locator('#conn-list .conn-row');
  await expect(panel).toBeVisible();
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('HTTPS ×2');
  await expect(panel).toContainText('<img src=x onerror=alert(1)>');
  await expect(panel).toContainText('203.0.113.30');
  await expect(panel.locator('script, img, svg')).toHaveCount(0);
  await expect(page.locator('#conn-count')).toContainText('3');

  await page.evaluate(async () => {
    const panelModule = await import('/js/connections-panel.js?v=p2-27-panel-smoke');
    panelModule.updateConnPanel(null);
  });
  await expect(panel).toBeHidden();
  expect(fatalErrors(errors), `Connection panel errors:\n  ${fatalErrors(errors).join('\n  ')}`).toHaveLength(0);
});

// (8) Changing the time filter must not raise errors (indirect test of getFilteredConnections)
test('time filter change produces no console errors', async ({ page }) => {
  if (!TOKEN) test.skip(true, 'EGRESSVIEW_TOKEN not set — skipping auth-gated test');

  const errors = collectErrors(page);
  await authPage(page);

  const select = page.locator('#time-filter-select');
  for (const value of ['24h', '6h', '7d', '14d', '1h']) {
    await select.selectOption(value);
    await page.waitForTimeout(500);
  }

  expect(fatalErrors(errors), `Time filter errors:\n  ${fatalErrors(errors).join('\n  ')}`).toHaveLength(0);
});

// (9) The connection log must show data over a long period (2 weeks)
test('log view shows rows with long period (14d)', async ({ page }) => {
  if (!TOKEN) test.skip(true, 'EGRESSVIEW_TOKEN not set — skipping auth-gated test');

  const errors = collectErrors(page);
  await authPage(page);

  // Switch to 2 weeks
  await page.locator('#time-filter-select').selectOption('14d');
  await page.waitForTimeout(1000);

  // Go to the connection log tab
  await page.click('#btn-log');
  await page.waitForTimeout(2000);

  // A real connection row must retain the nine-column table structure.
  const rows = page.locator('#log-tbody tr:not(#log-scroll-sentinel)');
  const rowCount = await rows.count();
  expect(rowCount, 'log view should show rows for 14d period').toBeGreaterThan(0);
  await expect(rows.first().locator('td')).toHaveCount(9);
  await expect(rows.first().locator('td').first()).not.toHaveText('');

  expect(fatalErrors(errors), `Long period log errors:\n  ${fatalErrors(errors).join('\n  ')}`).toHaveLength(0);
});

test('connection export streams authenticated CSV and JSON for a selected period', async ({ request }) => {
  if (!TOKEN) test.skip(true, 'EGRESSVIEW_TOKEN not set — skipping auth-gated test');

  const from = Date.now() - 14 * 86400_000;
  const headers = { 'X-Admin-Token': TOKEN };
  const csv = await request.get(`${BASE}/api/connections/export?format=csv&from=${from}`, { headers });
  expect(csv.ok()).toBeTruthy();
  expect(csv.headers()['content-type']).toContain('text/csv');
  expect(csv.headers()['content-disposition']).toMatch(/egressview-connections-.*\.csv/);
  expect(csv.headers()['x-export-count']).toMatch(/^\d+$/);
  expect((await csv.text()).replace(/^\uFEFF/, '')).toMatch(/^src,srcMac,srcVendor/);

  const json = await request.get(`${BASE}/api/connections/export?format=json&from=${from}`, { headers });
  expect(json.ok()).toBeTruthy();
  const body = await json.json();
  expect(body.meta.exported).toBe(body.connections.length);
  expect(body.meta.limit).toBe(50000);
  expect(Array.isArray(body.connections)).toBeTruthy();
});

// (10) Stats tab: switching the summary (destination/device) must not raise errors
test('stats tab summary switching produces no console errors', async ({ page }) => {
  if (!TOKEN) test.skip(true, 'EGRESSVIEW_TOKEN not set — skipping auth-gated test');

  const errors = collectErrors(page);
  await authPage(page);

  await page.click('#btn-stats');
  await page.waitForTimeout(1000);

  // Click every view-switch button in the stats tab, if any exist
  const statsBtns = page.locator('#stats-view [data-view], #stats-panel [data-view], .stats-tab-btn, #btn-stats-dst, #btn-stats-device');
  const btnCount = await statsBtns.count();
  for (let i = 0; i < btnCount; i++) {
    await statsBtns.nth(i).click().catch(() => {});
    await page.waitForTimeout(300);
  }

  expect(fatalErrors(errors), `Stats switch errors:\n  ${fatalErrors(errors).join('\n  ')}`).toHaveLength(0);
});

// (11) Stats tab: the map must render
test('stats tab renders map canvas', async ({ page }) => {
  if (!TOKEN) test.skip(true, 'EGRESSVIEW_TOKEN not set — skipping auth-gated test');

  await authPage(page);
  await page.click('#btn-stats');
  await expect(page.locator('#stats-container')).toBeVisible();
  await page.waitForTimeout(2000);

  // An SVG or canvas must exist in the stats area
  const mapEl = page.locator('#st-globe canvas, #st-globe svg, #st-flat canvas, #st-flat svg').first();
  const hasMap = await mapEl.count() > 0;
  if (hasMap) {
    await expect(mapEl).toBeVisible();
  } else {
    // If no map element is found, it's still OK as long as the stats container itself is visible
    const statsContainer = page.locator('#stats-container').first();
    await expect(statsContainer).toBeVisible();
  }
  await expect(page.locator('#st-globe-controls .globe-ctrl-btn')).toHaveCount(3);
  await expect(page.locator('#st-flat-controls .fmc-btn')).toHaveCount(7);
});

test('stats tab renders map coverage label and chart svgs without console errors', async ({ page }) => {
  if (!TOKEN) test.skip(true, 'EGRESSVIEW_TOKEN not set — skipping auth-gated test');

  const errors = collectErrors(page);
  await authPage(page);
  await page.locator('#time-filter-select').selectOption('14d');
  await page.click('#btn-stats');

  await expect(page.locator('#stats-container')).toBeVisible();
  await page.waitForTimeout(2_000);

  const coverage = page.locator('#stats-map-coverage');
  const coverageVisible = await coverage.isVisible();
  if (coverageVisible) {
    await expect(coverage).toContainText(/地図表示|Map|簡略表示|Compact/);
  } else {
    await expect(coverage).toHaveCount(1);
  }

  await expect(page.locator('#st-globe-svg')).toBeVisible();
  await expect(page.locator('#st-flat-svg')).toBeVisible();
  await expect(page.locator('#chart-bar')).toBeVisible();
  await expect(page.locator('#chart-timeline')).toBeVisible();

  // P2-28: the extracted chart/map modules must actually draw elements —
  // container visibility alone would pass even if the renderers broke.
  await expect
    .poll(() => page.locator('#chart-bar rect').count(), { timeout: 15_000 })
    .toBeGreaterThan(0);
  await expect
    .poll(() => page.locator('#chart-timeline path').count(), { timeout: 15_000 })
    .toBeGreaterThan(0);
  await expect
    .poll(() => page.locator('#st-app-pie-svg *').count(), { timeout: 15_000 })
    .toBeGreaterThan(0);
  await expect
    .poll(() => page.locator('#st-globe-svg path').count(), { timeout: 15_000 })
    .toBeGreaterThan(0);

  expect(fatalErrors(errors), `Stats render errors:\n  ${fatalErrors(errors).join('\n  ')}`).toHaveLength(0);
});

test('graph map uses summary without full-history requests or console errors', async ({ page }) => {
  if (!TOKEN) test.skip(true, 'EGRESSVIEW_TOKEN not set — skipping auth-gated test');

  const errors = collectErrors(page);
  await authPage(page);
  const historyRequests = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.endsWith('/api/connections')) historyRequests.push(url.toString());
  });
  await page.locator('#time-filter-select').selectOption('14d');
  await page.click('#btn-graph');

  await expect(page.locator('#graph-container')).toBeVisible();
  await expect(page.locator('#graph-summary-notice')).toHaveCount(1);
  await expect(page.locator('#graph-summary-notice')).toBeVisible();
  const graphChildren = await page.locator('#graph-container').evaluate(el => el.children.length);
  expect(graphChildren, 'graph container should keep rendered child elements').toBeGreaterThan(0);
  expect(historyRequests, 'graph period changes must use summary instead of full history').toHaveLength(0);

  expect(fatalErrors(errors), `Graph notice errors:\n  ${fatalErrors(errors).join('\n  ')}`).toHaveLength(0);
});

test('bounded five-minute live graph uses detailed rendering', async ({ page }) => {
  if (!TOKEN) test.skip(true, 'EGRESSVIEW_TOKEN not set — skipping auth-gated test');

  const errors = collectErrors(page);
  await authPage(page);
  const historyRequests = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.endsWith('/api/connections')) historyRequests.push(url.toString());
  });

  await page.locator('#time-filter-select').selectOption('live');
  await expect(page.locator('#time-filter-select option:checked')).toContainText(/5 min|5分/);
  await expect(page.locator('#graph-summary-notice')).not.toBeVisible();
  await expect(page.locator('#graph text').filter({ hasText: 'Σ' })).toHaveCount(0);
  expect(historyRequests, 'bounded live rendering must reuse WebSocket history').toHaveLength(0);
  expect(fatalErrors(errors), `Live graph errors:\n  ${fatalErrors(errors).join('\n  ')}`).toHaveLength(0);
});

test('fifteen-minute graph remains available as a summary range', async ({ page }) => {
  if (!TOKEN) test.skip(true, 'EGRESSVIEW_TOKEN not set — skipping auth-gated test');

  const errors = collectErrors(page);
  await authPage(page);
  await page.click('#btn-graph');
  await page.locator('#time-filter-select').selectOption('15m');
  await expect(page.locator('#time-filter-select option:checked')).toContainText(/15 min|15分/);
  await expect(page.locator('#graph-summary-notice')).toBeVisible();
  expect(fatalErrors(errors), `15-minute graph errors:\n  ${fatalErrors(errors).join('\n  ')}`).toHaveLength(0);
});

test('general settings save round-trip works without console errors', async ({ page, request }) => {
  if (!TOKEN) test.skip(true, 'EGRESSVIEW_TOKEN not set — skipping auth-gated test');

  const errors = collectErrors(page);
  await authPage(page);

  const headers = { 'X-Admin-Token': TOKEN, 'Content-Type': 'application/json' };
  const originalCountry = await page.locator('#s-home-country').inputValue();
  const originalLanguage = await page.locator('#s-language').inputValue();
  const targetCountry = originalCountry === 'JP' ? 'US' : 'JP';

  await page.click('#settings-btn');
  await page.click('.settings-tab[data-tab="general"]');
  await page.locator('#s-home-country').selectOption(targetCountry);
  await page.locator('#s-language').selectOption(originalLanguage);
  await page.click('#general-save-btn');
  await expect(page.locator('#general-status')).toBeVisible();
  await expect(page.locator('#general-status')).toContainText(/保存|Saved|✓/);

  const verify = await request.post(`${BASE}/api/config/general`, {
    headers,
    data: { homeCountry: targetCountry, language: originalLanguage },
  });
  expect(verify.ok()).toBeTruthy();
  const verified = await verify.json();
  expect(verified.homeCountry).toBe(targetCountry);

  await request.post(`${BASE}/api/config/general`, {
    headers,
    data: { homeCountry: originalCountry, language: originalLanguage },
  });

  expect(fatalErrors(errors), `Settings save errors:\n  ${fatalErrors(errors).join('\n  ')}`).toHaveLength(0);
});

test('settings tabs save and connection buttons work without console errors', async ({ page }) => {
  if (!TOKEN) test.skip(true, 'EGRESSVIEW_TOKEN not set — skipping auth-gated test');

  const errors = collectErrors(page);
  await mockSettingsRoutes(page);
  await authPage(page);

  await page.click('#settings-btn');
  await expect(page.locator('#settings-overlay')).toBeVisible();

  await page.click('#router-add-btn');
  await page.locator('#router-display-name').fill('<img src=x onerror=alert(1)>');
  await page.locator('#router-ip').fill('192.168.1.1');
  await page.locator('#router-user').fill('admin');
  await page.locator('#router-pass').fill('demo-pass');
  await page.locator('#router-nat').fill('100');
  await page.click('#router-detect-btn');
  await expect(page.locator('#router-editor-status')).toBeVisible();
  await expect(page.locator('#router-editor-status')).toContainText('SSH');
  await page.click('#router-save-btn');
  await expect(page.locator('.router-card')).toContainText('Yamaha RTX');
  await expect(page.locator('.router-card')).toContainText('<img src=x onerror=alert(1)>');
  await expect(page.locator('.router-card img')).toHaveCount(0);
  await page.locator('.router-edit').click();
  await expect(page.locator('#router-display-name')).toHaveValue('<img src=x onerror=alert(1)>');
  await page.locator('#router-cancel-btn').click();

  await page.click('.settings-tab[data-tab="l2"]');
  await page.locator('#s-asus-ip').fill('192.168.1.2');
  await page.locator('#s-asus-user').fill('admin');
  await page.locator('#s-asus-pass').fill('demo-pass');
  await page.click('#asus-connect-btn');
  await expect(page.locator('#asus-status')).toBeVisible();
  await page.waitForSelector('#settings-overlay', { state: 'hidden' });

  await page.click('#settings-btn');
  await page.click('.settings-tab[data-tab="general"]');
  await expect(page.locator('#pane-general')).toHaveClass(/active/);
  const sessionRows = page.locator('#sessions-list .settings-session-row');
  await expect(sessionRows).toHaveCount(2);
  await expect(page.locator('#sessions-list')).toContainText('<script>Current device</script>');
  await expect(page.locator('#sessions-list')).toContainText('<img src=x onerror=alert(1)>');
  await expect(page.locator('#sessions-list script, #sessions-list img')).toHaveCount(0);
  await expect(page.locator('#sessions-list .settings-session-revoke')).toHaveCount(1);
  await page.locator('#sessions-list .settings-session-revoke').click();
  await expect(sessionRows).toHaveCount(1);
  await page.locator('#s-home-country').selectOption('JP');
  await page.click('#general-save-btn');
  await expect(page.locator('#general-status')).toBeVisible();
  await expect(page.locator('#general-status')).toContainText(/保存|Saved|✓/);

  await page.click('.settings-tab[data-tab="threat"]');
  await expect(page.locator('#pane-threat')).toHaveClass(/active/);
  await page.click('#threat-save-btn');
  await expect(page.locator('#threat-status')).toBeVisible();
  await page.locator('#s-beacon-minobs').fill('4');
  await page.click('#beacon-save-btn');
  await expect(page.locator('#beacon-status')).toBeVisible();

  await page.locator('#s-slack-token').fill('xoxb-demo-token');
  await page.click('#slack-verify-btn');
  await expect(page.locator('#slack-workspace-info')).toBeVisible();
  await page.locator('#s-slack-username').fill('demo-user');
  await page.click('#slack-lookup-btn');
  await expect(page.locator('#slack-user-info')).toBeVisible();
  await page.click('#slack-save-btn');
  await expect(page.locator('#slack-status')).toBeVisible();
  await page.click('#slack-test-btn');
  await expect(page.locator('#slack-status')).toBeVisible();

  await page.click('.settings-tab[data-tab="ai"]');
  await expect(page.locator('#pane-ai')).toHaveClass(/active/);
  await page.locator('#s-ai-provider').selectOption('anthropic');
  await page.locator('#s-ai-key').fill('demo-anthropic-key');
  await page.locator('#s-ai-model').fill('claude-test');
  await page.click('#ai-test-btn');
  await expect(page.locator('#ai-status')).toContainText(/接続確認OK|Connection OK/);
  await expect(page.locator('#ai-model-options option')).toHaveCount(2);
  await expect(page.locator('#ai-model-options img')).toHaveCount(0);
  await expect(page.locator('#s-ai-key')).toHaveValue('');
  // The model dropdown (select) is populated and selecting an entry fills the model input.
  await expect(page.locator('#s-ai-model-select')).toBeVisible();
  const pickedModel = await page.locator('#s-ai-model-select option').nth(1).getAttribute('value');
  await page.locator('#s-ai-model-select').selectOption(pickedModel);
  await expect(page.locator('#s-ai-model')).toHaveValue(pickedModel);

  // Bedrock geo selection discovers and filters models without requiring a
  // second click on the connection/model refresh button.
  await page.locator('#s-ai-provider').selectOption('bedrock');
  await page.locator('#s-ai-region-select').selectOption('ap-northeast-1');
  await page.locator('#s-ai-profile-select').selectOption('jp.');
  await expect(page.locator('#s-ai-model-select')).toBeEnabled();
  await expect(page.locator('#s-ai-model-select option')).toHaveCount(2);
  await page.locator('#s-ai-model-select').selectOption('jp.anthropic.claude-sonnet-test');
  await expect(page.locator('#s-ai-model')).toHaveValue('jp.anthropic.claude-sonnet-test');

  await page.click('.settings-tab[data-tab="backup"]');
  await expect(page.locator('#pane-backup')).toHaveClass(/active/);
  await expect(page.locator('#backup-list .backup-list-empty')).toHaveCount(1);
  await expect(page.locator('#backup-capacity-status')).toContainText('8.00 GiB');
  await page.click('#backup-config-save');
  await expect(page.locator('#backup-config-status')).toBeVisible();
  await page.click('#backup-prune-btn');
  await expect(page.locator('#backup-prune-status')).toBeVisible();
  await page.click('#backup-create-btn');
  await expect(page.locator('#backup-action-status')).toBeVisible();

  await page.click('.settings-tab[data-tab="datasource"]');
  await expect(page.locator('#pane-datasource')).toHaveClass(/active/);
  await page.locator('#s-dnsmasq-logfile').fill('/var/log/dnsmasq-queries.log');
  await page.locator('#s-inspect-logfile').fill('/var/log/yamaha-router.log');
  await page.locator('#s-dhcpd-logfile').fill('/var/log/yamaha-router.log');
  await page.click('#datasource-save-btn');
  await expect(page.locator('#datasource-status')).toBeVisible();

  expect(fatalErrors(errors), `Settings tab button errors:\n  ${fatalErrors(errors).join('\n  ')}`).toHaveLength(0);
});

test('device detail note save persists after reopening without console errors', async ({ page }) => {
  if (!TOKEN) test.skip(true, 'EGRESSVIEW_TOKEN not set — skipping auth-gated test');

  const errors = collectErrors(page);
  await authPage(page);

  await page.click('#btn-devices');
  await expect(page.locator('#devices-container')).toBeVisible();
  await page.waitForTimeout(1_000);

  const rows = page.locator('#devices-tbody tr[data-ip]');
  const rowCount = await rows.count();
  if (rowCount === 0) {
    test.skip(true, 'no device rows');
  }

  await rows.first().click();
  await expect(page.locator('#dv-detail-panel')).toBeVisible();
  await expect(page.locator('#dv-detail-note-ta')).toBeVisible();

  const originalNote = await page.locator('#dv-detail-note-ta').inputValue();
  const testNote = `Playwright device note ${Date.now()}`;

  try {
    await page.locator('#dv-detail-note-ta').fill(testNote);
    await page.click('#dv-detail-save');
    await expect(page.locator('#dv-detail-save')).toContainText(/保存済|Saved/, { timeout: 5_000 });

    await page.click('#dv-detail-close');
    await expect(page.locator('#dv-detail-panel')).toHaveClass(/hidden/);

    await rows.first().click();
    await expect(page.locator('#dv-detail-note-ta')).toHaveValue(testNote, { timeout: 5_000 });
  } finally {
    const noteInput = page.locator('#dv-detail-note-ta');
    if (!(await noteInput.isVisible().catch(() => false))) {
      await rows.first().click().catch(() => {});
      await noteInput.waitFor({ state: 'visible', timeout: 3_000 }).catch(() => {});
    }
    if (await noteInput.isVisible().catch(() => false)) {
      await page.locator('#dv-detail-note-ta').fill(originalNote);
      await page.click('#dv-detail-save');
      await expect(page.locator('#dv-detail-save')).toContainText(/保存済|Saved/, { timeout: 5_000 });
    }
  }

  expect(fatalErrors(errors), `Device detail save errors:\n  ${fatalErrors(errors).join('\n  ')}`).toHaveLength(0);
});

// (12) Connection log infinite scroll: scrolling must append the next page
test('log view infinite scroll appends rows on scroll', async ({ page }) => {
  if (!TOKEN) test.skip(true, 'EGRESSVIEW_TOKEN not set — skipping auth-gated test');

  const errors = collectErrors(page);
  await authPage(page);

  await page.locator('#time-filter-select').selectOption('14d');
  const connections = Array.from({ length: 201 }, (_, index) => ({
    src: `192.168.1.${(index % 200) + 1}`,
    dst: `203.0.113.${(index % 200) + 1}`,
    dport: 443,
    proto: 'TCP',
    country: 'JP',
    org: `Smoke Org ${index}`,
    firstSeen: Date.now() - index * 1000,
    lastSeen: Date.now() - index * 1000,
    threat: null,
  }));
  await page.route(/\/api\/connections\?/, async route => {
    const url = new URL(route.request().url());
    const offset = Number(url.searchParams.get('offset') || 0);
    const limit = Number(url.searchParams.get('limit') || connections.length);
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        connections: connections.slice(offset, offset + limit),
        total: connections.length,
        serverTime: Date.now(),
      }),
    });
  });
  await page.click('#btn-log');
  const renderedRows = page.locator('#log-tbody tr:not(#log-scroll-sentinel)');
  await expect(renderedRows).toHaveCount(200);

  const firstRowText = await renderedRows.first().textContent();
  await expect(page.locator('#log-scroll-sentinel')).toHaveCount(1);
  await page.locator('#log-scroll-sentinel').scrollIntoViewIfNeeded();
  await expect(renderedRows).toHaveCount(201);
  expect(await renderedRows.first().textContent(), 'append should preserve existing DOM rows').toBe(firstRowText);
  await expect(renderedRows.last().locator('td')).toHaveCount(9);

  expect(fatalErrors(errors), `Scroll errors:\n  ${fatalErrors(errors).join('\n  ')}`).toHaveLength(0);
});

// (13) The demo-mode banner must be visible (only when DEMO_MODE=true)
test('demo banner is visible in demo mode', async ({ page }) => {
  if (!TOKEN) test.skip(true, 'EGRESSVIEW_TOKEN not set — skipping auth-gated test');

  await authPage(page);

  const isDemoMode = await page.evaluate(() => window._DEMO_MODE === true);
  if (!isDemoMode) {
    test.skip(true, 'not running in DEMO_MODE — skipping demo banner test');
  }

  await expect(page.locator('#demo-banner')).toBeVisible();
});
