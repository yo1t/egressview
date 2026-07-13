// Playwright smoke test configuration
//
// 2 ways to run:
//   1. npm run test:smoke
//      → EGRESSVIEW_URL 未指定ならデモサーバー（DEMO_MODE, :3002）を自動起動して実行
//   2. EGRESSVIEW_URL=http://YOUR_SERVER_IP:3002 EGRESSVIEW_TOKEN=<token> npm run test:smoke
//      → 既存サーバーに対して実行（自動起動なし）
const { defineConfig } = require('@playwright/test');

const externalUrl = process.env.EGRESSVIEW_URL;

// デモサーバー自動起動時は固定トークンをテストにも供給する
if (!externalUrl && !process.env.EGRESSVIEW_TOKEN) {
  process.env.EGRESSVIEW_TOKEN = 'demo-token-ci';
}

module.exports = defineConfig({
  testDir: './test/smoke',
  timeout: 15_000,
  retries: 0,
  use: {
    baseURL: externalUrl || 'http://localhost:3002',
    headless: true,
  },
  reporter: [['list']],
  // EGRESSVIEW_URL 未指定時のみデモサーバーを自動起動
  webServer: externalUrl ? undefined : {
    command: 'node server.js',
    url: 'http://localhost:3002',
    // 127.0.0.1 バインドで 0.0.0.0 listen が禁止されたサンドボックス環境でも動くようにする
    env: {
      DEMO_MODE: 'true', PORT: '3002', HOST: '127.0.0.1',
      EGRESSVIEW_CONFIG_PATH: '.egressview.demo.test.config.json',
    },
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
