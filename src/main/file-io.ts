import { dialog } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { mergeRecentFiles, readRecentFiles, writeRecentFiles, isKnownPath } from './recent-files'
import type { RecentFileEntry } from './recent-files'

// Re-exported so src/main/index.ts imports every file-I/O primitive from one
// place, matching its existing single-import pattern.
export { isKnownPath } from './recent-files'

const MARKDOWN_FILTERS = [{ name: 'Markdown', extensions: ['md', 'markdown'] }]

export interface OpenedFile {
  filePath: string
  content: string
}

export async function openFileDialog(): Promise<OpenedFile | null> {
  const result = await dialog.showOpenDialog({
    filters: MARKDOWN_FILTERS,
    properties: ['openFile']
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return readFileByPath(result.filePaths[0])
}

export async function readFileByPath(filePath: string): Promise<OpenedFile> {
  const content = await readFile(filePath, 'utf8')
  return { filePath, content }
}

export async function saveFile(
  filePath: string | null,
  content: string
): Promise<{ filePath: string } | null> {
  let targetPath = filePath
  if (targetPath === null) {
    const result = await dialog.showSaveDialog({
      filters: MARKDOWN_FILTERS,
      defaultPath: 'Untitled.md'
    })
    if (result.canceled || !result.filePath) return null
    targetPath = result.filePath
  }
  await writeFile(targetPath, content, 'utf8')
  return { filePath: targetPath }
}

export async function saveFileToKnownOrChosenPath(
  userDataDir: string,
  filePath: string | null,
  content: string
): Promise<{ filePath: string } | null> {
  if (filePath !== null && !(await isKnownPath(userDataDir, filePath))) {
    // filePath isn't (or is no longer) in the allowlist -- rather than
    // silently writing to an unvetted path, or permanently refusing to
    // save, fall back to a real Save-As dialog so the user is never
    // trapped with an unsaveable document. This preserves the security
    // property (never write to a path we didn't get from the user via a
    // native dialog or an already-vetted path) without ever blocking them.
    return saveFile(null, content)
  }
  return saveFile(filePath, content)
}

export async function getRecentFiles(userDataDir: string): Promise<RecentFileEntry[]> {
  return readRecentFiles(userDataDir)
}

export async function addRecentFile(userDataDir: string, filePath: string): Promise<void> {
  const existing = await readRecentFiles(userDataDir)
  const updated = mergeRecentFiles(existing, filePath, new Date().toISOString())
  await writeRecentFiles(userDataDir, updated)
}
