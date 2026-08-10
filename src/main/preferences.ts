import { readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { recordConfigWarning } from './config-warnings'
import type { PageSize, Orientation, PageTheme, PageFontFamily } from '../markdown/page-config'

const PREFERENCES_FILENAME = 'preferences.json'

// Names the consequence AND the fact that the damaged file is still sitting
// there: nothing rewrites preferences.json until the user next changes a
// setting, so "everything reset itself" persists across restarts until then.
const PREFERENCES_UNREADABLE_WARNING =
  'Your preferences could not be read, so PageDown is using its default settings. ' +
  'They will be saved again the next time you change a setting.'

// Deliberately a NARROW subset of PageConfig's own fields -- margins/header/
// footer/pageNumberFormat/customWidth/customHeight are real per-document
// settings (already editable via Page Setup, already persisted to each
// document's own frontmatter), not the kind of thing most users want to set
// ONCE as a global default the way page size/orientation/theme/font are.
export interface DefaultPageConfig {
  pageSize: PageSize
  orientation: Orientation
  theme: PageTheme
  fontFamily: PageFontFamily
}

// App-shell CHROME theme -- named `colorScheme`, deliberately NOT `theme`,
// to avoid any confusion with DefaultPageConfig's own `theme` field (which
// picks a DOCUMENT typography theme -- default/resume/letter/report,
// something else entirely). 'system' follows the OS's own
// prefers-color-scheme live (see App.tsx's own matchMedia listener) rather
// than snapshotting it once; 'light'/'dark' pin explicitly regardless of
// the OS setting.
export type ColorScheme = 'light' | 'dark' | 'system'

export interface Preferences {
  spellcheckEnabled: boolean
  autosaveIntervalMs: number
  defaultPageConfig: DefaultPageConfig
  colorScheme: ColorScheme
  // Attached to every new comment a user creates (Milkdown's addCommentCommand,
  // src/renderer/src/milkdown/commands.ts). This app has no accounts/identity
  // system at all (single local user, matching the master design doc's
  // explicit no-CRDT/no-collaboration stance) -- this is the same
  // best-effort, locally-persisted, no-sync posture every other preference
  // already has, not a real identity. An empty string (the default) falls
  // back to the literal label "You" wherever a comment's author is displayed
  // -- see EditorComments.tsx -- rather than showing a blank author.
  authorName: string
}

// 45_000 matches useAutosave.ts's own pre-existing hardcoded default exactly
// -- this is that same value, now user-adjustable rather than fixed, not a
// new default being introduced.
export const DEFAULT_PREFERENCES: Preferences = {
  spellcheckEnabled: true,
  autosaveIntervalMs: 45_000,
  defaultPageConfig: {
    pageSize: 'Letter',
    orientation: 'portrait',
    theme: 'default',
    fontFamily: 'source-serif-4'
  },
  colorScheme: 'system',
  authorName: ''
}

const PAGE_SIZES: readonly PageSize[] = ['Letter', 'A4', 'Legal', 'Custom']
const ORIENTATIONS: readonly Orientation[] = ['portrait', 'landscape']
const THEMES: readonly PageTheme[] = ['default', 'resume', 'letter', 'report']
const FONT_FAMILIES: readonly PageFontFamily[] = ['source-serif-4', 'inter']
const COLOR_SCHEMES: readonly ColorScheme[] = ['light', 'dark', 'system']

// Same "a well-formed JSON value can still hold malformed fields" guard
// recent-files.ts's own isRecentFileEntry documents -- degrades a corrupt or
// partially-missing preferences.json to DEFAULT_PREFERENCES for whichever
// fields don't validate, per-field, rather than discarding the whole file
// for one bad value or crashing every consumer.
function sanitizePreferences(value: unknown): Preferences {
  if (typeof value !== 'object' || value === null) return { ...DEFAULT_PREFERENCES }
  const raw = value as Record<string, unknown>

  const spellcheckEnabled =
    typeof raw.spellcheckEnabled === 'boolean'
      ? raw.spellcheckEnabled
      : DEFAULT_PREFERENCES.spellcheckEnabled

  const autosaveIntervalMs =
    typeof raw.autosaveIntervalMs === 'number' &&
    Number.isFinite(raw.autosaveIntervalMs) &&
    raw.autosaveIntervalMs >= 5_000
      ? raw.autosaveIntervalMs
      : DEFAULT_PREFERENCES.autosaveIntervalMs

  const rawDefaultConfig =
    typeof raw.defaultPageConfig === 'object' && raw.defaultPageConfig !== null
      ? (raw.defaultPageConfig as Record<string, unknown>)
      : {}

  const pageSize =
    typeof rawDefaultConfig.pageSize === 'string' &&
    (PAGE_SIZES as string[]).includes(rawDefaultConfig.pageSize)
      ? (rawDefaultConfig.pageSize as PageSize)
      : DEFAULT_PREFERENCES.defaultPageConfig.pageSize

  const orientation =
    typeof rawDefaultConfig.orientation === 'string' &&
    (ORIENTATIONS as string[]).includes(rawDefaultConfig.orientation)
      ? (rawDefaultConfig.orientation as Orientation)
      : DEFAULT_PREFERENCES.defaultPageConfig.orientation

  const theme =
    typeof rawDefaultConfig.theme === 'string' &&
    (THEMES as string[]).includes(rawDefaultConfig.theme)
      ? (rawDefaultConfig.theme as PageTheme)
      : DEFAULT_PREFERENCES.defaultPageConfig.theme

  const fontFamily =
    typeof rawDefaultConfig.fontFamily === 'string' &&
    (FONT_FAMILIES as string[]).includes(rawDefaultConfig.fontFamily)
      ? (rawDefaultConfig.fontFamily as PageFontFamily)
      : DEFAULT_PREFERENCES.defaultPageConfig.fontFamily

  const colorScheme =
    typeof raw.colorScheme === 'string' && (COLOR_SCHEMES as string[]).includes(raw.colorScheme)
      ? (raw.colorScheme as ColorScheme)
      : DEFAULT_PREFERENCES.colorScheme

  const authorName =
    typeof raw.authorName === 'string' ? raw.authorName : DEFAULT_PREFERENCES.authorName

  return {
    spellcheckEnabled,
    autosaveIntervalMs,
    defaultPageConfig: { pageSize, orientation, theme, fontFamily },
    colorScheme,
    authorName
  }
}

// Electron-free (like recent-files.ts's own readRecentFiles/writeRecentFiles)
// so it stays directly unit-testable against a real temp directory.
export async function readPreferences(userDataDir: string): Promise<Preferences> {
  let raw: string
  try {
    raw = await readFile(join(userDataDir, PREFERENCES_FILENAME), 'utf8')
  } catch (err) {
    // A missing file is the normal first-run state -- see readRecentFiles's
    // own version of this split for why the read and the parse are separated
    // rather than sharing one catch.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      recordConfigWarning(PREFERENCES_UNREADABLE_WARNING)
    }
    return { ...DEFAULT_PREFERENCES }
  }
  try {
    return sanitizePreferences(JSON.parse(raw))
  } catch {
    // Only a genuinely unparseable file lands here. sanitizePreferences's own
    // per-field fallback is deliberately NOT reported: a preferences.json
    // written by an older version that simply lacks a field is a normal
    // upgrade, not damage, and warning about it would cry wolf on every
    // release that adds a preference.
    recordConfigWarning(PREFERENCES_UNREADABLE_WARNING)
    return { ...DEFAULT_PREFERENCES }
  }
}

// Write-then-rename, same atomicity reasoning as writeRecentFiles: a crash
// mid-write must never leave a truncated preferences.json that then silently
// resets every preference to default on the next read.
export async function writePreferences(
  userDataDir: string,
  preferences: Preferences
): Promise<void> {
  const finalPath = join(userDataDir, PREFERENCES_FILENAME)
  const tempPath = `${finalPath}.tmp`
  await writeFile(tempPath, JSON.stringify(preferences, null, 2), 'utf8')
  await rename(tempPath, finalPath)
}
