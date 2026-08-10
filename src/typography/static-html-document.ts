// Assembles a single, self-contained `<!doctype html>` document for HTML
// export (src/main/html-exporter.ts) -- the file this app writes when a user
// picks "Export as HTML" must open correctly, and look like the rest of this
// app's typography, in ANY browser with no other files, no network access,
// and no PageDown-specific machinery available to it at all.
//
// Deliberately Electron/Node-free (no `fs`, no `electron` import) so it's
// directly unit-testable under plain Vitest with no mocks -- same
// testability convention as recent-files.ts/preferences.ts, and the one this
// task's own brief asked for by name ("given content, assert the output is a
// well-formed self-contained document"). Every byte this function needs
// (CSS text, font base64, the sanitized body HTML) is supplied by the
// caller, which is the ONLY thing that can actually reach a filesystem or
// Electron API in the first place.
//
// --- Why this does NOT reuse resources/pagination-render/index.ts's own
// buildDocumentStylesheet, even though the two build structurally similar
// CSS (a :root vars block, one gated body @font-face, an optional mono
// @font-face, an @page rule, document-typography.css's own text) ---
//
// That function is the load-bearing, heavily gate-tested CSS source for
// Paged.js pagination in the sandboxed render context (Gate 16 pins its
// margin-shorthand ORDER; Gate 10 pins 0.000px editor/paginator parity;
// document-typography.test.ts cross-checks its own literal `:root` block
// against document-typography.css and base.css by parsing
// resources/pagination-render/index.ts's SOURCE TEXT directly, because that
// module imports .css/.woff2 through an esbuild-only loader config plain
// Vitest cannot resolve). Refactoring buildDocumentStylesheet to delegate
// its :root/font-face assembly to a shared function would mean either (a)
// this file importing FROM resources/pagination-render/ -- backwards; that
// directory is a build OUTPUT-shaped, sandbox-only source tree, never a
// dependency of anything under src/ -- or (b) extracting the shared piece
// into a new file resources/pagination-render/index.ts would import instead
// of declaring inline, which breaks document-typography.test.ts's own
// source-text parsing (it looks for a literal root-selector rule with
// literal custom-property declarations written directly in that exact
// file; a template-literal interpolation of an imported constant has no
// such literal text for the regex to find) and would
// need that test rewritten and re-verified alongside a change to a function
// three separate gates already depend on for correctness. Given this
// feature's own real requirements are simpler (a plain flowing document, no
// Paged.js, no Mermaid/KaTeX runtime -- see the "what this deliberately does
// NOT render" note below), duplicating the small :root/font-face template
// here -- independent, low-risk, and covered by this file's OWN drift test
// (static-html-document.test.ts, mirroring document-typography.test.ts's
// method) -- is the narrower alternative CLAUDE.md's own build-quirk notes
// point toward, not a shortcut taken to avoid the harder refactor.
//
// --- What this deliberately does NOT render ---
//
// Mermaid diagrams and math equations reach this function exactly as
// markdownToHtml already renders them by default (no assetToken changes
// this): INERT placeholders -- `<pre><code class="language-mermaid">` /
// bare `<code class="language-math-*">` -- carrying their raw source text,
// never real SVG/KaTeX output. Baking those into real rendered output would
// mean driving the full sandboxed Mermaid/KaTeX pipeline
// (resources/pagination-render/) from the main process just for this
// export, extracting its resulting DOM back out as portable static markup --
// real, separate, substantially larger scope than a typography-parity export
// (and the KaTeX font assets alone are ~394KB, per that module's own
// hasMath-gating comment, that a math-free export must not pay for). Left as
// legible fenced code blocks instead: document-typography.css's own
// pre/code rules (border, padding, --font-mono) already make an unrendered
// Mermaid/LaTeX block a readable, honestly-labeled "here is the source",
// not a blank or broken element. A disclosed limitation, not a bug.
import type { PageGeometry } from './page-geometry'
import { DPI } from './page-geometry'
import { buildRunningContentCss, documentStyleClasses, type DocumentStyle } from './document-style'

export interface StaticHtmlFontAssets {
  // Base64-encoded (no `data:` prefix) woff2 bytes for the ACTIVE body font
  // ONLY -- whichever family `style.fontFamily` selects -- never both.
  // Mirrors buildDocumentStylesheet's own "exactly one body @font-face" cost
  // discipline (resources/pagination-render/index.ts): a portable,
  // hand-off-to-anyone export file benefits from this even more than the
  // in-app preview does, since every unused embedded font is dead weight a
  // reader downloads once and can never even benefit from (they're not
  // re-visiting this file across documents the way a long-lived harness is).
  bodyFontFamilyName: 'Source Serif 4' | 'Inter Variable'
  bodyFontWeightRange: '200 900' | '100 900'
  bodyFontBase64: string
  // null when the document has no <pre>/<code> element at all (mirrors
  // buildDocumentStylesheet's own `hasCode` gate) -- the caller decides this
  // by inspecting the rendered body HTML before calling in, since this
  // module has no HTML-parsing capability of its own.
  monoFontBase64: string | null
}

export interface StaticHtmlDocumentInput {
  // Used for both <title> and the visible on-screen page background isn't
  // exposed here -- see buildStaticHtmlDocument's own comment for why a
  // background/page-card frame is added at all despite document-typography.css
  // already covering the DOCUMENT content styling.
  title: string
  // The exact sanitized fragment markdownToHtml returned -- this function
  // never re-sanitizes or otherwise inspects it; it is trusted the same way
  // every other consumer of markdownToHtml's return value already is.
  bodyHtml: string
  geometry: PageGeometry
  style: DocumentStyle
  // document-typography.css's own raw text, read by the caller (Node fs,
  // via an electron-vite `?asset`-resolved path -- see html-exporter.ts) --
  // this module has no filesystem access of its own.
  documentTypographyCss: string
  fonts: StaticHtmlFontAssets
}

