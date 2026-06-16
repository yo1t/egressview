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
  'settings.js', 'map-common.js', 'stats.js', 'time-filter.js',
  'view-tabs.js', 'log.js', 'threat-popup.js', 'devices.js', 'main.js',
];
for (const file of PHASE2_JS_FILES) {
  test(`js/${file} is served (200)`, async ({ request }) => {
    const res = await request.get(`${BASE}/js/${file}`);
    expect(res.status()).toBe(200);
  });
}

// ② 削除済みファイルが 404 になること（誤って復元したときの検知）
const DELETED_JS_FILES = ['map.js', 'dashboard.js'];
for (const file of DELETED_JS_FILES) {
  test(`js/${file} is deleted (404)`, async ({ request }) => {
    const res = await request.get(`${BASE}/js/${file}`);
    expect(res.status()).toBe(404);
  });
}

// ③ index.html にインライン JS が残っていないこと（誤って巻き戻し検出）
test('index.html has no inline script block with JS code', async ({ request }) => {
  const res = await request.get(`${BASE}/`);
  const body = await res.text();
  expect(body).not.toMatch(/<script>\s*const _BASE/);
  expect(body).not.toMatch(/<script>\s*\/\/ ─/);
});

// ④ index.html が期待する <script src> タグを含むこと
test('index.html references expected script files', async ({ request }) => {
  const res = await request.get(`${BASE}/`);
  const body = await res.text();
  for (const f of ['utils.js', 'graph.js', 'map-common.js', 'settings.js', 'devices.js', 'main.js']) {
    expect(body, `index.html should reference ${f}`).toContain(`/js/${f}`);
  }
});

// ⑤ セキュリティヘッダーが返ってくること
test('security headers are present', async ({ request }) => {
  const res = await request.get(`${BASE}/`);
  const h = res.headers();
  expect(h['x-frame-options'],          'X-Frame-Options').toBe('DENY');
  expect(h['x-content-type-options'],   'X-Content-Type-Options').toBe('nosniff');
  expect(h['referrer-policy'],          'Referrer-Policy').toBe('same-origin');
  expect(h['content-security-policy'],  'Content-Security-Policy').toContain("object-src 'none'");
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

// Helper: authenticate and navigate to /
async function authPage(page) {
  await page.addInitScript(tok => {
    localStorage.setItem('widemap_admin_token', tok);
  }, TOKEN);
  await page.goto('/');
  await page.waitForLoadState('networkidle');
}

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

test('tab bar renders after auth', async ({ page }) => {
  if (!TOKEN) test.skip(true, 'WIDEMAP_TOKEN not set — skipping auth-gated test');

  await authPage(page);

  // Exactly 5 tabs: グラフマップ / 統計情報 / 通信ログ / 端末一覧 / 検出ログ
  const tabs = page.locator('.view-tab');
  await expect(tabs.first()).toBeVisible();
  const count = await tabs.count();
  expect(count).toBe(5);
});

test('graph canvas renders after auth (P2-4: background fetch completes)', async ({ page }) => {
  if (!TOKEN) test.skip(true, 'WIDEMAP_TOKEN not set — skipping auth-gated test');

  await authPage(page);

  // P2-4: after initial 1h emit, client fires a background 24h fetch and calls
  // buildGraphFromConnections(). The SVG/canvas element should be populated.
  const graphContainer = page.locator('#graph-container');
  await expect(graphContainer).toBeVisible();
  const childCount = await graphContainer.evaluate(el => el.children.length);
  expect(childCount, 'graph container should have rendered children after background fetch').toBeGreaterThan(0);
});

test('no console errors after auth', async ({ page }) => {
  if (!TOKEN) test.skip(true, 'WIDEMAP_TOKEN not set — skipping auth-gated test');

  const errors = collectErrors(page);
  await authPage(page);

  expect(fatalErrors(errors), `Console errors:\n  ${fatalErrors(errors).join('\n  ')}`).toHaveLength(0);
});

// ⑥ タブ切り替えがエラーなく動くこと（リファクタリング後の安全網）
test('tab switching produces no console errors', async ({ page }) => {
  if (!TOKEN) test.skip(true, 'WIDEMAP_TOKEN not set — skipping auth-gated test');

  const errors = collectErrors(page);
  await authPage(page);

  // 全タブを順にクリックしてエラーが出ないことを確認
  for (const btnId of ['btn-stats', 'btn-log', 'btn-devices', 'btn-notif-log', 'btn-graph']) {
    await page.click(`#${btnId}`);
    await page.waitForTimeout(500);
  }

  expect(fatalErrors(errors), `Tab switch errors:\n  ${fatalErrors(errors).join('\n  ')}`).toHaveLength(0);
});

// ⑦ 期間フィルター変更後にエラーが出ないこと（getFilteredConnections の間接テスト）
test('time filter change produces no console errors', async ({ page }) => {
  if (!TOKEN) test.skip(true, 'WIDEMAP_TOKEN not set — skipping auth-gated test');

  const errors = collectErrors(page);
  await authPage(page);

  const select = page.locator('#time-filter-select');
  for (const value of ['24h', '6h', '7d', '1h']) {
    await select.selectOption(value);
    await page.waitForTimeout(500);
  }

  expect(fatalErrors(errors), `Time filter errors:\n  ${fatalErrors(errors).join('\n  ')}`).toHaveLength(0);
});
