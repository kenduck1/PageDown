import { dialog } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { mergeRecentFiles, readRecentFiles, writeRecentFiles } from './recent-files'
import type { RecentFileEntry } from './recent-files'

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

export async function getRecentFiles(userDataDir: string): Promise<RecentFileEntry[]> {
  return readRecentFiles(userDataDir)
}

export async function addRecentFile(userDataDir: string, filePath: string): Promise<void> {
  const existing = await readRecentFiles(userDataDir)
  const updated = mergeRecentFiles(existing, filePath, new Date().toISOString())
  await writeRecentFiles(userDataDir, updated)
}
