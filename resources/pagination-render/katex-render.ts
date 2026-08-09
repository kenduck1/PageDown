// Runs inside the sandboxed pagedown-render:// context (bundled into
// resources/pagination-render — never into the main process), mirroring
// src/diagrams/render-mermaid.ts's own architecture exactly: math renders in
// exactly ONE place, this file, and never in the privileged app-shell
// renderer. src/markdown/pipeline.ts (main process, shared by every
// surface) only ever emits an inert placeholder -- a `<div><code
// class="language-math-block">` / bare `<code class="language-math-inline">`
// carrying the raw LaTeX source as plain text, deliberately NOT reusing
// Mermaid's own `<pre><code class="language-mermaid">` shape verbatim (see
// src/markdown/math-to-hast.ts for the real, test-caught reason the block
// wrapper differs). This module finds those placeholders and replaces them
// with real, typeset KaTeX output.
import { renderToString } from 'katex'
import katexCssText from 'katex/dist/katex.min.css'
import { hoistInlineStyleAttributes, reattachNoncedStyles } from './nonce-style-hoisting'

// esbuild's `.woff2: base64` loader (scripts/build-pagination-render.ts)
// applies to any resolved .woff2 import regardless of which package it
// lives in -- these 20 imports pull KaTeX's own bundled font files in as
// self-contained base64 strings, the same mechanism document-typography.css's
// Source Serif 4 / Inter Variable faces already use (index.ts). All 20 are
// needed together, unlike the Source Serif/Inter case: a single rendered
// equation can freely mix KaTeX's Main/Math/AMS/Size1-4/... families within
// one formula (e.g. big delimiters pull from Size1-4, blackboard-bold pulls
// from AMS), so there is no "pick one family" story the way there is for
// the two document body fonts -- see buildKatexFontFaceCss's own comment
// for how the real, non-free cost of registering all 20 unconditionally is
// avoided instead.
import katexAMSRegular from 'katex/dist/fonts/KaTeX_AMS-Regular.woff2'
import katexCaligraphicBold from 'katex/dist/fonts/KaTeX_Caligraphic-Bold.woff2'
import katexCaligraphicRegular from 'katex/dist/fonts/KaTeX_Caligraphic-Regular.woff2'
import katexFrakturBold from 'katex/dist/fonts/KaTeX_Fraktur-Bold.woff2'
import katexFrakturRegular from 'katex/dist/fonts/KaTeX_Fraktur-Regular.woff2'
import katexMainBold from 'katex/dist/fonts/KaTeX_Main-Bold.woff2'
import katexMainBoldItalic from 'katex/dist/fonts/KaTeX_Main-BoldItalic.woff2'
import katexMainItalic from 'katex/dist/fonts/KaTeX_Main-Italic.woff2'
import katexMainRegular from 'katex/dist/fonts/KaTeX_Main-Regular.woff2'
import katexMathBoldItalic from 'katex/dist/fonts/KaTeX_Math-BoldItalic.woff2'
import katexMathItalic from 'katex/dist/fonts/KaTeX_Math-Italic.woff2'
import katexSansSerifBold from 'katex/dist/fonts/KaTeX_SansSerif-Bold.woff2'
import katexSansSerifItalic from 'katex/dist/fonts/KaTeX_SansSerif-Italic.woff2'
import katexSansSerifRegular from 'katex/dist/fonts/KaTeX_SansSerif-Regular.woff2'
import katexScriptRegular from 'katex/dist/fonts/KaTeX_Script-Regular.woff2'
import katexSize1Regular from 'katex/dist/fonts/KaTeX_Size1-Regular.woff2'
import katexSize2Regular from 'katex/dist/fonts/KaTeX_Size2-Regular.woff2'
import katexSize3Regular from 'katex/dist/fonts/KaTeX_Size3-Regular.woff2'
import katexSize4Regular from 'katex/dist/fonts/KaTeX_Size4-Regular.woff2'
import katexTypewriterRegular from 'katex/dist/fonts/KaTeX_Typewriter-Regular.woff2'