// Minimal escaping for the one place user-controlled text (the document's
// own title, currently just the tab's filename with no extension -- see
// html-exporter.ts) lands inside HTML text content rather than inside an
// attribute or a CSS string -- `<`/`>`/`&` are the only three characters
// that can change HTML text-content parsing; `"` needs no escaping here
// because this value is never placed inside a quoted attribute.
function escapeHtmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// The identical eight custom properties resources/pagination-render/index.ts's
// own :root block declares today (document-typography.test.ts pins that file
// against document-typography.css/base.css) -- kept as a literal duplicate
// here on purpose; see this file's own top comment for why sharing a
// constant across that file and this one isn't the safe move it looks like.
// static-html-document.test.ts is THIS file's own drift guard, following
// document-typography.test.ts's exact method (parse document-typography.css's
// referenced var() names, assert this literal declares all of them with
// matching values) so a var added to the shared stylesheet without being
// added here fails a test instead of silently no-opping in exported HTML
// only.
function buildRootVarsCss(): string {
  return `:root {
  --font-serif: 'Source Serif 4', serif;
  --font-mono: 'Source Code Pro', monospace;
  --font-doc-sans: 'Inter Variable', sans-serif;
  --text-12: 12px;
  --text-13: 13px;
  --text-14: 14px;
  --text-15: 15px;
  --text-16: 16px;
  --text-20: 20px;
  --text-21: 21px;
  --text-26: 26px;
  --text-32: 32px;
}`
}

function buildFontFaceCss(fonts: StaticHtmlFontAssets): string {
  const bodyFontFace = `@font-face {
  font-family: '${fonts.bodyFontFamilyName}';
  font-style: normal;
  font-weight: ${fonts.bodyFontWeightRange};
  font-display: block;
  src: url(data:font/woff2;base64,${fonts.bodyFontBase64}) format('woff2-variations');
}`
  const monoFontFace = fonts.monoFontBase64
    ? `@font-face {
  font-family: 'Source Code Pro';
  font-style: normal;
  font-weight: 200 900;
  font-display: block;
  src: url(data:font/woff2;base64,${fonts.monoFontBase64}) format('woff2-variations');
}`
    : ''
  return [bodyFontFace, monoFontFace].filter((part) => part !== '').join('\n\n')
}

// Builds the ONE <style> block's full text: shared vars, font faces, a real
// @page rule (geometrically inert on screen, but genuinely honored if the
// reader prints this file from their own browser -- Chromium and every
// major engine respect @page size/margin for print regardless of what
// produced the HTML), document-typography.css verbatim, and a small
// "export shell" frame that exists ONLY for the on-screen, un-printed case:
// document-typography.css's `.pagedown-document` rule already pins a white
// background/dark text (see CLAUDE.md's dark-mode section on why those are
// literal, not var()-based), but a bare white block with no framing at all
// reads as a broken/unstyled page when opened directly in a browser tab --
// the shell gives it a neutral backdrop and a print-page-shaped card,
// mirroring EditorScreen's own page-card presentation, and disables itself
// entirely under @media print so an actual paper printout isn't affected by
// screen-only decoration.
function buildStyleBlock(input: StaticHtmlDocumentInput): string {
  const { geometry, style, documentTypographyCss, fonts } = input
  return `
${buildRootVarsCss()}

${buildFontFaceCss(fonts)}

@page {
  size: ${geometry.pageWidthPx / DPI}in ${geometry.pageHeightPx / DPI}in;
  margin: ${geometry.marginTopPx / DPI}in ${geometry.marginRightPx / DPI}in ${geometry.marginBottomPx / DPI}in ${geometry.marginLeftPx / DPI}in;
${buildRunningContentCss(style)}
}

html {
  background: #e7e7ea;
}

body {
  margin: 0;
  display: flex;
  justify-content: center;
  padding: 2.5rem 1rem;
}

.pagedown-export-page {
  box-sizing: border-box;
  width: ${geometry.pageWidthPx}px;
  max-width: 100%;
  padding: ${geometry.marginTopPx}px ${geometry.marginRightPx}px ${geometry.marginBottomPx}px ${geometry.marginLeftPx}px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12), 0 1px 12px rgba(0, 0, 0, 0.08);
}

@media print {
  html { background: none; }
  body { display: block; padding: 0; }
  .pagedown-export-page {
    width: auto;
    max-width: none;
    padding: 0;
    box-shadow: none;
  }
}

${documentTypographyCss}
`
}

// The full, final, self-contained document -- no <link>, no <script>, no
// external <img>/@font-face reference (local images are already inlined as
// data: URIs by the caller before this function ever sees `bodyHtml`; remote
// ones, if consented to, stay as ordinary http(s) URLs the reader's own
// browser fetches directly, exactly matching what every other render
// surface in this app already does with that same consent decision -- see
// html-exporter.ts's own comment for why re-fetching them at export time is
// out of scope here).
export function buildStaticHtmlDocument(input: StaticHtmlDocumentInput): string {
  const classes = [
    'pagedown-document',
    ...documentStyleClasses(input.style),
    'pagedown-export-page'
  ]
  return `<!doctype html>
<html lang="en" dir="${input.style.direction}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtmlText(input.title)}</title>
<style>${buildStyleBlock(input)}</style>
</head>
<body>
<div class="${classes.join(' ')}">
${input.bodyHtml}
</div>
</body>
</html>
`
}
