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
import type { PageGeometry } from '../typography/page-geometry'

export interface RenderRequestMessage {
  type: 'render'
  html: string
  requestId: string
  geometry: PageGeometry
}
