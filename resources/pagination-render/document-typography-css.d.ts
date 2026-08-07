// Document Typography sub-project: this render context's own esbuild step
// (scripts/build-pagination-render.ts) uses esbuild's `text` loader for
// `.css`, importing the raw file contents as a plain JS string default
// export -- but vite/client.d.ts's ambient `declare module '*.css' {}`
// (which tsconfig.web.json's "include" makes visible here too, since this
// directory shares that tsconfig with the real Vite-built app-shell
// renderer) declares `.css` imports as an EMPTY module with no default
// export, correct for ITS build (real Vite CSS imports are side-effect-only)
// but wrong for this one. A default import from document-typography.css
// therefore fails `pnpm run typecheck:web` ("has no default export") even
// though esbuild's `text` loader handles it fine at build time.
//
// Scoped narrowly to exactly this one file via a wildcard pattern more
// specific than vite/client.d.ts's own `*.css` -- NOT by redeclaring
// `*.css` broadly, which would silently change the type of every OTHER
// `.css` import in the app-shell renderer too (e.g. `import
// './assets/base.css'`, a real side-effect-only Vite import that must stay
// typed as the empty module).
//
// HOW THE AMBIGUITY IS ACTUALLY RESOLVED -- stated precisely, because an
// earlier version of this comment got it wrong in a way that sounded
// authoritative (it claimed TypeScript prefers whichever pattern's matched
// WILDCARD substring is shortest, and that vite/client.d.ts relies on the
// same rule to distinguish `*.module.css` from `*.css`; neither is true).
// The real rule is `findBestPatternMatch` (TypeScript's own source): among
// all ambient module patterns that match, it keeps the one with the longest
// PREFIX -- the fixed text BEFORE the `*` -- and nothing else. The suffix
// after the `*` is not considered at all, and the comparison is a strict
// `>`, so the FIRST match found wins any tie. For the specifier
// '../../src/typography/document-typography.css':
//   - '*.css'                      has prefix '' (length 0)
//   - '*/document-typography.css'  has prefix '' (length 0)
// Both prefixes are empty, so this is a tie, and which declaration wins is
// therefore determined by the order the program happened to discover the
// two .d.ts files -- not by either pattern being "more specific".
// (vite/client.d.ts's own `*.module.css` vs `*.css` pair is the same tie,
// and works only because both live in ONE file with the more specific
// pattern written first.)
//
// Kept anyway, deliberately: it resolves correctly today, and the failure
// mode if discovery order ever flipped is LOUD, not silent -- the default
// import below would resolve against vite's empty `*.css` module and
// `pnpm run typecheck:web` would fail with "has no default export", exactly
// the error this file exists to prevent. Nothing would silently mistype or
// mis-bundle. If that ever happens, the fix is to give this pattern a real
// non-empty prefix (e.g. declare the full relative specifier verbatim
// instead of a wildcard), not to broaden `*.css`.
declare module '*/document-typography.css' {
  const css: string
  export default css
}
