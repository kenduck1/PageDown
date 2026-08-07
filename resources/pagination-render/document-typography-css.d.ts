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
// typed as the empty module). When two ambient module patterns both match
// a given specifier, TypeScript resolves the ambiguity by preferring
// whichever pattern's matched WILDCARD substring is shortest -- equivalently,
// whichever pattern has the longest fixed, non-wildcard portion. For the
// specifier '../../src/typography/document-typography.css':
//   - '*.css'                       matches with wildcard text
//                                    '../../src/typography/document-typography'
//   - '*/document-typography.css'   matches with wildcard text
//                                    '../../src/typography'
// The second pattern's wildcard match is shorter, so it wins -- this is the
// exact same tie-break rule vite/client.d.ts itself relies on to give
// `*.module.css` (CSS Modules) a different type than plain `*.css`.
declare module '*/document-typography.css' {
  const css: string
  export default css
}