const KATEX_FONT_BASE64: Record<string, string> = {
  'KaTeX_AMS-Regular.woff2': katexAMSRegular,
  'KaTeX_Caligraphic-Bold.woff2': katexCaligraphicBold,
  'KaTeX_Caligraphic-Regular.woff2': katexCaligraphicRegular,
  'KaTeX_Fraktur-Bold.woff2': katexFrakturBold,
  'KaTeX_Fraktur-Regular.woff2': katexFrakturRegular,
  'KaTeX_Main-Bold.woff2': katexMainBold,
  'KaTeX_Main-BoldItalic.woff2': katexMainBoldItalic,
  'KaTeX_Main-Italic.woff2': katexMainItalic,
  'KaTeX_Main-Regular.woff2': katexMainRegular,
  'KaTeX_Math-BoldItalic.woff2': katexMathBoldItalic,
  'KaTeX_Math-Italic.woff2': katexMathItalic,
  'KaTeX_SansSerif-Bold.woff2': katexSansSerifBold,
  'KaTeX_SansSerif-Italic.woff2': katexSansSerifItalic,
  'KaTeX_SansSerif-Regular.woff2': katexSansSerifRegular,
  'KaTeX_Script-Regular.woff2': katexScriptRegular,
  'KaTeX_Size1-Regular.woff2': katexSize1Regular,
  'KaTeX_Size2-Regular.woff2': katexSize2Regular,
  'KaTeX_Size3-Regular.woff2': katexSize3Regular,
  'KaTeX_Size4-Regular.woff2': katexSize4Regular,
  'KaTeX_Typewriter-Regular.woff2': katexTypewriterRegular
}

// katex.min.css's real, unmodified @font-face rules each list THREE src
// entries in order -- `url(fonts/KaTeX_X.woff2) format("woff2")`, then a
// `.woff`/`.ttf` fallback for browsers this app never targets (Electron 39's
// bundled Chromium, pinned as the esbuild target in
// scripts/build-pagination-render.ts, has full woff2 support). Browsers
// evaluate an @font-face `src` list in order and stop at the first source
// that actually loads, never touching the rest -- so once every woff2 entry
// below is rewritten to a self-contained `data:` URI (which always "loads"
// successfully), the untouched `.woff`/`.ttf` fallback entries are
// structurally unreachable, not merely unlikely to fire. They are still
// stripped here, rather than left as harmless dead weight, so a future
// reader of the built stylesheet doesn't have to independently re-derive
// that reachability argument to trust that a relative `fonts/....woff` path
// with nothing behind it (this bundle never ships the .woff/.ttf files,
// only .woff2) is fine to ignore.
function embedKatexFonts(css: string): string {
  let result = css
  for (const [filename, base64] of Object.entries(KATEX_FONT_BASE64)) {
    result = result
      .replaceAll(`,url(fonts/${filename.replace('.woff2', '.woff')}) format("woff")`, '')
      .replaceAll(`,url(fonts/${filename.replace('.woff2', '.ttf')}) format("truetype")`, '')
      .replaceAll(`url(fonts/${filename})`, `url(data:font/woff2;base64,${base64})`)
  }
  return result
}

const EMBEDDED_KATEX_CSS = embedKatexFonts(katexCssText)

// Called from buildDocumentStylesheet (index.ts) ONLY when renderMathEquations
// (below) actually found and replaced at least one math placeholder in the
// current request -- never unconditionally. This mirrors the exact, already-
// learned lesson document-typography.css's own Source Serif/Inter handling
// encodes: Paged.js's Chunker.flow() awaits `loadFonts()`, which loads EVERY
// FontFace already registered in `document.fonts` regardless of whether
// anything on the page uses it (chunker.js, confirmed by reading it directly
// -- see index.ts's own buildDocumentStylesheet comment for the fuller
// writeup of this same invariant). All 20 KaTeX font files (~296KB of woff2,
// ~394KB once base64-inflated) would otherwise decode on every single
// render, including the (likely common) case of a document with no math in
// it at all.
export function buildKatexFontFaceCss(): string {
  return EMBEDDED_KATEX_CSS
}

