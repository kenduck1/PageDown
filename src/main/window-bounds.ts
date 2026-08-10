import { readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { recordConfigWarning } from './config-warnings'

const WINDOW_STATE_FILENAME = 'window-state.json'

// App identity/packaging cleanup: the scaffold's `new BrowserWindow({ width:
// 900, height: 670 })` never persisted, so every launch reset size and
// position back to those two literals. 670px is genuinely short for an
// 11in-tall (1056px-at-96dpi) page in Format mode, and at 900px wide the
// toolbar's "Add comment" button scrolls under the sticky left group and
// becomes unreachable without resizing (see CLAUDE.md's Comments section) --
// so the new default is deliberately wider AND taller than the old one, not
// just "restore what was there before."
//
// Width is a deliberately modest +100px over the old default, not a bigger,
// more comfortable jump -- verified empirically against
// phase0/gate28-bubble-menu.spec.ts's and gate29-slash-menu.spec.ts's own
// Split-mode "clamp is binding" assertions, both tuned at the OLD 900px
// default: the Format-mode editor pane is a FIXED-width page card (see
// gate16-page-geometry.spec.ts's own finding), so a selection's unclamped
// bubble/palette position does not move with window width, while the
// Split-mode preview pane's own left edge moves at roughly HALF the rate of
// any window-width increase (a 300px wider window measured a 150px-righter
// preview.x in a real launch). gate28's own margin is the tighter of the
// two gates' (its unclamped position sits closer to the preview pane), and
// a 1200px default measured its clamp no longer binding at all (preview.x
// moved past the unclamped position entirely, i.e. clamping had become
// unnecessary at that width) -- a real, reproduced regression against a
// gate this task was told to keep green, not a hypothetical. 1000px keeps
// comfortable margin under that gate's own crossover point (~1050px by the
// same measured rate) while still giving the toolbar's scrollable segment
// genuinely more room than 900px did. Re-verify against both gates directly
// (not just this arithmetic) before ever moving this constant again.
export const DEFAULT_WINDOW_WIDTH = 1000
export const DEFAULT_WINDOW_HEIGHT = 840

// A window smaller than this loses real, load-bearing UI -- the toolbar's
// sticky left group plus enough of the scrollable segment to reach common
// actions, and enough vertical room for the toolbar + status bar + a usable
// sliver of page. Set on the BrowserWindow itself (`minWidth`/`minHeight`),
// so the OS enforces it on every resize, not just at launch.
export const MIN_WINDOW_WIDTH = 760
export const MIN_WINDOW_HEIGHT = 560

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

// The subset of Electron's own `Display.workArea` this module needs --
// duplicated as a plain shape (not imported from 'electron') so this stays
// Electron-free, matching recent-files.ts's/preferences.ts's own reasoning:
// the caller (src/main/index.ts) already has real Display objects from
// `screen.getAllDisplays()` and they satisfy this shape structurally.
export interface DisplayWorkArea {
  x: number
  y: number
  width: number
  height: number
}

const WINDOW_STATE_UNREADABLE_WARNING =
  'Your saved window size and position could not be read, so PageDown opened at its default ' +
  'size. It will be saved again the next time you resize or move the window.'

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

// A well-formed JSON object can still hold malformed fields (a string where
// a number belongs, a missing key) -- same class of guard as
// preferences.ts's sanitizePreferences/recent-files.ts's isRecentFileEntry.
// Returns null (never throws) for anything that doesn't parse as real
// bounds, so the caller can fall back to the default size/position exactly
// as if no file existed yet.
function sanitizeWindowBounds(value: unknown): WindowBounds | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  if (
    !isFiniteNumber(raw.x) ||
    !isFiniteNumber(raw.y) ||
    !isFiniteNumber(raw.width) ||
    !isFiniteNumber(raw.height)
  ) {
    return null
  }
  // Floored rather than left fractional -- BrowserWindow bounds are always
  // integer device-independent pixels, and a corrupt/hand-edited file could
  // otherwise carry a fraction or a negative size.
  const width = Math.max(MIN_WINDOW_WIDTH, Math.round(raw.width))
  const height = Math.max(MIN_WINDOW_HEIGHT, Math.round(raw.height))
  return { x: Math.round(raw.x), y: Math.round(raw.y), width, height }
}

