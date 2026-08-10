import { dialog, type BrowserWindow } from 'electron'
import { readFile, writeFile, stat, realpath } from 'node:fs/promises'
import { dirname, basename, extname, join } from 'node:path'
import { mergeRecentFiles, readRecentFiles, writeRecentFiles, isKnownPath } from './recent-files'
import type { RecentFileEntry } from './recent-files'
import { getLatestSnapshot, MTIME_TOLERANCE_MS } from './version-history'
// Reused rather than re-implemented -- pagination-window.ts already imports
// `electron` at module scope (for WebContentsView/BaseWindow/session), but
// only inside function bodies never evaluated here, so pulling in just this
// one pure, already-exported, already-unit-tested function doesn't add any
// new runtime dependency this module doesn't already have (file-io.ts
// already imports `dialog` from 'electron').
import { sniffImageContentType } from './pagination-window'

// Re-exported so src/main/index.ts imports every file-I/O primitive from one
// place, matching its existing single-import pattern.
export { isKnownPath } from './recent-files'

const MARKDOWN_FILTERS = [{ name: 'Markdown', extensions: ['md', 'markdown'] }]

export interface OpenedFile {
  filePath: string
  content: string
  recoveredFromAutosave: boolean
  // The file's on-disk mtime at read time -- threaded back through the
  // Document Store (see documentStore.ts's DocumentTab.mtimeMs) as the
  // baseline saveFile below compares against to detect an external change.
  mtimeMs: number
}

// A conflict-free save (the common case) omits reloadedContent entirely. A
// save where the user chose "Reload" in response to a detected external
// change carries reloadedContent instead -- nothing was written in that
// case; the caller must adopt reloadedContent as the document's new content
// rather than treating this as a normal successful save.
export type SaveFileResult =
  | { filePath: string; mtimeMs: number; reloadedContent?: undefined }
  | { filePath: string; mtimeMs: number; reloadedContent: string }

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

// MTIME_TOLERANCE_MS (imported from version-history.ts, which owns the
// constant because it is Electron-free and this module is not -- see its own
// definition for the full mtime-granularity/mtime-preserving-restore
// rationale, and for why both consumers must share one value) absorbs two
// realistic failure modes below, both silent loss of genuinely saved work if
// the comparison were a bare `>`:
//   - mtime GRANULARITY TRUNCATION. An autosave at 10:00:00.500 followed by a
//     real Save at 10:00:00.900 can yield an mtime of 10:00:00.000 on a
//     truncating filesystem -- the PRE-save snapshot would then compare as
//     newer than the save that superseded it, silently reverting the save on
//     reopen.
//   - MTIME-PRESERVING RESTORES. A user who deliberately restores a backup
//     over their document would get it silently overridden by a
//     since-written, now-stale PageDown snapshot.
// So a snapshot must be newer by MORE than this margin to count as
// "meaningfully newer," not just newer by any nonzero amount.
//
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
  const fileStat = await stat(filePath)
  const recovery = await resolveContentWithRecovery(userDataDir, filePath, content)
  return { filePath, ...recovery, mtimeMs: fileStat.mtimeMs }
}

// Design doc Error Handling: "External file change detected via mtime check
// on save -> prompt to reload or overwrite rather than silently clobbering."
// `expectedMtimeMs` is the mtime OpenedFile (or a prior saveFile call)
// reported the last time this app actually read or wrote the file --
// `null` means the caller has no baseline (a brand-new, never-saved-to-this-
// path document), in which case there is nothing to compare against and the
// check is skipped entirely, matching every existing call site's fail-open
// posture elsewhere in this file. Reusing MTIME_TOLERANCE_MS (rather than a
// bare `>`) absorbs the same mtime-granularity-truncation risk documented on
// that constant's own definition -- without it, a save immediately following
// this exact save could round-trip through a truncating filesystem and
// compare its own just-written mtime as "newer than expected," which would
// incorrectly flag a conflict against no external change at all.
export async function saveFile(
  win: BrowserWindow,
  filePath: string | null,
  content: string,
  expectedMtimeMs: number | null
): Promise<SaveFileResult | null> {
  let targetPath = filePath
  if (targetPath === null) {
    const result = await dialog.showSaveDialog({
      filters: MARKDOWN_FILTERS,
      defaultPath: 'Untitled.md'
    })
    if (result.canceled || !result.filePath) return null
    targetPath = result.filePath
  } else if (expectedMtimeMs !== null) {
    // A deleted-since-open file has nothing to conflict with (that's a
    // separate, pre-existing "file moved/deleted externally" risk this
    // feature doesn't touch) -- stat failing here just means proceed to the
    // normal write below, which recreates the file.
    const currentStat = await stat(targetPath).catch(() => null)
    if (currentStat && currentStat.mtimeMs > expectedMtimeMs + MTIME_TOLERANCE_MS) {
      const choice = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['Reload', 'Overwrite', 'Cancel'],
        defaultId: 1,
        cancelId: 2,
        message: 'This file has changed on disk since it was opened.',
        detail:
          'Another program (or another PageDown window) has modified this file. ' +
          'Reload to discard your changes here and load the file as it is on disk now, ' +
          'or Overwrite to save your changes anyway, replacing what is on disk.'
      })
      if (choice.response === 2) return null // Cancel
      if (choice.response === 0) {
        // Reload: read what's actually on disk now; write nothing. The
        // caller (documentStore.save()) adopts reloadedContent as the
        // document's new content rather than treating this as a save.
        const diskContent = await readFile(targetPath, 'utf8')
        const diskStat = await stat(targetPath)
        return { filePath: targetPath, mtimeMs: diskStat.mtimeMs, reloadedContent: diskContent }
      }
      // Overwrite (response === 1): fall through to the write below.
    }
  }
  await writeFile(targetPath, content, 'utf8')
  const newStat = await stat(targetPath)
  return { filePath: targetPath, mtimeMs: newStat.mtimeMs }
}

