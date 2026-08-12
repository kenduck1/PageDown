import { $prose } from '@milkdown/utils'
import { Plugin, PluginKey } from '@milkdown/prose/state'
import { closeHistory } from '@milkdown/prose/history'
import type { Node as ProseMirrorNode } from '@milkdown/prose/model'
import type { EditorView, NodeView } from '@milkdown/prose/view'
import { isRelativeLocalPath, isRemoteImageSrc } from '../../../markdown/local-image-src'
import { resizeWidthPercent } from '../lib/image-resize'

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
// ---------------------------------------------------------------------------
// POLICY, and what changed when local images started rendering for real
// ---------------------------------------------------------------------------
//
// `isSafeImageSrc` is UNCHANGED and deliberately so: the only value this
// module will ever assign to a live `<img>.src` is a `data:image/` URI.
// That was the interim policy when nothing but `data:` could be shown, and
// it stays the policy now that local images render -- because a resolved
// local image IS a `data:` URI by the time it gets here. Main reads the
// bytes; what crosses contextBridge is self-contained base64 with no
// filesystem meaning. So the invariant this file has always enforced ("the
// browser's image-loading machinery never sees a real path or URL from
// document content") is not relaxed by the new capability, it is reused by
// it -- which is why the assignment below re-checks `isSafeImageSrc` on the
// RESOLVED value too rather than trusting the resolver.
//
// Deliberately NOT done, and each would have been the easy version:
//  - Widening `isSafeImageSrc` to accept relative paths. That is the whole
//    vulnerability: a relative `src` in this renderer resolves against the
//    app's OWN `file://` origin (out/renderer/...), and a `file:` src reads
//    anything on disk. The renderer must never be handed a src it can fetch.
//  - Registering a `pagedown-render://`-style protocol for this renderer so
//    it could fetch `__asset__` URLs like the sandbox does. That hands the
//    one context with full contextBridge/disk access a URL-shaped file-read
//    primitive -- exactly the split the sandboxed render context exists to
//    maintain. The token registry is safe THERE precisely because that
//    context has no other disk access to compound it with.
//  - Reading files in the renderer via a "just give me the bytes for this
//    path" IPC call. That is an arbitrary-file-read primitive with extra
//    steps. The handler that backs this instead takes the DOCUMENT's path
//    (isKnownPath-validated) plus a relative reference, and does the
//    confinement check itself -- see file:resolveLocalImage in
//    src/main/index.ts.
//
// REMOTE (`http`/`https`) IMAGES STAY BLOCKED ON THIS SURFACE, unconditionally,
// even for a document whose remote-image consent has been granted -- and that
// is a deliberate, disclosed asymmetry with every other rendering surface, not
// an oversight or a missed wiring. Two independent reasons:
//  1. `src/renderer/index.html`'s CSP is `default-src 'self'` with no
//     `img-src` widening beyond `data:`, so a remote `<img>` here is blocked
//     by the platform regardless of what this file does. Honoring consent
//     here would mean widening the CSP of the PRIVILEGED renderer -- the one
//     process with full contextBridge and disk access. The sandboxed
//     paginator's own `img-src` was widened for exactly this feature (see
//     CLAUDE.md's Remote image consent section) precisely BECAUSE it is
//     sandboxed and its real gate is `applyRemoteImagePolicy` upstream; that
//     argument does not transfer to this context.
//  2. Routing remote images through the resolver instead would make the MAIN
//     process issue outbound network requests on a document's behalf, which
//     nothing in this app does today.
// The consent flag is therefore never consulted here, and cannot be routed
// around here: the resolver only ever asks about `isRelativeLocalPath` srcs,
// and `file:resolveLocalImage` independently refuses anything scheme-prefixed.
// The user still sees remote images in the Split preview, the exported PDF
// and the printed page once they grant consent; the canvas says so rather
// than rendering an unexplained blank. This is the one real gap left here,
// and closing it properly is a CSP decision, not a wiring change.
export function isSafeImageSrc(src: string): boolean {
  return src.startsWith('data:image/')
}

