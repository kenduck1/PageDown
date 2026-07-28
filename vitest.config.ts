import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/renderer/src/test-setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // Vitest 4 exits non-zero when no test files match by default (a behavior
    // change from the version the plan brief was written against). Task 1 runs
    // this before any tests exist, so allow a clean exit until Task 4 adds the
    // first spec.
    passWithNoTests: true
  }
})
