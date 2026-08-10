import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildStaticHtmlDocument, type StaticHtmlDocumentInput } from './static-html-document'
import { computePageGeometry, DPI } from './page-geometry'
import { DEFAULT_PAGE_CONFIG } from '../markdown/page-config'
import { resolveDocumentStyle } from './document-style'

// This file's own drift guard, mirroring document-typography.test.ts's exact
// method (parse the shared stylesheet's referenced var() names; assert this
// module's own hand-duplicated :root block declares every one, with a
// matching value) -- see static-html-document.ts's own top comment for why
// this is a genuine THIRD copy of the same small vars block rather than a
// shared import, and why that's a deliberate, narrower-risk choice. Without
// this test, a future var added to document-typography.css (the h4-h6 case
// CLAUDE.md already documents as a real, previously-shipped bug) would
// silently no-op in exported HTML only, with nothing here to catch it.
const REPO_ROOT = join(__dirname, '..', '..')
const SHARED_CSS_PATH = join(REPO_ROOT, 'src', 'typography', 'document-typography.css')
const THIS_MODULE_PATH = join(REPO_ROOT, 'src', 'typography', 'static-html-document.ts')

function referencedCustomProperties(css: string): Set<string> {
  return new Set(Array.from(css.matchAll(/var\(\s*(--[\w-]+)/g), (m) => m[1]))
}

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

describe('static-html-document.ts root vars stay in sync with document-typography.css', () => {
  const sharedCss = readFileSync(SHARED_CSS_PATH, 'utf8')
  const thisModule = readFileSync(THIS_MODULE_PATH, 'utf8')

  const referenced = referencedCustomProperties(sharedCss)
  // buildRootVarsCss's own literal `:root {` block, parsed the same
  // source-text way document-typography.test.ts parses
  // resources/pagination-render/index.ts's -- this module has no
  // build-time asset loader complicating an import the way that one does,
  // but parsing the source text (not importing and calling the function)
  // keeps this test resilient to the function ever being renamed/reshaped
  // without its own :root literal moving.
  const declared = declaredCustomProperties(thisModule, ':root {')

  it('references at least the properties this guard exists to protect', () => {
    expect(referenced.has('--font-serif')).toBe(true)
    expect(referenced.has('--text-14')).toBe(true)
    expect(referenced.size).toBeGreaterThanOrEqual(6)
  })

  it('declares every property document-typography.css references, with no extras', () => {
    expect([...declared.keys()].sort()).toEqual([...referenced].sort())
  })

  it('gives every shared property the identical value document-typography.css expects', () => {
    // document-typography.css only ever REFERENCES these (var(--x)), never
    // declares a value itself -- the real "expected value" comes from
    // base.css's @theme static block, which document-typography.test.ts
    // already cross-checks against resources/pagination-render/index.ts's
    // own :root. What THIS test can additionally guarantee without a third
    // parse target is that this module's own copy matches what that
    // already-verified sandbox :root declares -- i.e. transitively correct
    // via that other test, not re-deriving the "true" values a third time.
    const RENDER_CONTEXT_PATH = join(REPO_ROOT, 'resources', 'pagination-render', 'index.ts')
    const renderContext = readFileSync(RENDER_CONTEXT_PATH, 'utf8')
    const sandboxRoot = declaredCustomProperties(renderContext, ':root {')
    for (const property of referenced) {
      expect(declared.get(property), `${property} must match the sandbox's own :root value`).toBe(
        sandboxRoot.get(property)
      )
    }
  })
})

describe('buildStaticHtmlDocument', () => {
  const geometry = computePageGeometry(DEFAULT_PAGE_CONFIG)
  const style = resolveDocumentStyle(DEFAULT_PAGE_CONFIG)

  function baseInput(overrides: Partial<StaticHtmlDocumentInput> = {}): StaticHtmlDocumentInput {
    return {
      title: 'My Document',
      bodyHtml: '<h1>Hello</h1>\n<p>World</p>',
      geometry,
      style,
      documentTypographyCss: '.pagedown-document h1 { font-size: 2em; }',
      fonts: {
        bodyFontFamilyName: 'Source Serif 4',
        bodyFontWeightRange: '200 900',
        bodyFontBase64: 'AAAA',
        monoFontBase64: null
      },
      ...overrides
    }
  }

  it('produces a well-formed, self-contained document', () => {
    const html = buildStaticHtmlDocument(baseInput())
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<html lang="en" dir="ltr">')
    expect(html).toContain('<title>My Document</title>')
    expect(html).toContain('<style>')
    expect(html).toContain('</style>')
    expect(html).toContain('<h1>Hello</h1>')
    expect(html).toContain('<p>World</p>')
  })

  it('carries no external references at all -- no <link>, no <script>, no bare http(s) asset URLs', () => {
    const html = buildStaticHtmlDocument(baseInput())
    expect(html).not.toContain('<link')
    expect(html).not.toContain('<script')
    // The one @font-face src is a data: URI, not a fetch -- confirm the
    // embedded font never regresses to a real network reference.
    expect(html).toContain('src: url(data:font/woff2;base64,AAAA)')
    expect(html).not.toMatch(/@font-face[^}]*url\(https?:/i)
  })

  it('embeds the document-typography.css text verbatim', () => {
    const html = buildStaticHtmlDocument(baseInput())
    expect(html).toContain('.pagedown-document h1 { font-size: 2em; }')
  })

  it('escapes a hostile title rather than injecting raw markup', () => {
    const html = buildStaticHtmlDocument(baseInput({ title: '</title><script>evil()</script>' }))
    expect(html).not.toContain('<script>evil()</script>')
    expect(html).toContain('&lt;script&gt;evil()&lt;/script&gt;')
  })

  it('omits the mono @font-face entirely when the document has no code', () => {
    const html = buildStaticHtmlDocument(baseInput())
    expect(html).not.toContain("font-family: 'Source Code Pro'")
  })

  it('includes the mono @font-face only when the caller supplies it', () => {
    const html = buildStaticHtmlDocument(
      baseInput({
        fonts: {
          bodyFontFamilyName: 'Source Serif 4',
          bodyFontWeightRange: '200 900',
          bodyFontBase64: 'AAAA',
          monoFontBase64: 'BBBB'
        }
      })
    )
    expect(html).toContain("font-family: 'Source Code Pro'")
    expect(html).toContain('src: url(data:font/woff2;base64,BBBB)')
  })

  it('reflects the resolved document style as real classes and a real dir attribute', () => {
    const rtlStyle = resolveDocumentStyle({
      ...DEFAULT_PAGE_CONFIG,
      theme: 'resume',
      direction: 'rtl'
    })
    const html = buildStaticHtmlDocument(baseInput({ style: rtlStyle }))
    expect(html).toContain('dir="rtl"')
    expect(html).toContain('pagedown-theme-resume')
    expect(html).toContain('pagedown-document')
  })

  it('emits a real @page rule sized from the given geometry', () => {
    const a4Geometry = computePageGeometry({ ...DEFAULT_PAGE_CONFIG, pageSize: 'A4' })
    const html = buildStaticHtmlDocument(baseInput({ geometry: a4Geometry }))
    // Derived from the geometry actually passed in, not a hand-typed nominal
    // A4 figure (8.2677in) -- computePageGeometry rounds to whole CSS pixels
    // before this function divides back out by DPI, so the real emitted
    // value is 794/96 = 8.270833...in, a real, small, expected divergence
    // from the nominal float (the same whole-pixel-rounding CLAUDE.md's own
    // Gate 13 distinguishes as "nominal" vs. "what this pipeline's own
    // rounding implies"), not a bug in either this test's original
    // expectation... except that it WAS the bug the first version of this
    // test had, caught by actually running it rather than trusting the
    // arithmetic.
    const expectedWidthIn = a4Geometry.pageWidthPx / DPI
    const expectedHeightIn = a4Geometry.pageHeightPx / DPI
    expect(html).toContain(`size: ${expectedWidthIn}in ${expectedHeightIn}in`)
    // A sanity check that this is genuinely A4-shaped, not accidentally
    // Letter -- guards against the geometry override silently not taking
    // effect at all.
    expect(expectedWidthIn).toBeCloseTo(8.27, 1)
    expect(expectedHeightIn).toBeCloseTo(11.7, 1)
  })
})