// What the node view can ask its host for. Only ever handed relative,
// document-local srcs (the node view checks first), and expected to resolve
// `null` rather than reject for every failure alike -- see
// window.api.resolveLocalImage's own contract.
export interface ImageResolver {
  resolveLocalImage: (src: string) => Promise<string | null>
}

// The node view needs a per-DOCUMENT resolver (it closes over the active
// tab's own file path), but `safeImageViewProse` below is a single static
// plugin registered once in EDITOR_COMMAND_PLUGINS -- so the resolver cannot
// be a constructor argument to it without turning that static export into a
// factory and changing its one call site.
//
// Passing it through ProseMirror plugin STATE instead is what keeps the two
// independent: a second, tiny, per-mount plugin (createImageResolverPlugin,
// built in MilkdownEditor.tsx from the same latest-ref callbacks every other
// per-mount plugin there uses) publishes the resolver, and the node view
// reads it off `view.state` at the moment it needs it. Plugin registration
// order is irrelevant -- all plugin state exists before any node view is
// constructed -- and an editor built WITHOUT the resolver plugin (the
// round-trip and schema-fidelity tests, which compose only
// EDITOR_SCHEMA_PLUGINS) simply reads `undefined` and degrades to exactly
// the pre-existing behaviour: local images show as unresolved, nothing
// throws.
const imageResolverKey = new PluginKey<ImageResolver>('pagedownImageResolver')

export function createImageResolverPlugin(resolver: ImageResolver): Plugin {
  return new Plugin({
    key: imageResolverKey,
    state: {
      init: () => resolver,
      // The resolver object itself is stable for a mount's lifetime (it
      // delegates through a latest-ref), so this never needs to change
      // across transactions.
      apply: (_tr, value) => value
    }
  })
}

// 'ok' -- a real `data:image/` URI is on the <img>, either because the
//         document said `data:` or because main resolved a local file.
// 'pending' -- a local reference is being resolved right now. Renders nothing
//         extra: local reads are a single stat+read and settle in a few ms,
//         so a "loading" chip would flash more than it informs.
// 'missing' -- a local reference that main declined to resolve. Undifferentiated
//         on purpose (missing file, `..` escape, oversize, not-really-an-image,
//         document not in the known-paths allowlist) because the resolver
//         itself is undifferentiated, for the anti-oracle reason documented on
//         resolveAssetPath.
// 'blocked' -- a src this surface will not render at all: remote, `file:`,
//         another scheme, or a root-absolute path.
type ImageState = 'ok' | 'pending' | 'missing' | 'blocked'

// The src is untrusted document content and can be arbitrarily long (a
// tracking URL with a query string, most plausibly). Rendered as real DOM
// TEXT via textContent, never as markup, so there is no injection concern --
// this bound is purely so one bad reference cannot blow out the line the
// user is editing.
const MAX_SHOWN_SRC_CHARS = 60

function shortenSrc(src: string): string {
  return src.length <= MAX_SHOWN_SRC_CHARS ? src : `${src.slice(0, MAX_SHOWN_SRC_CHARS - 1)}…`
}

function noteFor(state: ImageState, src: string): string {
  if (state === 'missing') return `Image not found: ${shortenSrc(src)}`
  if (state === 'blocked' && isRemoteImageSrc(src)) {
    return `Remote image (shown in preview and exports): ${shortenSrc(src)}`
  }
  if (state === 'blocked') return `Image blocked for security: ${shortenSrc(src)}`
  return ''
}

