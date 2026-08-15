// Throwaway (not part of the shipped app) Milkdown-mounting script for
// Task 6 / Gate 3's editor/paginator layout-parity comparison. Bundled by
// gate3-layout-parity.spec.ts via esbuild into milkdown-compare.js
// (gitignored -- see fixtures/.gitignore -- generated at test-run time,
// never committed) and loaded by milkdown-compare.html as a plain classic
// <script> (not `type="module"`; esbuild bundles this to a self-contained
// IIFE, which sidesteps any file:// module-loading quirks entirely --
// there is nothing left for the browser to resolve at load time).
//
// Deliberately does NOT reuse tests/spike/milkdown-fixture.ts's
// createMilkdownEditor() as-is: that helper (built for Gate 1/2's jsdom
// unit tests, where the mount point's own size/position never mattered)
// creates its OWN throwaway <div>, appended directly to document.body, with
// no way to target it at this page's width-constrained #content-root. This
// reimplements the same Editor.make() wiring -- same presets
// (commonmark + gfm), same PINNED_STRINGIFY_OPTIONS, imported from that
// shared fixture rather than re-declared here -- differing only in where
// rootCtx points, which is exactly what this gate needs control over.
import { Editor, rootCtx, defaultValueCtx, remarkStringifyOptionsCtx } from '@milkdown/core'
import { commonmark } from '@milkdown/preset-commonmark'
import { gfm } from '@milkdown/preset-gfm'
import { PINNED_STRINGIFY_OPTIONS } from '../milkdown-fixture'

// Set by the spec via page.addInitScript(...) BEFORE this script ever runs
// (classic <script src> execution is synchronous/parser-blocking, so
// addInitScript -- which Playwright guarantees runs before ANY page script
// on every navigation -- is what makes the ordering safe here, not
// incidental timing).
declare global {
  interface Window {
    __gate3Markdown: string
    __gate3Ready?: boolean
    __gate3Error?: string
  }
}

async function mount(): Promise<void> {
  const root = document.getElementById('content-root')
  if (!root) throw new Error('content-root element is missing from milkdown-compare.html')

  await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root)
      ctx.set(defaultValueCtx, window.__gate3Markdown)
      ctx.set(remarkStringifyOptionsCtx, PINNED_STRINGIFY_OPTIONS)
    })
    .use(commonmark)
    .use(gfm)
    .create()
}

mount()
  .then(() => {
    window.__gate3Ready = true
  })
  .catch((err: unknown) => {
    window.__gate3Error = err instanceof Error ? (err.stack ?? err.message) : String(err)
  })
