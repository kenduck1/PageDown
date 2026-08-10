import { readFile, writeFile, rename, stat } from 'node:fs/promises'
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

// Product-completeness audit 0.6: "a dead recents row cannot be removed" --
// there was previously no "Remove from recents" / "Clear recents" anywhere
// in this codebase (grep: zero hits). Both operations live HERE, alongside
// readRecentFiles/writeRecentFiles, rather than in file-io.ts, for the same
// reason isKnownPath does: this module is deliberately Electron-free and
// therefore directly unit-testable against a real temp directory.
//
// SECURITY, both functions: this list IS the isKnownPath allowlist (see that
// function's own comment above) -- every renderer-supplied path this app
// ever touches disk with is validated against it. Both operations below can
// only ever NARROW the list (drop one entry, or drop all of them); neither
// accepts, nor could be made to accept without changing its signature, a
// path to ADD. Removing an entry therefore only ever REVOKES this app's own
// willingness to write to that path again via saveFileToKnownOrChosenPath's
// fast path -- it can never grant new access, and a user can always restore
// access to a removed path by opening it again through a real native dialog.

// Removes a single entry by exact filePath match and persists the result.
// Returns the resulting list so the caller (the file:removeRecent IPC
// handler) can hand it straight to the renderer without a second read.
export async function removeRecentFile(
  userDataDir: string,
  filePath: string
): Promise<RecentFileEntry[]> {
  const existing = await readRecentFiles(userDataDir)
  const updated = existing.filter((entry) => entry.filePath !== filePath)
  // Skip the write when nothing actually changed -- removing a path that
  // was already gone (a stale double-click, a race with another remove
  // call) must not touch disk for no reason.
  if (updated.length !== existing.length) {
    await writeRecentFiles(userDataDir, updated)
  }
  return updated
}

// Wipes the entire allowlist. Takes no filePath argument at all -- unlike
// removeRecentFile, there is no per-entry input here for a hostile or
// malformed value to hide in.
export async function clearRecentFiles(userDataDir: string): Promise<void> {
  await writeRecentFiles(userDataDir, [])
}

export interface RecentFileEntryWithStatus extends RecentFileEntry {
  // Whether this entry's file is still actually there, as of THIS read --
  // not cached, not persisted (a file deleted a second after this read
  // would still report true; that's fine, this is a display hint, not a
  // security check -- isKnownPath's own allowlist semantics are completely
  // unaffected by this field either way).
  exists: boolean
}

// Enriches each entry with a real, freshly-checked existence flag -- product-
// completeness audit 0.6's "mark rows whose file no longer exists" fix.
// Deliberately a bare fs.stat, not readFileByPath/getThumbnail's full
// open-and-render path: CLAUDE.md's own cost note on this app's recents rows
// already flags that a thumbnail CACHE MISS costs a stat + a version-history
// index read + a full snapshot-content read PER ROW -- so this must not add
// a second per-row round trip on top of that. It doesn't: this is the ONE
// place recents existence is checked, called once by the file:getRecents
// handler (batched into the single call the Home screen already makes on
// mount), and its own cost is exactly one extra `stat` per entry (capped at
// mergeRecentFiles' maxEntries, 10) -- no content read, no version-history
// touch, run in parallel via Promise.all rather than sequentially.
export async function readRecentFilesWithStatus(
  userDataDir: string
): Promise<RecentFileEntryWithStatus[]> {
  const entries = await readRecentFiles(userDataDir)
  return Promise.all(
    entries.map(async (entry) => ({
      ...entry,
      exists: await stat(entry.filePath).then(
        () => true,
        () => false
      )
    }))
  )
}
