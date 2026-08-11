// The wire shape for non-blocking, informational notices about a document's
// own Markdown source -- distinct from `documentStore.error` (a load/save
// FAILURE) and from the remote-image consent banner (a yes/no DECISION with
// real security consequences). A DocumentWarning never blocks editing and
// never has a "no" to click, only "OK, I've seen it."
//
// Two producers, both of which already parse the document for an unrelated
// reason -- this module exists so they agree on ONE shape rather than each
// inventing its own:
//   - `pagebreak-plugin.ts`'s `collectPagebreakWarnings`, read off the mdast
//     tree `markdownToHtml` (pipeline.ts) already builds during its own
//     parse pass.
//   - `page-config.ts`'s `resolvePageConfigWithWarnings`, read off the same
//     `js-yaml` parse `extractPageConfig` already performs on a document's
//     frontmatter block.
// See `page-count-generator.ts`'s `getPageCount` for where these two are
// combined into one array and threaded back to the renderer over the
// EXISTING debounced status-bar IPC round trip -- no new parse, no new
// debounce, no new IPC channel.
//
// Deliberately a plain, dependency-free type module (no unified/remark/
// js-yaml imports of its own), matching `local-image-src.ts`'s and
// `src/menu/commands.ts`'s own precedent for a shape shared across the
// main/preload/renderer boundary: `src/preload/index.d.ts` imports this type
// directly rather than re-declaring it locally, the same exception that
// file's own header comment already carves out for `MenuCommand`/
// `WindowUiState` (a dependency-free contract module, not something living
// under `src/main/**` that would drag Electron's own types along with it).
export type DocumentWarningId =
  | 'malformed-frontmatter'
  | 'inline-pagebreak-marker'
  | 'alternate-pagebreak-syntax'
  // `toc-plugin.ts`'s `collectTocWarnings`, read off the same mdast tree as
  // the pagebreak warnings above. Exists because an empty table of contents
  // is the one TOC outcome that is invisible on screen: the marker renders as
  // literally nothing, so without this the user cannot tell "recognized, but
  // your headings are deeper than depth=3" from "not recognized at all".
  | 'empty-toc'

export interface DocumentWarning {
  id: DocumentWarningId
  // Pre-formatted, ready to display verbatim -- aggregated (a document with
  // 30 inline markers produces ONE warning with a count baked into its own
  // message, not 30 entries) at the point of generation, per the "don't be
  // noisy" requirement this feature shipped under. Producers own their own
  // wording so a consumer never has to know the difference between, say,
  // singular and plural phrasing for a count of 1 vs N.
  message: string
}
