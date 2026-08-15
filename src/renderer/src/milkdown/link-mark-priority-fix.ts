import { linkSchema } from '@milkdown/preset-commonmark'
import { linkReferenceSchema } from './nodes/reference'

// FIX for a real, measured round-trip fidelity defect found while building
// reference-link support, and confirmed to be PRE-EXISTING for ordinary
// inline links too (i.e. not introduced by that work): a link whose text
// contains a nested mark over only PART of it was split into two links.
//
//   `See the [_emphatic_ source](https://example.com) here.`
//     -> `See the _[emphatic](https://example.com)_ [source](https://example.com) here.`
//
// Plain remark-stringify round-trips that source byte-identically -- verified
// directly -- so this is Milkdown's serializer, not remark's.
//
// ROOT CAUSE, read out of @milkdown/transformer@7.21.3's SerializerState.
// `#orderMarks` decides which of a node's marks opens outermost: marks
// already open continue first, and the remainder are sorted by
// `mark.type.spec.priority ?? 50`. Every commonmark/gfm mark except
// `inlineCode` (100) leaves that field unset, so they all tie at 50 and the
// tie is broken by ProseMirror's own mark rank -- which is schema
// DECLARATION ORDER, and `linkSchema` is declared after `emphasisSchema` and
// `strongSchema` (composed/schema.ts). So on the first text node of
// `[_emphatic_ source]`, where neither mark is open yet, emphasis wins the
// tie and opens outside the link. The link then cannot span the following
// unemphasized " source" text without reopening, and one link becomes two.
//
// FIX: give both link marks a priority BELOW the 50 default so a newly
// opened link always nests outside a newly opened emphasis/strong. This
// cannot invert the other direction (`_text with a [link](url) inside_`),
// because `#orderMarks` puts already-CONTINUING marks ahead of priority --
// the emphasis is open before the link starts, so it stays outermost. Both
// directions are pinned by tests.
//
// MEASURED, not assumed: over the same 400 third-party README.md files under
// node_modules/.pnpm used for this sub-project's other before/after numbers,
// this moves structural round-trip fidelity from 344/400 (86.0%) to 363/400
// (90.8%) with byte-exact fidelity unchanged-to-better (118 -> 119), and
// moves nothing at all across tests/gates/corpus + this app's templates (13/21
// byte, 20/21 structural either way). There IS a real trade in the other
// direction and it is worth naming: for a link whose text is EXACTLY
// coextensive with an emphasis (`**[bold link](url)**`), the two orderings
// are both valid CommonMark and this fix flips which one is emitted
// (`[**bold link**](url)`). That case is byte-visible but semantically
// identical; the case it fixes is a genuine structural change to the
// document tree. The measurement above is the whole justification for taking
// that trade rather than an argument from taste.
//
// Applied via Milkdown's own $markSchema#extendSchema, registered after the
// presets -- the same last-registration-wins override contract
// table-cell-empty-fix.ts documents. `priority` is read ONLY by
// SerializerState#orderMarks (grepped across @milkdown/transformer), so this
// changes serialization order and nothing else: not parsing, not the schema's
// mark rank, not rendering.
const LINK_MARK_PRIORITY = 10

export const linkSchemaOuter = linkSchema.extendSchema((prev) => (ctx) => ({
  ...prev(ctx),
  priority: LINK_MARK_PRIORITY
}))

export const linkReferenceSchemaOuter = linkReferenceSchema.extendSchema((prev) => (ctx) => ({
  ...prev(ctx),
  priority: LINK_MARK_PRIORITY
}))
