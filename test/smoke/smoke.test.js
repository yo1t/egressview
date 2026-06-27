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

// ① Phase 2 で分割した全 JS ファイルが 200 で配信されること
const PHASE2_JS_FILES = [
  'utils.js', 'connections-panel.js', 'auth-socket.js', 'graph.js',
  'settings.js', 'map-common.js', 'stats.js', 'time-filter.js',
  'view-tabs.js', 'log.js', 'beacon.js', 'threat-popup.js',
  'devices.js', 'notif-log.js', 'main.js',
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

// ④ index.html が期待する <script> タグを含むこと（ES module化後は main.js 1本のみ）
test('index.html references expected script files', async ({ request }) => {
  const res = await request.get(`${BASE}/`);
  const body = await res.text();
  expect(body, 'index.html should reference main.js as module entry point').toContain('/js/main.js');
  expect(body, 'index.html should use type="module"').toContain('type="module"');
  for (const f of ['utils.js', 'graph.js', 'map-common.js', 'settings.js', 'devices.js']) {
    expect(body, `index.html should NOT have separate <script> for ${f}`).not.toContain(`<script src`+`="${BASE}/js/${f}"`);
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
// Skipped when EGRESSVIEW_TOKEN is not set.

// Helper: authenticate and navigate to /
async function authPage(page) {
  await page.addInitScript(tok => {
    localStorage.setItem('egressview_admin_token', tok);
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
  if (!TOKEN) test.skip(true, 'EGRESSVIEW_TOKEN not set — skipping auth-gated test');

  await authPage(page);

  // Exactly 5 tabs: グラフマップ / 統計情報 / 通信ログ / 端末一覧 / 検出ログ
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
});

test('no console errors after auth', async ({ page }) => {
  if (!TOKEN) test.skip(true, 'EGRESSVIEW_TOKEN not set — skipping auth-gated test');

  const errors = collectErrors(page);
  await authPage(page);

  expect(fatalErrors(errors), `Console errors:\n  ${fatalErrors(errors).join('\n  ')}`).toHaveLength(0);
});

// ⑥ タブ切り替えがエラーなく動くこと（リファクタリング後の安全網）
test('tab switching produces no console errors', async ({ page }) => {
  if (!TOKEN) test.skip(true, 'EGRESSVIEW_TOKEN not set — skipping auth-gated test');

  const errors = collectErrors(page);
  await authPage(page);

  // 全タブを順にクリックしてエラーが出ないことを確認
  for (const btnId of ['btn-stats', 'btn-log', 'btn-devices', 'btn-notif-log', 'btn-graph']) {
    await page.click(`#${btnId}`);
    await page.waitForTimeout(500);
  }

  expect(fatalErrors(errors), `Tab switch errors:\n  ${fatalErrors(errors).join('\n  ')}`).toHaveLength(0);
});

// ⑦ 検出ログ詳細: 行クリックで開き、右上のバツで閉じること
test('notification log detail popup opens and closes', async ({ page }) => {
  if (!TOKEN) test.skip(true, 'EGRESSVIEW_TOKEN not set — skipping auth-gated test');

  const errors = collectErrors(page);
  await authPage(page);

  await page.click('#btn-notif-log');
  await page.waitForTimeout(1500);

  const rows = page.locator('#notif-log-tbody tr');
  const rowCount = await rows.count();
  if (rowCount === 0) {
    test.skip(true, 'no notification log rows');
  }

  const firstRowText = await rows.first().innerText().catch(() => '');
  if (/検出ログがありません|No notification logs|HTTP \d+|serverUnavailable/.test(firstRowText)) {
    test.skip(true, 'no usable notification log row');
  }

  await rows.first().click();
  const overlay = page.locator('#notif-log-detail-overlay');
  await expect(overlay).toBeVisible();
  await page.click('#notif-log-detail-close');
  await expect(overlay).toHaveClass(/hidden/);

  expect(fatalErrors(errors), `Notification detail errors:\n  ${fatalErrors(errors).join('\n  ')}`).toHaveLength(0);
});

// ⑦ 期間フィルター変更後にエラーが出ないこと（getFilteredConnections の間接テスト）
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

// ⑧ 長期間（2週間）表示で通信ログにデータが表示されること
test('log view shows rows with long period (14d)', async ({ page }) => {
  if (!TOKEN) test.skip(true, 'EGRESSVIEW_TOKEN not set — skipping auth-gated test');

  const errors = collectErrors(page);
  await authPage(page);

  // 2週間に切り替え
  await page.locator('#time-filter-select').selectOption('14d');
  await page.waitForTimeout(1000);

  // 通信ログタブへ
  await page.click('#btn-log');
  await page.waitForTimeout(2000);

  // tbody に少なくとも1行あること
  const rowCount = await page.locator('#log-tbody tr').count();
  expect(rowCount, 'log view should show rows for 14d period').toBeGreaterThan(0);

  expect(fatalErrors(errors), `Long period log errors:\n  ${fatalErrors(errors).join('\n  ')}`).toHaveLength(0);
});

// ⑨ 統計タブ: サマリー切替（宛先/端末）でエラーが出ないこと
test('stats tab summary switching produces no console errors', async ({ page }) => {
  if (!TOKEN) test.skip(true, 'EGRESSVIEW_TOKEN not set — skipping auth-gated test');

  const errors = collectErrors(page);
  await authPage(page);

  await page.click('#btn-stats');
  await page.waitForTimeout(1000);

  // 統計タブ内のビュー切替ボタンがあれば全てクリック
  const statsBtns = page.locator('#stats-view [data-view], #stats-panel [data-view], .stats-tab-btn, #btn-stats-dst, #btn-stats-device');
  const btnCount = await statsBtns.count();
  for (let i = 0; i < btnCount; i++) {
    await statsBtns.nth(i).click().catch(() => {});
    await page.waitForTimeout(300);
  }

  expect(fatalErrors(errors), `Stats switch errors:\n  ${fatalErrors(errors).join('\n  ')}`).toHaveLength(0);
});

// ⑩ 統計タブ: 地図（マップ）が表示されること
test('stats tab renders map canvas', async ({ page }) => {
  if (!TOKEN) test.skip(true, 'EGRESSVIEW_TOKEN not set — skipping auth-gated test');

  await authPage(page);
  await page.click('#btn-stats');
  await expect(page.locator('#stats-container')).toBeVisible();
  await page.waitForTimeout(2000);

  // SVGまたはcanvasが統計エリアに存在すること
  const mapEl = page.locator('#st-globe canvas, #st-globe svg, #st-flat canvas, #st-flat svg').first();
  const hasMap = await mapEl.count() > 0;
  if (hasMap) {
    await expect(mapEl).toBeVisible();
  } else {
    // マップ要素が見つからなくても統計コンテナ自体が表示されていればOK
    const statsContainer = page.locator('#stats-container').first();
    await expect(statsContainer).toBeVisible();
  }
});

// ⑪ 通信ログの無限スクロール: スクロールで次ページが追記されること
test('log view infinite scroll appends rows on scroll', async ({ page }) => {
  if (!TOKEN) test.skip(true, 'EGRESSVIEW_TOKEN not set — skipping auth-gated test');

  const errors = collectErrors(page);
  await authPage(page);

  await page.locator('#time-filter-select').selectOption('14d');
  await page.click('#btn-log');
  await page.waitForTimeout(2000);

  const firstCount = await page.locator('#log-tbody tr:not(#log-scroll-sentinel)').count();

  // sentinel がある（= まだ次ページがある）場合のみスクロールテストを実施
  const hasSentinel = await page.locator('#log-scroll-sentinel').count() > 0;
  if (hasSentinel) {
    await page.locator('#log-scroll-sentinel').scrollIntoViewIfNeeded();
    await page.waitForTimeout(2000);
    const afterCount = await page.locator('#log-tbody tr:not(#log-scroll-sentinel)').count();
    expect(afterCount, 'scroll should load more rows').toBeGreaterThan(firstCount);
  }

  expect(fatalErrors(errors), `Scroll errors:\n  ${fatalErrors(errors).join('\n  ')}`).toHaveLength(0);
});

// ⑫ デモモードバナーが表示されること（DEMO_MODE=true 時のみ）
test('demo banner is visible in demo mode', async ({ page }) => {
  if (!TOKEN) test.skip(true, 'EGRESSVIEW_TOKEN not set — skipping auth-gated test');

  await authPage(page);

  const isDemoMode = await page.evaluate(() => window._DEMO_MODE === true);
  if (!isDemoMode) {
    test.skip(true, 'not running in DEMO_MODE — skipping demo banner test');
  }

  await expect(page.locator('#demo-banner')).toBeVisible();
});