export async function saveFileToKnownOrChosenPath(
  win: BrowserWindow,
  userDataDir: string,
  filePath: string | null,
  content: string,
  expectedMtimeMs: number | null
): Promise<SaveFileResult | null> {
  if (filePath !== null && !(await isKnownPath(userDataDir, filePath))) {
    // filePath isn't (or is no longer) in the allowlist -- rather than
    // silently writing to an unvetted path, or permanently refusing to
    // save, fall back to a real Save-As dialog so the user is never
    // trapped with an unsaveable document. This preserves the security
    // property (never write to a path we didn't get from the user via a
    // native dialog or an already-vetted path) without ever blocking them.
    // No conflict check applies to a Save-As target either -- it's a fresh
    // path the user is about to pick via a native dialog, not one this app
    // has any prior mtime baseline for.
    return saveFile(win, null, content, null)
  }
  return saveFile(win, filePath, content, expectedMtimeMs)
}

export type SaveDroppedImageResult = { relativePath: string } | { error: string }

// A file's own real byte content, sniffed the same way the local-asset
// protocol handler already sniffs a served asset -- no content-type
// allowlist is skipped just because this write originates from a genuine
// drag gesture rather than a document reference. `documentDir` is derived
// from `filePath`, never a renderer-supplied directory -- consistent with
// "Any future registerAssetRoot caller must pass an isKnownPath-validated
// absolute path" (CLAUDE.md's File I/O security invariant): this function
// is that same shape of caller, one level removed (it writes INTO the
// directory local assets already resolve against, rather than registering
// the directory itself).
export async function saveDroppedImage(
  userDataDir: string,
  filePath: string | null,
  base64Data: string,
  suggestedFilename: string
): Promise<SaveDroppedImageResult> {
  // No saved document yet -- there is no directory to copy into, and (per
  // the same reasoning registerAssetRoot's own "no validated path" branch
  // already documents) inventing a placeholder would be worse than a clear,
  // real error. The caller surfaces this through the existing
  // documentStore.error/error-banner pattern, not a new UI.
  if (filePath === null || !(await isKnownPath(userDataDir, filePath))) {
    return { error: 'Save the document before adding images.' }
  }

  const buffer = Buffer.from(base64Data, 'base64')
  if (!sniffImageContentType(buffer)) {
    return { error: 'That file does not look like a real image.' }
  }

  const documentDir = dirname(filePath)
  // basename() strips any path/traversal component a hostile or malformed
  // suggestedFilename might carry -- same defensive posture as every other
  // renderer-supplied string this codebase writes to disk, even though this
  // one originates from a real OS drag gesture's own File#name, not
  // document content.
  const cleanName = basename(suggestedFilename) || 'image'
  const ext = extname(cleanName)
  const stem = ext ? cleanName.slice(0, -ext.length) : cleanName

  let candidate = cleanName
  let suffix = 1
  // Never overwrites an existing file -- a same-named image dropped twice
  // (or colliding with an unrelated existing file) gets its own numbered
  // sibling instead of silently clobbering something already referenced
  // elsewhere in the document.
  for (;;) {
    try {
      await stat(join(documentDir, candidate))
    } catch {
      break
    }
    suffix += 1
    candidate = `${stem}-${suffix}${ext}`
  }

  await writeFile(join(documentDir, candidate), buffer)
  return { relativePath: candidate }
}

export type DiscardChangesChoice = 'save' | 'discard' | 'cancel'

// `documentName` names WHICH document is being asked about. Optional, and
// omitting it reproduces the original wording exactly, because the two
// original callers (Home navigation, closing the tab you are looking at) are
// unambiguous on their own -- the document in question is the one on screen.
// It exists for the window-close/quit guard, which can prompt several times in
// a row for several different tabs; three identical "Do you want to save the
// changes you made?" dialogs with nothing distinguishing them is how a user
// ends up discarding the wrong document.
//
// It is renderer-supplied, but it is a display string in a native dialog and
// nothing else -- it never reaches disk, a path join, or a shell. Coerced to a
// string and length-capped anyway (a document basename is short; a pathological
// value should not be able to produce a dialog taller than the screen).
const MAX_DIALOG_DOCUMENT_NAME = 80

export async function confirmDiscardChanges(
  win: BrowserWindow,
  documentName?: string
): Promise<DiscardChangesChoice> {
  const name =
    typeof documentName === 'string' ? documentName.slice(0, MAX_DIALOG_DOCUMENT_NAME) : ''
  const result = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Save', "Don't Save", 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    message: name
      ? `Do you want to save the changes you made to “${name}”?`
      : 'Do you want to save the changes you made?',
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
