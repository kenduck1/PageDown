// Runs inside the sandboxed pagedown-render:// context (bundled into the
// resources/pagination-render entry — see scripts/build-pagination-render.ts
// — never into the main process; this file needs `document`/`window`,
// which don't exist there). Per the design doc's Mermaid diagram support
// section: Mermaid renders in exactly ONE place, this sandboxed render
// context, and never in the privileged app-shell renderer. This module is
// that one rendering entry point.
//
// CORRECTION (font-determinism fix): the sentence above used to end "— the
// WYSIWYG side only ever receives an already-rendered, sanitized SVG
// string." That describes a path which does not exist and never did,
// checked directly rather than assumed. `sendDocument`'s result payload
// (src/main/pagination-window.ts) carries `diagramBoxes: Array<{ id, width,
// height }>` — diagram IDS AND MEASURED SIZES ONLY, never SVG markup — and
// nothing under src/renderer/ renders Mermaid at all: a ```mermaid fence in
// the Milkdown canvas is an ordinary fenced code block showing its own
// source. The accurate statement is just the first one: Mermaid renders
// HERE and nowhere else, and its rendered form appears only on the
// paginated surfaces (Split-mode preview, PDF export, print, thumbnails,
// page count).
//
// Single pinned config, initialized once and reused for every diagram in
// every render pass across this context's lifetime — not a per-document or
// per-theme configurable API. That's deliberate Phase 0 scope: the real
// per-document theme/font system is out of scope for this spike (see the
// design doc's "One render, reused everywhere" section for the full
// content-hash-cache design this Phase 0 module does NOT implement).
import mermaid from 'mermaid'

// The font Mermaid measures and paints every diagram label in. Exported
// (rather than inlined into `mermaid.initialize` below) because it is one
// half of a two-part contract that spans two files, and splitting the
// string across them is exactly how the bug this constant exists to fix got
// shipped in the first place: this module PINS the family, and the render
// context (resources/pagination-render/index.ts's
// `ensureMermaidLabelFontRegistered` / `document.fonts.load`) must REGISTER
// AND LOAD that same family before calling renderMermaidToSvg. A literal
// here that no @font-face anywhere matches silently degrades to whatever
// the host machine happens to have installed — see the config comment
// below.
//
// 'Inter Variable' specifically, rather than a diagram-only third face:
// it is already vendored in this repo (src/renderer/src/assets/fonts/
// inter-variable.woff2, SIL OFL, 48KB) and already emitted into this very
// context as a base64 data: URI for documents whose own `fontFamily` is
// `inter`, so pointing diagram labels at it costs ZERO new bytes on disk
// and zero new licensing surface. Mermaid's default stack (Trebuchet MS,
// Verdana, Arial) was never an option — none of those are bundled with
// Chromium.
export const MERMAID_LABEL_FONT_FAMILY = 'Inter Variable'

let initialized = false

// Config choices below are pinned per the design doc's Mermaid section, not
// arbitrary spike defaults:
//   - securityLevel: 'strict' — the only security level this app ever uses.
//     'loose'/'antiscript' both leave Mermaid's click-callback script
//     execution live; the design doc's SiYuan reference is exactly the
//     zero-click-credential-theft shape that guards against.
//   - htmlLabels: false — Mermaid's default foreignObject-based label
//     rendering is a documented casualty of PDF export pipelines (label
//     text can silently vanish on export). Pinned off from the start rather
//     than discovered broken in Task 9/Gate 4's export spike.
//   - fontFamily: MERMAID_LABEL_FONT_FAMILY — a REAL, bundled, OFL face.
//     This value used to be the string 'PageDownSans', which named nothing:
//     no such font file was ever checked into this repo and no @font-face
//     ever declared it, so Mermaid measured every label in whatever the
//     render context's fallback happened to resolve to — i.e. in whatever
//     font the HOST MACHINE has installed. Since Mermaid sizes each node
//     box from its label's measured text extent, and those boxes then feed
//     Paged.js's page breaking, a document's PAGE COUNT around a diagram
//     varied machine to machine. That directly undercuts the determinism
//     argument the design doc uses to choose Electron over Tauri (ship one
//     known Chromium rather than inherit the host's webview), which is why
//     the design doc's Mermaid section calls for pinning a bundled font
//     here in the first place rather than treating it as polish.
//
//     Naming a bundled family here is necessary but NOT sufficient, and the
//     other half deliberately lives in the caller: an @font-face declared
//     in CSS is only fetched/decoded lazily, so Mermaid can still measure
//     against a fallback if it renders before the face has actually loaded.
//     resources/pagination-render/index.ts's renderMermaidDiagrams()
//     registers this family and `await document.fonts.load(...)`s it before
//     the first renderMermaidToSvg call of a render pass — see that
//     function for why the registration cannot simply ride along on the
//     per-document stylesheet Paged.js receives later. Gate 3
//     (tests/gates/gate3-mermaid.spec.ts) asserts the loaded-and-applied end
//     state in the real app rather than trusting either half.
export async function renderMermaidToSvg(
  diagramSource: string,
  elementId: string
): Promise<string> {
  if (!initialized) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      htmlLabels: false,
      fontFamily: MERMAID_LABEL_FONT_FAMILY
    })
    initialized = true
  }
  const { svg } = await mermaid.render(elementId, diagramSource)
  return svg
}
