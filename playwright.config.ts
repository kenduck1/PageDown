import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/gates',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'tests/gates/results/playwright-report.json' }]]
})
