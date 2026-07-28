import { readFile, writeFile } from 'node:fs/promises'
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

export async function readRecentFiles(userDataDir: string): Promise<RecentFileEntry[]> {
  try {
    const raw = await readFile(join(userDataDir, RECENT_FILES_FILENAME), 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export async function writeRecentFiles(
  userDataDir: string,
  entries: RecentFileEntry[]
): Promise<void> {
  await writeFile(join(userDataDir, RECENT_FILES_FILENAME), JSON.stringify(entries, null, 2), 'utf8')
}
