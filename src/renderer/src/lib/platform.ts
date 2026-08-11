// Single source for "is this renderer running on a Mac" -- extracted out of
// ShortcutsHelpModal.tsx (the first place this check existed, for MOD/ALT
// glyph labeling) once useFindShortcuts.ts needed the SAME predicate for a
// second, behavioral purpose: gating whether Ctrl+H opens Find and Replace
// (Windows/Linux convention) versus doing nothing (macOS, where Cmd+H is the
// system-reserved Hide Application shortcut and must never be intercepted).
// Two independent copies of this regex would risk exactly the drift this
// codebase's other "single source of truth" rules exist to prevent -- see
// e.g. MTIME_TOLERANCE_MS's own reuse across file-io.ts/version-history.ts.
//
// navigator.platform is deprecated but still functionally reports "MacIntel"
// on every real Mac (Intel or Apple Silicon, via Rosetta-compatibility
// reporting). No IPC round trip to the main process's real process.platform:
// neither call site needs 100% certainty --
// useFindShortcuts.ts's own keydown handler already keys its actual
// modifier logic off event.metaKey/event.ctrlKey/event.altKey directly, so a
// wrong guess here would at worst mislabel a shortcut or leave one
// unreachable, never grant behavior the real modifiers didn't ask for.
//
// Read live on every call rather than cached in a module-level constant --
// unlike ShortcutsHelpModal's own former IS_MAC (computed once, since that
// modal's labels never need to change mid-session) -- because
// useFindShortcuts.ts's keydown handler calls this on every keypress, and a
// test needs to flip navigator.platform between cases the same way it
// already flips modifier keys per `press()` call.
export function isMacPlatform(): boolean {
  return navigator.platform.toUpperCase().includes('MAC')
}
