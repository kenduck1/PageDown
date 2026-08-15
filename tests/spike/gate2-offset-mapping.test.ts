import { describe, it, expect } from 'vitest'
import { editorViewCtx } from '@milkdown/core'
import { createMilkdownEditor } from './milkdown-fixture'

describe('Gate 2: source-offset <-> ProseMirror-position mapping', () => {
  it('maps a source offset to a PM position and back consistently at initial parse', async () => {
    const source = '# Heading\n\nA paragraph with some text to locate.\n'
    const editor = await createMilkdownEditor(source)
    const view = editor.ctx.get(editorViewCtx)

    // "text to locate" starts at this character offset in `source`:
    const targetOffset = source.indexOf('text to locate')
    expect(targetOffset).toBeGreaterThan(-1)

    // Build the simplest possible offset<->position table: walk the PM doc's
    // text nodes, tracking a running source-offset cursor alongside each
    // node's PM position range. This is intentionally minimal -- proving the
    // *concept* works, not building the production mapping (that belongs in
    // the real editor build, informed by this gate's findings).
    let sourceCursor = 0
    let foundPos = -1
    view.state.doc.descendants((node, pos) => {
      if (foundPos !== -1) return false
      if (node.isText && node.text) {
        const idxInNode = node.text.indexOf('text to locate')
        if (idxInNode !== -1 && sourceCursor <= targetOffset) {
          foundPos = pos + idxInNode
          return false
        }
        sourceCursor += node.text.length
      }
      return true
    })

    expect(foundPos).toBeGreaterThan(-1)
    const resolvedText = view.state.doc.textBetween(foundPos, foundPos + 'text to locate'.length)
    expect(resolvedText).toBe('text to locate')
  })

  // NOTE on a correction from the brief's starting-point code for this test:
  //
  // The brief computed `beforePos` as `doc.textContent.indexOf('Original') + 2`
  // and inserted at raw position `0`. Hands-on testing (a throwaway diagnostic,
  // not committed) showed this does NOT exercise the scenario the brief
  // describes ("a position captured inside a word, before an edit"):
  //
  //   - `doc.textContent` is a flattened string with no node-boundary tokens,
  //     so indexing into it and treating the result as a PM position is only
  //     valid within a single textblock. Here it lands on PM position 9, which
  //     `doc.resolve(9)` reports as having `parent.type.name === 'doc'` (i.e.
  //     it's the *boundary between* the heading and paragraph nodes, not a
  //     position inside "Original" at all).
  //   - `tr.insertText('PREFIX ', 0)` at position 0 is also not a valid
  //     in-textblock position (text cannot be a direct child of `doc`), so
  //     ProseMirror's replace-fitting logic silently auto-wraps the inserted
  //     text in a brand new top-level paragraph and inserts *that node*
  //     before the heading, rather than inserting text inline anywhere.
  //     `tr.mapping.map(beforePos)` then shifts forward by 9 -- which is the
  //     new paragraph's `nodeSize` (2 boundary tokens + 7 chars), not by
  //     `'PREFIX '.length` (also coincidentally 7, differing by the 2
  //     boundary tokens). The brief's assertions (`not.toBe`, `toBeGreaterThan`)
  //     are loose enough to pass regardless, but they don't actually confirm
  //     "insert text before a found position; that position shifts forward by
  //     the inserted text's length" -- they confirm a different, structurally
  //     bigger edit (a whole extra node) also shifts positions forward, which
  //     is a much weaker claim.
  //
  // This rewritten version finds a real in-textblock position via the same
  // offset-walk technique as the test above, inserts text at a position
  // confirmed (by assertion) to resolve inside the paragraph, and checks the
  // mapped position shifts by exactly the inserted text's length and still
  // resolves to the correct word afterward.
  it('keeps a previously-found position meaningful after an edit, via PM Mapping', async () => {
    const source = '# Heading\n\nOriginal text here.\n'
    const editor = await createMilkdownEditor(source)
    const view = editor.ctx.get(editorViewCtx)

    // Find the real PM position of "text" inside "Original text here." using
    // the same descendants-walk technique as the test above.
    let textPos = -1
    view.state.doc.descendants((node, pos) => {
      if (textPos !== -1) return false
      if (node.isText && node.text) {
        const idx = node.text.indexOf('text')
        if (idx !== -1) {
          textPos = pos + idx
          return false
        }
      }
      return true
    })
    expect(textPos).toBeGreaterThan(-1)
    expect(view.state.doc.textBetween(textPos, textPos + 4)).toBe('text')

    // Find the paragraph's own content-start position by walking to the
    // paragraph node itself (pos is the position right before the paragraph
    // opens, so pos + 1 is the first valid position *inside* its content).
    let paragraphContentStart = -1
    view.state.doc.descendants((node, pos) => {
      if (paragraphContentStart !== -1) return false
      if (node.type.name === 'paragraph') {
        paragraphContentStart = pos + 1
        return false
      }
      return true
    })
    expect(paragraphContentStart).toBeGreaterThan(-1)
    // Confirm this is genuinely an in-textblock position before relying on it
    // (this is exactly the check that would have caught the brief's position-0
    // issue above).
    expect(view.state.doc.resolve(paragraphContentStart).parent.type.name).toBe('paragraph')

    const insertedText = 'PREFIX '
    const tr = view.state.tr.insertText(insertedText, paragraphContentStart)
    view.dispatch(tr)

    // Per the design doc (line ~67): a position captured before an edit must be
    // mapped forward through the transaction's Mapping, not reused raw.
    const mappedPos = tr.mapping.map(textPos)
    expect(mappedPos).toBe(textPos + insertedText.length)

    // And the mapped position should still resolve to the same word in the
    // *new* document -- proving the mapping is not just numerically shifted
    // but semantically still correct.
    expect(view.state.doc.textBetween(mappedPos, mappedPos + 4)).toBe('text')
  })
})
