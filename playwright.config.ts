import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './phase0',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'phase0/results/playwright-report.json' }]]
})