class SafeImageView implements NodeView {
  // A wrapper rather than the bare <img> this used to be, for one reason:
  // an <img> whose src is empty renders as literally nothing in Chromium --
  // no broken-image icon, no alt text, zero height -- so every non-rendering
  // case was previously an invisible gap in the document with the
  // explanation hidden in a `title` tooltip nobody hovers. The wrapper lets
  // a blocked or missing image say so in real, readable text. The <img>
  // itself is still always present inside it (so a resolved image is an
  // ordinary <img> the shared document-typography.css `img` rule styles
  // exactly as on every other surface), which is also why this change is
  // invisible to anything selecting `.milkdown-mount img`.
  dom: HTMLSpanElement
  private img: HTMLImageElement
  private note: HTMLSpanElement
  // The drag-to-resize grip, drawn INSIDE the image's own bottom-right corner.
  // Deliberately not a floating overlay: a WebContentsView (Split mode's live
  // preview) composites above ALL DOM unconditionally, so anything floating
  // over the canvas needs the clamp treatment floating-position.ts exists for
  // (the bubble menu) or PageSetupModal's zero-rect workaround. A grip that
  // lives inside the element it resizes cannot reach the preview's column by
  // construction, so it needs neither.
  private handle: HTMLSpanElement
  private view: EditorView
  private getPos: () => number | undefined
  // Set for the duration of a drag so the pointer listeners can be torn down
  // from destroy() as well as from pointerup -- ProseMirror destroys node
  // views eagerly (every key={revision} remount destroys all of them), and a
  // drag in flight at that moment must not leave listeners on window.
  private endDrag: (() => void) | null = null
  // What syncFrom last rendered from. Compared in update() so a width-only
  // change -- which is every drag commit -- does not re-run the whole resolve
  // path and tear a local image's src off for a visible flash.
  private synced = { src: '', alt: '', title: '' }
  // Bumped on every syncFrom. An async resolution that completes after its
  // generation has been superseded (the node's src changed, or this view was
  // reused for a different node) is discarded rather than applied -- without
  // this, editing an image's URL could land the OLD image's bytes on the NEW
  // reference, since the two resolutions race.
  private generation = 0
  // ProseMirror destroys node views eagerly (every key={revision} remount
  // destroys all of them). A resolution in flight at that moment must not
  // touch detached DOM.
  private destroyed = false

  constructor(node: ProseMirrorNode, view: EditorView, getPos: () => number | undefined) {
    this.view = view
    this.getPos = getPos
    this.dom = document.createElement('span')
    this.dom.className = 'pagedown-image'
    this.img = document.createElement('img')
    this.img.draggable = false
    this.note = document.createElement('span')
    this.note.className = 'pagedown-image-note'
    // The note is chrome, not document content: it must never be a caret
    // target, and it must never be picked up as text if the user selects
    // across the image.
    this.note.contentEditable = 'false'
    this.handle = document.createElement('span')
    this.handle.className = 'pagedown-image-resize-handle'
    this.handle.contentEditable = 'false'
    this.handle.draggable = false
    this.handle.title = 'Drag to resize'
    // aria-hidden because there is no keyboard equivalent to offer: this is a
    // pointer affordance for discoverability, and the syntax it writes
    // (`{width=50%}`) stays typeable in Source mode, which is the accessible
    // path. Announcing a control no assistive-technology user can operate
    // would be worse than announcing nothing.
    this.handle.setAttribute('aria-hidden', 'true')
    this.handle.addEventListener('pointerdown', this.onHandlePointerDown)
    this.dom.append(this.img, this.note, this.handle)
    this.syncFrom(node)
  }

  private setState(state: ImageState, src: string, alt: string, title: string): void {
    this.dom.dataset.state = state
    const note = noteFor(state, src)
    this.note.textContent = note
    this.note.hidden = note.length === 0
    this.img.alt = alt
    this.img.title = note ? [note, title].filter(Boolean).join(' — ') : title
    // Only a really-rendering image can be resized. For 'blocked'/'missing'
    // there is no picture on screen to grab a corner of, and for 'pending' the
    // width the drag would start from is not known yet.
    this.handle.hidden = state !== 'ok'
  }

