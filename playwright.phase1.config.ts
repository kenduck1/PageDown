import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './phase1',
  testMatch: '**/*.spec.ts',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1
})
