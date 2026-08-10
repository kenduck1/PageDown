// A tiny, process-wide collector for "your on-disk configuration could not be
// read, so PageDown fell back to defaults" notices.
//
// WHY THIS EXISTS AT ALL. `readPreferences` and `readRecentFiles` both degrade
// silently on a corrupt or unreadable file -- per-field for preferences,
// per-entry for recents -- and that degradation is the right behavior (see
// each function's own comment: a defensive read that turned its own corruption
// into a hard failure would be strictly worse). The missing half was telling
// the user it happened. A silently-emptied recents allowlist is not cosmetic:
// `isKnownPath` is built from exactly that list, so every previously-openable
// document starts failing with "Requested path is not a known recent file"
// with nothing anywhere explaining why.
//
// Electron-free, like `recent-files.ts`/`preferences.ts`/`version-history.ts`
// themselves, so those modules can record a warning without acquiring an
// Electron dependency (and so this stays directly unit-testable).
//
// DEDUPED PERMANENTLY, not just until the next drain. `isKnownPath` calls
// `readRecentFiles` on EVERY renderer-supplied-path validation, so a corrupt
// recents file would otherwise re-queue the same message dozens of times per
// session -- and re-queue it again after a drain, so a second window opened an
// hour later would surface a notice about something the user was already told
// about and cannot act on twice.

// Every message ever recorded this process, whether or not it has been drained
// yet. Never cleared outside tests.
const reported = new Set<string>()

// Messages recorded but not yet handed to a renderer.
let pending: string[] = []

export function recordConfigWarning(message: string): void {
  if (reported.has(message)) return
  reported.add(message)
  pending.push(message)
  // The console half of this is the floor, not the ceiling: it is what a
  // developer or a support log sees even if no window ever drains the queue
  // (a crash during startup, a headless harness run).
  console.warn(`[PageDown] ${message}`)
}

// Returns the not-yet-shown warnings and empties the queue, so the FIRST
// window to ask is the one that shows them -- once, per app run.
export function drainConfigWarnings(): string[] {
  const drained = pending
  pending = []
  return drained
}

// Test-only. Production never calls this: `reported` is deliberately
// process-lifetime state (see the dedupe note above), and resetting it in a
// running app would let an already-dismissed notice reappear.
export function resetConfigWarningsForTest(): void {
  reported.clear()
  pending = []
}
