import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // See tests/vitest.config.ts on why `root` is pinned rather than left to
    // default to this file's own directory.
    root: fileURLToPath(new URL('..', import.meta.url)),
    environment: 'jsdom',
    include: ['tests/spike/**/*.test.ts']
  }
})