const MATH_BLOCK_CLASS = 'pagedown-math-block'
const MATH_INLINE_CLASS = 'pagedown-math-inline'

// KaTeX's own equivalent of Mermaid's `securityLevel: 'strict'` -- pinned
// explicitly rather than relied on as "the current default," matching this
// codebase's own established style for every other security-relevant
// rendering option (see index.ts's Mermaid config comments):
//   - trust: false (KaTeX's own default) disables \href/\url/\includegraphics/
//     \htmlData and similar commands that would otherwise let document
//     content embed arbitrary URLs or raw HTML attributes into the render.
//     Explicit here so a future KaTeX upgrade changing its own default can
//     never silently loosen this.
//   - throwOnError: false makes a malformed equation degrade to KaTeX's own
//     built-in inline error rendering (red text showing the parse error)
//     instead of throwing -- document content is arbitrary/untrusted text,
//     and one broken `$$` pair must not be able to abort the whole render.
//   - maxSize bounds how large KaTeX's own explicit size-changing constructs
//     (\Huge nesting, \rule, \kern, \hspace, ...) can render, in ems.
//     KaTeX's own default is Infinity -- unbounded -- which is a real,
//     if not yet corpus-exercised, DoS surface for content this app treats
//     as untrusted (the same posture Mermaid's classDef-CSS stripping and
//     this file's own font/style hoisting already take). 20em is generous
//     for any legitimate large display equation while bounding the
//     worst case.
//   - maxExpand caps macro expansion (guards a `\def`-based expansion loop).
//     KaTeX's own default (1000) is already finite; pinned explicitly here
//     for the same "don't depend on an unstated library default" reasoning
//     as the rest of this list, not because the default was unsafe.
//   - strict: 'ignore' (KaTeX's own default is 'warn', which calls
//     `console.warn` for LaTeX constructs that are common and harmless but
//     not strictly (Xe)LaTeX-faithful) avoids noisy console warnings for
//     ordinary document content -- this app has no LaTeX-faithfulness
//     requirement to enforce.
const KATEX_RENDER_OPTIONS = {
  trust: false,
  throwOnError: false,
  maxSize: 20,
  maxExpand: 1000,
  strict: 'ignore'
} as const

