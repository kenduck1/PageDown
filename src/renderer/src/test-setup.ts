import '@testing-library/jest-dom/vitest'

// jsdom doesn't implement scrollIntoView at all (a long-standing jsdom gap,
// not specific to this project) — polyfill it as a no-op so components that
// call it (e.g. HomeScreen's Recent/Templates nav) don't throw under test.
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || (() => {})

// jsdom implements Element.prototype.getClientRects/getBoundingClientRect
// (returning zero rects, since jsdom performs no real layout) but does NOT
// implement either on Range at all. ProseMirror's EditorView.scrollToSelection
// calls Range.getClientRects() while computing scroll position after every
// dispatched transaction (prosemirror-view's coordsAtPos/singleRect), so any
// real edit inside a mounted Milkdown editor throws under jsdom without this —
// found empirically while building MilkdownEditor.test.tsx. Match jsdom's own
// zero-rect convention for Element instead of a bare no-op, since some callers
// destructure the returned rect's fields.
if (!Range.prototype.getClientRects) {
  Range.prototype.getClientRects = function (): DOMRectList {
    return [] as unknown as DOMRectList
  }
}
if (!Range.prototype.getBoundingClientRect) {
  Range.prototype.getBoundingClientRect = function (): DOMRect {
    return {
      top: 0,
      bottom: 0,
      left: 0,
      right: 0,
      width: 0,
      height: 0,
      x: 0,
      y: 0,
      toJSON() {
        return this
      }
    } as DOMRect
  }
}

// jsdom doesn't implement ResizeObserver at all (a real, current-Chromium-only
// API; jsdom performs no real layout to observe changes to in the first
// place) — a no-op stub, same convention as scrollIntoView's polyfill above,
// so components that construct one (e.g. EditorToolbar's scroll-fade
// tracking) don't throw under test. Real Electron/Chromium has the genuine
// implementation; this only affects jsdom-based unit tests.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    /* eslint-disable @typescript-eslint/no-empty-function */
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    /* eslint-enable @typescript-eslint/no-empty-function */
  }
}
