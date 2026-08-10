import { commonmark } from '@milkdown/preset-commonmark'
import { gfm } from '@milkdown/preset-gfm'
import { frontmatterRemark, frontmatterNode } from './nodes/frontmatter'
import { pagebreakRemark, pagebreakRemarkToMarkdown, pagebreakNode } from './nodes/pagebreak'
import { commentRemark, commentRemarkToMarkdown, commentSchema } from './nodes/comment'
import { tableCellSchemaNoBr, tableHeaderSchemaNoBr } from './table-cell-empty-fix'

// The full custom schema/plugin set the real editor mounts (MilkdownEditor.tsx)
// -- shared with round-trip.test.ts so "the tested composition" and "the
// shipped composition" cannot silently drift apart. listener and the
// editedTrackerProse plugin are deliberately NOT included here: they exist
// for change-notification/Save-race purposes, not document schema, and have
// no bearing on parse/serialize round-trip fidelity, which is all this list
// is for.
export const EDITOR_SCHEMA_PLUGINS = [
  commonmark,
  gfm,
  frontmatterRemark,
  frontmatterNode,
  pagebreakRemark,
  pagebreakRemarkToMarkdown,
  pagebreakNode,
  commentRemark,
  commentRemarkToMarkdown,
  commentSchema,
  // Must come AFTER gfm -- see table-cell-empty-fix.ts's own header comment
  // for why later registration under the same node id ('table_cell'/
  // 'table_header') is what makes this an override rather than a duplicate.
  tableCellSchemaNoBr,
  tableHeaderSchemaNoBr
]
