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
    passWithNoTests: true,
    // Loaded with `--import` rather than added to `setupFiles`, and that
    // distinction is the whole point: setup files run AFTER the jsdom
    // environment is installed, and this has to define a global BEFORE it, so
    // Vitest records the global as pre-existing and RESTORES it on teardown
    // instead of deleting it. See the shim's own header for the upstream
    // @milkdown/ctx timer bug it neutralises, and for why this is not
    // `dangerouslyIgnoreUnhandledErrors`.
    //
    // TOP-LEVEL `execArgv`, not `poolOptions.forks.execArgv`. Vitest 4 removed
    // `test.poolOptions` entirely and flattened its contents; the nested form
    // is not an error, it is silently IGNORED, so the shim never loaded and
    // the flake it targets was never actually addressed. Caught only because
    // Vitest prints a deprecation line, which is easy to scroll past.
    execArgv: ['--import', './scripts/vitest-dom-teardown-shim.mjs']
  }
})
