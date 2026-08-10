import { tableCellSchema, tableHeaderSchema } from '@milkdown/preset-gfm'

// FIX for a real, shipped defect (product-completeness audit, Tier 1: "An
// empty GFM table cell serializes as `<br />`"): the "Insert table" toolbar
// button, and every row/column-adding command in commands.ts, has always
// produced `| <br /> | <br /> |` for a genuinely empty cell -- non-portable
// HTML landing in a document whose entire premise is real, portable
// Markdown, before the user has typed anything.
//
// ROOT CAUSE, confirmed by reading the installed package source directly,
// not assumed -- and it is NOT a table-specific bug in @milkdown/preset-gfm
// at all. @milkdown/preset-commonmark's own paragraphSchema.toMarkdown
// (node/paragraph.ts) has a real, useful, otherwise-correct feature:
// serializing a genuinely EMPTY paragraph (zero inline children) as a
// literal `<br />` HTML node instead of nothing, because plain Markdown has
// no other way to represent "the user pressed Enter twice and left a
// deliberately blank paragraph here" -- a bare blank line collapses on its
// own, with nothing surviving a save/reopen round trip to tell the
// ProseMirror doc it should still show two addressable empty lines rather
// than one. The matched read-side plugin (remarkPreserveEmptyLinePlugin,
// bundled unconditionally into the `commonmark` preset's own composed
// `plugins` array -- see plugins.ts, which uses that whole export rather
// than an individually-selected subset) strips the same `<br />` back out on
// the next parse, so the round trip is invisible for real prose. This
// mechanism is worth keeping exactly as upstream ships it; the fix below
// does not touch it.
//
// A GFM table cell always contains EXACTLY one paragraph child
// (`cellContent: 'paragraph'`, tableNodes()'s own content model -- read
// directly from @milkdown/preset-gfm's node/table/schema.ts), so "an empty
// cell" is, structurally, nothing but "a table cell whose one paragraph
// child happens to be empty." table_cell/table_header's own toMarkdown
// runners delegate straight into that paragraph's toMarkdown via a plain
// `.next(node.content)` call with no table-aware branch of their own --
// which walks directly into paragraph's <br />-substitution branch, even
// though GFM table syntax already has a completely unambiguous, native way
// to write an empty cell (`|  |`), with no "will this collapse on reparse"
// risk to protect against in a table row the way there is in the document
// body. The substitution is real and correct for the DOCUMENT BODY; it is
// simply the wrong tool inside a table cell, and paragraph's own toMarkdown
// `match()` has no way to know which context it's being called from --
// Milkdown hands a serializer runner the ProseMirror node itself, not its
// parent chain, so paragraph's schema cannot special-case "inside a table"
// on its own.
//
// FIX, scoped to exactly the two node schemas that need it: table_cell and
// table_header's own toMarkdown runners are overridden via Milkdown's own
// sanctioned $nodeSchema#extendSchema mechanism (@milkdown/utils'
// $node-schema.ts -- built for precisely this "keep everything else about a
// preset node, override one field" case, not a workaround improvised here)
// to skip calling `.next()` entirely when the cell's sole paragraph child is
// itself empty, rather than delegating to paragraph's own runner. That
// leaves the emitted mdast tableCell node's `children` empty, which the GFM
// table serializer already renders correctly as a blank cell (`|  |`), with
// no further changes needed anywhere else. Content model, parseDOM/toDOM,
// attrs, and parseMarkdown are all left completely untouched (spread
// straight from the original spec) -- parsing an already-empty GFM cell back
// in already worked correctly before this fix; only serializing one back OUT
// was broken. A NON-empty cell -- including one containing e.g. only an
// inline image, which has no text but is very much not "empty": losing it
// would be silent data loss -- takes the exact original `.next(node.content)`
// path, byte-for-byte, so this cannot change output for anything the
// original code already serialized correctly. Verified against the real
// serializer, not just the node shape: table-commands.test.ts's own
// `getMarkdown()` assertions cover both the empty-cell case and a
// still-non-empty cell surviving untouched.
//
// Registered AFTER `gfm` in plugins.ts's EDITOR_SCHEMA_PLUGINS. Both this
// and gfm's own tableCellSchema.node/tableHeaderSchema.node share their
// respective node id ('table_cell'/'table_header'), and Milkdown resolves a
// node schema's ctx slice and its Schema-building NodeType by that shared
// id -- so later registration overwrites earlier, which is exactly the
// contract extendSchema's own upstream design assumes. Confirmed empirically
// here, not just by reading extendSchema's doc comment: the "pre-existing
// serializer behaviour" tests this same file's fix touches were failing
// (asserting `<br />`) before this override was wired into
// EDITOR_SCHEMA_PLUGINS, and pass once it is -- proving last-registration-
// wins is real, not merely a documented intention.
//
// A shared helper (rather than one function genericized over both schemas)
// is deliberately NOT used here: $nodeSchema's own extendSchema typing ties
// the return type to the exact node id string literal, and fighting that
// generic for two three-line runners is not worth the line count it would
// save. Both extensions are intentionally near-identical -- that repetition
// mirrors table_cell/table_header being genuinely separate node types
// upstream (schema.ts registers them as two distinct $nodeSchema calls too).

export const tableCellSchemaNoBr = tableCellSchema.extendSchema((prev) => (ctx) => {
  const spec = prev(ctx)
  return {
    ...spec,
    toMarkdown: {
      match: spec.toMarkdown.match,
      runner: (state, node) => {
        state.openNode('tableCell')
        const paragraph = node.content.firstChild
        // Guard, not an assumption: only skip the recursive .next() call
        // when the sole child really is the empty paragraph the content
        // model guarantees is there -- anything else (defensively) falls
        // through to the exact original behaviour.
        if (!paragraph || paragraph.content.size > 0) state.next(node.content)
        state.closeNode()
      }
    }
  }
})

export const tableHeaderSchemaNoBr = tableHeaderSchema.extendSchema((prev) => (ctx) => {
  const spec = prev(ctx)
  return {
    ...spec,
    toMarkdown: {
      match: spec.toMarkdown.match,
      runner: (state, node) => {
        state.openNode('tableCell')
        const paragraph = node.content.firstChild
        if (!paragraph || paragraph.content.size > 0) state.next(node.content)
        state.closeNode()
      }
    }
  }
})
