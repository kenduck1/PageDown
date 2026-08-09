import { Plugin } from '@milkdown/prose/state'
import { imageSchema } from '@milkdown/preset-commonmark'
import type { EditorView } from '@milkdown/prose/view'
import type { Ctx } from '@milkdown/ctx'

// MilkdownEditor.tsx wires these to its own latest-ref-captured onDropImage/
// onError props (the same latest-ref pattern onChange/onError already use),
// not directly to the raw props themselves -- this plugin is constructed
// once per mount effect, same as findProse, so it needs the same
// "always call whatever the CURRENT prop is" indirection.
export interface DropImageHandlers {
  onDropImage: (file: File) => Promise<{ relativePath: string } | { error: string }>
  onError: (message: string) => void
}

function isImageFile(file: File): boolean {
  return file.type.startsWith('image/')
}

// Exported (unlike the rest of this plugin's internals) specifically so it
// can be unit-tested directly, given a manually-supplied position -- see
// drop-image.test.ts's own header comment for why: `view.posAtCoords`
// (called only inside createDropImagePlugin's own drop handler, never in
// here) THROWS under jsdom (`document.elementFromPoint is not a function`
// -- confirmed directly, jsdom implements no real layout/hit-testing at
// all), so the position-finding half of this feature can only be verified
// against a real browser. This function is everything downstream of
// already knowing where to insert, which jsdom CAN exercise. Same class of
// split as commands.test.ts's own historyKeymap tests (test the command
// callback directly; a real Playwright gate covers the DOM-dispatch/keymap
// half jsdom cannot).
//
// Inserts each dropped image in turn, sequentially (not Promise.all) -- so
// insertion order always matches drop order, and each node's own real
// nodeSize (not a guessed constant) advances `pos` for the next one. A
// failure on one file surfaces via onError and simply skips that file,
// rather than aborting the whole drop -- a batch of five dropped images
// where one happens to not be a real image (or the write races an unrelated
// failure) still inserts the other four.
export async function insertDroppedImages(
  view: EditorView,
  ctx: Ctx,
  startPos: number,
  files: File[],
  handlers: DropImageHandlers
): Promise<void> {
  let pos = startPos
  for (const file of files) {
    const result = await handlers.onDropImage(file)
    if ('error' in result) {
      handlers.onError(result.error)
      continue
    }
    const node = imageSchema.type(ctx).create({ src: result.relativePath, alt: file.name })
    const tr = view.state.tr.insert(pos, node)
    view.dispatch(tr)
    // `tr.insert(pos, node)` can land the node somewhere OTHER than the
    // literal `pos` given -- ProseMirror's replace/"fitting" algorithm
    // (prosemirror-transform) auto-adjusts an inline node's insertion point
    // to the nearest valid inline-content slot, which for `pos` sitting
    // right at a block boundary (the common case: dropping into an empty
    // paragraph) is NOT the literal position requested. Mapping `pos`
    // through this transaction's own recorded steps -- rather than blindly
    // adding node.nodeSize to the ORIGINAL pos -- finds where the content
    // genuinely ended up, which is what the NEXT file needs to insert
    // after. Verified with a real, reproduced bug: without this mapping, a
    // second dropped file landed BEFORE the first one in the final
    // document (both insert() calls silently auto-adjusted to the exact
    // same real position, since both used the same pre-fitting `pos`).
    pos = tr.mapping.map(pos) + node.nodeSize
  }
}

// A real ProseMirror `handleDOMEvents.drop` handler -- the native OS file
// drop this app had no handling for at all before this. Returns `true`
// (and calls preventDefault()) SYNCHRONOUSLY the moment a real image file
// is found in the drop's dataTransfer, which is what stops ProseMirror's
// own default drop handling (and the browser's default "navigate to the
// dropped file") from ever running -- the actual file read + IPC round
// trip + insertion happens asynchronously afterward. Returns `false` (lets
// ProseMirror handle it normally) for an ordinary in-editor text/node drag,
// or a drop carrying no image files at all.
//
// The drop position is captured via `view.posAtCoords` SYNCHRONOUSLY,
// before any async work starts -- if the document changes significantly
// during the (typically fast) save round trip, the position could drift;
// accepted as a narrow, minor edge case rather than engineering a full
// position-mapping-through-intervening-transactions solution for it.
export function createDropImagePlugin(ctx: Ctx, handlers: DropImageHandlers): Plugin {
  return new Plugin({
    props: {
      handleDOMEvents: {
        drop: (view, event) => {
          const files = Array.from(event.dataTransfer?.files ?? []).filter(isImageFile)
          if (files.length === 0) return false

          event.preventDefault()
          const coords = view.posAtCoords({ left: event.clientX, top: event.clientY })
          if (!coords) return true

          void insertDroppedImages(view, ctx, coords.pos, files, handlers)
          return true
        }
      }
    }
  })
}
