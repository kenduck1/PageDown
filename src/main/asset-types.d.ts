// electron-vite's own bundled ambient types (`electron-vite/node`, referenced
// by tsconfig.node.json) declare `*?asset` (a build-time-resolved file PATH
// -- src/main/index.ts's Dock icon, and this file's own three .woff2 font
// imports) but do NOT declare `*?raw` (a build-time-resolved file STRING) --
// confirmed by reading node_modules/electron-vite/node.d.ts directly, not
// assumed. html-exporter.ts needs `?raw` specifically for
// document-typography.css: `?asset` does NOT work for a `.css`-extensioned
// import in this build (a real, `pnpm build`-caught failure, not a
// hypothetical -- Vite's own core CSS plugin intercepts any `.css` import
// ahead of the generic asset-URL plugin regardless of query string, and in
// this SSR/Node-targeted build that leaves no real `default` export for
// Rollup to bind the import to). This declaration is scoped to exactly the
// one case actually in use (`*.css?raw`), not a blanket `*?raw`, so it can't
// silently mask some OTHER extension's `?raw` import resolving to something
// unexpected in this Node-targeted build.
declare module '*.css?raw' {
  const css: string
  export default css
}
