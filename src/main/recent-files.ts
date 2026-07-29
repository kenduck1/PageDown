import { readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'

const RECENT_FILES_FILENAME = 'recent-files.json'

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
  try {
    const raw = await readFile(join(userDataDir, RECENT_FILES_FILENAME), 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(isRecentFileEntry) : []
  } catch {
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
