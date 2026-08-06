import { dialog, type BrowserWindow } from 'electron'
import { readFile, writeFile, stat, realpath } from 'node:fs/promises'
import { dirname, basename, join } from 'node:path'
import { mergeRecentFiles, readRecentFiles, writeRecentFiles, isKnownPath } from './recent-files'
import type { RecentFileEntry } from './recent-files'
import { getLatestSnapshot } from './version-history'

// Re-exported so src/main/index.ts imports every file-I/O primitive from one
// place, matching its existing single-import pattern.
export { isKnownPath } from './recent-files'

const MARKDOWN_FILTERS = [{ name: 'Markdown', extensions: ['md', 'markdown'] }]

export interface OpenedFile {
  filePath: string
  content: string
  recoveredFromAutosave: boolean
}

// Canonicalizes a document path via fs.realpath before it's used to key
// version-history.ts storage. Required because two spellings of the SAME
// file -- most commonly a symlinked temp dir vs. its realpath (macOS
// resolves `/tmp/x` to `/private/tmp/x`, which a mkdtemp(tmpdir())-based
// fixture hits directly) -- would otherwise silently key two different
// history entries for what is really one document: an autosave written
// under one spelling would never be found by a lookup under the other,
// permanently splitting the document's history and defeating recovery.
//
// realpath(filePath) itself throws for two realistic reasons: the file
// doesn't exist yet (a brand-new, not-yet-saved document), or it existed a
// moment ago but doesn't right now (deleted, or a transient race). Falling
// straight back to the fully raw path for either case would silently
// reintroduce the exact split-history bug this function exists to prevent,
// in precisely the scenario the feature cares most about: if the file's
// PARENT directory is itself reached through a symlink (or any other
// raw !== canonical spelling), a not-yet-existing or since-deleted file
// keyed by the raw path would land in a different hash bucket than every
// other lookup for the same logical document, keyed by its canonical form.
// So the fallback canonicalizes the PARENT directory instead and rejoins
// the file's own basename -- correct whenever the parent exists, which
// covers both the not-yet-created-file and deleted-file cases. Only once
// even the parent can't be resolved (neither the file nor its directory
// exists) does this fall all the way back to the fully raw path, as a last
// resort rather than the first one.
//
// Exported so src/main/index.ts's four version-history IPC handlers
// canonicalize exactly the same way as the recovery check below -- factored
// into one function so all five call sites (this module's own recovery
// check, plus the four handlers) can't drift apart.
export async function canonicalizeDocumentPath(filePath: string): Promise<string> {
  try {
    return await realpath(filePath)
  } catch {
    try {
      return join(await realpath(dirname(filePath)), basename(filePath))
    } catch {
      return filePath
    }
  }
}

// Filesystem mtime is not a monotonic clock directly comparable, bare, to a
// locally-generated Date#toISOString() timestamp -- two realistic failure
// modes, both silent loss of genuinely saved work, if compared with a bare
// `>`:
//   - mtime GRANULARITY TRUNCATION. Snapshot timestamps are millisecond-
//     precision; mtime is not, on any filesystem short of APFS/ext4-with-ns
//     (exFAT/FAT32 -- USB sticks -- truncate to 2s; HFS+ and many SMB/NFS
//     shares to 1s). An autosave at 10:00:00.500 followed by a real Save at
//     10:00:00.900 can yield an mtime of 10:00:00.000 on a truncating
//     filesystem -- the PRE-save snapshot would then compare as newer than
//     the save that superseded it, silently reverting the save on reopen.
//   - MTIME-PRESERVING RESTORES. `rsync -t`, `tar -x`, `unzip`, and most
//     backup/sync tools reinstate the original mtime, so a user who
//     deliberately restores a backup over their document would get it
//     silently overridden by a since-written, now-stale PageDown snapshot.
// MTIME_TOLERANCE_MS absorbs both: a snapshot must be newer by MORE than
// this margin to count as "meaningfully newer," not just newer by any
// nonzero amount. Chosen to comfortably exceed the coarsest realistic mtime
// granularity above (FAT32/exFAT's 2s).
const MTIME_TOLERANCE_MS = 2000

