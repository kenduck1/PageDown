// Turns a document's own PageConfig into the NON-geometric inputs the
// rendering surfaces need -- theme, font family, and running header/footer
// content. The geometric half of the same job lives in page-geometry.ts.
//
// This module is bundled into the sandboxed pagination render context, so its
// page-config import MUST stay type-only: a runtime import would drag
// `unified`, `remark-parse` and `remark-frontmatter` into the one context that
// deliberately runs untrusted document HTML. See page-geometry.ts's own,
// longer note on the same invariant.
import type {
  PageConfig,
  PageFontFamily,
  PageNumberFormat,
  PageRunningContent,
  PageTheme
} from '../markdown/page-config'

export interface DocumentStyle {
  theme: PageTheme
  fontFamily: PageFontFamily
  // null means "do not render this band at all", collapsing showHeader/
  // showFooter here so no consumer has to distinguish "hidden" from "empty".
  header: PageRunningContent | null
  footer: PageRunningContent | null
  pageNumberFormat: PageNumberFormat
}

export function resolveDocumentStyle(config: PageConfig): DocumentStyle {
  return {
    theme: config.theme,
    fontFamily: config.fontFamily,
    header: config.showHeader ? config.header : null,
    footer: config.showFooter ? config.footer : null,
    pageNumberFormat: config.pageNumberFormat
  }
}

export const DEFAULT_DOCUMENT_STYLE: DocumentStyle = {
  theme: 'default',
  fontFamily: 'source-serif-4',
  header: null,
  footer: { left: '', center: 'Page {n} of {total}', right: '' },
  pageNumberFormat: 'decimal'
}

// Header/footer text is untrusted: it comes from hand-editable YAML
// frontmatter, which this project's threat model treats as attacker-
// controllable, and it is interpolated into a CSS string literal. An
// unescaped `"` would terminate that string and let a document inject
// arbitrary declarations into the sandbox's stylesheet.
//
// Two things stated precisely so this is neither over- nor under-claimed:
//   - It is NOT an HTML-injection vector. Paged.js inserts the stylesheet via
//     document.createTextNode (polisher.js's `insert`), not innerHTML, so a
//     literal `</style>` cannot break out of the element. `<`/`>` therefore
//     need no escaping.
//   - It IS a real CSS-injection vector, and Paged.js clones the parsed
//     `content` value straight through with no sanitization of its own
//     (`cleanPseudoContent` exists but is used only by string-sets/target-text,
//     never by the literal-content path). So it is closed here, at the source.
//
// Backslash must be replaced FIRST, or it would double-escape the backslashes
// the later replacements introduce.
export function escapeCssString(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\A ')
}

const TOKEN_PATTERN = /(\{n\}|\{total\})/g

// Builds one CSS `content:` value from user text, substituting PageDown's own
// {n}/{total} tokens with real CSS counters. Paged.js resolves counter(page)
// natively, and counter(pages) works because Paged.js sets --pagedjs-page-count
// on the pages container after layout completes, which re-triggers the
// counter-reset that reads it.
//
// Only the LITERAL chunks are escaped; the counter() calls are generated here
// and never derived from user text. Preserve that split-then-escape ordering
// in any refactor -- it is what keeps user text unable to emit a function call.
function buildContentValue(text: string, format: PageNumberFormat): string {
  const style = format === 'roman' ? ', lower-roman' : ''
  const parts: string[] = []
  for (const chunk of text.split(TOKEN_PATTERN)) {
    if (chunk === '') continue
    if (chunk === '{n}') parts.push(`counter(page${style})`)
    else if (chunk === '{total}') parts.push(`counter(pages${style})`)
    else parts.push(`"${escapeCssString(chunk)}"`)
  }
  return parts.join(' ')
}

const SIDES: readonly (keyof PageRunningContent)[] = ['left', 'center', 'right']

// Emits nothing for an empty side ON PURPOSE. Paged.js hides a margin box
// unless it is flagged `.hasContent`, and that flag is set for ANY content
// other than `none` -- an emitted `content: ""` would therefore produce a
// present-but-empty box rather than no box at all.
function buildBand(
  band: 'top' | 'bottom',
  content: PageRunningContent | null,
  format: PageNumberFormat
): string {
  if (!content) return ''
  return SIDES.filter((side) => content[side] !== '')
    .map((side) => `  @${band}-${side} { content: ${buildContentValue(content[side], format)}; }`)
    .join('\n')
}

// The returned string is spliced INSIDE the existing `@page { ... }` block in
// resources/pagination-render/index.ts -- these are nested margin-box rules,
// not standalone ones.
export function buildRunningContentCss(style: DocumentStyle): string {
  return [
    buildBand('top', style.header, style.pageNumberFormat),
    buildBand('bottom', style.footer, style.pageNumberFormat)
  ]
    .filter((part) => part !== '')
    .join('\n')
}