// Renders one placeholder's raw LaTeX source into a real, CSP-safe DOM
// element. Synchronous throughout (unlike Mermaid's renderMermaidToSvg) --
// katex.renderToString does no async work internally, so unlike
// renderMathEquations's Mermaid counterpart, there is no `await
// document.fonts.ready` needed here either: buildKatexFontFaceCss's output
// only reaches `document.fonts` once the caller folds it into the
// stylesheet handed to `previewer.preview()`, well after this function
// returns -- font loading itself is Paged.js's own Chunker.loadFonts()
// concern, not this function's.
function renderMathPlaceholder(sourceText: string, displayMode: boolean): HTMLElement {
  const wrapperTag = displayMode ? 'div' : 'span'
  const wrapperClass = displayMode ? MATH_BLOCK_CLASS : MATH_INLINE_CLASS

  let katexHtml: string
  try {
    katexHtml = renderToString(sourceText, { ...KATEX_RENDER_OPTIONS, displayMode })
  } catch {
    // throwOnError: false already converts a malformed-LaTeX ParseError into
    // KaTeX's own inline error span rather than throwing (confirmed by
    // reading katex's own render() source) -- this catch is a second,
    // defensive layer for anything else that could throw (a genuinely
    // unexpected internal KaTeX error). This function runs synchronously
    // inside the 'render' message handler with no per-equation try/catch
    // upstream the way Mermaid's async loop has via its own outer try/catch,
    // so one broken equation must degrade to its own visible raw source
    // text here, not abort the whole document's render.
    const fallback = document.createElement(wrapperTag)
    fallback.className = wrapperClass
    fallback.textContent = sourceText
    return fallback
  }

  // Same scratch-document strategy Mermaid's own rendering uses (see
  // index.ts's renderMermaidDiagrams): parse into a separate, CSP-free
  // DOMParser document, hoist every inline style="" attribute out into a
  // class-selector rule WHILE the element still lives there, then import
  // the now-style-attribute-free element into this page's own governed
  // document. KaTeX's vlist-based layout mechanism (fraction bars,
  // exponent/subscript stacking, radical signs, accents, ...) depends
  // directly on per-element inline `style="top:...em; margin-left:...em;"`
  // declarations for correct positioning -- unlike Mermaid's own mostly-
  // decorative inline styles, these are load-bearing for math to render
  // correctly at all under this context's style-src (no 'unsafe-inline')
  // CSP, not just a CSP-hygiene concern.
  const scratchDoc = new DOMParser().parseFromString(katexHtml, 'text/html')
  const scratchRoot = scratchDoc.body.firstElementChild
  if (!scratchRoot) {
    const fallback = document.createElement(wrapperTag)
    fallback.className = wrapperClass
    fallback.textContent = sourceText
    return fallback
  }

  const hoistedCss = hoistInlineStyleAttributes(scratchRoot)
  const imported = document.importNode(scratchRoot, true) as HTMLElement
  reattachNoncedStyles(imported, hoistedCss)

  const wrapper = document.createElement(wrapperTag)
  wrapper.className = wrapperClass
  wrapper.appendChild(imported)
  return wrapper
}

// Finds every math placeholder inside `container` and replaces it in place
// with real, typeset KaTeX output -- mutates `container` directly (no
// return value beyond the boolean below), matching renderMermaidDiagrams's
// own in-place-mutation contract in index.ts, for the identical reason:
// the caller passes the SAME container straight into `previewer.preview()`
// afterward, and only a live DOM node (not a re-serialized HTML string)
// keeps this function's nonced <style> elements valid.
//
// Returns whether it found (and rendered) any math at all -- the caller
// uses this to decide whether buildKatexFontFaceCss's ~394KB of embedded
// font data needs to be included in this request's stylesheet at all. See
// buildKatexFontFaceCss's own comment for why that gating is real and
// load-bearing, not a micro-optimization.
export function renderMathEquations(container: DocumentFragment): boolean {
  // `div > code.language-math-block`, not `pre > code...` -- see
  // math-to-hast.ts's own comment on createMathBlockToHast for why the
  // wrapper is deliberately a bare `<div>`, not `<pre>` (a real,
  // test-caught rehype-highlight interaction, not a stylistic choice).
  const blockCodeBlocks = Array.from(
    container.querySelectorAll('div > code.language-math-block')
  ) as HTMLElement[]
  const inlineCodeSpans = Array.from(
    container.querySelectorAll('code.language-math-inline')
  ) as HTMLElement[]

  if (blockCodeBlocks.length === 0 && inlineCodeSpans.length === 0) return false

  for (const code of blockCodeBlocks) {
    const placeholderDiv = code.parentElement
    if (!placeholderDiv) continue // unreachable for a `div > code` match, but keeps this a type-safe non-null narrowing rather than a cast
    const wrapper = renderMathPlaceholder(code.textContent ?? '', true)
    placeholderDiv.replaceWith(wrapper)
  }

  for (const code of inlineCodeSpans) {
    const wrapper = renderMathPlaceholder(code.textContent ?? '', false)
    code.replaceWith(wrapper)
  }

  return true
}
