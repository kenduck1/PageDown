import type { Handler } from 'mdast-util-to-hast'

// Comments are pure authoring-time metadata -- never print content, per the
// design doc (docs/superpowers/specs/2026-08-09-comments-design.md). Unlike
// Mermaid/Math (which render something real in the sandboxed context and
// therefore need an inert PLACEHOLDER element there to find and replace),
// a comment has nothing to render on the pagination-preview/PDF-export
// surface at all -- so this handler is a pure PASSTHROUGH: it returns the
// node's own children converted to hast, with no wrapping element, no
// class, no data attribute. The marked text renders completely normally,
// structurally indistinguishable from unmarked text. This needs no sanitize
// schema exception (nothing new survives to need one) and no CSS (nothing
// to hide) -- the simplest possible correct answer to "never appears in
// print," simpler even than Mermaid/Math's own sandboxed-rendering split
// because there is nothing to render on this surface at all.
export function createCommentToHast(): Handler {
  return (state, node) => {
    return state.all(node)
  }
}
