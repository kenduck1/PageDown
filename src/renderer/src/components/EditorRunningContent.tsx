import { memo } from 'react'
import type { PageGeometry } from '../../../typography/page-geometry'
import { documentStyleClasses, type DocumentStyle } from '../../../typography/document-style'
import { computeEditorRunningBands } from '../../../typography/editor-running-content'

interface EditorRunningContentProps {
  geometry: PageGeometry
  style: DocumentStyle
  /** Sheets currently drawn in the card -- i.e. `seamCount + 1`. */
  pageCount: number
}

/**
 * Draws the document's running headers and footers onto the Format-mode page
 * card, one pair per sheet.
 *
 * These are real, printing content -- they appear in the paginated preview,
 * the exported PDF, the printed page and HTML/DOCX export. The canvas showed
 * none of them, which is the same divergence class as the old frontmatter box
 * in reverse: there the editor painted something the page does not have, here
 * it omitted something the page does.
 *
 * THREE THINGS THAT ARE LOAD-BEARING RATHER THAN INCIDENTAL:
 *
 * 1. `pointer-events: none`, and NOT rendered inside the ProseMirror DOM.
 *    Header/footer text is document CONFIGURATION (Page Setup writes it into
 *    frontmatter), not document content -- it has no position in the
 *    ProseMirror document, and putting it there would let a caret land in it.
 *    It is a sibling overlay for the same reason the page seam is drawn as a
 *    widget decoration rather than as editable text.
 *
 * 2. `aria-hidden`. The text is already reachable and editable through Page
 *    Setup; announcing it once per page would make a ten-page document read
 *    its own footer ten times.
 *
 * 3. The bands are positioned from `computeEditorRunningBands`, which derives
 *    page pitch from the same constants the card's own min-height and Split
 *    mode's Follow estimate use. A literal here would drift the moment a
 *    document's margins changed.
 */
export const EditorRunningContent = memo(function EditorRunningContent({
  geometry,
  style,
  pageCount
}: EditorRunningContentProps): React.JSX.Element | null {
  const bands = computeEditorRunningBands(geometry, style, pageCount)
  if (bands.length === 0) return null

  // Each band carries `pagedown-document` plus the same theme/font/size
  // classes the Milkdown mount does, so it inherits its typography from the
  // one stylesheet BOTH surfaces share rather than from values restated here.
  // That is what makes it match the paginated margin box by construction: over
  // there, Paged.js's `.pagedjs_margin-*` divs are descendants of the
  // sandbox's own `.pagedown-document` body and inherit exactly the same
  // rules. Restating a font size here would be a second source of truth, and
  // this file's whole reason for existing is that those drift.
  //
  // Applied per BAND rather than to the wrapper on purpose: `.pagedown-document`
  // pins an opaque white background, and the wrapper spans the full card
  // including the seam gutters, which must keep showing the canvas through.
  const bandClasses = ['pagedown-document', ...documentStyleClasses(style)].join(' ')

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {bands.map((band) => (
        <div
          key={`${band.band}-${band.pageNumber}`}
          data-testid={`running-${band.band}`}
          data-page={band.pageNumber}
          className={`${bandClasses} pagedown-running-content absolute flex items-center`}
          style={{
            top: band.topPx,
            left: band.leftPx,
            width: band.widthPx,
            height: band.heightPx
          }}
        >
          {/* Three equal tracks, so the centre band is centred on the CONTENT
              column rather than on whatever the left text happens to be --
              matching how Paged.js's own @top-left/@top-center/@top-right
              margin boxes divide that space. */}
          <span className="flex-1 truncate text-left">{band.left}</span>
          <span className="flex-1 truncate text-center">{band.center}</span>
          <span className="flex-1 truncate text-right">{band.right}</span>
        </div>
      ))}
    </div>
  )
})
