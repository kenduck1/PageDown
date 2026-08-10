import { readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { recordConfigWarning } from './config-warnings'

const RECENT_FILES_FILENAME = 'recent-files.json'

// Names the real, otherwise-invisible CONSEQUENCE rather than the mechanism.
// This list is not just the Home screen's recent rows: `isKnownPath` (below)
// is built from it, and it is the allowlist every renderer-supplied path is
// validated against. So an emptied list makes previously-openable documents
// start failing with "Requested path is not a known recent file" -- which,
// with no notice, reads as the app randomly refusing to open a file the user
// opened yesterday. Both branches share one message deliberately: "unreadable"
// and "damaged" have the same fix (reopen via File > Open) and the same
// consequence, and one message means one dedupe key.
const RECENTS_UNREADABLE_WARNING =
  'Your list of recent documents could not be read and has been reset. Documents you had ' +
  'open before may need to be reopened with File > Open before PageDown will save to them again.'

export interface RecentFileEntry {
  filePath: string
  editedAt: string
}

export function mergeRecentFiles(
  existing: RecentFileEntry[],
  filePath: string,
  editedAt: string,
  maxEntries = 10
): RecentFileEntry[] {
  const withoutExisting = existing.filter((entry) => entry.filePath !== filePath)
  return [{ filePath, editedAt }, ...withoutExisting].slice(0, maxEntries)
}

// Lives here, not in file-io.ts, so it stays directly unit-testable: file-io.ts
// imports `dialog` from 'electron', which resolves to something that isn't a
// real API object outside a running Electron process. This module is
// deliberately Electron-free.
export async function isKnownPath(userDataDir: string, filePath: string): Promise<boolean> {
  const recents = await readRecentFiles(userDataDir)
  return recents.some((entry) => entry.filePath === filePath)
}

// A well-formed JSON array can still hold malformed entries (`[null]`,
// `[{"filePath": 123}]`). Those pass an `Array.isArray` check and then crash
// every consumer on `entry.filePath`, with no way to self-heal — nothing would
// ever get far enough to rewrite the file. Filtering here degrades a corrupt
// allowlist to a smaller (or empty) one instead of a hard lock.
function isRecentFileEntry(value: unknown): value is RecentFileEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as RecentFileEntry).filePath === 'string' &&
    typeof (value as RecentFileEntry).editedAt === 'string'
  )
}

export async function readRecentFiles(userDataDir: string): Promise<RecentFileEntry[]> {
  let raw: string
  try {
    raw = await readFile(join(userDataDir, RECENT_FILES_FILENAME), 'utf8')
  } catch (err) {
    // A MISSING file is the normal first-run state, not something to report --
    // distinguishing it from a genuine read failure (permissions, I/O error, a
    // directory where the file should be) is the whole point of splitting this
    // read out of the parse below. Without that split, every fresh install
    // would greet the user with a warning about a file that was never supposed
    // to exist yet.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      recordConfigWarning(RECENTS_UNREADABLE_WARNING)
    }
    return []
  }
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      recordConfigWarning(RECENTS_UNREADABLE_WARNING)
      return []
    }
    const entries = parsed.filter(isRecentFileEntry)
    // A PARTIAL loss counts too: dropping three of ten entries silently is the
    // same "why won't this file open any more?" experience as dropping all of
    // them, just narrower.
    if (entries.length !== parsed.length) recordConfigWarning(RECENTS_UNREADABLE_WARNING)
    return entries
  } catch {
    recordConfigWarning(RECENTS_UNREADABLE_WARNING)
    return []
  }
}

// Write-then-rename: a crash or kill mid-write would otherwise leave a
// truncated recent-files.json, silently emptying the allowlist. rename(2) is
// atomic within a filesystem, and the temp file is a sibling of the target, so
// a reader only ever sees the old file or the complete new one.
export async function writeRecentFiles(
  userDataDir: string,
  entries: RecentFileEntry[]
): Promise<void> {
  const finalPath = join(userDataDir, RECENT_FILES_FILENAME)
  const tempPath = `${finalPath}.tmp`
  await writeFile(tempPath, JSON.stringify(entries, null, 2), 'utf8')
  await rename(tempPath, finalPath)
}
