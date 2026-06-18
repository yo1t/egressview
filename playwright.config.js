// Playwright smoke test configuration
// Run: EGRESSVIEW_URL=http://YOUR_SERVER_IP:3002 EGRESSVIEW_TOKEN=<token> npm run test:smoke
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './test/smoke',
  timeout: 15_000,
  retries: 0,
  use: {
    baseURL: process.env.EGRESSVIEW_URL || 'http://localhost:3002',
    headless: true,
  },
  reporter: [['list']],
});
