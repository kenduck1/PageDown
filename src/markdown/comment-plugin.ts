import { visit } from 'unist-util-visit'
import type { Root, Html, Parent, PhrasingContent, Text } from 'mdast'
import type { Node } from 'unist'
import type { Processor } from 'unified'
import type { Handle } from 'mdast-util-to-markdown'

declare module 'mdast-util-to-markdown' {
  interface ConstructNameMap {
    // Registered so `state.enter('comment')` (remarkCommentToMarkdown below)
    // type-checks -- the same augmentation mdast-util-math makes for its own
    // `mathFlow`/`mathFlowMeta` construct names (confirmed by reading that
    // package's own .d.ts).
    comment: 'comment'
  }
}

export interface CommentMeta {
  author: string
  text: string
  createdAt: string
}

// Extends Parent (not the bare unist Node) and overrides `children` to
// PhrasingContent[], matching mdast's own official Strong/Emphasis shape
// exactly (@types/mdast's index.d.ts) -- both extend Parent, not Node, and
// both narrow `children` the same way.
export interface Comment extends Parent {
  type: 'comment'
  id: string
  author: string
  text: string
  createdAt: string
  children: PhrasingContent[]
}

// Registered in BOTH PhrasingContentMap AND RootContentMap -- confirmed by
// reading @types/mdast's own index.d.ts, these are two SEPARATE registries,
// not one deriving from the other, and `strong`/`emphasis` are natively
// listed in both for exactly the reason this comment now explains from
// first principles rather than by analogy. math-to-hast.ts's Math/InlineMath
// types only needed PhrasingContentMap/BlockContentMap because they extend
// Literal (a LEAF node, no `children` field to typecheck at all) -- but
// Comment is a WRAPPING node, so TypeScript must verify `Comment.children`
// (declared PhrasingContent[]) is assignable to `Parent.children`
// (RootContent[]), which requires PhrasingContent -- now including Comment
// -- to itself be a subtype of RootContent. Registering only in
// PhrasingContentMap left `comment` absent from RootContentMap's own
// key set, so RootContent didn't include it, PhrasingContent (which does,
// via this map) stopped being assignable to RootContent, and every
// mdast-consuming file in the program -- including pagebreak-plugin.ts,
// which never imports this module at all -- failed to typecheck, because
// TypeScript resolves module-augmentation merges program-wide, not
// per-importer. Registering here too is what fixes it, not a workaround.
declare module 'mdast' {
  interface PhrasingContentMap {
    comment: Comment
  }
  interface RootContentMap {
    comment: Comment
  }
}

// Comments are HTML comments embedded directly in the .md file, exactly the
// same portability argument the pagebreak marker already established (see
// pagebreak-plugin.ts and CLAUDE.md's Mermaid/Math sections for the same
// "invisible to every other Markdown renderer" property): opening a
// PageDown document with comments in another tool silently shows the clean
// document, no sidecar file anywhere. Free-form author-typed comment text
// cannot safely be embedded as literal HTML-comment content (an unescaped
// `--` or a premature `-->` would corrupt the comment), so the payload is
// base64 of a JSON object -- base64's alphabet contains none of HTML
// comment syntax's meaningful characters, sidestepping escaping entirely
// rather than attempting to escape-and-hope.
const START_MARKER_RE = /^<!--comment\s+id="([^"]+)"\s+data="([^"]+)"\s*-->$/
const END_MARKER_RE = /^<!--\/comment\s+id="([^"]+)"\s*-->$/

