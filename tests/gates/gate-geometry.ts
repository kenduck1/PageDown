import { computePageGeometry } from '../../src/typography/page-geometry'
import { DEFAULT_PAGE_CONFIG } from '../../src/markdown/page-config'
import { DEFAULT_DOCUMENT_STYLE } from '../../src/typography/document-style'

// Page Geometry Wiring: harness.sendDocument now requires a real geometry
// argument. Every gate that drives a pagination harness directly therefore
// has to compute one, and every one of them wants the SAME one -- the
// DEFAULT, no-frontmatter geometry (Letter/portrait/1in margins), because
// their fixtures and reference corpora predate per-document page config and
// carry no page-config frontmatter at all. Per-document geometry is
// gate16-page-geometry.spec.ts's concern; it is deliberately NOT what these
// gates measure.
//
// Two things make this a shared module rather than a one-liner each gate
// restates. First, it was literally copy-pasted into six spec files
// (gate3, gate4, gate5, gate6, gate10, and tests/spike/gate3) along with a
// near-identical ten-line version of this comment, which the task review
// flagged; gate16 would have made a seventh. Second, and more important:
// these gates are only comparable to each other, and to their own committed
// baseline result artifacts (tests/gates/results/*.json), if they all paginate
// at the same page box -- one gate silently drifting onto a different
// PageConfig would move its page counts and break-quality measurements with
// no visible cause. One shared value makes that drift impossible instead of
// merely unlikely.
//
// Why it's computed at a Node-side module scope, and threaded through
// app.evaluate()'s single argument at each call site rather than imported
// inside the callback: an app.evaluate() callback runs in a bare V8 context
// with no working module resolution, so an imported binding simply isn't
// reachable from inside one. (Same constraint that makes the
// __pagedownPhase0 bridge exist -- see CLAUDE.md's "Known pre-existing
// issues".)
export const LETTER_GEOMETRY = computePageGeometry(DEFAULT_PAGE_CONFIG)

// Same rationale as LETTER_GEOMETRY above, for sendDocument's now-required
// `documentStyle` parameter (Page Setup Completeness sub-project, Task 5):
// every gate that drives a pagination harness directly needs one, and they
// all want the SAME default (no theme override, no font override, the
// default footer's own "Page {n} of {total}" running content) since none of
// their fixtures carry page-config frontmatter either. Re-exported here
// (rather than each gate importing it directly from
// src/typography/document-style.ts) purely so LETTER_GEOMETRY and this stay
// a single pair threaded through app.evaluate()'s args together -- not a
// hard requirement, just consistent with why LETTER_GEOMETRY itself is a
// shared module rather than six copy-pasted `computePageGeometry(...)`
// calls (see the module comment above).
export const DEFAULT_STYLE = DEFAULT_DOCUMENT_STYLE

/**
 * A JavaScript SOURCE EXPRESSION (not a value) evaluating, inside the
 * sandboxed render context, to the presentation scale that context is
 * currently showing its pages at -- 1 unless Split-mode fit-to-width is
 * active for that harness.
 *
 * WHY THIS EXISTS. Split mode's preview pane is fitted to width by a CSS
 * `zoom` on #content-root (resources/pagination-render/index.ts's
 * applyPreviewFitScale). `zoom` participates in layout, which is exactly why
 * it was chosen -- and it means `getBoundingClientRect()` inside that context
 * comes back already multiplied by it. Measured against this app's own
 * Chromium: a 794px-wide box inside `zoom: 0.7` reports `rect.width` 555.80
 * while `offsetWidth` still reports 794 and `getComputedStyle().width` still
 * reports 793.996px.
 *
 * Several gates ask a DOCUMENT-SPACE question of that context -- "is an A4
 * page really 794 CSS px wide?", "is the ruler the full 624px content width?"
 * -- which is a different question from "how big is it on screen right now".
 * Dividing a measured rect by this recovers the former from the latter, and
 * makes those gates independent of any presentation scaling rather than
 * silently coupled to the window size the divider happens to produce.
 *
 * Deliberately NOT solved by switching those probes to `offsetWidth`: that is
 * integer-rounded, and the assertions it would feed are `toBeCloseTo(x, 0)`,
 * i.e. tolerant to well under a pixel. It also would not fix the ones that
 * measure an OFFSET between two rects (gate16's `@page` margin-order pin).
 *
 * The presentation scale ITSELF is not this constant's business to check --
 * tests/gates/gate35-split-fit-to-width.spec.ts is where that is pinned, in both
 * panes, with its own would-have-failed-without-it half.
 */
export const PREVIEW_DOCUMENT_SCALE_JS =
  "(function () { var r = document.getElementById('content-root'); " +
  'var z = r ? parseFloat(window.getComputedStyle(r).zoom) : 1; ' +
  'return z > 0 ? z : 1 })()'
