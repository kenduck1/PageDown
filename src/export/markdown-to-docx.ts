// Markdown -> .docx (Office Open XML WordprocessingML) conversion.
//
// WHAT THIS IS, STATED HONESTLY UP FRONT, because the rest of this app is
// built around the opposite promise: this is a CONTENT export with structural
// fidelity, NOT a layout-fidelity export. Word repaginates with its own layout
// engine, its own installed fonts and its own line-breaking, so a .docx cannot
// reproduce the page-exact output this app's whole premise rests on -- the
// page BOX (size, orientation, margins) and the running header/footer are
// carried across because Word has real equivalents, but where a line or a page
// actually breaks is Word's decision, not ours. PDF remains the fidelity path,
// and every user-facing string for this feature says so rather than implying
// pixel parity.
//
// LIBRARY: `docx` (dolanmiu), pinned exactly like every other layout-affecting
// dependency here. Ruled out, with reasons rather than by taste:
//   - `html-to-docx`: converts an HTML string, so it would need this app's
//     already-rendered pipeline HTML re-parsed by a THIRD Markdown-adjacent
//     parser (virtual-dom + html-to-vdom), lands 13 transitive dependencies
//     including lodash and a full DOM implementation in the PRIVILEGED main
//     process, and gives no direct handle on the two things this feature most
//     needs to be exact about -- page breaks and section properties.
//   - `html-docx-js`: unmaintained, and its whole mechanism is the MHTML
//     `altChunk` trick -- it embeds HTML inside the .docx and asks Word to
//     convert it on open. That is not a real .docx: Google Docs, Pages and
//     LibreOffice render it poorly or not at all, and nothing about the
//     resulting file can be asserted on in a test.
//   - `docx` builds real OOXML part by part, so `word/document.xml` contains
//     exactly the elements this module emitted, which is what makes the
//     round-trip assertions in the tests and the gate meaningful.
//
// SOURCE OF TRUTH: this converts the MDAST tree, not the rendered HTML.
// Going through pipeline.ts's HTML would mean re-parsing HTML to find
// structure that mdast already states directly, and would lose the two node
// types this feature most needs -- `pagebreak` (which becomes an inert marker
// div in HTML) and `comment` (which is deliberately flattened away by
// comment-to-hast.ts). Constructing a second unified PROCESSOR from the same
// plugins -- not a second Markdown parser -- is the established precedent
// here (extractOutline.ts, extractComments.ts, detectRemoteImages.ts); the
// plugin list below is kept byte-identical to pipeline.ts's own parse-phase
// list for that reason, and must move with it.
//
// Electron-free on purpose, so it is directly unit-testable under plain
// Vitest -- the recent-files.ts / version-history.ts / static-html-document.ts
// precedent. The thin Electron half (the Save dialog, the disk write, and the
// security-vetted image reads) lives in src/main/docx-exporter.ts.
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkFrontmatter from 'remark-frontmatter'
import remarkMath from 'remark-math'
import { visit } from 'unist-util-visit'
import type {
  Blockquote,
  Definition,
  FootnoteDefinition,
  Heading,
  Image,
  ImageReference,
  Link,
  LinkReference,
  List,
  ListItem,
  Paragraph as MdParagraph,
  PhrasingContent,
  Root,
  RootContent,
  Table as MdTable,
  TableCell as MdTableCell,
  TableRow as MdTableRow
} from 'mdast'
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  FootnoteReferenceRun,
  Header,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  NumberFormat,
  Packer,
  PageBreak,
  PageNumber,
  PageOrientation,
  Paragraph,
  ShadingType,
  Tab,
  TabStopType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type ILevelsOptions,
  type IParagraphOptions,
  type IRunPropertiesOptions,
  type ParagraphChild
} from 'docx'
import { remarkPagebreak } from '../markdown/pagebreak-plugin'
import { remarkComment, type Comment } from '../markdown/comment-plugin'
import { isRelativeLocalPath, isRemoteImageSrc } from '../markdown/local-image-src'
import { computePageGeometry, DPI } from '../typography/page-geometry'
import { resolveDocumentStyle, type DocumentStyle } from '../typography/document-style'
import {
  resolvePageConfig,
  type PageConfig,
  type PageRunningContent
} from '../markdown/page-config'
import type { DocxImageType } from './docx-image'

// ---------------------------------------------------------------------------
// Units.
//
// OOXML measures pages and indents in TWIPs (twentieths of a point, 1440/inch)
// and font sizes in HALF-POINTS. This app measures everything in CSS pixels at
// a fixed 96 DPI (page-geometry.ts's own DPI constant, reused rather than
// re-stated so a change there cannot silently desynchronise this exporter).
// ---------------------------------------------------------------------------
const TWIPS_PER_INCH = 1440
const POINTS_PER_INCH = 72

const pxToTwip = (px: number): number => Math.round((px / DPI) * TWIPS_PER_INCH)
/** Font size in HALF-points, which is the unit every `size` field in `docx` takes. */
const pxToHalfPoints = (px: number): number => Math.round(((px / DPI) * POINTS_PER_INCH) / 0.5)