// btoa/atob + TextEncoder/TextDecoder, NOT node:buffer's Buffer -- this
// module is imported from BOTH the main process (markdownToHtml, a real
// Node runtime) AND the renderer's Milkdown mark schema
// (src/renderer/src/milkdown/nodes/comment.ts, contextIsolated, no Node
// globals at all). Buffer only exists on the main-process side; using it
// here would throw the moment a comment mark's parseMarkdown/toMarkdown
// runner executed in the editor. btoa/atob/TextEncoder/TextDecoder are
// standard Web APIs, also present as real Node globals (confirmed: Node 18+,
// this project's actual runtime), so one implementation works unmodified in
// both places. Manual byte<->binary-string conversion (not the older
// `unescape(encodeURIComponent(...))`/`escape` trick) is the currently
// recommended UTF-8-safe base64 pattern for environments with TextEncoder.
function utf8ToBase64(str: string): string {
  const bytes = new TextEncoder().encode(str)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function base64ToUtf8(base64: string): string {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

export function encodeCommentMeta(meta: CommentMeta): string {
  return utf8ToBase64(JSON.stringify(meta))
}

// Returns null (never throws) for a malformed/corrupted payload -- comment
// metadata is round-tripped through hand-editable Markdown text, so a
// human could truncate or garble it; a null return here means the caller
// leaves the marker pair as inert, unmatched literal text rather than
// crashing the whole document's parse.
export function decodeCommentMeta(data: string): CommentMeta | null {
  try {
    const parsed: unknown = JSON.parse(base64ToUtf8(data))
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'author' in parsed &&
      'text' in parsed &&
      'createdAt' in parsed &&
      typeof (parsed as CommentMeta).author === 'string' &&
      typeof (parsed as CommentMeta).text === 'string' &&
      typeof (parsed as CommentMeta).createdAt === 'string'
    ) {
      return parsed as CommentMeta
    }
    return null
  } catch {
    return null
  }
}

// Real, test-caught parsing gap, not a hypothetical: when a comment marker
// is the FIRST thing on its own line (the exact shape produced by
// commenting on, say, the first word of a paragraph -- an entirely
// ordinary, expected gesture), CommonMark's HTML BLOCK type-2 rule ("starts
// with the string `<!--`; ends when the line contains `-->`") swallows the
// WHOLE LINE -- start marker, the marked text, AND the end marker -- into
// ONE opaque `html` node, never wrapped in a paragraph at all. Confirmed by
// dumping the real parsed tree for `Intro.\n\n<!--comment id="c1"
// data="..."-->span<!--/comment id="c1"-->`: remark-parse produces a
// root-level `html` node whose single `value` is the entire concatenated
// string, not three separate siblings the way "Before. <!--comment...-->
// text<!--/comment-->" (leading text prevents the line from EVER
// triggering HTML-block recognition in the first place) already produces.
// processContainer's own sibling-pair matching structurally cannot see a
// pair merged into one node's `value` this way.
//
// unmergeHtmlNode splits exactly this shape back apart, restoring the fine-
// grained node sequence that WOULD have resulted had HTML-block detection
// never kicked in -- not a new concept, a NORMALIZATION making the
// collapsed case structurally identical to the already-working inline case
// before processContainer ever runs on it.
const MARKER_SPLIT_RE =
  /(<!--comment\s+id="[^"]+"\s+data="[^"]+"\s*-->|<!--\/comment\s+id="[^"]+"\s*-->)/

// Returns null when there is nothing to unmerge (no embedded marker found,
// or the node's value IS already exactly one marker with nothing else --
// the ordinary already-inline case, left untouched). String#split with a
// CAPTURING group interleaves [text, marker, text, marker, ..., text]
// (confirmed JS behavior, not assumed) -- so parity alone (even index =
// plain text, odd index = a captured marker) is what distinguishes them,
// with no need for a second classification regex pass that could in
// principle disagree with the split itself.
//
// Parity MUST be computed against the RAW split array, before dropping
// empty strings -- a real, test-caught bug in an earlier version of this
// function filtered empties first (`.filter(...).map((part, index) => ...)`),
// which silently shifts every later element's index whenever an earlier one
// gets dropped. A marker sitting at the very START of the source string
// (the exact case this function exists to fix) splits as `['', marker,
// text, marker]` -- filtering the leading '' before indexing turned the
// FIRST real element (the start marker, originally at raw index 1, odd) into
// post-filter index 0 (even), misclassifying it as plain text. Caught by
// this file's own extractComments.test.ts, not by inspection.
//
// The "nothing to unmerge" check itself is against the SIGNIFICANT (non-
// empty) part COUNT, not the raw length -- a second real, test-caught bug:
// an ALREADY-CLEAN, already-standalone marker node (the common case --
// nothing merged into it at all) splits as `['', theWholeMarker, '']`,
// length 3, which the original `rawParts.length <= 1` guard did NOT
// recognize as "nothing to do" -- it proceeded to build a REPLACEMENT node
// carrying no `position` (this function never sets one), silently
// discarding the original node's real position. That downstream broke
// extractComments.ts, which reads a comment's `sourceOffset` straight off
// its own position -- every already-working single-marker case started
// reporting `[]` (position undefined, extractComments's own null-check
// skipping it) the moment this function started touching nodes it should
// have left alone.
// Computed positions on every unmerged piece are LOAD-BEARING, not cosmetic
// -- processContainer (below) reads `children[i].position`/
// `children[endIndex].position` to build the resulting `comment` node's own
// position, and extractComments.ts (src/renderer/src/lib/extractComments.ts)
// reads a comment's `sourceOffset` straight off that position. A position-
// less piece here silently produces a position-less comment there, which
// extractComments's own `if (sourceOffset == null) return` then drops
// entirely -- a real, test-caught regression this exact function caused
// once already (see this function's own comment above) by returning pieces
// with no position at all. Tracked by walking `node`'s own starting
// line/column/offset forward through each piece's text, counting newlines
// -- markers themselves are always one line (base64 payloads contain no
// newline characters by construction), but the "between" text a merged
// block collapsed alongside them, in principle, could.
function advancePosition(
  point: { line: number; column: number; offset?: number },
  text: string
): { line: number; column: number; offset?: number } {
  const newlineCount = (text.match(/\n/g) ?? []).length
  if (newlineCount === 0) {
    return {
      line: point.line,
      column: point.column + text.length,
      offset: point.offset === undefined ? undefined : point.offset + text.length
    }
  }
  const lastLineStart = text.lastIndexOf('\n') + 1
  return {
    line: point.line + newlineCount,
    column: text.length - lastLineStart + 1,
    offset: point.offset === undefined ? undefined : point.offset + text.length
  }
}

function unmergeHtmlNode(node: Html): Array<Html | { type: 'text'; value: string }> | null {
  const rawParts = node.value.split(MARKER_SPLIT_RE)
  const significantPartCount = rawParts.filter((part) => part !== '').length
  if (significantPartCount <= 1) return null
  const result: Array<Html | { type: 'text'; value: string }> = []
  let cursor = node.position?.start ?? { line: 1, column: 1, offset: undefined }
  for (let index = 0; index < rawParts.length; index++) {
    const part = rawParts[index]
    if (part === '') continue
    const start = cursor
    const end = advancePosition(cursor, part)
    cursor = end
    const position =
      start.offset !== undefined && end.offset !== undefined
        ? {
            start: { line: start.line, column: start.column, offset: start.offset },
            end: { line: end.line, column: end.column, offset: end.offset }
          }
        : undefined
    result.push(
      index % 2 === 1
        ? ({ type: 'html', value: part, position } as Html)
        : ({ type: 'text', value: part, position } as { type: 'text'; value: string })
    )
  }
  return result
}

// The container types where a comment marker can appear as a direct BLOCK-
// level child (the shape that triggers the HTML-block swallowing above) --
// mirrors pagebreak-plugin.ts's own BLOCK_CONTAINER_TYPES concept, but
// includes `listItem` (pagebreak explicitly excludes it -- breaks inside
// list items are unsupported v1 scope for PAGE BREAKS specifically, per the
// master design doc -- comments have no such restriction: commenting on
// text inside a list item is ordinary, expected usage).
const BLOCK_LEVEL_CONTAINER_TYPES = new Set([
  'root',
  'blockquote',
  'footnoteDefinition',
  'listItem'
])

// Unmerges every child of `container` that collapsed into one opaque html
// blob, BEFORE processContainer's own pairing logic ever runs on it. A
// BLOCK container's unmerged pieces are wrapped in a synthetic `paragraph`
// -- reconstructing the shape CommonMark would have produced had its own
// HTML-block detection not intercepted the line first, which is what makes
// this a correctness fix rather than an ad hoc patch: `root`/`blockquote`/
// etc. children must be block-level nodes, never bare phrasing content, and
// a paragraph is exactly what a line of plain/inline-HTML text becomes
// under ordinary CommonMark parsing. A PHRASING container's unmerged
// pieces splice in directly -- already valid at that level, no wrapping
// needed (this path is normally a no-op in practice, since a phrasing
// container's own html children are essentially never pre-merged blobs to
// begin with; kept for structural completeness/symmetry, not a case this
// module's own tests currently exercise).
//
// Real, disclosed, NARROW limitation of this recovery path specifically,
// confirmed by a real test (extractComments.test.ts) rather than left
// theoretical: the "between" piece this produces is always a single plain
// `text` node -- CommonMark's own HTML-block detection consumed the ENTIRE
// line, including the marked span, before any markdown parsing of ITS
// contents happened at all, so there is no mdast tree for "between the
// markers" to draw from here, only the raw substring. Real markdown syntax
// inside a paragraph-LEADING comment's own marked span (`**bold**` inside
// the comment) therefore round-trips as literal characters, not parsed
// formatting -- distinct from, and in ADDITION to, the design's own
// documented single-block scope boundary. Not fixed here: re-parsing the
// between-text as its own inline markdown fragment and splicing the result
// in is real, separate work (correctly handling escape sequences, nested
// marks, footnote/link references defined elsewhere in the document, ...)
// that the narrowness of this edge case -- commenting on text that ALSO
// needs its own bold/italic emphasis, where the comment ALSO happens to
// open its own paragraph -- doesn't currently justify.
//
// SECOND HALF of the same HTML-block problem, and the reason a synthetic
// paragraph alone is not enough: CommonMark's HTML block type 2 ends at the
// first line CONTAINING `-->`, and a start marker carries its own `-->`, so
// the block is exactly ONE LINE. For a single-line source paragraph that is
// the whole paragraph and unmergeHtmlNode above finishes the job. For a
// HAND-WRAPPED paragraph it is not: every remaining line of what the author
// wrote as ONE paragraph is left behind as SEPARATE sibling block(s), and
// wrapping only the first line in a paragraph of its own permanently SPLITS
// the user's paragraph in two -- visible in the paginated preview, the
// exported PDF and HTML export, and compounding on every save/reload cycle.
//
// This cannot be avoided by emitting different bytes, which was checked
// before building the recovery rather than assumed. The marked span begins
// at the paragraph's first character (the ordinary triple-click-then-comment
// gesture), so the start marker necessarily begins the line; a line
// beginning with `<!--` is an HTML block whatever follows it, and any line
// break inside the marked span therefore always lands outside that block.
// Ruled out for the same reason: emitting the break as two trailing spaces
// rather than `\` (still a newline), and prefixing the marker with an
// invisible character to defeat the start condition (silently injects a real
// character into the user's document).
//
// The ANCHOR SET is what keeps this NARROW. Absorption can only ever begin
// at a paragraph whose own content was genuinely un-collapsed by
// unmergeHtmlNode -- which by construction means an html blob holding one of
// OUR markers PLUS other content, i.e. a real collapsed line. An ordinary
// `<!-- note -->` html block never unmerges (one significant part), so it
// never becomes an anchor and a hand-authored html block followed by a
// paragraph is untouched. A plain inline marker inside an ordinary
// paragraph (`Before <!--comment-->x<!--/comment-->`) does not unmerge
// either, and correctly never anchors: its start marker is not line-leading,
// so nothing was fragmented in the first place.

// Was the candidate on the line IMMEDIATELY after the accumulated run, i.e.
// with no blank line between them? That is exactly the CommonMark condition
// for "these lines were one paragraph": remark-stringify always separates
// two genuine sibling blocks with a blank line, so contiguity is not a
// heuristic for the bytes this app itself writes. Only `paragraph` is
// absorbed -- a heading/list/fence on the next line genuinely interrupts a
// paragraph in CommonMark too, so it was a separate block in the source.
function continuesSplitParagraph(accumulated: Parent, candidate: Node): boolean {
  if (candidate.type !== 'paragraph') return false
  const accumulatedEnd = accumulated.position?.end
  const candidateStart = candidate.position?.start
  if (!accumulatedEnd || !candidateStart) return false
  return candidateStart.line === accumulatedEnd.line + 1
}

// Re-inserts the line break CommonMark consumed when it cut the paragraph at
// the block boundary, then splices the continuation's own children in.
//
// The continuation's children are REAL parsed inline content (it was parsed
// as an ordinary paragraph), so unmergeHtmlNode's documented "the between
// piece is always plain text" limitation applies only to the first line, not
// to anything absorbed here.
//
// Which break to re-insert is read off the source, not guessed. A hard break
// reaches the html blob as a literal trailing `\` (mdast-util-to-markdown's
// own break handler emits `\` + newline -- read from its lib/handle/break.js
// -- never two spaces), which would otherwise render as a stray visible
// backslash. Trailing backslashes are counted for PARITY rather than tested
// for presence, because `\\` at end of line is an ESCAPED literal backslash
// followed by a soft break, not a hard break.
function appendContinuationLine(accumulated: Parent, continuation: Parent): void {
  const children = accumulated.children as Node[]
  const last = children[children.length - 1]
  let isHardBreak = false
  if (last && last.type === 'text') {
    const value = (last as Text).value
    const trailingBackslashes = /\\+$/.exec(value)?.[0].length ?? 0
    if (trailingBackslashes % 2 === 1) {
      isHardBreak = true
      const trimmed = value.slice(0, -1)
      if (trimmed === '') children.pop()
      else (last as Text).value = trimmed
    }
  }
  // A soft wrap becomes a bare `\n` inside phrasing content -- the exact
  // shape remark itself produces for one -- NOT a `break` node, which
  // mdast-util-to-hast would render as a real <br> and turn the author's
  // invisible hand-wrap into a visible line break on the printed page.
  children.push(isHardBreak ? ({ type: 'break' } as Node) : ({ type: 'text', value: '\n' } as Node))
  children.push(...(continuation.children as Node[]))
  if (accumulated.position && continuation.position) {
    accumulated.position = {
      start: accumulated.position.start,
      end: continuation.position.end
    }
  }
}

function absorbSplitParagraphs(children: Node[], anchors: Set<Node>): Node[] {
  const result: Node[] = []
  let index = 0
  while (index < children.length) {
    const child = children[index]
    if (!anchors.has(child)) {
      result.push(child)
      index++
      continue
    }
    const accumulated = child as Parent
    let next = index + 1
    while (next < children.length && continuesSplitParagraph(accumulated, children[next])) {
      appendContinuationLine(accumulated, children[next] as Parent)
      next++
    }
    result.push(accumulated)
    index = next
  }
  return result
}

// Splices every unmergeable html child apart in place. Returns whether
// anything actually changed, which is the anchor discriminator described
// above -- not merely a convenience return.
function unmergeChildren(children: Node[]): { children: Node[]; changed: boolean } {
  const result: Node[] = []
  let changed = false
  for (const child of children) {
    const unmerged = child.type === 'html' ? unmergeHtmlNode(child as Html) : null
    if (!unmerged) {
      result.push(child)
      continue
    }
    changed = true
    result.push(...unmerged)
  }
  return { children: result, changed }
}

function unmergeContainer(container: Parent): void {
  if (!BLOCK_LEVEL_CONTAINER_TYPES.has(container.type)) {
    // A PHRASING container's unmerged pieces splice in directly -- already
    // valid at that level, no wrapping needed.
    const { children } = unmergeChildren(container.children as Node[])
    container.children = children as typeof container.children
    return
  }

  const result: Node[] = []
  const anchors = new Set<Node>()
  for (const child of container.children as Node[]) {
    if (child.type === 'html') {
      const unmerged = unmergeHtmlNode(child as Html)
      if (!unmerged) {
        result.push(child)
        continue
      }
      const paragraph = { type: 'paragraph', children: unmerged, position: child.position } as Node
      anchors.add(paragraph)
      result.push(paragraph)
      continue
    }
    if (child.type === 'paragraph') {
      // The SAME collapsed line, reached by the other of this plugin's two
      // consumers. Inside Milkdown's own remark chain,
      // @milkdown/preset-commonmark's remarkHtmlTransformer has ALREADY
      // rewritten every block-level html node into a `paragraph` wrapping it
      // (read from the installed lib/index.js) before this plugin runs, so
      // the `child.type === 'html'` branch above never fires there and the
      // collapsed blob arrives one level deeper. Handling it here rather
      // than relying on the later per-paragraph visit is what makes
      // absorption possible at all: `visit` is PREORDER, so this block
      // container is processed before its own children, and an anchor
      // discovered later could no longer reach its sibling continuation
      // lines. The later visit re-runs unmergeChildren on these same
      // children and is a no-op by construction -- an already-split single
      // marker has one significant part, which unmergeHtmlNode declines.
      const paragraph = child as Parent
      const { children, changed } = unmergeChildren(paragraph.children as Node[])
      if (changed) {
        paragraph.children = children as typeof paragraph.children
        anchors.add(child)
      }
      result.push(child)
      continue
    }
    result.push(child)
  }
  container.children = absorbSplitParagraphs(result, anchors) as typeof container.children
}

function matchStart(node: Node): { id: string; meta: CommentMeta } | null {
  if (node.type !== 'html') return null
  const value = (node as Html).value.trim()
  const match = START_MARKER_RE.exec(value)
  if (!match) return null
  const meta = decodeCommentMeta(match[2])
  if (!meta) return null
  return { id: match[1], meta }
}

function matchEnd(node: Node, id: string): boolean {
  if (node.type !== 'html') return false
  const match = END_MARKER_RE.exec((node as Html).value.trim())
  return match !== null && match[1] === id
}

// Scans ONE container's own `children` array for a start/end marker PAIR at
// THIS nesting level and wraps everything between them into a single
// `comment` node -- mirrors how `strong`/`emphasis` are themselves mdast
// WRAPPING nodes, not a new concept. Runs on every node with a `children`
// array (paragraph, heading, tableCell, strong, emphasis, link, ...), via
// the visit() call below, so a marker pair is found regardless of how
// deeply nested the marked span is -- e.g. a comment wholly inside a bold
// run is found when this function processes the `strong` node itself, not
// only when it processes the enclosing paragraph.
//
// An unmatched start marker (no later sibling END_MARKER_RE with the same
// id in the SAME container) is left untouched, as inert literal HTML-comment
// text -- deliberately fails closed to "shows as literal text," never
// throws and never silently drops content. This is the direct consequence
// of the design's own single-block scope boundary (see the design doc): a
// comment mark that was ever applied across a block boundary cannot
// round-trip through independent per-block serialization, so its start and
// end markers land in different containers and neither ever finds its
// partner here -- an intentional, disclosed failure mode, not a bug.
function processContainer(container: Parent): void {
  const children = container.children as Node[]
  const result: Node[] = []
  let i = 0
  while (i < children.length) {
    const start = matchStart(children[i])
    if (!start) {
      result.push(children[i])
      i++
      continue
    }
    let endIndex = -1
    for (let j = i + 1; j < children.length; j++) {
      if (matchEnd(children[j], start.id)) {
        endIndex = j
        break
      }
    }
    if (endIndex === -1) {
      // No matching end in this container -- leave the start marker as
      // inert literal text and keep scanning the rest normally.
      result.push(children[i])
      i++
      continue
    }
    const between = children.slice(i + 1, endIndex) as PhrasingContent[]
    const comment: Comment = {
      type: 'comment',
      id: start.id,
      author: start.meta.author,
      text: start.meta.text,
      createdAt: start.meta.createdAt,
      children: between,
      position:
        children[i].position && children[endIndex].position
          ? { start: children[i].position!.start, end: children[endIndex].position!.end }
          : undefined
    }
    result.push(comment)
    i = endIndex + 1
  }
  container.children = result as typeof container.children
}

function hasChildren(node: Node): node is Parent {
  return Array.isArray((node as Parent).children)
}

export function remarkComment() {
  return (tree: Root): void => {
    visit(tree, (node) => {
      if (!hasChildren(node)) return
      unmergeContainer(node)
      processContainer(node)
    })
  }
}

// A line break is the ONLY thing that may sit between two fragments of one
// logical comment. Both spellings have to be recognised: a hard break is a
// `break` node, while a SOFT wrap round-trips through Milkdown's own
// hardbreak schema as a `text` node whose entire value is a newline
// (@milkdown/preset-commonmark's hardbreakSchema.toMarkdown emits
// `state.addNode('text', undefined, '\n')` when its `isInline` attr is set --
// read from the installed package, not assumed).
function isLineBreakSeparator(node: Node): boolean {
  if (node.type === 'break') return true
  if (node.type !== 'text') return false
  return /^[ \t]*\n[ \t]*$/.test((node as Text).value)
}

function hasRunNeighbour(siblings: Node[], index: number, step: 1 | -1, id: string): boolean {
  for (let i = index + step; i >= 0 && i < siblings.length; i += step) {
    const sibling = siblings[i]
    if (isLineBreakSeparator(sibling)) continue
    return sibling.type === 'comment' && (sibling as unknown as Comment).id === id
  }
  return false
}

// WHERE THE SPLIT COMES FROM, and why the fix belongs here rather than at
// the ProseMirror layer: @milkdown/preset-commonmark's own
// hardbreakClearMarkPlugin has an appendTransaction that strips EVERY mark
// off EVERY hardbreak inside any AddMarkStep's range (read from the
// installed lib/index.js). So immediately after addCommentCommand's
// `tr.addMark(from, to, mark)`, the hardbreak between two commented lines
// carries no comment mark -- by that preset's deliberate design, not by
// accident. Milkdown's SerializerState then closes an open mark as soon as
// the NEXT inline node does not carry it (`#closeEndedMarks`), so the mark
// is closed before the break and reopened after it: TWO mdast `comment`
// nodes sharing one id, which this handler used to serialize faithfully as
// two marker pairs.
//
// Rejoining them here, at the mdast layer, is the layer that can actually
// see the run: the ProseMirror document genuinely has two marked runs and
// fighting the preset to make the mark span a hardbreak would mean
// overriding a schema plugin this app deliberately mounts wholesale. It is
// also the layer both consumers share, so Milkdown's serializer and any
// future mdast producer get the same guarantee.
//
// Deliberately NOT done by refusing the gesture: a hardbreak lives inside
// one block, so addCommentCommand's `$from.sameParent($to)` guard is
// correctly satisfied and the design's single-block scope boundary is not
// what is at stake here.
function commentRunPosition(
  node: Comment,
  parent: Parent | undefined
): { isFirst: boolean; isLast: boolean } {
  if (!parent) return { isFirst: true, isLast: true }
  const siblings = parent.children as Node[]
  const index = siblings.indexOf(node as unknown as Node)
  if (index === -1) return { isFirst: true, isLast: true }
  return {
    isFirst: !hasRunNeighbour(siblings, index, -1, node.id),
    isLast: !hasRunNeighbour(siblings, index, 1, node.id)
  }
}

// Teaches mdast-util-to-markdown how to print a `comment` node -- needed
// only by Milkdown's internal remark pipeline, which serializes ProseMirror
// content back to Markdown text (markdownToHtml never serializes back to
// Markdown, so it never needs this half -- same split as
// remarkPagebreakToMarkdown, see that function's own comment for why `this`
// must be accessed directly in the attacher body).
//
// Re-encodes author/text/createdAt from the node's CURRENT attrs on every
// call, not an unparsed original string carried through -- an edited or
// re-authored comment's saved bytes must actually reflect the edit. `id`
// stays whatever the node already carries (identity, not content).
export function remarkCommentToMarkdown(this: Processor): void {
  const data = this.data() as { toMarkdownExtensions?: unknown[] }
  const extensions = data.toMarkdownExtensions ?? (data.toMarkdownExtensions = [])
  // Follows mdast-util-to-markdown's own real handler pattern exactly (read
  // directly from its installed `lib/handle/link.js` -- `state.enter`/
  // `tracker.move`/`state.containerPhrasing`, NOT a hand-rolled
  // re-serialization of children). No character-escaping/attention-encoding
  // complexity is needed here the way strong/emphasis need it (their `*`/`_`
  // markers can be misparsed depending on adjacent characters; a literal
  // HTML comment has no such ambiguity), so this is simpler than strong.js's
  // own handler despite following the same shape.
  const commentHandler: Handle = (node, parent, state, info) => {
    const typedNode = node as unknown as Comment
    // One marker pair per LOGICAL comment, not per marked run: a fragment
    // that merely continues an earlier same-id fragment emits its content
    // and no markers at all, so the pair ends up spanning the line break
    // between them (which the `break`/`text` separator serializes itself,
    // in between, exactly as it would outside a comment). See
    // commentRunPosition above for where the fragmentation comes from.
    const { isFirst, isLast } = commentRunPosition(typedNode, parent as Parent | undefined)
    const exit = state.enter('comment')
    const tracker = state.createTracker(info)
    const startText = isFirst
      ? `<!--comment id="${typedNode.id}" data="${encodeCommentMeta({
          author: typedNode.author,
          text: typedNode.text,
          createdAt: typedNode.createdAt
        })}"-->`
      : ''
    const endText = isLast ? `<!--/comment id="${typedNode.id}"-->` : ''
    let value = startText ? tracker.move(startText) : ''
    value += tracker.move(
      state.containerPhrasing(typedNode, {
        before: value || info.before,
        after: endText || info.after,
        ...tracker.current()
      })
    )
    if (endText) value += tracker.move(endText)
    exit()
    return value
  }
  extensions.push({ handlers: { comment: commentHandler } })
}
