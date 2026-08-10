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
  PageFontSize,
  PageNumberFormat,
  PageRunningContent,
  PageTheme,
  TextDirection
} from '../markdown/page-config'

export interface DocumentStyle {
  theme: PageTheme
  fontFamily: PageFontFamily
  // Body text size in CSS pixels, or 'default' -- see PageFontSize. Applied
  // the same way theme/fontFamily are: as one more class on each surface's own
  // `.pagedown-document` element (`pagedown-size-<n>`), never as an inline
  // style, so both surfaces read the identical rules out of the identical
  // stylesheet. 'default' deliberately emits NO class at all, matching how
  // `theme: 'default'` and `fontFamily: 'source-serif-4'` emit no rules -- the
  // base stylesheet already IS the default, and a no-op override would risk
  // Gate 10's 0.000px editor/paginator parity for the case nothing is supposed
  // to change.
  fontSize: PageFontSize
  // null means "do not render this band at all", collapsing showHeader/
  // showFooter here so no consumer has to distinguish "hidden" from "empty".
  header: PageRunningContent | null
  footer: PageRunningContent | null
  pageNumberFormat: PageNumberFormat
  direction: TextDirection
}

export function resolveDocumentStyle(config: PageConfig): DocumentStyle {
  return {
    theme: config.theme,
    fontFamily: config.fontFamily,
    fontSize: config.fontSize,
    header: config.showHeader ? config.header : null,
    footer: config.showFooter ? config.footer : null,
    pageNumberFormat: config.pageNumberFormat,
    direction: config.direction
  }
}

export const DEFAULT_DOCUMENT_STYLE: DocumentStyle = {
  theme: 'default',
  fontFamily: 'source-serif-4',
  fontSize: 'default',
  header: null,
  footer: { left: '', center: 'Page {n} of {total}', right: '' },
  pageNumberFormat: 'decimal',
  direction: 'ltr'
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
// A raw, unescaped CR or FF is just as dangerous as a raw LF, not merely
// cosmetic whitespace: per the CSS Syntax Module Level 3 input-stream
// preprocessing step, a lone U+000D CARRIAGE RETURN, a lone U+000C FORM FEED,
// and a U+000D U+000A pair are EACH independently normalized to a single
// U+000A LINE FEED before the CSS parser ever tokenizes the text -- so any of
// the three terminates a quoted `content:` string exactly like the plain `\n`
// case already handled here, via the same <bad-string-token> mechanism.
// Reachable in practice, not merely theoretical: js-yaml resolves an explicit
// double-quoted YAML escape (`headerCenter: "text\r} body { ... } @page {"`)
// into a JS string containing a literal CR -- that's YAML's own explicit
// escape resolution, not its plain/block-scalar line-folding normalization,
// so the raw control character survives into this function untouched.
//
// Backslash must be replaced FIRST, or it would double-escape the backslashes
// the later replacements introduce.
export function escapeCssString(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r\n|\r|\n|\f/g, '\\A ')
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
/**
 * The `.pagedown-document`-scoped classes a surface must carry for this style,
 * beyond `pagedown-document` itself. ONE list, consumed by both surfaces (the
 * Milkdown mount div in MilkdownEditor.tsx, and the sandboxed context's
 * `<body>` in resources/pagination-render/index.ts), so a class added for one
 * cannot be forgotten on the other -- which is exactly the divergence class
 * this whole shared-typography design exists to prevent.
 *
 * 'default'/'source-serif-4' emit no class, matching the "no rules for the
 * default" convention document-typography.css's own theme section documents.
 */
export function documentStyleClasses(style: DocumentStyle): string[] {
  const classes = [`pagedown-theme-${style.theme}`, `pagedown-font-${style.fontFamily}`]
  if (style.fontSize !== 'default') classes.push(`pagedown-size-${style.fontSize}`)
  return classes
}

export function buildRunningContentCss(style: DocumentStyle): string {
  return [
    buildBand('top', style.header, style.pageNumberFormat),
    buildBand('bottom', style.footer, style.pageNumberFormat)
  ]
    .filter((part) => part !== '')
    .join('\n')
}