// ---------------------------------------------------------------------------
// Fonts.
//
// OOXML's `w:rFonts` names exactly ONE family per script (there is no CSS-style
// fallback stack -- checked against the spec, not assumed), and Word's
// automatic substitution for a family the reader does not have installed is
// poor. This app's own bundled faces (Source Serif 4, Inter, Source Code Pro)
// ship as .woff2, which OOXML font embedding cannot consume at all -- it takes
// obfuscated TTF/OTF -- so embedding them is not merely expensive, it is not
// available.
//
// So these are deliberately UNIVERSALLY-AVAILABLE substitutes, chosen for the
// closest match within what every Word/LibreOffice/Pages install genuinely
// has. This is the single largest visual divergence in the whole export and it
// is a disclosed one: the point of a .docx is that the recipient can open and
// edit it, and a document rendered in Word's "missing font" fallback reads as
// broken.
const DOCX_SERIF_FONT = 'Georgia' // for source-serif-4: transitional serif, on every Windows/macOS install
const DOCX_SANS_FONT = 'Arial' // for inter: neo-grotesque, the only truly universal sans
const DOCX_MONO_FONT = 'Courier New' // the only monospace present on every platform by default

// ---------------------------------------------------------------------------
// Typography.
//
// MIRRORS src/typography/document-typography.css's own size ramp and its three
// non-default themes. It is a mirror rather than a shared source because that
// stylesheet is CSS consumed by two BROWSER surfaces, and there is no parser
// here to read it with -- so this must be kept in sync by hand when that file's
// sizes change. Exact parity is explicitly NOT the goal (see this module's
// header); what has to survive is the RELATIVE hierarchy -- an h2 must stay
// bigger than body text, and an h3 must not end up smaller than a paragraph.
// ---------------------------------------------------------------------------
const BASE_BODY_PX = 14
// Index 0 is unused; 1..6 are h1..h6, matching document-typography.css's
// 26/20/16/14/13/12 ramp.
const BASE_HEADING_PX: readonly number[] = [0, 26, 20, 16, 14, 13, 12]

interface DocxTypography {
  bodyPx: number
  headingPx: readonly number[]
  bodyFont: string
}

/**
 * Resolves the body and heading sizes a document renders at, applying the same
 * precedence document-typography.css does: an explicit `fontSize` beats the
 * theme's own implied size and takes over the whole heading ramp
 * proportionally (that stylesheet's own `calc(26 / 14 * 1em)` block), while a
 * theme that sets no size for a given heading leaves the base ramp in place.
 */
export function resolveDocxTypography(style: DocumentStyle): DocxTypography {
  const bodyFont = style.fontFamily === 'inter' ? DOCX_SANS_FONT : DOCX_SERIF_FONT

  if (style.fontSize !== 'default') {
    const bodyPx = style.fontSize
    // Proportional ramp, exactly as the stylesheet's `em`-based block does it:
    // every heading keeps its own ratio to the 14px base at whatever body size
    // was chosen. Without this an 18px body renders an h3 (fixed 16px) SMALLER
    // than its own paragraphs.
    return {
      bodyPx,
      headingPx: BASE_HEADING_PX.map((px) => (px / BASE_BODY_PX) * bodyPx),
      bodyFont
    }
  }

  switch (style.theme) {
    case 'resume':
      return { bodyPx: 13, headingPx: [0, 20, 13, 16, 14, 13, 12], bodyFont }
    case 'letter':
      return { bodyPx: 15, headingPx: [0, 20, 16, 16, 14, 13, 12], bodyFont }
    case 'report':
      return { bodyPx: BASE_BODY_PX, headingPx: [0, 32, 21, 16, 14, 13, 12], bodyFont }
    default:
      return { bodyPx: BASE_BODY_PX, headingPx: BASE_HEADING_PX, bodyFont }
  }
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

/** One already-read, already-vetted local image, ready to embed. */
export interface DocxImageAsset {
  data: Uint8Array
  type: DocxImageType
  widthPx: number
  heightPx: number
}

export interface BuildDocxOptions {
  /** The document's raw Markdown source, exactly as it sits on disk. */
  content: string
  /**
   * Local images, keyed by the `src` EXACTLY as written in the Markdown (the
   * same string collectLocalImageSrcs returned), already read and vetted by
   * the Electron half. A src absent from this map renders as its alt text --
   * an image that could not be read must never abort the export.
   */
  images?: ReadonlyMap<string, DocxImageAsset>
  /**
   * Per-document remote-image consent (documentStore.remoteImagesAllowed).
   * Remote images are NEVER embedded either way -- see renderImage -- so this
   * only decides whether the placeholder is a live hyperlink to the remote URL
   * or inert alt text.
   */
  allowRemoteImages?: boolean
  /** Document title, for the .docx core properties. */
  title?: string
}

/**
 * Parses Markdown into the exact mdast shape this exporter walks.
 *
 * Exported separately from the build so the Electron half can collect image
 * references (which needs a parsed tree) without paying for a second parse --
 * see collectLocalImageSrcs.
 *
 * The plugin list is pipeline.ts's own parse-phase list, minus the
 * rehype/sanitize half it has no use for. remarkPagebreak and remarkComment
 * are post-parse TREE TRANSFORMS, not syntax extensions, so they need an
 * explicit `.runSync()` on the same processor instance -- the same distinction
 * pipeline.ts and extractComments.ts both document. `singleDollarTextMath:
 * false` is the same deliberate deviation from remark-math's own default that
 * pipeline.ts pins, and it must match: a document whose "$50K to $120K" prose
 * parses as inline math in ONE exporter and as prose in another is worse than
 * either answer alone.
 */
export function parseDocxTree(content: string): Root {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter, ['yaml'])
    .use(remarkMath, { singleDollarTextMath: false })
    .use(remarkPagebreak)
    .use(remarkComment)
  return processor.runSync(processor.parse(content)) as Root
}

