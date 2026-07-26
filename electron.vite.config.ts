import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      // Task 6 discovery, not previously exercised: electron-vite's default
      // main-process build externalizes every package.json dependency,
      // emitting a raw `require("remark-gfm")` etc. for each rather than
      // bundling it. `unified`/`remark-*`/`rehype-*` (and their `unist-`/
      // `micromark-`-prefixed helpers) are all `"type": "module"` ESM-only
      // packages with no CJS entry point. Node 22's `require()` CAN load an
      // ESM module, but returns its *namespace object* (`{ default: fn,
      // ...named }`), not the default export directly — so
      // `unified().use(remarkGfm)` received the whole namespace object
      // instead of the plugin function, and unified rejected it with
      // "Expected usable value but received an empty preset" the moment
      // `markdownToHtml` actually ran inside the compiled main process
      // (confirmed by reproducing it via `paginateAndTime` in this task —
      // see docs/superpowers/plans/2026-07-25-phase0-findings.md's Gate 2
      // notes). This had never been caught before because Gate 1
      // (phase0/gate1-source-offset.spec.ts) and the unit tests
      // (src/markdown/pipeline.test.ts) only ever import pipeline.ts
      // directly through Playwright/Vitest's own TypeScript transform,
      // which correctly unwraps `.default` for an ESM default import — they
      // never exercised the actual electron-vite-bundled `out/main/index.js`
      // that the real running app uses. Excluding these specific packages
      // from externalization makes Rollup bundle (rather than
      // require()-passthrough) them, which resolves the default export
      // correctly at build time instead of relying on Node's require(esm)
      // interop at runtime.
      externalizeDeps: {
        exclude: [
          'unified',
          'remark-parse',
          'remark-gfm',
          'remark-frontmatter',
          'remark-rehype',
          'rehype-stringify',
          'unist-util-visit',
          'decode-named-character-reference',
          'micromark-util-decode-numeric-character-reference'
        ]
      }
    }
  },
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()]
  }
})
