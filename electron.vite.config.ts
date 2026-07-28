import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

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
      // NOTE for whoever adds the next main-process import: this list is a
      // known trap, not a one-time fix. Any other ESM-only ("type":
      // "module", no CJS entry point) package.json dependency imported from
      // main-process code will silently break the exact same way the first
      // time it actually runs inside the compiled app (not caught by
      // Playwright/Vitest, which transform imports correctly on their own —
      // see the comment above). `remark-stringify` and `hast-util-sanitize`
      // are both already `"type": "module"` dependencies in package.json
      // with nothing importing them from main-process code yet; added here
      // pre-emptively since they're the most likely next ones (Markdown
      // round-tripping / HTML sanitization). `mermaid` is also ESM-only and
      // in `dependencies`, but is only ever imported from
      // src/diagrams/render-mermaid.ts, which is only ever imported from
      // resources/pagination-render/index.ts — the sandboxed render
      // context's OWN separately-built bundle (scripts/build-pagination-render.ts,
      // via esbuild), never part of this electron-vite `main` build at all.
      // Task 8 landed and this was re-checked as promised: `mermaid` does
      // not need excluding here — confirmed by grepping the actual built
      // `out/main/index.js` for "mermaid", which has zero hits.
      externalizeDeps: {
        exclude: [
          'unified',
          'remark-parse',
          'remark-gfm',
          'remark-frontmatter',
          'remark-rehype',
          'remark-stringify',
          'rehype-stringify',
          'hast-util-sanitize',
          'unist-util-visit',
          'decode-named-character-reference',
          'micromark-util-decode-numeric-character-reference'
        ]
      }
    }
  },
  preload: {
    build: {
      externalizeDeps: {
        exclude: ['@electron-toolkit/preload']
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [tailwindcss(), react()]
  }
})
