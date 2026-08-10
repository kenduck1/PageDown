import { useEffect, useRef, type RefObject } from 'react'

// Shared by PageSetupModal and ShortcutsHelpModal -- both declare
// aria-modal="true" but (until this hook) had NO Escape handler, focus trap,
// focus-in, or focus-restore, which made that attribute a false claim: the
// DOM behind the scrim stayed fully tabbable. Concrete, reported symptom:
// press Mod-/ for the shortcuts reference and focus never leaves the
// document, so every subsequent keystroke -- including Escape itself -- goes
// into the user's file instead of the modal. See
// docs/superpowers/plans/2026-08-10-product-completeness-audit.md Tier 1
// section 1.4.
//
// All realistically-tabbable element types either modal renders today
// (buttons, text/number inputs) plus the general WAI-ARIA APG list, so this
// stays correct if either modal grows a <select>/<textarea> later.
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function queryFocusable(container: HTMLElement | null): HTMLElement[] {
  if (!container) return []
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
}

// Returns a ref to attach to the dialog's own root element (the one carrying
// role="dialog" aria-modal="true" -- also give it tabIndex={-1} in the JSX,
// so `container.focus()` below has something to land on even in the
// (currently hypothetical) case where the dialog renders zero focusable
// children).
//
// `open`/`onClose` mirror PageSetupModalProps/ShortcutsHelpModalProps
// exactly -- this hook has no state of its own beyond what those props
// already carry, so callers just forward what they already have.
export function useModalDialog(
  open: boolean,
  onClose: () => void
): RefObject<HTMLDivElement | null> {
  const containerRef = useRef<HTMLDivElement>(null)
  // The element focus should return to once the dialog closes -- captured at
  // the moment it opens, not read lazily on close, because by close time
  // document.activeElement is whatever's INSIDE the dialog (the trap below
  // guarantees that), which is not what we want to restore focus to.
  const previouslyFocusedRef = useRef<Element | null>(null)
  // Read through a ref rather than depended on directly: PageSetupModal
  // passes closePageSetup (a stable Zustand action) today, but this is a
  // SHARED hook and a future caller handing it a fresh inline closure on
  // every render (PageSetupModal itself already re-renders on every
  // keystroke, via its draft state) would otherwise tear this effect down
  // and rebuild it every render -- including running the cleanup below,
  // which restores focus to the pre-open element. That would yank focus out
  // of the dialog and back to the trigger button on every single keystroke.
  // Same convention as Toast.tsx's own onDismiss ref and MilkdownEditor.tsx's
  // onChangeRef/onErrorRef -- updated via its own no-deps effect, never
  // assigned during render (react-hooks/refs forbids that: a ref is a value
  // that shouldn't be needed for rendering).
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  })

  useEffect(() => {
    if (!open) return undefined

    previouslyFocusedRef.current = document.activeElement

    // Focus-in: the dialog's first real focusable control (in both modals
    // today, the header's own Close button, since it's first in DOM order),
    // or the container itself as a fallback -- see the tabIndex={-1} note
    // above. Landing focus on SOMETHING inside the dialog is what fixes the
    // reported bug; which specific element is secondary.
    const container = containerRef.current
    const first = queryFocusable(container)[0]
    ;(first ?? container)?.focus()

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        // No stopPropagation needed here the way slash-plugin.ts's own
        // Escape handler needs it (that guard stops one keystroke closing
        // BOTH a slash session and Find, two unrelated `window` listeners).
        // Here, once focus-in above has moved DOM focus inside the dialog,
        // a slash session cannot be open at the same time to race with:
        // ProseMirror's own handleKeyDown only ever sees a keydown whose
        // target is its own contenteditable node, and that node cannot hold
        // focus while this dialog does. The two are mutually exclusive by
        // construction, not by an ordering guard.
        onCloseRef.current()
        return
      }

      if (event.key !== 'Tab') return

      const focusable = queryFocusable(containerRef.current)
      if (focusable.length === 0) {
        // Nothing to cycle to -- still don't let Tab escape to the document
        // behind the scrim.
        event.preventDefault()
        return
      }

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      const activeInside = active !== null && containerRef.current?.contains(active)

      if (event.shiftKey) {
        if (!activeInside || active === first) {
          event.preventDefault()
          last.focus()
        }
      } else if (!activeInside || active === last) {
        event.preventDefault()
        first.focus()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      const restore = previouslyFocusedRef.current
      // instanceof check, not a bare cast: activeElement can be null (jsdom,
      // or a real page with nothing focused) or an SVGElement/etc with no
      // .focus() method at all.
      if (restore instanceof HTMLElement) restore.focus()
    }
  }, [open])

  return containerRef
}
