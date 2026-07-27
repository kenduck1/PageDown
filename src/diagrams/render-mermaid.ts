// Runs inside the sandboxed pagedown-render:// context (bundled into the
// resources/pagination-render entry — see scripts/build-pagination-render.ts
// — never into the main process; this file needs `document`/`window`,
// which don't exist there). Per the design doc's Mermaid diagram support
// section: Mermaid renders in exactly ONE place, this sandboxed render
// context, and never in the privileged app-shell renderer — the WYSIWYG
// side only ever receives an already-rendered, sanitized SVG string. This
// module is that one rendering entry point.
//
// Single pinned config, initialized once and reused for every diagram in
// every render pass across this context's lifetime — not a per-document or
// per-theme configurable API. That's deliberate Phase 0 scope: the real
// per-document theme/font system is out of scope for this spike (see the
// design doc's "One render, reused everywhere" section for the full
// content-hash-cache design this Phase 0 module does NOT implement).
import mermaid from 'mermaid'

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
//   - fontFamily: 'PageDownSans' — the design doc's planned bundled OFL
//     font. Not actually bundled anywhere in this Phase 0 spike (no
//     font-loading infrastructure exists yet, and no such font file is
//     checked into this repo) — Gate 3's job is only to confirm Mermaid
//     honors this config value and that diagram sizing stays non-zero and
//     deterministic even when the named font falls back to whatever's
//     available in the render context, not to prove the bundled font
//     itself renders. See phase0/gate3-mermaid.spec.ts and this task's
//     findings-doc entry for what was actually checked.
export async function renderMermaidToSvg(
  diagramSource: string,
  elementId: string
): Promise<string> {
  if (!initialized) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      htmlLabels: false,
      fontFamily: 'PageDownSans'
    })
    initialized = true
  }
  const { svg } = await mermaid.render(elementId, diagramSource)
  return svg
}
