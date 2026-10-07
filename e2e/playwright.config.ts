import { defineConfig, devices } from '@playwright/test';

// @playwright/test is pinned to 1.56.1, which matches the Chromium build
// (revision 1194) preinstalled at PLAYWRIGHT_BROWSERS_PATH in the cloud dev
// container, so no browser download is needed there.
const WEB_URL = process.env.E2E_WEB_URL ?? 'http://localhost:3000';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    // The Betika-style UI is designed for low-end Android phones first.
    ...devices['Pixel 5'],
  },
  projects: [{ name: 'mobile-chromium' }],
});
