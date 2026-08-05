import { $prose } from '@milkdown/utils'
import { Plugin } from '@milkdown/prose/state'
import type { Node as ProseMirrorNode } from '@milkdown/prose/model'
import type { NodeView } from '@milkdown/prose/view'

// Confirmed live, real vulnerability (not theoretical): @milkdown/preset-commonmark's
// stock `imageSchema` (node/image.ts) has `toDOM: (node) => ['img', {
// ...ctx.get(imageAttr.key)(node), ...node.attrs }]` -- node.attrs.src is
// spread LAST, so it always wins over anything imageAttr's own Ctx override
// tries to set, meaning overriding imageAttr cannot sanitize `src`. Verified
// directly against the real built app (not jsdom, which doesn't enforce CSP
// or do real resource loads): opening a document containing
// `![x](file:///path/to/any/local/file)` renders a real <img> element in
// Milkdown's mount -- which lives in the PRIVILEGED app-shell renderer (full
// contextBridge/disk access), not the sandboxed pagedown-render:// context --
// and that image genuinely LOADS (a real 1x1 test PNG measured
// naturalWidth/naturalHeight of 1x1, i.e. successfully read and decoded from
// disk), completely unrestricted by path. A same-test remote `http://` image
// WAS correctly blocked (confirmed via a real `securitypolicyviolation`
// event against src/renderer/index.html's `img-src 'self' data:` CSP) --
// only the `file:`/local-path case is unmitigated, exactly the "hostile
// <img> in a context with disk access" scenario CLAUDE.md's File I/O
// security section and the master design doc's Security section describe,
// except it was never actually closed for the WYSIWYG surface (only
// designed for the sandboxed render context, which -- per Phase 0 Gate 4's
// own correction -- doesn't even serve local assets at all yet either;
// Format mode is the ONLY currently-mounted editing surface, so this is the
// live attack surface today, not a future one).
//
// Fix, chosen over two rejected alternatives:
// 1. REJECTED: overriding `imageAttr` (@milkdown/preset-commonmark's own
//    `$nodeAttr('image')` override hook) -- doesn't work, per the merge-order
//    bug explained above.
// 2. REJECTED: filtering the stock imageSchema/imageAttr/insertImageCommand/
//    insertImageInputRule plugins out of `commonmark`'s composed array by
//    reference and replacing them with a custom node -- `$nodeSchema`'s
//    return shape and whether it survives `commonmark`'s own `.flat()` call
//    as a stable, reference-comparable identity is an unverified internal
//    detail of a third-party library; getting the reference wrong would
//    silently no-op (leaving the vulnerable stock node in place) rather than
//    failing loudly. Too fragile for a security fix.
// 3. CHOSEN: a ProseMirror node view (a stable, public, first-class
//    ProseMirror API, not an internal implementation detail) registered for
//    the `image` node TYPE, which takes priority over the schema's own
//    `toDOM` for actual DOM rendering. This leaves the stock node's
//    parsing/serialization completely untouched (so Markdown round-trip
//    fidelity for image syntax -- already covered by round-trip.test.ts's
//    EDITOR_SCHEMA_PLUGINS composition -- is unaffected; this plugin is
//    correctly excluded from that list, same as historyProse/undoCommand/
//    insertPagebreakCommand, since it's rendering behavior, not schema) and
//    intercepts every path that could produce an image node with an unsafe
//    `src` -- typed markdown syntax, a loaded document, paste, or a future
//    insertImageCommand/toolbar call -- since the node view is keyed on node
//    type, not on how the node was created.
//
// Policy (interim, until the design doc's own "remote images blocked by
// default with a per-document Load/Keep-blocked prompt" and "local asset
// policy confined to the document's directory" features are built): only
// `data:` URIs render for real. `data:` is self-contained (no disk/network
// resolution at all) and is already the sandboxed render context's own
// `img-src` allowance (`'self' data:'`) -- allowing it here is consistent,
// not a double standard. Everything else (`http:`, `https:`, `file:`, bare
// relative paths that would resolve against the app's own file:// origin) is
// blocked -- conservatively matching "remote images blocked by default"
// rather than trying to distinguish remote-vs-local here, since neither
// consent system exists yet to safely allow either. `isSafeImageSrc` is the
// one function future work (remote-image consent, local-asset policy) needs
// to extend -- it's exported and unit-tested precisely so that extension has
// a clear, obvious seam.
export function isSafeImageSrc(src: string): boolean {
  return src.startsWith('data:image/')
}

class SafeImageView implements NodeView {
  dom: HTMLImageElement

  constructor(node: ProseMirrorNode) {
    this.dom = document.createElement('img')
    this.dom.draggable = false
    this.syncFrom(node)
  }

  private syncFrom(node: ProseMirrorNode): void {
    const src = typeof node.attrs.src === 'string' ? node.attrs.src : ''
    const alt = typeof node.attrs.alt === 'string' ? node.attrs.alt : ''
    const title = typeof node.attrs.title === 'string' ? node.attrs.title : ''
    const safe = isSafeImageSrc(src)

    // Never assign an unsafe value to `src` at all -- not even briefly --
    // rather than assign-then-clear, so there's no window where the real
    // browser image-loading machinery ever sees the real path/URL.
    this.dom.src = safe ? src : ''
    this.dom.alt = alt
    this.dom.title =
      !safe && src ? `Blocked for security: "${src}" is not a data: image. ${alt}`.trim() : title
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type.name !== 'image') return false
    this.syncFrom(node)
    return true
  }

  // Content-less atom node -- nothing here can be a valid insertion target
  // for a stray click/selection to "edit into", matching the stock node's
  // own `atom: true` schema flag.
  ignoreMutation(): boolean {
    return true
  }
}

export const safeImageViewProse = $prose(
  () =>
    new Plugin({
      props: {
        nodeViews: {
          image: (node) => new SafeImageView(node)
        }
      }
    })
)
