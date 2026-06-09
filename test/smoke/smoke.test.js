// Smoke tests for Widemap — Phase 2 safety net
//
// Primary goal: catch JS load-order errors when index.html is refactored.
// Secondary: verify extracted static assets are served correctly.
//
// Usage:
//   WIDEMAP_URL=http://YOUR_SERVER_IP:3002 WIDEMAP_TOKEN=<token> npm run test:smoke
//
// WIDEMAP_TOKEN is optional — tests that need auth are skipped when omitted.

const { test, expect } = require('@playwright/test');

const BASE  = process.env.WIDEMAP_URL  || 'http://localhost:3002';
const TOKEN = process.env.WIDEMAP_TOKEN || '';

// ─── Static asset tests (no auth required) ────────────────────────────────────

test('GET / returns 200 with correct title', async ({ page }) => {
  page.on('dialog', dialog => dialog.dismiss());
  // 'commit' = response headers received; title is in <head> so available immediately
  const res = await page.goto('/', { waitUntil: 'commit' });
  expect(res.status()).toBe(200);
  await expect(page).toHaveTitle('Widemap');
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

// ① Phase 2 で分割した全 JS ファイルが 200 で配信されること
const PHASE2_JS_FILES = [
  'utils.js', 'connections-panel.js', 'auth-socket.js', 'graph.js',
  'settings.js', 'map.js', 'stats.js', 'time-filter.js',
  'view-tabs.js', 'log.js', 'threat-popup.js', 'devices.js', 'main.js',
];
for (const file of PHASE2_JS_FILES) {
  test(`js/${file} is served (200)`, async ({ request }) => {
    const res = await request.get(`${BASE}/js/${file}`);
    expect(res.status()).toBe(200);
  });
}

// ② index.html にインライン JS が残っていないこと（誤って巻き戻し検出）
test('index.html has no inline script block with JS code', async ({ request }) => {
  const res = await request.get(`${BASE}/`);
  const body = await res.text();
  expect(body).not.toMatch(/<script>\s*const _BASE/);
  expect(body).not.toMatch(/<script>\s*\/\/ ─/);
});

// ③ index.html が期待する <script src> タグを含むこと
test('index.html references expected script files', async ({ request }) => {
  const res = await request.get(`${BASE}/`);
  const body = await res.text();
  for (const f of ['utils.js', 'graph.js', 'settings.js', 'devices.js', 'main.js']) {
    expect(body, `index.html should reference ${f}`).toContain(`/js/${f}`);
  }
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
// Skipped when WIDEMAP_TOKEN is not set.

test('tab bar renders after auth', async ({ page }) => {
  if (!TOKEN) {
    test.skip(true, 'WIDEMAP_TOKEN not set — skipping auth-gated test');
  }
  await page.addInitScript(tok => {
    localStorage.setItem('widemap_admin_token', tok);
  }, TOKEN);

  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // At least one .view-tab element should be visible
  const tabs = page.locator('.view-tab');
  await expect(tabs.first()).toBeVisible();
  const count = await tabs.count();
  expect(count).toBeGreaterThanOrEqual(4); // graph / map / stats / log / devices
});

test('graph canvas renders after auth (P2-4: background fetch completes)', async ({ page }) => {
  if (!TOKEN) {
    test.skip(true, 'WIDEMAP_TOKEN not set — skipping auth-gated test');
  }
  await page.addInitScript(tok => {
    localStorage.setItem('widemap_admin_token', tok);
  }, TOKEN);

  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // P2-4: after initial 1h emit, client fires a background 24h fetch and calls
  // buildGraphFromConnections(). The SVG/canvas element should be populated.
  // We just verify the graph container is present and non-empty (has child nodes).
  const graphContainer = page.locator('#graph-container');
  await expect(graphContainer).toBeVisible();
  // The graph SVG or canvas should have at least one child once data is rendered
  const childCount = await graphContainer.evaluate(el => el.children.length);
  expect(childCount, 'graph container should have rendered children after background fetch').toBeGreaterThan(0);
});

test('no console errors after auth', async ({ page }) => {
  if (!TOKEN) {
    test.skip(true, 'WIDEMAP_TOKEN not set — skipping auth-gated test');
  }
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  page.on('console',   msg => { if (msg.type() === 'error') errors.push(msg.text()); });

  await page.addInitScript(tok => {
    localStorage.setItem('widemap_admin_token', tok);
  }, TOKEN);

  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // Ignore Socket.IO noise — when testing directly against port 3002 without a
  // reverse proxy, socket.io.js may be served at a different path than SUBPATH
  // expects. This is a test-infrastructure artifact, not a code defect.
  const fatal = errors.filter(e =>
    !e.includes('socket.io') &&
    !e.includes('Socket') &&
    !e.includes('WebSocket') &&
    !e.includes('ERR_CONNECTION_REFUSED') &&
    !e.includes('io is not defined') &&  // socket.io not loaded without proxy
    !e.includes('Failed to load resource') // CDN / socket.io 404 in tunnel mode
  );
  expect(fatal, `Console errors:\n  ${fatal.join('\n  ')}`).toHaveLength(0);
});
