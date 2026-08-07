import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The shared document stylesheet (document-typography.css) is consumed by TWO
// surfaces that mint its CSS custom properties in two completely different
// ways: the app-shell renderer gets them from Tailwind's `@theme static` block
// in src/renderer/src/assets/base.css, while the sandboxed pagination render
// context -- which has no Tailwind and no base.css at all -- gets them from a
// hand-written `:root` block inside the DOCUMENT_STYLESHEET template literal in
// resources/pagination-render/index.ts.
//
// Two files restating one list by hand is a drift hazard with an unusually
// nasty failure mode, and it has already fired once for real: the final
// whole-branch review added h4-h6 rules referencing `--text-13`/`--text-12`
// without adding them to the sandbox's `:root` block. An unresolved `var()` is
// invalid-at-computed-value-time, and because `font-size`/`font-family`
// INHERIT, the declaration doesn't error or fall back to a UA default -- it
// silently takes the nearest ancestor's value. So h5/h6 rendered at the
// baseline's 14px in the paginated preview and exported PDF while the editor
// rendered them at 13px and 12px, with knock-on line-height/margin drift (both
// are em-relative). Nothing caught it: no corpus fixture and no gate fixture
// contains an h4-h6 heading, so a fully green Gate 10 run is compatible with
// this bug existing.
//
// These tests are the mechanical guard for that whole class of drift, not just
// the two properties that happened to be missing. They parse the real files as
// text (the render context's module can't be imported here -- it imports .css
// as raw text and .woff2 as base64 through an esbuild-only loader config), so
// they check what actually ships rather than a restatement of it.
const REPO_ROOT = join(__dirname, '..', '..')
const SHARED_CSS = join(REPO_ROOT, 'src', 'typography', 'document-typography.css')
const RENDER_CONTEXT = join(REPO_ROOT, 'resources', 'pagination-render', 'index.ts')
const BASE_CSS = join(REPO_ROOT, 'src', 'renderer', 'src', 'assets', 'base.css')

/** Every `var(--x)` name referenced anywhere in the shared stylesheet. */
function referencedCustomProperties(css: string): Set<string> {
  return new Set(Array.from(css.matchAll(/var\(\s*(--[\w-]+)/g), (m) => m[1]))
}

/** Custom properties declared inside a given `<selector> { ... }` block. */
function declaredCustomProperties(source: string, blockOpener: string): Map<string, string> {
  const start = source.indexOf(blockOpener)
  if (start === -1) throw new Error(`could not find a "${blockOpener}" block to parse`)
  const bodyStart = start + blockOpener.length
  const end = source.indexOf('}', bodyStart)
  if (end === -1) throw new Error(`"${blockOpener}" block is not closed`)
  const body = source.slice(bodyStart, end)
  return new Map(
    Array.from(body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g), (m) => [m[1], m[2].trim()])
  )
}

describe('document-typography.css custom properties', () => {
  const sharedCss = readFileSync(SHARED_CSS, 'utf8')
  const renderContext = readFileSync(RENDER_CONTEXT, 'utf8')
  const baseCss = readFileSync(BASE_CSS, 'utf8')

  const referenced = referencedCustomProperties(sharedCss)
  const sandboxRoot = declaredCustomProperties(renderContext, ':root {')
  const appShellTheme = declaredCustomProperties(baseCss, '@theme static {')

  it('references at least the properties this guard exists to protect', () => {
    // A sanity check on the parser itself: if the regex above ever stopped
    // matching, every assertion below would vacuously pass against an empty
    // set. Pinning a couple of known-present names makes that impossible.
    expect(referenced.has('--font-serif')).toBe(true)
    expect(referenced.has('--text-14')).toBe(true)
    expect(referenced.size).toBeGreaterThanOrEqual(6)
  })

  it('defines every referenced property in the sandboxed render context, with no extras', () => {
    // THE assertion this file exists for. An unresolved var() here is silent
    // and surface-specific -- see this file's header comment.
    expect([...sandboxRoot.keys()].sort()).toEqual([...referenced].sort())
  })

  it('defines every referenced property in the app shell via base.css', () => {
    for (const property of referenced) {
      expect(appShellTheme.has(property), `base.css's @theme static must define ${property}`).toBe(
        true
      )
    }
  })

  it('gives both surfaces identical values for every shared property', () => {
    // Two hand-synced copies agreeing on WHICH properties exist is not enough:
    // they must also agree on what each one equals, or the two surfaces render
    // the same markup at different sizes with no error anywhere.
    for (const property of referenced) {
      expect(sandboxRoot.get(property), `${property} must match base.css's value`).toBe(
        appShellTheme.get(property)
      )
    }
  })
})
