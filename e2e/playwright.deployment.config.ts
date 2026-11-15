import { defineConfig, devices } from '@playwright/test';
import { WEB_URL } from './support/env';

// Checks a deployed demo (docs/deployment.md, "Testing deposits and withdrawals") through its
// public pages. No global setup: a deployment has no dev SMS inbox or stand-in back office.
export default defineConfig({
  testDir: './deployment',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    ...devices['Pixel 5'],
  },
  projects: [{ name: 'mobile-chromium' }],
});