// Best-effort: an autosave snapshot meaningfully newer than the file's own
// on-disk mtime, AND whose content actually differs from what's on disk,
// means the app (or OS) crashed after an autosave tick but before the next
// real Save, so what's on disk is stale relative to what the user last saw
// -- silently prefer that snapshot's content over the on-disk bytes so the
// document reopens exactly where the user left off (Task 3 surfaces the
// returned `recoveredFromAutosave` flag as a passive banner, not a prompt).
// The content-equality check guards a narrower case than the tolerance
// above: a snapshot that IS meaningfully newer by the clock, but whose
// bytes are already identical to disk (e.g. a Save landed, then an autosave
// tick fired on the same unchanged content before the next edit) has
// nothing to recover -- flagging it as a "recovery" would just be noise.
//
// Reverse clock skew (the system clock stepping BACKWARD between an
// autosave tick and this comparison) fails SAFE here and is intentionally
// not compensated for: it can only ever make a genuinely-newer snapshot
// compare as not-newer, so recovery simply doesn't fire -- the snapshot
// itself is never deleted by this function and stays fully reachable via
// the version-history UI (Task 3/4). Do not "fix" that direction too; only
// forward skew (mtime granularity truncation, mtime-preserving restores) is
// the failure mode MTIME_TOLERANCE_MS guards against.
//
// The whole body is wrapped in try/catch and degrades to the on-disk
// content on ANY failure (a deleted file racing the stat call, a corrupted
// history, anything) -- this must never turn an otherwise-successful file
// open into a failure. Deliberately asymmetric with the write side
// (autosaveSnapshot etc. in index.ts): those drop silently, but a failed
// *read* here still has perfectly good on-disk content to fall back to, so
// nothing is lost either way.
async function resolveContentWithRecovery(
  userDataDir: string,
  filePath: string,
  onDiskContent: string
): Promise<{ content: string; recoveredFromAutosave: boolean }> {
  try {
    const fileStat = await stat(filePath)
    const canonicalPath = await canonicalizeDocumentPath(filePath)
    const latest = await getLatestSnapshot(userDataDir, canonicalPath)
    const isMeaningfullyNewer =
      latest !== null &&
      new Date(latest.timestamp).getTime() > fileStat.mtimeMs + MTIME_TOLERANCE_MS
    const differsFromDisk = latest !== null && latest.content !== onDiskContent
    if (latest && isMeaningfullyNewer && differsFromDisk) {
      return { content: latest.content, recoveredFromAutosave: true }
    }
    return { content: onDiskContent, recoveredFromAutosave: false }
  } catch (err) {
    console.error('Failed to check for a newer autosave snapshot', err)
    return { content: onDiskContent, recoveredFromAutosave: false }
  }
}

export async function openFileDialog(userDataDir: string): Promise<OpenedFile | null> {
  const result = await dialog.showOpenDialog({
    filters: MARKDOWN_FILTERS,
    properties: ['openFile']
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return readFileByPath(result.filePaths[0], userDataDir)
}

export async function readFileByPath(filePath: string, userDataDir: string): Promise<OpenedFile> {
  const content = await readFile(filePath, 'utf8')
  const recovery = await resolveContentWithRecovery(userDataDir, filePath, content)
  return { filePath, ...recovery }
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

export type DiscardChangesChoice = 'save' | 'discard' | 'cancel'

export async function confirmDiscardChanges(win: BrowserWindow): Promise<DiscardChangesChoice> {
  const result = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Save', "Don't Save", 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    message: 'Do you want to save the changes you made?',
    detail: "Your changes will be lost if you don't save them."
  })
  return (['save', 'discard', 'cancel'] as const)[result.response]
}

export async function getRecentFiles(userDataDir: string): Promise<RecentFileEntry[]> {
  return readRecentFiles(userDataDir)
}

export async function addRecentFile(userDataDir: string, filePath: string): Promise<void> {
  const existing = await readRecentFiles(userDataDir)
  const updated = mergeRecentFiles(existing, filePath, new Date().toISOString())
  await writeRecentFiles(userDataDir, updated)
}
