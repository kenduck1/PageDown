import type { Node as ProseNode } from '@milkdown/prose/model'
import { bulletListSchema, orderedListSchema } from '@milkdown/preset-commonmark'
import { extendListItemSchemaForTask } from '@milkdown/preset-gfm'

// FIX for a real, measured round-trip fidelity defect: a TIGHT list
// (`- a\n- b\n- c`, no blank lines) came back LOOSE (a blank line between
// every item) after a Format-mode edit. It is why two of this app's own
// shipped templates (meeting-notes.md.ts, newsletter.md.ts) carried a
// "deliberately not byte-canonical" header comment, and it is one of the only
// two structural causes behind the 2026-08-09 gap audit's measured round-trip
// divergence for real PageDown-shaped documents.
//
// ROOT CAUSE, read out of the installed @milkdown/preset-commonmark@7.21.3
// source rather than inferred from the symptom -- and it is NOT "ProseMirror
// has no equivalent of mdast's `spread`", the obvious hypothesis. All three
// list node schemas ALREADY declare a real `spread` attr
// (bulletListSchema/orderedListSchema/listItemSchema, each
// `{ default: ..., validate: 'boolean' }`). The information is captured on
// parse and lost on serialize, to a plain string-vs-boolean type confusion:
//
//   - Every one of the three `parseMarkdown` runners STRINGIFIES the mdast
//     boolean before storing it as an attr -- literally
//     `const spread = node.spread != null ? `${node.spread}` : 'false'`.
//     So a tight list's attr is the STRING 'false', which is truthy.
//   - `bulletListSchema`/`listItemSchema`'s `toMarkdown` runners then pass
//     that attr straight back out (`spread: node.attrs.spread`), so the
//     emitted mdast node carries `spread: 'false'` -- a string.
//   - `mdast-util-to-markdown`'s own join rule (lib/join.js) gates entirely
//     on `'spread' in parent && typeof parent.spread === 'boolean'`. A string
//     fails that `typeof` check, so the rule returns `undefined`, the
//     serializer falls back to its default of one blank line between flow
//     children, and every list comes out loose regardless of what it was.
//
// The `validate: 'boolean'` declaration does not catch this: ProseMirror only
// runs attribute validators from `checkAttrs` (Node#check / a JSON round
// trip), never from `NodeType.create`/`createAndFill`, which is the path
// ParserState.addNode/openNode take (confirmed by reading prosemirror-model's
// own `computeAttrs` vs `checkAttrs`). So the string sails through silently.
//
// There is a SECOND, independent representation in play, which is why the fix
// below normalizes rather than just re-reading the attr: the `parseDOM`
// getAttrs for these nodes produce a real BOOLEAN
// (`dom.dataset.spread === 'true'`). So `attrs.spread` is legitimately a
// string when the node came from Markdown and a boolean when it came from the
// DOM (a copy/paste inside the editor, or `data-spread` round-tripping
// through toDOM). Upstream is internally inconsistent about which it expects,
// in BOTH directions -- `orderedListSchema.toMarkdown` and
// `extendListItemSchemaForTask`'s task branch compare
// `node.attrs.spread === 'true'` (correct for the Markdown-parsed string,
// silently wrong for the DOM-parsed boolean, so pasting a LOOSE ordered list
// made it tight), while `bulletListSchema` and the plain list-item branch
// pass the value straight through (correct for a boolean, silently wrong for
// the string). One normalization covers all four.
//
// MECHANISM: Milkdown's own sanctioned $nodeSchema#extendSchema, the same
// last-registration-wins override contract table-cell-empty-fix.ts already
// documents at length. Each override calls the PREVIOUS runner rather than
// reimplementing it, handing it a node whose `spread` attr has been rewritten
// into whichever representation that particular runner expects. Rewriting the
// runners outright was tried first and rejected: the list-item runner has two
// branches (plain and GFM task) emitting DIFFERENT prop sets
// (`{spread}` vs `{label, listType, spread, checked}`), so a rewrite would
// have to duplicate upstream's own prop plumbing and would silently drop any
// prop a future @milkdown/preset-* release adds. Delegating keeps this fix to
// exactly the one field it is about.
//
// LOAD-BEARING DETAIL, found by a real test failure rather than by reading:
// the list-item override chains off `extendListItemSchemaForTask`
// (@milkdown/preset-gfm), NOT off `listItemSchema` (@milkdown/preset-
// commonmark). Both plugins share the node id 'list_item', and gfm's is
// itself an `extendSchema` of commonmark's that adds the `checked` attr and
// the task-list parse/serialize branches. Extending the commonmark original
// and registering it after gfm silently REPLACED gfm's version, and every
// `- [ ] task` in the document serialized back as a plain `- task` -- real,
// silent data loss (it destroyed the checkbox state in this app's own
// meeting-notes template). Chaining off the gfm version keeps both.
function toSpreadBoolean(value: unknown): boolean {
  // A string 'true'/'false' (Markdown-parsed) and a real boolean (DOM-parsed)
  // are both real, reachable representations -- see the header. Anything else
  // (undefined from a hand-built node, a stray null) falls to `false`, i.e.
  // tight, which is both CommonMark's own default reading for a list with no
  // blank lines and the safer failure direction: a wrongly-tight list is a
  // one-line visual difference, a wrongly-loose one inserts blank lines
  // through the whole document.
  return value === true || value === 'true'
}

// A copy of `node` with `spread` replaced. A genuine ProseMirror node rather
// than a structural stand-in because the runners we delegate to also read
// `node.content` / `node.attrs.order` / `node.attrs.checked`, and
// `NodeType.create` with the node's existing Fragment is the cheapest way to
// hand them something wholly valid.
function withSpread(node: ProseNode, spread: boolean | string): ProseNode {
  return node.type.create({ ...node.attrs, spread }, node.content, node.marks)
}

export const bulletListSchemaSpread = bulletListSchema.extendSchema((prev) => (ctx) => {
  const spec = prev(ctx)
  return {
    ...spec,
    toMarkdown: {
      match: spec.toMarkdown.match,
      // Upstream emits `spread: node.attrs.spread` verbatim, so it wants a
      // real boolean.
      runner: (state, node) =>
        spec.toMarkdown.runner(state, withSpread(node, toSpreadBoolean(node.attrs.spread)))
    }
  }
})

export const orderedListSchemaSpread = orderedListSchema.extendSchema((prev) => (ctx) => {
  const spec = prev(ctx)
  return {
    ...spec,
    toMarkdown: {
      match: spec.toMarkdown.match,
      // Upstream emits `spread: node.attrs.spread === 'true'`, so it wants
      // the STRING form -- the opposite of bullet_list above. That asymmetry
      // is upstream's, not this file's.
      runner: (state, node) =>
        spec.toMarkdown.runner(state, withSpread(node, String(toSpreadBoolean(node.attrs.spread))))
    }
  }
})

export const listItemSchemaSpread = extendListItemSchemaForTask.extendSchema((prev) => (ctx) => {
  const spec = prev(ctx)
  return {
    ...spec,
    toMarkdown: {
      match: spec.toMarkdown.match,
      runner: (state, node) => {
        // gfm's own runner branches on exactly this test, and its two
        // branches want different representations: the task branch compares
        // `=== 'true'`, the plain branch (commonmark's) passes through. This
        // one condition is the whole duplication of upstream logic here, and
        // both branches are pinned by tests in round-trip.test.ts.
        const isTask = node.attrs.checked != null
        const spread = toSpreadBoolean(node.attrs.spread)
        spec.toMarkdown.runner(state, withSpread(node, isTask ? String(spread) : spread))
      }
    }
  }
})