/**
 * Every LOCAL image reference in the tree, deduplicated, in the exact `src`
 * spelling the Markdown used -- which is the key BuildDocxOptions.images must
 * be built with. Reference-style images (`![alt][ref]`) are resolved against
 * the document's own definitions here, so the caller never has to know the
 * difference.
 *
 * Remote references are deliberately excluded: nothing in this export ever
 * fetches one, so asking the caller to resolve one would be asking it to add
 * the network path this feature specifically does not have.
 */
export function collectLocalImageSrcs(tree: Root): string[] {
  const definitions = collectDefinitions(tree)
  const srcs = new Set<string>()
  visit(tree, (node) => {
    if (node.type === 'image') {
      const url = (node as Image).url
      if (isRelativeLocalPath(url)) srcs.add(url)
    } else if (node.type === 'imageReference') {
      const url = definitions.get((node as ImageReference).identifier.toLowerCase())?.url
      if (url && isRelativeLocalPath(url)) srcs.add(url)
    }
  })
  return [...srcs]
}

/** Builds the in-memory `docx` Document. Separated from packing so tests can
 * assert on the produced XML without going through a zip round trip. */
export function buildDocxDocument(options: BuildDocxOptions): Document {
  return new DocxBuilder(options).build()
}

/**
 * Full conversion: Markdown source in, real .docx file bytes out.
 *
 * Returns a Buffer rather than writing anything -- this module never touches
 * the filesystem, which is what keeps it Electron-free and directly testable.
 */
export async function markdownToDocx(options: BuildDocxOptions): Promise<Buffer> {
  return Packer.toBuffer(buildDocxDocument(options))
}

// ---------------------------------------------------------------------------
// Conversion.
// ---------------------------------------------------------------------------

function collectDefinitions(tree: Root): Map<string, Definition> {
  const definitions = new Map<string, Definition>()
  // Definitions may appear anywhere, including AFTER the reference that uses
  // them, so this must be a complete pre-pass rather than resolved inline --
  // the same two-pass shape detectRemoteImages.ts already needs.
  visit(tree, 'definition', (node: Definition) => {
    definitions.set(node.identifier.toLowerCase(), node)
  })
  return definitions
}

const HEADING_LEVELS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6
] as const

const ALIGNMENT_BY_MDAST = {
  left: AlignmentType.LEFT,
  right: AlignmentType.RIGHT,
  center: AlignmentType.CENTER
} as const

// {n} / {total}, the same two tokens document-style.ts's own
// buildRunningContentCss substitutes for CSS counters. Split-capturing so the
// literal chunks between them survive in order.
const RUNNING_CONTENT_TOKENS = /(\{n\}|\{total\})/g

class DocxBuilder {
  private readonly tree: Root
  private readonly config: PageConfig
  private readonly style: DocumentStyle
  private readonly typography: DocxTypography
  private readonly definitions: Map<string, Definition>
  private readonly images: ReadonlyMap<string, DocxImageAsset>
  private readonly allowRemoteImages: boolean
  private readonly contentWidthPx: number
  private readonly rtl: boolean

  /** mdast footnote identifier -> the 1-based number Word will print. */
  private readonly footnoteNumbers = new Map<string, number>()
  private readonly footnoteDefinitions = new Map<string, FootnoteDefinition>()
  /** One numbering config per ordered list, so each restarts at its own `start`. */
  private readonly numberingConfigs: { reference: string; levels: ILevelsOptions[] }[] = []
  private orderedListCount = 0
  private quoteDepth = 0

  constructor(private readonly options: BuildDocxOptions) {
    this.tree = parseDocxTree(options.content)
    this.config = resolvePageConfig(options.content)
    this.style = resolveDocumentStyle(this.config)
    this.typography = resolveDocxTypography(this.style)
    this.definitions = collectDefinitions(this.tree)
    this.images = options.images ?? new Map()
    this.allowRemoteImages = options.allowRemoteImages === true
    this.contentWidthPx = computePageGeometry(this.config).contentWidthPx
    this.rtl = this.style.direction === 'rtl'
    this.collectFootnotes()
  }

