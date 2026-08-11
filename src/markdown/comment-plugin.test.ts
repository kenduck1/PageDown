import { describe, it, expect } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'
import { encodeCommentMeta, decodeCommentMeta, remarkComment } from './comment-plugin'
import type { CommentMeta } from './comment-plugin'

// A comment BODY can be multi-line -- that is the whole reason the payload is
// base64 of a JSON object rather than literal text inside the HTML comment
// (see comment-plugin.ts's own header). These tests pin that property
// directly, because the composer's new textarea is only safe if it holds.
//
// This is a DIFFERENT question from the design's single-block scope boundary,
// which is about which text a comment MARK may span and is unchanged.
describe('encodeCommentMeta / decodeCommentMeta with multi-line bodies', () => {
  const CREATED = '2026-08-11T09:00:00.000Z'

  function roundTrip(meta: CommentMeta): CommentMeta | null {
    return decodeCommentMeta(encodeCommentMeta(meta))
  }

  it('round-trips a body containing single newlines', () => {
    const meta = { author: 'Kai', text: 'line one\nline two', createdAt: CREATED }
    expect(roundTrip(meta)).toEqual(meta)
  })

  it('round-trips a body containing real blank-line-separated paragraphs', () => {
    const meta = {
      author: 'Kai',
      text: 'First paragraph.\n\nSecond paragraph, after a blank line.',
      createdAt: CREATED
    }
    expect(roundTrip(meta)).toEqual(meta)
  })

  it('round-trips CRLF and a trailing newline byte-exactly', () => {
    // Nothing normalises line endings anywhere along this path, so a body
    // pasted from a Windows source has to survive as-is rather than silently
    // becoming something else on reload.
    const meta = { author: 'Kai', text: 'a\r\nb\n', createdAt: CREATED }
    expect(roundTrip(meta)).toEqual(meta)
  })

  it('round-trips a multi-line body that also contains HTML-comment syntax', () => {
    // The exact hazard the base64 encoding exists to remove: `--` and `-->` in
    // free text would terminate or corrupt a literal HTML comment. Worth
    // pinning alongside the newline cases, because multi-line bodies make
    // "the user pasted something structured" far more likely.
    const meta = {
      author: 'Kai',
      text: 'see --> here\nand -- there\n<!--nested-->',
      createdAt: CREATED
    }
    expect(roundTrip(meta)).toEqual(meta)
  })

  it('emits a payload that is safe to embed in a one-line HTML comment', () => {
    const encoded = encodeCommentMeta({
      author: 'Kai',
      text: 'line one\nline two\n\nline four',
      createdAt: CREATED
    })

    // The properties the marker's own one-line regexes (START_MARKER_RE /
    // MARKER_SPLIT_RE) depend on: base64's alphabet contains none of HTML
    // comment syntax's meaningful characters, and no newline, so a multi-line
    // BODY still produces a single-line MARKER.
    expect(encoded).toMatch(/^[A-Za-z0-9+/=]+$/)
    expect(encoded).not.toContain('\n')
    expect(encoded).not.toContain('--')
    expect(encoded).not.toContain('>')
  })

  it('round-trips non-ASCII alongside the newlines', () => {
    const meta = { author: 'Kai', text: 'café ☕\nsecond ligne — ok', createdAt: CREATED }
    expect(roundTrip(meta)).toEqual(meta)
  })
})

// The save/reload half: a marker pair whose payload carries a multi-line body
// must parse back into a `comment` node with those newlines intact. Uses the
// real remarkComment transform against real remark-parse output, not a
// hand-built tree.
describe('remarkComment with a multi-line body', () => {
  it('parses the newlines back out of a real markdown document', () => {
    const meta = {
      author: 'Kai',
      text: 'First paragraph.\n\nSecond paragraph.',
      createdAt: '2026-08-11T09:00:00.000Z'
    }
    const source = `Before. <!--comment id="c1" data="${encodeCommentMeta(meta)}"-->marked<!--/comment id="c1"--> after.\n`

    const tree = unified()
      .use(remarkParse)
      .use(remarkComment)
      .use(remarkStringify)
      .runSync(unified().use(remarkParse).parse(source))

    const found: { text: string }[] = []
    const walk = (node: { type: string; children?: unknown[] }): void => {
      if (node.type === 'comment') found.push(node as unknown as { text: string })
      for (const child of (node.children ?? []) as { type: string; children?: unknown[] }[]) {
        walk(child)
      }
    }
    walk(tree as unknown as { type: string; children?: unknown[] })

    expect(found).toHaveLength(1)
    expect(found[0].text).toBe('First paragraph.\n\nSecond paragraph.')
  })
})
