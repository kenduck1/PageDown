import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    // This config lives in tests/, but every path below is repo-relative and
    // the suite under test is src/. Vitest defaults `root` to the config
    // file's own directory, so without this the include glob would resolve
    // against tests/ and match nothing.
    root: fileURLToPath(new URL('..', import.meta.url)),
    environment: 'jsdom',
    setupFiles: ['./src/renderer/src/test-setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // Deliberately NOT `passWithNoTests: true`. That was set when this config
    // predated the first spec; with 2000+ tests it would instead turn "the
    // include glob no longer matches anything" into a silent green run. This
    // config moved into tests/ and now depends on `root` above resolving
    // correctly, which is exactly the mistake that needs to fail loudly.
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