  build(): Document {
    const geometry = computePageGeometry(this.config)
    // Body FIRST: walking the tree is what registers the numbering configs and
    // footnote bodies the Document options below have to already contain.
    const body = this.renderBlocks(this.tree.children)

    const landscape = this.config.orientation === 'landscape'
    return new Document({
      title: this.options.title,
      creator: 'PageDown',
      // Word applies its own defaults (Calibri 11pt) to anything a run does
      // not state, so the document default is set explicitly -- otherwise a
      // table cell or a footnote body that this code did not think to stamp
      // silently reverts to Calibri beside Georgia body text.
      styles: {
        default: {
          document: {
            run: {
              font: this.typography.bodyFont,
              size: pxToHalfPoints(this.typography.bodyPx)
            }
          }
        }
      },
      numbering: { config: this.numberingConfigs },
      footnotes: this.buildFootnotes(),
      sections: [
        {
          properties: {
            page: {
              size: {
                orientation: landscape ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT,
                // DOUBLE SWAP, and it is deliberate rather than a bug that
                // cancels out. computePageGeometry has ALREADY applied
                // orientation (it swaps width/height itself), so
                // geometry.pageWidthPx is the final on-page width. But
                // `docx`'s own createPageSize ALSO swaps when orientation is
                // LANDSCAPE (read from the installed package: `w:w` is set
                // from `height` in that branch). Passing the geometry values
                // straight through would therefore emit a landscape page
                // that is TALLER than it is wide. Swapping them back here so
                // the library's swap restores them is the only way to get
                // both a correct `w:pgSz` and a correct `w:orient` -- and
                // `w:orient` matters on its own, because it is what Word's
                // own Page Setup UI and the print pipeline read.
                width: pxToTwip(landscape ? geometry.pageHeightPx : geometry.pageWidthPx),
                height: pxToTwip(landscape ? geometry.pageWidthPx : geometry.pageHeightPx)
              },
              margin: {
                top: pxToTwip(geometry.marginTopPx),
                right: pxToTwip(geometry.marginRightPx),
                bottom: pxToTwip(geometry.marginBottomPx),
                left: pxToTwip(geometry.marginLeftPx)
              },
              pageNumbers: {
                formatType:
                  this.style.pageNumberFormat === 'roman'
                    ? NumberFormat.LOWER_ROMAN
                    : NumberFormat.DECIMAL
              }
            }
          },
          headers: this.style.header
            ? { default: new Header({ children: [this.runningContent(this.style.header)] }) }
            : undefined,
          footers: this.style.footer
            ? { default: new Footer({ children: [this.runningContent(this.style.footer)] }) }
            : undefined,
          // A section with an empty body produces a .docx Word will open but
          // several readers report as damaged, so an empty document still gets
          // one empty paragraph.
          children: body.length > 0 ? body : [new Paragraph({})]
        }
      ]
    })
  }

  // -------------------------------------------------------------------------
  // Running header/footer.
  // -------------------------------------------------------------------------

  /**
   * One paragraph carrying the left/centre/right bands, using Word's own
   * idiom for that: a centre tab stop at half the content width and a right
   * tab stop at the full content width, with literal tabs between the three
   * pieces. Rejected alternative: a three-cell borderless table, which is what
   * some exporters do -- it survives less well through Word's own header
   * editing UI and turns a one-line header into a structure the user has to
   * navigate with arrow keys.
   *
   * The left band is emitted even when empty, because the tabs are positional:
   * dropping an empty left band would shift the centre band into the left
   * slot.
   */
  private runningContent(content: PageRunningContent): Paragraph {
    const children: ParagraphChild[] = []
    children.push(...this.runningContentRuns(content.left))
    children.push(new TextRun({ children: [new Tab()] }))
    children.push(...this.runningContentRuns(content.center))
    children.push(new TextRun({ children: [new Tab()] }))
    children.push(...this.runningContentRuns(content.right))
    return new Paragraph({
      bidirectional: this.rtl,
      tabStops: [
        { type: TabStopType.CENTER, position: pxToTwip(this.contentWidthPx / 2) },
        { type: TabStopType.RIGHT, position: pxToTwip(this.contentWidthPx) }
      ],
      children
    })
  }

  /**
   * Substitutes {n}/{total} with real Word PAGE and NUMPAGES fields, the exact
   * counterpart of buildRunningContentCss's counter(page)/counter(pages).
   * These are live fields Word recomputes, not baked-in numbers -- which is
   * the whole reason page numbering is worth carrying across at all.
   *
   * Header/footer text is untrusted (hand-editable frontmatter), but unlike
   * the CSS path there is nothing to escape here: it becomes the TEXT CONTENT
   * of a `w:t` element, which `docx` writes through its own XML escaper, so it
   * cannot terminate an attribute or open an element. The dangerous shape in
   * the CSS surface -- a quote closing a string literal and injecting
   * declarations -- has no analogue in this one.
   */
  private runningContentRuns(text: string): ParagraphChild[] {
    const runs: ParagraphChild[] = []
    for (const chunk of text.split(RUNNING_CONTENT_TOKENS)) {
      if (chunk === '') continue
      if (chunk === '{n}') runs.push(new TextRun({ children: [PageNumber.CURRENT] }))
      else if (chunk === '{total}') runs.push(new TextRun({ children: [PageNumber.TOTAL_PAGES] }))
      else runs.push(new TextRun({ text: chunk }))
    }
    return runs
  }

  // -------------------------------------------------------------------------
  // Footnotes.
  // -------------------------------------------------------------------------

  /**
   * Numbers footnotes by the order their REFERENCES appear, not the order
   * their definitions do -- which is what a reader expects and what every
   * other renderer of this document already does (mdast-util-to-hast's own
   * footer handler orders by first reference too). A definition nobody
   * references is dropped rather than printed with no marker to reach it.
   */
  private collectFootnotes(): void {
    visit(this.tree, 'footnoteDefinition', (node: FootnoteDefinition) => {
      this.footnoteDefinitions.set(node.identifier.toLowerCase(), node)
    })
    visit(this.tree, 'footnoteReference', (node) => {
      const identifier = (node as { identifier: string }).identifier.toLowerCase()
      if (this.footnoteNumbers.has(identifier)) return
      if (!this.footnoteDefinitions.has(identifier)) return
      this.footnoteNumbers.set(identifier, this.footnoteNumbers.size + 1)
    })
  }

