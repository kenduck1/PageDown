// Same underlying problem document-typography-css.d.ts documents at length:
// esbuild's `text` loader (scripts/build-pagination-render.ts) imports
// katex.min.css as a plain JS string default export, but vite/client.d.ts's
// ambient `declare module '*.css' {}` (visible here too, since this
// directory shares tsconfig.web.json with the real Vite-built app-shell
// renderer) declares `.css` imports as an empty, no-default-export module --
// correct for Vite's own side-effect-only CSS imports, wrong for this one.
//
// Deliberately an EXACT module specifier, not a wildcard pattern (unlike
// document-typography-css.d.ts's `*/document-typography.css`) -- and this
// is a real difference, not a stylistic one. That file imports via a
// RELATIVE path, so a wildcard is the only option, which is what forces its
// whole prefix-length/discovery-order tie-break writeup. `katex/dist/
// katex.min.css` is a bare package specifier: the same literal string at
// every import site, so TypeScript's exact-module-name lookup (checked
// before any wildcard pattern, unconditionally -- no tie-break, no
// discovery-order dependency) applies directly. Simpler for a real reason,
// not merely a shorter file.
declare module 'katex/dist/katex.min.css' {
  const css: string
  export default css
}
