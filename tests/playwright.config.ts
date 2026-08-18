import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './gates',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: './gates/results/playwright-report.json' }]]
})