  // The box a `%` width actually resolves against: the <img>'s containing
  // block, i.e. the nearest block container -- normally the paragraph holding
  // it. Measured off the live DOM rather than derived from
  // computePageGeometry, because the canvas sits inside a CSS `zoom` wrapper
  // and, in Split mode, a fit-to-width scale, so the geometry constants are
  // not what is on screen. Reading a rect keeps this in the same post-zoom
  // viewport space as the pointer coordinates -- see image-resize.ts on why
  // that is what makes the result zoom-invariant with nothing to divide by.
  private containerWidth(): number {
    const block = this.dom.parentElement
    return block ? block.getBoundingClientRect().width : 0
  }

  private onHandlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return
    const startWidthPx = this.img.getBoundingClientRect().width
    const containerWidthPx = this.containerWidth()
    if (startWidthPx <= 0 || containerWidthPx <= 0) return

    // preventDefault BEFORE anything else: it is what stops the pointerdown
    // from moving DOM focus and from starting a text selection across the
    // image. This node view never calls view.focus() either -- the same rule
    // applyFindState and the selection bubble already follow.
    event.preventDefault()
    event.stopPropagation()

    const startX = event.clientX
    // The drag mutates only the DOM, never the document, so there is exactly
    // ONE transaction for the whole gesture and it is one undo step BY
    // CONSTRUCTION rather than by coalescing after the fact. A transaction per
    // pointermove would also be re-serialized through the debounced onChange
    // path on every frame. ignoreMutation() already returns true for this node
    // view, so ProseMirror will not try to reconcile these writes away.
    let width = ''
    const onMove = (move: PointerEvent): void => {
      const next = resizeWidthPercent({
        startWidthPx,
        containerWidthPx,
        deltaPx: move.clientX - startX
      })
      if (next === null || next === width) return
      width = next
      this.img.setAttribute('width', width)
    }

