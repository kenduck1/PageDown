import { describe, it, expect } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'
import {
  encodeCommentMeta,
  decodeCommentMeta,
  remarkComment,
  remarkCommentToMarkdown
} from './comment-plugin'
import type { CommentMeta } from './comment-plugin'
import type { Root } from 'mdast'

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

// The mdast half of the hand-wrapped-paragraph fix. Deliberately asserts on
// the parsed NODE STRUCTURE as well as on the emitted bytes: CLAUDE.md
// records that Milkdown round-tripped the pagebreak marker perfectly as
// inert TEXT with zero custom plugins, so byte-level agreement alone proves
// nothing about whether a real `comment` node exists.
describe('remarkComment across a line break inside one paragraph', () => {
  const META = { author: 'Kai', text: 'a note', createdAt: '2026-08-11T09:00:00.000Z' }
  const DATA = encodeCommentMeta(META)
  const START = `<!--comment id="c1" data="${DATA}"-->`
  const END = '<!--/comment id="c1"-->'

  function parse(source: string): Root {
    const processor = unified().use(remarkParse).use(remarkComment)
    return processor.runSync(processor.parse(source)) as Root
  }

  function shape(node: { type: string; children?: unknown[] }): unknown {
    const children = (node.children ?? []) as { type: string; children?: unknown[] }[]
    if (children.length === 0) return node.type
    return { [node.type]: children.map(shape) }
  }

  it('reunites a comment CommonMark split across the HTML-block boundary', () => {
    // The start marker begins the line (the comment covers the paragraph from
    // its first character), so CommonMark's HTML block type 2 swallows line 1
    // and orphans line 2 -- the whole reason the recovery exists.
    const tree = parse(`Intro.\n\n${START}first line\nsecond line tail.${END}\n`)

    expect(tree.children).toHaveLength(2)
    expect(shape(tree.children[1] as never)).toEqual({
      paragraph: [{ comment: ['text', 'text', 'text'] }]
    })
  })

  it('restores a HARD break as a real break node, never a stray backslash', () => {
    const tree = parse(`Intro.\n\n${START}first line\\\nsecond line tail.${END}\n`)

    expect(shape(tree.children[1] as never)).toEqual({
      paragraph: [{ comment: ['text', 'break', 'text'] }]
    })
  })

  it('keeps an escaped trailing backslash as content rather than eating it', () => {
    // `\\` at end of line is an ESCAPED literal backslash plus a soft break,
    // not a hard break -- which is why the recovery counts trailing
    // backslashes for PARITY instead of testing for presence.
    const tree = parse(`Intro.\n\n${START}first line\\\\\nsecond line tail.${END}\n`)

    expect(shape(tree.children[1] as never)).toEqual({
      paragraph: [{ comment: ['text', 'text', 'text'] }]
    })
  })

  it('absorbs the continuation even when both markers matched on line 1', () => {
    // Commenting only the FIRST WORDS of a hand-wrapped paragraph: the pair
    // matches inside the html block, but the paragraph would still be split
    // in two without absorption.
    const tree = parse(`Intro.\n\n${START}first${END} line\nsecond line tail.\n`)

    // Three trailing text nodes rather than one: the piece unmerged out of
    // the html block, the re-inserted soft break, and the absorbed
    // continuation. mdast does not merge adjacent text nodes, and neither
    // rendering nor serialization needs it to.
    expect(tree.children).toHaveLength(2)
    expect(shape(tree.children[1] as never)).toEqual({
      paragraph: [{ comment: ['text'] }, 'text', 'text', 'text']
    })
  })

  it('does NOT absorb a genuinely separate block across a blank line', () => {
    const tree = parse(`Intro.\n\n${START}marked${END}\n\nA separate paragraph.\n`)

    expect(tree.children).toHaveLength(3)
    expect(shape(tree.children[2] as never)).toEqual({ paragraph: ['text'] })
  })

  it('leaves a hand-authored html block followed by a paragraph alone', () => {
    // The anchor is only ever a paragraph genuinely un-collapsed by
    // unmergeHtmlNode, so an ordinary html comment never starts an
    // absorption -- the narrowness this whole recovery depends on.
    const tree = parse('Intro.\n\n<!-- just a note -->\nA following paragraph.\n')

    expect(tree.children.map((child) => child.type)).toEqual(['paragraph', 'html', 'paragraph'])
  })

  it('serializes a split same-id run as exactly ONE marker pair', () => {
    // The exact mdast shape Milkdown's SerializerState produces once
    // preset-commonmark's hardbreakClearMarkPlugin has stripped the mark off
    // the hardbreak: two `comment` nodes, one id, a `break` between them.
    const fragment = (): unknown => ({
      type: 'comment',
      id: 'c1',
      ...META,
      children: [{ type: 'text', value: 'x' }]
    })
    const tree = {
      type: 'root',
      children: [{ type: 'paragraph', children: [fragment(), { type: 'break' }, fragment()] }]
    }

    const out = unified()
      .use(remarkCommentToMarkdown)
      .use(remarkStringify)
      .stringify(tree as never)

    expect((out.match(/<!--comment id=/g) ?? []).length).toBe(1)
    expect((out.match(/<!--\/comment id=/g) ?? []).length).toBe(1)
    // ...and the break still separates the two fragments inside the pair.
    expect(out).toContain('x\\\nx')
  })

  it('still emits a pair each for two genuinely DIFFERENT comments', () => {
    const fragment = (id: string): unknown => ({
      type: 'comment',
      id,
      ...META,
      children: [{ type: 'text', value: 'x' }]
    })
    const tree = {
      type: 'root',
      children: [
        { type: 'paragraph', children: [fragment('c1'), { type: 'break' }, fragment('c2')] }
      ]
    }

    const out = unified()
      .use(remarkCommentToMarkdown)
      .use(remarkStringify)
      .stringify(tree as never)

    expect((out.match(/<!--comment id=/g) ?? []).length).toBe(2)
    expect((out.match(/<!--\/comment id=/g) ?? []).length).toBe(2)
  })
})
