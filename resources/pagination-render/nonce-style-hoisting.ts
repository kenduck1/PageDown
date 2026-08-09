// Shared CSP-nonce-safe inline-style handling, used by BOTH Mermaid diagram
// rendering (index.ts) and KaTeX math rendering (katex-render.ts). Extracted
// out of index.ts by the math-equations sub-project -- these two functions
// were already written generically (operating on `Element`/any style
// declarations, not on anything Mermaid-specific; see their own comments
// below) when Task 8 / Gate 3 first built them, so reusing them for KaTeX's
// output is a real reuse, not a coincidental lookalike. Lives in its own
// file, not exported from index.ts, specifically to avoid a circular import:
// index.ts is this bundle's entry point and katex-render.ts needs these two
// functions too, so both import from here instead of one importing from the
// other.

// Strips `@import` and external `url(...)` references from a CSS text block
// this render context is about to reattach as a real, nonced <style>
// element. Per the design doc's third-review correction (the SiYuan
// reference, see index.ts's own top-of-file comments): rendered content this
// context turns into real DOM can carry CSS that would fire a real outbound
// network request the moment the style is applied -- Mermaid's `classDef`
// syntax accepts arbitrary CSS declarations on node classes, and is the
// concrete case this was written for -- the same class of leak
// `connect-src 'none'` and the remote-image-blocking policy exist to close
// everywhere else. Neutralized here as plain string surgery (not a full CSS
// parse) -- adequate for every corpus fixture exercising this path so far,
// not a full sanitizer.
function stripExternalCssRefs(css: string): string {
  return css
    .replace(/@import\s+[^;]+;/gi, '')
    .replace(/url\(\s*(['"]?)(?:https?:)?\/\/[^)'"]*\1\s*\)/gi, 'url()')
}

let hoistedStyleCounter = 0

// Moves every inline `style="..."` ATTRIBUTE under (and including) `element`
// into a synthetic class selector, returning the equivalent CSS text for the
// caller to fold into a real nonced <style> element via reattachNoncedStyles
// below. CSP nonces apply only to elements carrying a `nonce` CONTENT
// attribute (`<style>`/`<script>`) -- never to a `style=""` attribute on an
// arbitrary element, confirmed empirically (not just from the spec) while
// building Mermaid support, by first observing ~130 real "Applying inline
// style violates..." console violations with only a <style>-BLOCK nonce fix
// in place. Hoisting into a class rule inside a nonced <style> is the only
// CSP-compatible fix once inline style attributes are in play at all.
//
// Deliberately generic (moves ANY property:value declarations, not a
// caller-specific property allowlist) -- this is what makes it safe to reuse
// unchanged for KaTeX's own output below, which has nothing to do with
// Mermaid: KaTeX's vlist-based layout mechanism (fraction bars, exponent/
// subscript stacking, radical signs, ...) depends on per-element inline
// `style="top:...em; margin-left:...em;"` declarations for correct
// positioning -- unlike Mermaid's case, these are load-bearing for KaTeX,
// not decorative, so this function is not optional for math to render
// correctly under this context's `style-src` (no `unsafe-inline`) CSP.
//
// Untested risk, flagged on review rather than chased down for Mermaid and
// unchanged here: this changes CSS SPECIFICITY, not just mechanism -- an
// inline `style=""` attribute always wins the cascade unbeatable by any
// selector-based rule short of `!important`; a `.pd-hoisted-style-N { ... }`
// class rule does not. Neither corpus (Mermaid diagrams without `classDef`,
// KaTeX's own generated markup, which carries no competing class-based
// author styling of its own) has anything else contesting specificity on
// these elements today.
//
// Includes `element` ITSELF, not just its descendants -- Mermaid's own
// `configureSvgSize` sets a `style="max-width:...px"` attribute directly on
// the SVG root (see index.ts's fitSvgToNaturalSize), and KaTeX's own
// top-level `.katex`/`.katex-display` wrapper can likewise carry its own
// inline style -- `element.querySelectorAll('[style]')` only matches
// descendants by definition, so omitting the root would silently leave
// exactly the outermost element's style unhoisted.
export function hoistInlineStyleAttributes(element: Element): string {
  const styledElements: Element[] = [element, ...element.querySelectorAll('[style]')]
  const rules: string[] = []
  for (const el of styledElements) {
    const declarations = el.getAttribute('style') ?? ''
    el.removeAttribute('style')
    if (!declarations.trim()) continue // e.g. a no-op style="" attribute -- nothing to hoist
    const marker = `pd-hoisted-style-${hoistedStyleCounter++}`
    el.classList.add(marker)
    rules.push(`.${marker} { ${stripExternalCssRefs(declarations)} }`)
  }
  return rules.join('\n')
}

// Discards every <style> element already inside `element` and re-creates
// each one via THIS page's own `document.createElement` -- which is what
// gets it a real, valid nonce, since the bootstrap shim at the top of
// index.ts only patches `document.createElement('style')` calls made by
// trusted code running on this page, not elements produced by parsing a
// string (e.g. `element.innerHTML = svgMarkup`) or imported from a separate
// scratch document. A <style> that arrived via markup parsing/import is
// nonce-less and would be silently blocked by this context's own CSP the
// instant it takes effect.
//
// If `element` carries no existing <style> of its own (KaTeX's output never
// does -- it relies entirely on a document-wide stylesheet plus the inline
// style attributes hoistInlineStyleAttributes moves out, not a per-render
// embedded <style> block the way Mermaid's output does) but `extraCss` is
// non-empty, one fresh nonced <style> is still created and inserted as the
// first child -- this is the branch KaTeX's own call site below actually
// exercises.
export function reattachNoncedStyles(element: Element, extraCss = ''): void {
  const staleStyles = Array.from(element.querySelectorAll('style'))
  for (const stale of staleStyles) {
    const fresh = document.createElement('style')
    fresh.textContent = [stripExternalCssRefs(stale.textContent ?? ''), extraCss]
      .filter(Boolean)
      .join('\n')
    stale.replaceWith(fresh)
  }
  if (staleStyles.length === 0 && extraCss.trim()) {
    const fresh = document.createElement('style')
    fresh.textContent = extraCss
    element.insertBefore(fresh, element.firstChild)
  }
}
