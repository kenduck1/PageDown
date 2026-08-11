import type { MilkdownPlugin } from '@milkdown/ctx'
import { commonmark, remarkInlineLinkPlugin } from '@milkdown/preset-commonmark'
import { gfm } from '@milkdown/preset-gfm'
import { frontmatterRemark, frontmatterNode } from './nodes/frontmatter'
import { pagebreakRemark, pagebreakRemarkToMarkdown, pagebreakNode } from './nodes/pagebreak'
import { commentRemark, commentRemarkToMarkdown, commentSchema } from './nodes/comment'
import { tocRemark, tocRemarkToMarkdown, tocNode } from './nodes/toc'
import { linkReferenceSchema, imageReferenceNode, definitionNode } from './nodes/reference'
import { tableCellSchemaNoBr, tableHeaderSchemaNoBr } from './table-cell-empty-fix'
import {
  bulletListSchemaSpread,
  orderedListSchemaSpread,
  listItemSchemaSpread
} from './list-spread-fix'
import { linkSchemaOuter, linkReferenceSchemaOuter } from './link-mark-priority-fix'

// @milkdown/preset-commonmark's composed `plugins` array unconditionally
// registers remarkInlineLinkPlugin (a wrapper around `remark-inline-links`),
// which rewrites every linkReference/imageReference into a plain inline
// link/image and DELETES the definition nodes -- inside `remark.runSync(...)`
// during ParserState.run, before the schema is consulted at all. That is the
// whole reason reference-style links round-tripped destructively; see
// nodes/reference.ts's header for the full writeup and for why the schema
// half alone cannot fix it.
//
// Removing it by FILTERING the composed array is deliberate, over the two
// alternatives that were considered:
//
//   - `Editor#remove(remarkInlineLinkPlugin.plugin)` is async, warns loudly
//     when called during creation, and is documented for teardown -- it
//     would have to race the very `create()` call it is meant to precede.
//   - Filtering `remarkPluginsCtx` after InitReady (what $remark's own
//     cleanup does) needs to identify the entry by the raw `remark-inline-
//     links` function, which is a transitive dependency this package cannot
//     import under pnpm's strict layout, or by the identity of its options
//     object -- fragile either way.
//
// `Editor#use` keys its plugin store by plugin-function identity, so passing
// a filtered array is exactly equivalent to never having asked for that
// plugin. Only `.plugin` is dropped, not the paired `.options` $Ctx slice:
// the slice is inert on its own (it only injects a value nothing reads once
// the plugin is gone), and removing it too would be a strictly larger change
// with no behavioural difference.
const COMMONMARK_WITHOUT_INLINE_LINKS: MilkdownPlugin[] = commonmark.filter(
  (plugin) => plugin !== remarkInlineLinkPlugin.plugin
)

// The full custom schema/plugin set the real editor mounts (MilkdownEditor.tsx)
// -- shared with round-trip.test.ts so "the tested composition" and "the
// shipped composition" cannot silently drift apart. listener and the
// editedTrackerProse plugin are deliberately NOT included here: they exist
// for change-notification/Save-race purposes, not document schema, and have
// no bearing on parse/serialize round-trip fidelity, which is all this list
// is for.
export const EDITOR_SCHEMA_PLUGINS = [
  COMMONMARK_WITHOUT_INLINE_LINKS,
  gfm,
  frontmatterRemark,
  frontmatterNode,
  pagebreakRemark,
  pagebreakRemarkToMarkdown,
  pagebreakNode,
  commentRemark,
  commentRemarkToMarkdown,
  commentSchema,
  // Schema only. The live-rendering node view (tocViewProse) is deliberately
  // NOT here, matching safeImageViewProse's placement in EDITOR_COMMAND_PLUGINS
  // -- it is rendering behaviour, not document schema, and this list's whole
  // job is to be exactly what round-trip fidelity depends on.
  tocRemark,
  tocRemarkToMarkdown,
  tocNode,
  // Reference-style links: required, not optional, once
  // remarkInlineLinkPlugin is gone -- ParserState.#matchTarget THROWS on an
  // mdast node type no schema claims. See nodes/reference.ts.
  linkReferenceSchema,
  imageReferenceNode,
  definitionNode,
  // Must come AFTER gfm -- see table-cell-empty-fix.ts's own header comment
  // for why later registration under the same node id ('table_cell'/
  // 'table_header') is what makes this an override rather than a duplicate.
  tableCellSchemaNoBr,
  tableHeaderSchemaNoBr,
  // Same last-registration-wins override contract, for the three list node
  // ids ('bullet_list'/'ordered_list'/'list_item') -- must come after
  // COMMONMARK_WITHOUT_INLINE_LINKS, which is where the originals live.
  bulletListSchemaSpread,
  orderedListSchemaSpread,
  listItemSchemaSpread,
  // Same contract again, for the 'link' mark and the 'linkReference' mark
  // declared above -- must come after BOTH. See link-mark-priority-fix.ts.
  linkSchemaOuter,
  linkReferenceSchemaOuter
]
