import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  reporter: 'line',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1
});
