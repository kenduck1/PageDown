import { describe, it, expect } from 'vitest'
import { extractComments } from './extractComments'
import { encodeCommentMeta } from '../../../markdown/comment-plugin'

function marker(id: string, meta: { author: string; text: string; createdAt: string }): string {
  return `<!--comment id="${id}" data="${encodeCommentMeta(meta)}"-->`
}

describe('extractComments', () => {
  it('returns an empty array for a document with no comments', () => {
    expect(extractComments('Just a paragraph.\n\nAnother one.')).toEqual([])
  })

  it('extracts a single comment with its author/text/createdAt and matched span', () => {
    const meta = { author: 'Kai', text: 'needs revision', createdAt: '2026-08-09T06:00:00Z' }
    const source = `Before. ${marker('c1', meta)}the marked phrase<!--/comment id="c1"-->. After.`

    const comments = extractComments(source)

    expect(comments).toHaveLength(1)
    expect(comments[0]).toMatchObject({
      id: 'c1',
      author: 'Kai',
      text: 'needs revision',
      createdAt: '2026-08-09T06:00:00Z',
      matchedText: 'the marked phrase'
    })
  })

  it('reports a source offset pointing at the comment’s own start marker', () => {
    const meta = { author: 'Kai', text: 'x', createdAt: '2026-08-09T06:00:00Z' }
    const source = `Intro.\n\n${marker('c1', meta)}span<!--/comment id="c1"-->`
    const [comment] = extractComments(source)

    expect(comment.sourceOffset).toBe(source.indexOf('<!--comment'))
  })

  it('finds multiple comments in document order', () => {
    const metaA = { author: 'Kai', text: 'first', createdAt: '2026-08-09T06:00:00Z' }
    const metaB = { author: 'Kai', text: 'second', createdAt: '2026-08-09T06:01:00Z' }
    const source = [
      `One ${marker('a', metaA)}alpha<!--/comment id="a"--> done.`,
      '',
      `Two ${marker('b', metaB)}beta<!--/comment id="b"--> done.`
    ].join('\n')

    const comments = extractComments(source)

    expect(comments.map((c) => [c.id, c.text, c.matchedText])).toEqual([
      ['a', 'first', 'alpha'],
      ['b', 'second', 'beta']
    ])
    expect(comments[1].sourceOffset).toBeGreaterThan(comments[0].sourceOffset)
  })

  it('flattens inline formatting inside a comment span down to plain text', () => {
    const meta = { author: 'Kai', text: 'note', createdAt: '2026-08-09T06:00:00Z' }
    // Leading text ("Say ") before the marker, deliberately -- this keeps
    // the marker from being the first thing on its own line, which would
    // otherwise trip CommonMark's HTML-block recognition (see
    // comment-plugin.ts's own extensive comment on unmergeHtmlNode) and
    // exercise the DIFFERENT, plain-text-only recovery path the next test
    // covers instead of this one's real goal: proving matchedText's
    // text/inlineCode leaf-walk correctly flattens GENUINE nested mdast
    // formatting nodes (strong, inlineCode), not just adjacent plain text.
    const source = `Say ${marker('c1', meta)}hello **world** and \`code\`<!--/comment id="c1"-->`
    const [comment] = extractComments(source)

    expect(comment.matchedText).toBe('hello world and code')
  })

  // Real, disclosed, narrow limitation of the block-collapse recovery path
  // specifically (comment-plugin.ts's unmergeHtmlNode) -- NOT a bug, and
  // distinct from the design's own single-block scope boundary. When a
  // comment marker is the very first thing in its own paragraph, CommonMark
  // swallows the whole line into one opaque HTML-block string BEFORE any
  // markdown parsing of its contents happens at all -- there is no mdast
  // tree for "between the markers" to walk in the first place, only a raw
  // text blob unmergeHtmlNode splits back into a single plain-text node.
  // Real markdown syntax inside a paragraph-LEADING comment's own marked
  // span therefore renders as literal characters, not parsed formatting --
  // narrower in practice than it sounds (most comments annotate a phrase
  // that doesn't also need its own bold/italic emphasis), and the marked
  // TEXT itself, the comment's id/author/text/createdAt, and everything
  // else in the document are all still fully correct either way.
  it('does not re-parse inline formatting when the marker collapses into a block (a disclosed limitation, not a bug)', () => {
    const meta = { author: 'Kai', text: 'note', createdAt: '2026-08-09T06:00:00Z' }
    const source = `${marker('c1', meta)}hello **world** and \`code\`<!--/comment id="c1"-->`
    const [comment] = extractComments(source)

    expect(comment.matchedText).toBe('hello **world** and `code`')
  })

  it('does not surface an unmatched (unpaired) comment marker as a real comment', () => {
    const meta = { author: 'Kai', text: 'x', createdAt: '2026-08-09T06:00:00Z' }
    const source = `Stray marker: ${marker('c1', meta)}no closing tag here.`
    expect(extractComments(source)).toEqual([])
  })

  it('does not surface a comment whose payload is corrupted (fails closed)', () => {
    const source =
      'Text <!--comment id="c1" data="not-valid-base64-json"-->span<!--/comment id="c1"-->.'
    expect(extractComments(source)).toEqual([])
  })
})

// Files saved by an earlier build genuinely contain TWO marker pairs sharing
// one id whenever a comment covered a hand-wrapped paragraph -- each line was
// serialized as its own pair. Those files still exist on disk, so the read
// side has to collapse them rather than render two rows under duplicate React
// keys. (A file like this re-serializes to a single pair on its next save.)
describe('extractComments with a legacy split same-id comment', () => {
  const DATA = encodeCommentMeta({
    author: 'Kai',
    text: 'a note',
    createdAt: '2026-08-11T09:00:00.000Z'
  })
  const pair = (body: string): string =>
    `<!--comment id="dup" data="${DATA}"-->${body}<!--/comment id="dup"-->`

  it('collapses same-id occurrences into one entry with one id', () => {
    const source = `Intro.\n\n${pair('first line')}\\\n${pair('second line tail.')}\n`

    const comments = extractComments(source)

    expect(comments).toHaveLength(1)
    expect(comments[0].id).toBe('dup')
    // Both fragments of the one marked span, in document order.
    expect(comments[0].matchedText).toBe('first line second line tail.')
  })

  it('points sourceOffset at the FIRST fragment, where the span begins', () => {
    const source = `Intro.\n\n${pair('first line')}\\\n${pair('second line tail.')}\n`

    const [comment] = extractComments(source)

    expect(source.slice(comment.sourceOffset)).toMatch(/^<!--comment id="dup"/)
  })

  it('still returns one entry per genuinely distinct id', () => {
    const other = `<!--comment id="two" data="${DATA}"-->x<!--/comment id="two"-->`
    const source = `Intro ${pair('a')} and ${other} here.\n`

    expect(extractComments(source).map((comment) => comment.id)).toEqual(['dup', 'two'])
  })
})
