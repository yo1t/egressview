// Playwright smoke test configuration
// Run: WIDEMAP_URL=http://YOUR_SERVER_IP:3002 WIDEMAP_TOKEN=<token> npm run test:smoke
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './test/smoke',
  timeout: 15_000,
  retries: 0,
  use: {
    baseURL: process.env.WIDEMAP_URL || 'http://localhost:3002',
    headless: true,
  },
  reporter: [['list']],
});