// Electron-free (like recent-files.ts's own readRecentFiles/preferences.ts's
// own readPreferences), so it stays directly unit-testable against a real
// temp directory. Returns null for "no usable saved state" -- missing file,
// unparseable file, or malformed bounds -- never throws.
export async function readWindowState(userDataDir: string): Promise<WindowBounds | null> {
  let raw: string
  try {
    raw = await readFile(join(userDataDir, WINDOW_STATE_FILENAME), 'utf8')
  } catch (err) {
    // A missing file is the normal first-launch state -- see
    // readPreferences's own version of this split for why the read and the
    // parse are separated rather than sharing one catch.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      recordConfigWarning(WINDOW_STATE_UNREADABLE_WARNING)
    }
    return null
  }
  try {
    return sanitizeWindowBounds(JSON.parse(raw))
  } catch {
    recordConfigWarning(WINDOW_STATE_UNREADABLE_WARNING)
    return null
  }
}

// Write-then-rename, same atomicity reasoning as writeRecentFiles/
// writePreferences: a crash mid-write must never leave a truncated
// window-state.json that then silently falls back to the default size on
// the next launch.
export async function writeWindowState(userDataDir: string, bounds: WindowBounds): Promise<void> {
  const finalPath = join(userDataDir, WINDOW_STATE_FILENAME)
  const tempPath = `${finalPath}.tmp`
  await writeFile(tempPath, JSON.stringify(bounds, null, 2), 'utf8')
  await rename(tempPath, finalPath)
}

function rectsIntersect(a: WindowBounds, b: DisplayWorkArea): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

// True when `bounds` genuinely overlaps at least one connected display's
// work area. Pure and Electron-free so it's directly testable with
// hand-built display lists -- the real caller passes
// `screen.getAllDisplays().map((d) => d.workArea)`.
//
// This is what stops a window saved while an external monitor was attached
// from restoring fully off-screen after that monitor is disconnected: there
// is no OS-universal affordance for "drag back an off-screen window," so an
// off-screen restore would otherwise strand the app looking like it failed
// to launch.
export function boundsAreOnScreen(
  bounds: WindowBounds,
  displays: readonly DisplayWorkArea[]
): boolean {
  return displays.some((display) => rectsIntersect(bounds, display))
}

// What createWindow (src/main/index.ts) actually needs to seed a
// `new BrowserWindow({...})` call -- x/y are optional because Electron
// itself centers a window on the primary display whenever they're omitted,
// which is exactly the fallback resolveInitialWindowBounds below wants for
// an off-screen or absent saved position.
export interface InitialWindowBounds {
  x?: number
  y?: number
  width: number
  height: number
}

// The one function src/main/index.ts actually calls to decide where a new
// window should open. Pure (no I/O, no Electron) -- the caller supplies the
// saved bounds (already read via readWindowState) and the live display list
// (already read via screen.getAllDisplays()) and gets back exactly what to
// pass into `new BrowserWindow({...})`.
//
// Deliberately drops x/y (letting Electron center the window on the primary
// display, its own default when neither is supplied) rather than clamping
// them into range -- clamping an arbitrary saved position onto a
// differently-sized display can still land a window somewhere the user
// never put it (e.g. mid-screen, overlapping nothing meaningful), whereas
// centering is always a sane, predictable landing spot. Width/height are
// preserved even when position is dropped: a saved SIZE the user chose is
// still worth keeping even if the saved POSITION no longer applies.
export function resolveInitialWindowBounds(
  saved: WindowBounds | null,
  displays: readonly DisplayWorkArea[]
): InitialWindowBounds {
  if (!saved) {
    return { width: DEFAULT_WINDOW_WIDTH, height: DEFAULT_WINDOW_HEIGHT }
  }
  if (boundsAreOnScreen(saved, displays)) {
    return { x: saved.x, y: saved.y, width: saved.width, height: saved.height }
  }
  return { width: saved.width, height: saved.height }
}
