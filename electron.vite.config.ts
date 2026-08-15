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
      // (tests/gates/gate1-source-offset.spec.ts) and the unit tests
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
          'remark-math',
          'remark-rehype',
          'remark-stringify',
          'rehype-stringify',
          'rehype-highlight',
          'hast-util-sanitize',
          'hast-util-raw',
          'unist-util-visit',
          'decode-named-character-reference',
          'micromark-util-decode-numeric-character-reference',
          // Task 101 / math equations: remark-math pulls in this whole
          // ESM-only sub-chain. Left externalized, Node's require(esm)
          // interop wouldn't just misbehave the way it does for the other
          // packages on this list -- micromark-extension-math's own index.js
          // re-exports BOTH its tokenizer (`math`, the only export
          // remark-math actually imports) AND `mathHtml` from `./lib/html.js`,
          // which imports the real `katex` package. A raw CJS require()
          // fully evaluates every re-export a module declares, including
          // unused ones, so an externalized require('micromark-extension-math')
          // would drag the real KaTeX renderer into the PRIVILEGED main
          // process -- exactly the architecture split CLAUDE.md's Mermaid
          // section (and this feature's own design) exists to prevent, not
          // just a bundle-size concern. Bundling it here instead lets
          // Rollup's tree-shaking prove the unused `mathHtml` re-export (and
          // therefore `katex`) is dead and drop it -- confirmed against the
          // real compiled bundle, see the katex-render.ts / gate for this
          // feature's own verification, not assumed from this comment alone.
          'mdast-util-math',
          'micromark-extension-math'
          // `docx` (.docx export, src/export/markdown-to-docx.ts) is
          // DELIBERATELY NOT on this list, and the check that establishes that
          // is recorded here so nobody has to redo it -- or, worse, assume the
          // opposite. It is `"type": "module"`, which is the trigger condition
          // this whole comment block warns about, but unlike every package
          // above it also ships a REAL CommonJS build and declares it in
          // `exports["."].require` (./dist/index.cjs). So Node's require(esm)
          // interop is never reached: `require("docx")` loads genuine CJS and
          // returns genuine named exports.
          //
          // Verified against the REAL COMPILED BUNDLE rather than a test, per
          // this file's own warning that Vitest/Playwright mask exactly this
          // failure -- a CJS probe placed inside `out/main/` (so it resolves
          // the module identically to the emitted `require("docx")`) reported
          // `{Packer:"function", Document:"function", Paragraph:"function",
          // hasDefaultOnly:false}` and packed a real 8493-byte PK-prefixed
          // file. tests/gates/gate39-docx-export.spec.ts is the permanent version of
          // that check: it drives a real export through the real compiled app.
          //
          // Left externalized on purpose rather than "excluded to be safe":
          // bundling it would add roughly 300KB to out/main/index.js in
          // exchange for nothing.
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
