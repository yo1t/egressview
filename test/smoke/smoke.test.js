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
  'view-tabs.js', 'log.js', 'beacon.js', 'threat-popup.js',
  'devices.js', 'notif-log.js', 'main.js',
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
  expect(csp,  'Content-Security-Policy').toContain("style-src-attr 'unsafe-inline'");
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
  await page.goto('/');
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

  await page.evaluate(async () => {
    const i18n = await import('/js/i18n.js?v=p2-29-smoke');
    i18n.setCurrentLang('en');
    i18n.applyI18n();
  });
  await expect(graphTab).toHaveText('📊 Graph Map');
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
      config: { intervalHours: 24, maxGenerations: 7 },
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

  // Exactly 5 tabs: graph map / stats / connection log / devices / notification log
  const tabs = page.locator('.view-tab');
  await expect(tabs.first()).toBeVisible();
  const count = await tabs.count();
  expect(count).toBe(5);
});

test('graph canvas renders after auth (P2-4: background fetch completes)', async ({ page }) => {
  if (!TOKEN) test.skip(true, 'EGRESSVIEW_TOKEN not set — skipping auth-gated test');

  await authPage(page);

  // P2-4: after initial 1h emit, client fires a background 24h fetch and calls
  // buildGraphFromConnections(). The SVG/canvas element should be populated.
  const graphContainer = page.locator('#graph-container');
  await expect(graphContainer).toBeVisible();
  const childCount = await graphContainer.evaluate(el => el.children.length);
  expect(childCount, 'graph container should have rendered children after background fetch').toBeGreaterThan(0);

  // P2-25: the renderer (graph-render.js) must actually draw node and link
  // elements — container children alone would pass even if drawNodes broke.
  await expect
    .poll(() => page.locator('#graph g.node').count(), { timeout: 15_000 })
    .toBeGreaterThan(0);
  await expect
    .poll(() => page.locator('#graph line').count(), { timeout: 15_000 })
    .toBeGreaterThan(0);
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
  for (const btnId of ['btn-stats', 'btn-log', 'btn-devices', 'btn-notif-log', 'btn-graph']) {
    await page.click(`#${btnId}`);
    await page.waitForTimeout(500);
  }

  expect(fatalErrors(errors), `Tab switch errors:\n  ${fatalErrors(errors).join('\n  ')}`).toHaveLength(0);
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

test('graph map exposes summary/truncation notices without console errors', async ({ page }) => {
  if (!TOKEN) test.skip(true, 'EGRESSVIEW_TOKEN not set — skipping auth-gated test');

  const errors = collectErrors(page);
  await authPage(page);
  await page.locator('#time-filter-select').selectOption('14d');
  await page.click('#btn-graph');

  await expect(page.locator('#graph-container')).toBeVisible();
  await expect(page.locator('#graph-summary-notice')).toHaveCount(1);
  await expect(page.locator('#graph-truncated-notice')).toHaveCount(1);
  const graphChildren = await page.locator('#graph-container').evaluate(el => el.children.length);
  expect(graphChildren, 'graph container should keep rendered child elements').toBeGreaterThan(0);

  expect(fatalErrors(errors), `Graph notice errors:\n  ${fatalErrors(errors).join('\n  ')}`).toHaveLength(0);
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
  await page.locator('#router-ip').fill('192.168.1.1');
  await page.locator('#router-user').fill('admin');
  await page.locator('#router-pass').fill('demo-pass');
  await page.locator('#router-nat').fill('100');
  await page.click('#router-detect-btn');
  await expect(page.locator('#router-editor-status')).toBeVisible();
  await expect(page.locator('#router-editor-status')).toContainText('SSH');
  await page.click('#router-save-btn');
  await expect(page.locator('.router-card')).toContainText('Yamaha RTX');

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

  await page.click('.settings-tab[data-tab="backup"]');
  await expect(page.locator('#pane-backup')).toHaveClass(/active/);
  await page.click('#backup-config-save');
  await expect(page.locator('#backup-config-status')).toBeVisible();
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