  private buildFootnotes(): Record<string, { children: Paragraph[] }> | undefined {
    if (this.footnoteNumbers.size === 0) return undefined
    const footnotes: Record<string, { children: Paragraph[] }> = {}
    for (const [identifier, number] of this.footnoteNumbers) {
      const definition = this.footnoteDefinitions.get(identifier)
      if (!definition) continue
      // A footnote body may contain any flow content, but `docx`'s footnote
      // option only accepts Paragraphs (its own type says so), so anything
      // that renders as a Table -- a GFM table inside a footnote -- is
      // dropped rather than crashing the export. Rare enough to be worth the
      // simplicity; disclosed rather than silently mishandled.
      footnotes[String(number)] = {
        children: this.renderBlocks(definition.children).filter(
          (child): child is Paragraph => child instanceof Paragraph
        )
      }
    }
    return footnotes
  }

  // -------------------------------------------------------------------------
  // Blocks.
  // -------------------------------------------------------------------------

  private renderBlocks(nodes: readonly RootContent[]): (Paragraph | Table)[] {
    const out: (Paragraph | Table)[] = []
    for (const node of nodes) out.push(...this.renderBlock(node))
    return out
  }

  private renderBlock(node: RootContent): (Paragraph | Table)[] {
    switch (node.type) {
      // Frontmatter must never appear as body text -- it is configuration,
      // and it is already consumed above via resolvePageConfig. Only `yaml` is
      // listed because parseDocxTree enables remark-frontmatter for yaml only
      // (matching pipeline.ts), so a `toml` node cannot occur.
      case 'yaml':
        return []
      // Reference-link definitions are resolved inline (collectDefinitions);
      // the definition line itself is not document text.
      case 'definition':
        return []
      // Rendered as real Word footnotes at the bottom of the page, so the
      // definition block does not also appear inline in the body.
      case 'footnoteDefinition':
        return []
      case 'heading':
        return [this.renderHeading(node as Heading)]
      case 'paragraph':
        return [
          new Paragraph({
            ...this.paragraphBase(),
            children: this.renderInline((node as MdParagraph).children)
          })
        ]
      case 'thematicBreak':
        // Word has no <hr> element; a paragraph with only a bottom border is
        // the conventional representation and is what Word itself produces
        // for its own "---" autoformat.
        return [
          new Paragraph({
            ...this.paragraphBase(),
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'BFBFBF', space: 1 } }
          })
        ]
      case 'pagebreak':
        return [this.renderPagebreak()]
      case 'blockquote':
        return this.renderBlockquote(node as Blockquote)
      case 'list':
        return this.renderList(node as List, 0)
      case 'code':
        return [this.renderCode(node as { value: string })]
      case 'math':
        // Matches HTML export's own disclosed choice exactly: math stays an
        // inert source-text block. Converting LaTeX to OOXML's OMML is a real
        // project (a second, independent maths typesetter), not something to
        // half-build inside an exporter -- and silently DROPPING an equation
        // would be strictly worse than showing its source.
        return [this.renderCode({ value: (node as { value: string }).value })]
      case 'table':
        return [this.renderTable(node as MdTable)]
      case 'comment':
        // Authoring metadata, exactly as it is excluded from PDF: the marked
        // span's CONTENT is real document text and is kept, the comment
        // itself leaves no trace.
        return this.renderBlocks((node as Comment).children as RootContent[])
      case 'html':
        // Raw HTML has no meaningful .docx representation. Dropping the NODE
        // keeps the text: CommonMark splits `<span>text</span>` into three
        // siblings (html, text, html), so the prose between the tags is a
        // separate node that survives -- only the markup itself is lost.
        return []
      default:
        // Any node type with children still contributes its text rather than
        // vanishing -- a conservative default that degrades unknown or future
        // constructs to their content instead of to nothing.
        if ('children' in node && Array.isArray(node.children)) {
          return [
            new Paragraph({
              ...this.paragraphBase(),
              children: this.renderInline(node.children as PhrasingContent[])
            })
          ]
        }
        return []
    }
  }

  private renderHeading(node: Heading): Paragraph {
    const px = this.typography.headingPx[node.depth] ?? this.typography.bodyPx
    return new Paragraph({
      ...this.paragraphBase(),
      // Both the built-in heading style AND explicit run properties. The style
      // is what gives Word a real outline (the navigation pane, PDF bookmarks,
      // Table-of-Contents fields all read it and none of them read font size);
      // the explicit size/colour is what makes the heading actually LOOK like
      // this document's own ramp rather than Word's blue Calibri Heading 1.
      heading: HEADING_LEVELS[node.depth - 1],
      children: this.renderInline(node.children, {
        bold: true,
        size: pxToHalfPoints(px),
        font: this.typography.bodyFont,
        color: '000000'
      })
    })
  }

  private renderPagebreak(): Paragraph {
    // A real `w:br w:type="page"`, which is the one thing in this whole export
    // that translates EXACTLY -- the app's own marker convention and Word's
    // own hard page break mean precisely the same thing.
    return new Paragraph({ ...this.paragraphBase(), children: [new PageBreak()] })
  }

  /**
   * Quote depth is BUILDER STATE consulted by paragraphBase, not a parameter
   * threaded through every render method, and that is a fix for a real bug
   * rather than a shortcut. `docx`'s Paragraph has no setter for its own
   * properties, so an indent has to be present in the options at
   * construction -- which means the first implementation here rendered the
   * quote's children normally and then rebuilt each result from the ORIGINAL
   * mdast node's `children`. That silently emptied every quoted block with no
   * phrasing children of its own (a fenced code block inside a quote lost its
   * code entirely, since `code` is a literal node with a `value` and no
   * `children`) and duplicated any block that rendered to more than one
   * paragraph (every quoted list). Carrying the depth as state means each
   * block is rendered exactly once, by its own handler, and simply picks the
   * indent up from the base options.
   */
  private renderBlockquote(node: Blockquote): (Paragraph | Table)[] {
    this.quoteDepth += 1
    try {
      return this.renderBlocks(node.children)
    } finally {
      this.quoteDepth -= 1
    }
  }

  private renderList(node: List, depth: number): (Paragraph | Table)[] {
    const out: (Paragraph | Table)[] = []
    // A fresh numbering config per ordered list is what makes each list
    // restart at its own `start` value. Sharing one reference across every
    // ordered list in the document -- the obvious first implementation -- makes
    // the second list continue counting from where the first stopped, which is
    // Word's documented behaviour for a shared numId and is exactly wrong here.
    const reference = node.ordered ? this.registerOrderedNumbering(node) : null

    for (const item of node.children) {
      out.push(...this.renderListItem(item, node, depth, reference))
    }
    return out
  }

  private registerOrderedNumbering(node: List): string {
    const reference = `pagedown-ordered-${this.orderedListCount++}`
    this.numberingConfigs.push({
      reference,
      // Nine levels because that is OOXML's own maximum list depth; the
      // format cycles decimal / lower-letter / lower-roman the way Word's own
      // default multilevel list does.
      //
      // All nine are defined even though one list only ever uses the level it
      // sits at, because a NESTED ordered list registers its OWN config (this
      // method is called once per `list` node, at whatever depth) and then
      // writes items at `ilvl` = its depth -- so a config whose levels stopped
      // at 0 would leave a level-2 item with no format to render. Verified in
      // the produced numbering.xml, not assumed: a list nested one deep emits
      // `ilvl=1` against its own numId and picks up the lowerLetter level here.
      levels: Array.from({ length: 9 }, (_, level) => ({
        level,
        format: [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN][level % 3],
        text: `%${level + 1}.`,
        alignment: AlignmentType.START,
        start: level === 0 ? (node.start ?? 1) : 1,
        style: { paragraph: { indent: { left: 360 * (level + 1), hanging: 260 } } }
      }))
    })
    return reference
  }

  private renderListItem(
    item: ListItem,
    list: List,
    depth: number,
    reference: string | null
  ): (Paragraph | Table)[] {
    const out: (Paragraph | Table)[] = []
    // A GFM task item carries its own visible marker, so it deliberately gets
    // NO list bullet/number -- a bullet AND a checkbox reads as two markers
    // for one item. Decided per ITEM rather than per list, because GFM allows
    // a list to mix task and plain items.
    const isTask = item.checked === null || item.checked === undefined ? false : true
    let first = true

    for (const child of item.children) {
      if (child.type === 'list') {
        out.push(...this.renderList(child, depth + 1))
        continue
      }
      if (child.type !== 'paragraph') {
        // Anything else inside a list item (a code block, a blockquote, a
        // nested table) renders as its own block, indented to the item's
        // level but without repeating the marker.
        for (const rendered of this.renderBlock(child)) out.push(rendered)
        first = false
        continue
      }

      const inline = this.renderInline(child.children)
      const marker = isTask
        ? [new TextRun({ text: item.checked ? '☒ ' : '☐ ', font: this.typography.bodyFont })]
        : []
      const listOptions: IParagraphOptions =
        first && !isTask ? this.listMarkerOptions(list, depth, reference) : {}
      out.push(
        new Paragraph({
          ...this.paragraphBase(),
          ...listOptions,
          // A task item and a continuation paragraph both need the indent the
          // numbering would otherwise have supplied.
          ...(isTask || !first ? { indent: { left: 360 * (depth + 1) } } : {}),
          children: [...(first ? marker : []), ...inline]
        })
      )
      first = false
    }

    if (out.length === 0) {
      // An empty list item still has to occupy a numbered slot, or every
      // following item shifts up by one.
      out.push(
        new Paragraph({
          ...this.paragraphBase(),
          ...this.listMarkerOptions(list, depth, reference)
        })
      )
    }
    return out
  }

  private listMarkerOptions(
    list: List,
    depth: number,
    reference: string | null
  ): IParagraphOptions {
    if (list.ordered && reference) return { numbering: { reference, level: Math.min(depth, 8) } }
    // Word's own built-in bullet numbering, which `docx` exposes directly --
    // no numbering config needed, and it produces the disc/circle/square
    // cascade a reader expects from a nested bullet list.
    return { bullet: { level: Math.min(depth, 8) } }
  }

  // Takes the narrow shape it actually uses rather than a `Code` node, so the
  // block-math case can reuse it without a cast between two unrelated mdast
  // types.
  private renderCode(node: { value: string }): Paragraph {
    // ONE paragraph with hard line breaks between lines, not one paragraph per
    // line. Shading is a paragraph property, so per-line paragraphs would
    // produce a stack of separately-shaded strips with visible seams between
    // them, and Word would happily insert its own paragraph spacing into the
    // middle of the block.
    const lines = node.value.split('\n')
    const runs = lines.map(
      (line, index) =>
        new TextRun({
          text: line,
          font: DOCX_MONO_FONT,
          size: pxToHalfPoints(this.typography.bodyPx),
          break: index === 0 ? undefined : 1
        })
    )
    return new Paragraph({
      ...this.paragraphBase(),
      shading: { type: ShadingType.CLEAR, fill: 'F6F8FA' },
      border: {
        top: { style: BorderStyle.SINGLE, size: 4, color: 'D0D7DE', space: 4 },
        bottom: { style: BorderStyle.SINGLE, size: 4, color: 'D0D7DE', space: 4 },
        left: { style: BorderStyle.SINGLE, size: 4, color: 'D0D7DE', space: 4 },
        right: { style: BorderStyle.SINGLE, size: 4, color: 'D0D7DE', space: 4 }
      },
      children: runs.length > 0 ? runs : [new TextRun({ text: '', font: DOCX_MONO_FONT })]
    })
  }

  private renderTable(node: MdTable): Table {
    const columnCount = node.children.reduce((max, row) => Math.max(max, row.children.length), 0)
    // Equal column widths in DXA (twips). A fixed layout with real widths is
    // used rather than leaving it to Word's auto-fit, because auto-fit measures
    // content and would collapse a table of short cells to a fraction of the
    // page -- the document's own table spans the content box, and that is the
    // one table property worth carrying across.
    const columnWidth =
      columnCount > 0 ? Math.floor(pxToTwip(this.contentWidthPx) / columnCount) : 0

    const rows = node.children.map((row: MdTableRow, rowIndex: number) => {
      const cells = row.children.map((cell: MdTableCell, columnIndex: number) =>
        this.renderTableCell(cell, node.align?.[columnIndex] ?? null, rowIndex === 0, columnWidth)
      )
      // Pad short rows: a GFM row may legally have fewer cells than the header,
      // and a Word table row with a missing cell renders as a torn grid.
      while (cells.length < columnCount) {
        cells.push(
          new TableCell({
            width: { size: columnWidth, type: WidthType.DXA },
            children: [new Paragraph({})]
          })
        )
      }
      return new TableRow({
        children: cells,
        // Repeats the header row at the top of every page the table spans --
        // one of the few genuinely good things Word does that this app's own
        // paginator does not.
        tableHeader: rowIndex === 0
      })
    })

    return new Table({
      rows,
      width: { size: pxToTwip(this.contentWidthPx), type: WidthType.DXA },
      columnWidths: Array.from({ length: columnCount }, () => columnWidth),
      ...(this.rtl ? { visuallyRightToLeft: true } : {})
    })
  }

  private renderTableCell(
    cell: MdTableCell,
    align: 'left' | 'right' | 'center' | null,
    isHeader: boolean,
    columnWidth: number
  ): TableCell {
    return new TableCell({
      width: { size: columnWidth, type: WidthType.DXA },
      shading: isHeader ? { type: ShadingType.CLEAR, fill: 'F6F8FA' } : undefined,
      children: [
        new Paragraph({
          ...(this.rtl ? { bidirectional: true } : {}),
          alignment: align ? ALIGNMENT_BY_MDAST[align] : undefined,
          children: this.renderInline(cell.children, isHeader ? { bold: true } : undefined)
        })
      ]
    })
  }

  /**
   * The properties EVERY paragraph this exporter emits starts from.
   *
   * `bidirectional` is omitted entirely rather than set to `false` for an ltr
   * document: `docx` writes the option out either way, so a plain English
   * document would otherwise carry a `<w:bidi w:val="false"/>` on every single
   * paragraph -- inert, but it is the kind of noise that makes a diff of the
   * generated XML unreadable and makes the file look machine-mangled to anyone
   * who opens it in Word's own XML view.
   */
  private paragraphBase(): IParagraphOptions {
    return {
      ...(this.rtl ? { bidirectional: true } : {}),
      // A quoted block indents once per nesting level and carries the vertical
      // rule Markdown readers expect. Applied here rather than by the
      // blockquote handler so it reaches EVERY block type a quote can contain,
      // including ones with no inline children of their own.
      ...(this.quoteDepth > 0
        ? {
            indent: { left: pxToTwip(24 * this.quoteDepth) },
            border: { left: { style: BorderStyle.SINGLE, size: 12, color: 'D0D7DE', space: 8 } }
          }
        : {})
    }
  }

  // -------------------------------------------------------------------------
  // Inline content.
  // -------------------------------------------------------------------------

  private renderInline(
    nodes: readonly PhrasingContent[],
    inherited: IRunPropertiesOptions = {}
  ): ParagraphChild[] {
    const out: ParagraphChild[] = []
    for (const node of nodes) out.push(...this.renderInlineNode(node, inherited))
    return out
  }

  private renderInlineNode(
    node: PhrasingContent,
    inherited: IRunPropertiesOptions
  ): ParagraphChild[] {
    switch (node.type) {
      case 'text':
        return [new TextRun({ ...inherited, text: node.value })]
      case 'strong':
        return this.renderInline(node.children, { ...inherited, bold: true })
      case 'emphasis':
        return this.renderInline(node.children, { ...inherited, italics: true })
      case 'delete':
        return this.renderInline(node.children, { ...inherited, strike: true })
      case 'inlineCode':
        return [
          new TextRun({
            ...inherited,
            text: node.value,
            font: DOCX_MONO_FONT,
            shading: { type: ShadingType.CLEAR, fill: 'F0F1F3' }
          })
        ]
      case 'inlineMath':
        // Same disclosed treatment as block math -- inert source text, in the
        // code face so it is visibly not prose.
        return [
          new TextRun({
            ...inherited,
            text: (node as { value: string }).value,
            font: DOCX_MONO_FONT
          })
        ]
      case 'break':
        return [new TextRun({ ...inherited, text: '', break: 1 })]
      case 'link':
        return [this.renderLink((node as Link).url, (node as Link).children, inherited)]
      case 'linkReference': {
        const definition = this.definitions.get((node as LinkReference).identifier.toLowerCase())
        // An unresolved reference degrades to its own link TEXT rather than
        // disappearing -- the words were written on purpose even if the
        // definition is missing.
        if (!definition) return this.renderInline(node.children, inherited)
        return [this.renderLink(definition.url, node.children, inherited)]
      }
      case 'image':
        return this.renderImage((node as Image).url, (node as Image).alt ?? '', inherited)
      case 'imageReference': {
        const definition = this.definitions.get((node as ImageReference).identifier.toLowerCase())
        if (!definition) return [new TextRun({ ...inherited, text: node.alt ?? '' })]
        return this.renderImage(definition.url, node.alt ?? '', inherited)
      }
      case 'footnoteReference': {
        const number = this.footnoteNumbers.get(node.identifier.toLowerCase())
        return number === undefined ? [] : [new FootnoteReferenceRun(number)]
      }
      case 'comment':
        // The marked span's content survives; the comment does not.
        return this.renderInline((node as Comment).children as PhrasingContent[], inherited)
      case 'html':
        // See renderBlock's own `html` case: the tags go, the prose between
        // them is a sibling node and stays.
        return []
      default:
        return this.renderUnknownInline(node, inherited)
    }
  }

  /**
   * The catch-all for a phrasing node type this switch does not name.
   *
   * Takes `unknown` on purpose. TypeScript narrows an exhaustive switch's
   * `default` to `never`, so reading `.children`/`.value` off the narrowed
   * binding is a compile error the moment the cases happen to cover every
   * member of `PhrasingContent` -- and that union GROWS whenever any module in
   * this program adds a `declare module 'mdast'` augmentation, which several
   * already do (pagebreak, comment, math) and more will. Widening here keeps
   * this branch compiling either way, and keeps its actual job intact: a node
   * type nobody taught this exporter about still contributes its text rather
   * than silently vanishing from the document.
   */
  private renderUnknownInline(node: unknown, inherited: IRunPropertiesOptions): ParagraphChild[] {
    if (typeof node !== 'object' || node === null) return []
    const candidate = node as { children?: unknown; value?: unknown }
    if (Array.isArray(candidate.children)) {
      return this.renderInline(candidate.children as PhrasingContent[], inherited)
    }
    if (typeof candidate.value === 'string') {
      return [new TextRun({ ...inherited, text: candidate.value })]
    }
    return []
  }

  private renderLink(
    url: string,
    children: readonly PhrasingContent[],
    inherited: IRunPropertiesOptions
  ): ExternalHyperlink {
    return new ExternalHyperlink({
      link: url,
      children: this.renderInline(children, {
        ...inherited,
        style: 'Hyperlink'
      })
    })
  }

  /**
   * A local image becomes real embedded bytes; a remote one never does.
   *
   * Remote images are NOT fetched, with or without consent, and that is a
   * deliberate scope decision rather than an unfinished one: embedding one
   * would mean adding an HTTP client to the PRIVILEGED main process and
   * letting untrusted document content choose the URL it talks to -- a
   * genuinely new capability, for a format that (unlike HTML) cannot simply
   * carry the reference and let the reader's own renderer decide. The consent
   * flag still governs what is left behind: without consent the reference is
   * inert alt text, with consent it is a clickable link the reader can follow
   * deliberately.
   */
  private renderImage(
    url: string,
    alt: string,
    inherited: IRunPropertiesOptions
  ): ParagraphChild[] {
    if (isRemoteImageSrc(url)) {
      const label = alt !== '' ? alt : url
      if (!this.allowRemoteImages) return [new TextRun({ ...inherited, text: label })]
      return [this.renderLink(url, [{ type: 'text', value: label }], inherited)]
    }

    const asset = this.images.get(url)
    // Unreadable, oversized, wrong-format or (for an unsaved document)
    // unresolvable: every denial reason alike degrades to alt text, matching
    // resolveLocalImageDataUri's own no-oracle convention. One bad image never
    // fails the export.
    if (!asset) return [new TextRun({ ...inherited, text: alt })]

    // Scale down to the content box, never up: an image smaller than the
    // column stays at its natural size, exactly as it does on every other
    // surface (CSS `max-width: 100%`).
    const scale = Math.min(1, this.contentWidthPx / asset.widthPx)
    return [
      new ImageRun({
        type: asset.type,
        data: asset.data,
        altText: alt === '' ? undefined : { name: alt, title: alt, description: alt },
        transformation: {
          width: Math.max(1, Math.round(asset.widthPx * scale)),
          height: Math.max(1, Math.round(asset.heightPx * scale))
        }
      })
    ]
  }
}
