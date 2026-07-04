// Playwright config for the Chrome extension E2E tests (#15).
// Only picks up specs under tests/extension-e2e so it never collides with the
// Jest suites in tests/unit and tests/e2e.
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/extension-e2e',
  testMatch: '**/*.spec.js',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
});
