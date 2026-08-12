// The sandboxed pagination render context and the main process talk to each
// other over `window.postMessage` + `JSON.stringify` (see
// resources/pagination-render/index.ts's `window.addEventListener('message',
// ...)` and src/main/pagination-window.ts's `sendDocument`) -- a boundary
// TypeScript cannot check on its own, since neither side calls a shared
// function; each just builds/consumes a plain JSON payload. Before this
// module existed, that payload was an untyped object literal at the call
// site (`JSON.stringify({ type: 'render', html, requestId })`), so a field
// missing from it -- e.g. Page Geometry Wiring's own `geometry` -- was
// invisible to `tsc` and would only have surfaced at runtime, as a
// NaN-valued `@page` rule (`size: NaNin NaNin; margin: NaNin NaNin NaNin
// NaNin;`) silently producing wrong pagination for every document. This
// interface is the single source of truth for the 'render' message's shape:
// resources/pagination-render/index.ts's own `IncomingMessage` type derives
// from it directly (rather than restating the shape by hand), and
// pagination-window.ts builds its outgoing payload through a local typed as
// this interface before stringifying it -- so a forgotten field is a real
// compile error on whichever side drops it, not a silent runtime NaN.
//
// `documentStyle` (Page Setup Completeness sub-project) is covered by the
// exact same guarantee as `geometry`: a forgotten field here is a compile
// error at whichever sender drops it, not a silent runtime surprise (a
// missing theme/font body class, or an absent header/footer margin box)
// inside the sandbox.
import type { PageGeometry } from '../typography/page-geometry'
import type { DocumentStyle } from '../typography/document-style'

export interface RenderRequestMessage {
  type: 'render'
  html: string
  requestId: string
  geometry: PageGeometry
  documentStyle: DocumentStyle
  /**
   * Whether this render's output should be scaled down (visually only, after
   * pagination) so a full page fits the render context's own viewport width.
   *
   * OPTIONAL, defaulting to "no", and that is a deliberate inversion of this
   * module's usual make-it-required discipline. `geometry`/`documentStyle` are
   * required because a sender that forgets one produces a silently WRONG
   * render (a `@page { size: NaNin }` rule, a missing theme class). This field
   * fails the other way round: forgetting it costs a preview that is not
   * fitted -- visible, cosmetic, recoverable -- while a sender that set it by
   * accident would scale a PDF export or a Home-screen thumbnail. Defaulting
   * to `false` means every existing sender, and every future one that does not
   * think about this, keeps producing true-to-size output.
   *
   * Only `src/main/split-preview-window.ts` sets it: Split mode's preview is
   * the one surface whose viewport is an arbitrary, user-draggable fraction of
   * the window rather than exactly one page wide. It CANNOT be inferred inside
   * the render context from the viewport alone -- every headless harness
   * (thumbnails, page count, PDF export) sizes its view to exactly
   * `PAGE_WIDTH_PX`, so "is my viewport narrower than a page?" answers yes for
   * them too once the fit gutter is subtracted, and they would quietly render
   * at 0.99.
   */
  fitToWidth?: boolean
}