    const finish = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      this.endDrag = null
      delete this.dom.dataset.resizing
      if (width) this.commitWidth(width)
    }

    this.endDrag = finish
    this.dom.dataset.resizing = 'true'
    // Listeners on window, not on the handle: the pointer routinely leaves the
    // 12px grip within the first few pixels of a drag, and a pointerup
    // released anywhere on screen still has to end the gesture.
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  }

  private commitWidth(width: string): void {
    const pos = this.getPos()
    if (typeof pos !== 'number') return
    const node = this.view.state.doc.nodeAt(pos)
    // Re-read from the CURRENT document rather than trusting the node this
    // view was constructed with: a drag is a real interval of time, and the
    // document can have moved underneath it.
    if (!node || node.type.name !== 'image') return
    if (node.attrs.width === width) return

    const tr = this.view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, width })
    // Forces prosemirror-history to open a new group, so a resize is its own
    // undo step instead of being merged into whatever typing happened within
    // newGroupDelay before it -- the same primitive and the same reason the
    // slash menu uses it for its own delete+insert. closeHistory can only
    // force a SPLIT, never a merge, so this pins the boundary before the
    // resize; two consecutive drags are therefore two undo steps, which is the
    // property that matters for a gesture the user repeats to converge on a
    // size.
    closeHistory(tr)
    this.view.dispatch(tr)
  }

  // The `{width=...}` size the document asked for (nodes/image-size.ts), put
  // on the real <img> as the HTML `width` DIMENSION ATTRIBUTE -- exactly the
  // attribute markdownToHtml emits for the paginated/PDF/HTML-export surfaces,
  // so both surfaces resolve the size through the identical mechanism.
  //
  // This has to happen HERE rather than in the node schema's toDOM, and that
  // is easy to get wrong: this node view takes priority over toDOM for actual
  // rendering (see this file's own point 3 above), so a width applied only in
  // toDOM would render on every surface EXCEPT the editing canvas -- the one
  // divergence Gate 10's 0.000px parity exists to prevent.
  private applyWidth(node: ProseMirrorNode): void {
    const width = typeof node.attrs.width === 'string' ? node.attrs.width : ''
    if (width) this.img.setAttribute('width', width)
    else this.img.removeAttribute('width')
  }

  private syncFrom(node: ProseMirrorNode): void {
    const src = typeof node.attrs.src === 'string' ? node.attrs.src : ''
    const alt = typeof node.attrs.alt === 'string' ? node.attrs.alt : ''
    const title = typeof node.attrs.title === 'string' ? node.attrs.title : ''
    const generation = ++this.generation
    this.synced = { src, alt, title }

    this.applyWidth(node)

    if (isSafeImageSrc(src)) {
      this.img.src = src
      this.setState('ok', src, alt, title)
      return
    }

    // Never assign an unsafe value to `src` at all -- not even briefly --
    // rather than assign-then-clear, so there's no window where the real
    // browser image-loading machinery ever sees the real path/URL. This
    // clear happens BEFORE the async branch below for the same reason: a
    // view being re-synced from one image to another must not keep showing
    // the previous one's pixels while the new one resolves.
    this.img.removeAttribute('src')

    if (!isRelativeLocalPath(src)) {
      this.setState('blocked', src, alt, title)
      return
    }

    const resolver = imageResolverKey.getState(this.view.state)
    if (!resolver) {
      // No host wired one up (a bare schema-only editor, as in the
      // round-trip tests). Not an error; there is simply nothing that could
      // resolve this reference.
      this.setState('missing', src, alt, title)
      return
    }

    this.setState('pending', src, alt, title)
    void resolver.resolveLocalImage(src).then((dataUri) => {
      if (this.destroyed || this.generation !== generation) return
      // Re-checked rather than trusted: this is the one place a value from
      // outside this module reaches a live `src`, and the whole guarantee of
      // this file is that only `data:image/` ever does. A resolver that
      // returned anything else would be a bug on the other side, and this
      // turns that bug into a blank image instead of a fetch.
      if (typeof dataUri === 'string' && isSafeImageSrc(dataUri)) {
        this.img.src = dataUri
        this.setState('ok', src, alt, title)
        return
      }
      this.setState('missing', src, alt, title)
    })
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type.name !== 'image') return false
    const src = typeof node.attrs.src === 'string' ? node.attrs.src : ''
    const alt = typeof node.attrs.alt === 'string' ? node.attrs.alt : ''
    const title = typeof node.attrs.title === 'string' ? node.attrs.title : ''

    // A width-only change -- which is every single drag commit -- must NOT go
    // through syncFrom. That path unconditionally removes `src` and starts a
    // fresh resolve, which for a document-local image means the picture
    // disappears and reappears on the release of every drag. Short-circuiting
    // on the three attrs syncFrom actually reads is what makes the resize
    // visually continuous; `width` is applied either way.
    if (src === this.synced.src && alt === this.synced.alt && title === this.synced.title) {
      this.applyWidth(node)
      return true
    }

    this.syncFrom(node)
    return true
  }

  // Content-less atom node -- nothing here can be a valid insertion target
  // for a stray click/selection to "edit into", matching the stock node's
  // own `atom: true` schema flag.
  ignoreMutation(): boolean {
    return true
  }

  destroy(): void {
    this.destroyed = true
    this.handle.removeEventListener('pointerdown', this.onHandlePointerDown)
    // A drag can still be in flight: ProseMirror destroys node views eagerly,
    // and the pointer listeners live on `window`, so without this they would
    // outlive the element they were opened for.
    this.endDrag?.()
  }
}

export const safeImageViewProse = $prose(
  () =>
    new Plugin({
      props: {
        nodeViews: {
          image: (node, view, getPos) => new SafeImageView(node, view, getPos)
        }
      }
    })
)
