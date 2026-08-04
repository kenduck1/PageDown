import { commonmark } from '@milkdown/preset-commonmark'
import { gfm } from '@milkdown/preset-gfm'
import { frontmatterRemark, frontmatterNode } from './nodes/frontmatter'
import { pagebreakRemark, pagebreakRemarkToMarkdown, pagebreakNode } from './nodes/pagebreak'

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
  pagebreakNode
]
