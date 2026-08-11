import { randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Crash protection for NEVER-SAVED (untitled) documents.
//
// Electron-free by design, exactly like recent-files.ts / version-history.ts /
// preferences.ts: this module takes `userDataDir` as an explicit parameter and
// never imports `electron`, so it stays directly unit-testable under plain
// Vitest and its main-process callers are responsible for passing
// `app.getPath('userData')`.
//
// --- WHY THIS IS A SEPARATE STORE FROM version-history.ts ---
//
// version-history.ts keys EVERYTHING on a document's canonical file path:
// the storage directory is sha256(canonicalPath), `document-path.json`
// records that path as a collision marker, and recovery-on-open decides
// whether to prefer a snapshot by comparing its timestamp against the FILE's
// own on-disk mtime. A never-saved document has no path, so none of that has
// an input. The two available shortcuts are both wrong:
//   - Inventing a synthetic path (e.g. "untitled://tab-3") to hash would put
//     a real string into `document-path.json` that names no real file, and
//     would make the collision marker -- whose entire job is "these snapshots
//     belong to THIS path" -- assert something untrue.
//   - Keying on the renderer's `DocumentTab.id` would collide across
//     launches: those ids are a module-level `tab-1`, `tab-2`, ... counter
//     that RESTARTS at 1 on every launch (see documentStore.ts's
//     generateTabId), so today's `tab-1` and yesterday's `tab-1` are
//     different documents that would share one directory.
// So drafts get their own area, their own identity scheme, and their own
// (much smaller) contract.
//
// --- WHAT TRANSFERRED FROM version-history.ts, AND WHAT DELIBERATELY DID NOT
//
// TRANSFERRED, unchanged, because the reasoning is identical:
//   - Electron-free module + explicit `userDataDir` (testability).
//   - Write-then-rename atomicity: a crash mid-write must never leave a
//     truncated draft, which for THIS feature would mean corrupting the only
//     copy of the work in existence.
//   - Strict, ANCHORED id validation before any path is built from an id
//     (DRAFT_ID_PATTERN below mirrors version-history.ts's own
//     SNAPSHOT_ID_PATTERN), plus a backstop check inside the path builder.
//   - A per-key serialized work queue, so two operations on one draft cannot
//     interleave.
//   - Best-effort everywhere: a corrupt or unreadable file degrades to "no
//     draft", never to a thrown error.
//
// DELIBERATELY NOT TRANSFERRED:
//   - MTIME_TOLERANCE_MS and the whole "is this snapshot meaningfully newer
//     than the file?" comparison. There IS no file. Nothing on disk can be
//     stale relative to a draft, because the draft is the only copy. The
//     entire class of mtime-granularity / mtime-preserving-restore bugs that
//     constant exists for cannot arise here.
//   - `document-path.json`'s collision marker. That guards a 64-bit TRUNCATED
//     HASH of an attacker-independent string. A draft id is 128 bits of
//     `randomBytes`, minted by the main process, so there is no birthday
//     problem to defend against -- and no "other document's path" for a
//     marker to disagree with even in principle.
//   - Silent recovery. Opening a file has a natural moment at which content
//     can be swapped underneath the user; a draft has no file to open, so
//     there is no such moment. Drafts are OFFERED (Home screen) and never
//     loaded without an explicit click.
//   - The multi-snapshot index + 30-day-then-one-per-day thinning. See
//     "ONE CURRENT STATE PER DRAFT" below.
//
// --- ONE CURRENT STATE PER DRAFT, NOT A HISTORY ---
//
// version-history keeps N snapshots because its value proposition is "go back
// to an earlier version of a document you still have". A draft's value
// proposition is only "the app died; give me back what was on screen". There
// is no earlier version worth browsing, because there is no later version to
// compare it to -- so this stores exactly one file per draft, overwritten in
// place (atomically) on every tick. That removes an index.json, its shape
// validation, its prune pass, and the whole class of "index and files
// disagree" bugs, for nothing a user would ever miss.
//
// --- LAYOUT: A FLAT FILE, NOT A PER-DRAFT DIRECTORY ---
//
// `<userData>/unsaved/<draftId>.md`. A `<userData>/unsaved/<draftId>/`
// directory was the obvious shape (it is what version-history uses) and was
// rejected: with a single-current-state design there is no second file to put
// beside the draft, so every directory would hold exactly one entry forever.
// `updatedAt` and `sizeBytes` come from the file's own `stat()` rather than a
// sidecar meta.json, which is not merely simpler but strictly safer -- a
// sidecar can disagree with the content it describes, and the failure mode of
// "metadata got garbled so your work is now invisible" is exactly the outcome
// this feature exists to prevent. Nothing here is compared against another
// clock, so mtime coarseness (the thing MTIME_TOLERANCE_MS exists for
// elsewhere) is irrelevant: it is display text and a 30-day age check.
//
// Listing filters on the anchored filename pattern, so an unrelated file that
// finds its way into this directory is ignored rather than offered as
// somebody's lost work.

// 30 days, matching version-history.ts's own RETENTION_FULL_GRANULARITY_DAYS
// -- deliberately the same number so the app has ONE answer to "how long does
// PageDown hang on to work you didn't explicitly save".
const DRAFT_RETENTION_DAYS = 30
const MS_PER_DAY = 24 * 60 * 60 * 1000

// 16 random bytes, lowercase hex. Anchored on both ends so a conforming id
// cannot have extra segments smuggled in before or after it -- the same
// posture (and the same reason) as version-history.ts's SNAPSHOT_ID_PATTERN.
//
// SECURITY: this is the ONLY thing standing between a renderer-supplied
// string and a filesystem path. A draft id is not a path and is never
// validated by isKnownPath (CLAUDE.md's File I/O security invariant covers
// renderer-supplied PATHS; no path reaches this module at all) -- so the
// containment argument has to be carried entirely by this pattern. It is a
// strict allowlist match, NOT a sanitizer: nothing is stripped or rewritten,
// a non-conforming id is simply refused, so there is no "what if the
// sanitizer misses a case" question to answer.
const DRAFT_ID_PATTERN = /^[0-9a-f]{32}$/

// Deliberately derived from DRAFT_ID_PATTERN's own source rather than
// re-spelling `[0-9a-f]{32}` a second time: these two must always describe
// the same id shape, and two hand-written copies of one regex is precisely
// how they drift.
const DRAFT_FILE_PATTERN = new RegExp(`^(${DRAFT_ID_PATTERN.source.slice(1, -1)})\\.md$`)

export interface UnsavedDraftMeta {
  draftId: string
  // ISO 8601, from the draft file's own mtime -- see the layout note above
  // for why there is no sidecar recording this.
  updatedAt: string
  sizeBytes: number
  // A short, human-readable label so a list of three untitled drafts is
  // distinguishable by something other than a timestamp. Computed from the
  // content on every listing (buildDraftPreview), never stored.
  preview: string
}

export function isValidDraftId(draftId: string): boolean {
  return DRAFT_ID_PATTERN.test(draftId)
}

// 128 bits of randomness. Minted HERE, in the main process, rather than in
// the renderer -- two reasons, and the second is the load-bearing one:
//   - The renderer would need `crypto.randomUUID`, whose availability across
//     every runtime this store is exercised in (Electron renderer, jsdom
//     under Vitest) is exactly the concern documentStore.ts's own
//     generateTabId comment already records for tab ids.
//   - More importantly, it keeps identity minting on the side of the process
//     that owns the filesystem. The renderer can only ever ECHO an id back
//     (and gets validated when it does); it can never name a fresh one.
export function generateDraftId(): string {
  return randomBytes(16).toString('hex')
}

function draftsRoot(userDataDir: string): string {
  return join(userDataDir, 'unsaved')
}

// SECURITY BACKSTOP, mirroring version-history.ts's snapshotPath: every
// public entry point below validates `draftId` and degrades before reaching
// here, but this throws anyway so that any future call site which skips that
// check still cannot build a path outside the drafts directory from an id
// like '../../../../etc/passwd'. Do not remove or relax it -- the early
// returns are the contract, this is the guarantee.
function draftPath(userDataDir: string, draftId: string): string {
  if (!isValidDraftId(draftId)) {
    throw new Error(`Invalid unsaved-draft id: ${draftId}`)
  }
  return join(draftsRoot(userDataDir), `${draftId}.md`)
}

// Serializes every operation on the SAME draft, keyed by draft id -- the same
// promise-chaining queue shape as version-history.ts's enqueueDocumentWork and
// thumbnail-generator.ts's enqueueHarnessWork (CLAUDE.md names this as the
// required pattern for this class of problem).
//
// The single-file design already makes a torn read impossible (rename(2) is
// atomic, so a reader sees the whole old file or the whole new one), so this
// is NOT about write corruption. It is about ORDERING across DIFFERENT
// operations: `discardUnsavedDraft` racing an in-flight `writeUnsavedDraft`
// for the same draft would otherwise be able to delete the file first and let
// the write recreate it a moment later -- resurrecting work the user had just
// explicitly discarded, which is the single worst outcome this whole feature
// can produce (CLAUDE.md's "a deliberately discarded edit must never
// reappear"). Serializing makes discard-after-write and write-after-discard
// the only two possible orders, and both are correct.
//
// Keyed per draft (a Map, not one shared queue) so two unrelated drafts never
// wait on each other. Grows by one resolved-promise entry per distinct draft
// touched in a session and is never pruned; negligible, same as the
// version-history queue it copies.
const draftQueues = new Map<string, Promise<unknown>>()

function enqueueDraftWork<T>(draftId: string, task: () => Promise<T>): Promise<T> {
  const previous = draftQueues.get(draftId) ?? Promise.resolve()
  const result = previous.then(task)
  // Chain the queue's tail through a value- and rejection-swallowing
  // continuation, not `result` directly -- otherwise one rejected write would
  // permanently wedge every future operation on this draft, since a rejected
  // promise used as the next `.then()`'s receiver short-circuits the rest of
  // the chain. Same reasoning, verbatim, as version-history.ts's own queue.
  draftQueues.set(
    draftId,
    result.then(
      () => undefined,
      () => undefined
    )
  )
  return result
}

/**
 * Writes (or overwrites) the current state of one never-saved document.
 *
 * `draftId` is `null` the first time a given untitled document is protected;
 * a fresh id is minted and RETURNED, and the caller is expected to remember it
 * so subsequent ticks overwrite the same draft rather than accumulating one
 * file per tick.
 *
 * Returns the id in use, or `null` when there was nothing worth writing.
 *
 * Byte-empty content is the one case that writes nothing at all: it has
 * nothing to recover, and creating a file for it would put an "unsaved
 * document" row on the Home screen for every blank tab the app has ever
 * opened. The check is deliberately byte-exact (`=== ''`) rather than
 * trimmed, matching documentStore.ts's own isPristineBlankTab predicate for
 * the same stated reason: whitespace-only or frontmatter-only content is
 * still something a user or a template produced on purpose, and the price of
 * getting this predicate wrong is silently destroying it.
 *
 * An INVALID non-null `draftId` throws rather than quietly minting a fresh
 * one. Minting would look more forgiving but is worse: the only way an
 * invalid id can arrive is corrupted caller state, and silently starting a
 * new draft on every such call would spray orphaned files into the store
 * while hiding the fault. The caller's IPC handler logs and swallows, so a
 * throw here costs one skipped tick, not a user-visible error.
 */
export async function writeUnsavedDraft(
  userDataDir: string,
  draftId: string | null,
  content: string
): Promise<string | null> {
  if (content === '') return null
  if (draftId !== null && !isValidDraftId(draftId)) {
    throw new Error(`Invalid unsaved-draft id: ${draftId}`)
  }
  const id = draftId ?? generateDraftId()
  return enqueueDraftWork(id, async () => {
    await mkdir(draftsRoot(userDataDir), { recursive: true })
    const finalPath = draftPath(userDataDir, id)
    // Write-then-rename, matching recent-files.ts/version-history.ts: a crash
    // or kill mid-write would otherwise leave a truncated draft. That is
    // strictly worse here than anywhere else in this codebase, because for an
    // unsaved document this file is not a backup of something -- it IS the
    // document.
    const tempPath = `${finalPath}.tmp`
    await writeFile(tempPath, content, 'utf8')
    await rename(tempPath, finalPath)
    return id
  })
}

/** The draft's content, or `null` for every failure alike (unknown id, absent, unreadable). */
export async function readUnsavedDraft(
  userDataDir: string,
  draftId: string
): Promise<string | null> {
  if (!isValidDraftId(draftId)) return null
  try {
    return await readFile(draftPath(userDataDir, draftId), 'utf8')
  } catch {
    return null
  }
}

/**
 * Deletes one draft outright. No cutoff, no timestamp comparison, no
 * "delete everything newer than X" -- and that absence is the whole point.
 *
 * version-history.ts's clearPendingAutosave DOES take a cutoff, because for a
 * SAVED document only some snapshots are pending (the ones newer than what is
 * on disk) and the rest are legitimate history that must survive. That design
 * shipped a Critical bug: the renderer passed `new Date().toISOString()` as
 * the cutoff, every existing snapshot was necessarily written in the past
 * relative to "now", the `timestamp > sinceIso` comparison was therefore false
 * for all of them, and the discard silently deleted NOTHING -- so the
 * discarded edit came straight back as a "recovered" document on the next
 * open. (Fixed by computing the cutoff in main from the file's real mtime; see
 * clearPendingAutosaveForFile.)
 *
 * That entire class of bug cannot arise here, and it is worth being precise
 * about why rather than merely asserting it: a draft is ENTIRELY pending by
 * definition. It has never been written anywhere else, so there is no on-disk
 * version for some of it to be "already reflected in" and no history worth
 * preserving -- which means there is no correct cutoff other than "all of
 * it", and therefore no timestamp for a caller to compute wrongly. The
 * discard is unconditional removal, and it is verified by a test that asserts
 * the file is genuinely gone from disk rather than merely that the call
 * resolved.
 *
 * `force: true` so discarding an already-absent draft is a no-op rather than
 * a throw -- every caller is fire-and-forget on an already-final decision.
 */
export async function discardUnsavedDraft(userDataDir: string, draftId: string): Promise<void> {
  if (!isValidDraftId(draftId)) return
  await enqueueDraftWork(draftId, async () => {
    await rm(draftPath(userDataDir, draftId), { force: true })
  })
}

/**
 * Every recoverable draft, most-recently-updated FIRST (the opposite of
 * version-history's newest-last index, because this is a list a human reads
 * top-down rather than an append log).
 *
 * Degrades per entry rather than wholesale: one unreadable file drops that
 * one row and leaves the rest listed. A single broken draft must never hide
 * the others -- the same governing rule recent-files.ts's isRecentFileEntry
 * and version-history.ts's isSnapshotMeta already apply to their own stores.
 */
export async function listUnsavedDrafts(userDataDir: string): Promise<UnsavedDraftMeta[]> {
  let entries: string[]
  try {
    entries = await readdir(draftsRoot(userDataDir))
  } catch {
    // No drafts directory yet is the normal case, not an error.
    return []
  }

  const metas = await Promise.all(
    entries.map(async (name): Promise<UnsavedDraftMeta | null> => {
      const match = DRAFT_FILE_PATTERN.exec(name)
      // Ignores `.tmp` files from an interrupted write, and anything else
      // that finds its way into this directory -- neither is somebody's lost
      // work, and offering one as if it were would be worse than dropping it.
      if (!match) return null
      const draftId = match[1]
      try {
        const fileStat = await stat(draftPath(userDataDir, draftId))
        const content = await readFile(draftPath(userDataDir, draftId), 'utf8')
        // A byte-empty draft cannot be produced by writeUnsavedDraft (which
        // refuses empty content), so this only fires for a file truncated by
        // something else. There is nothing to recover from it, so it is not
        // offered.
        if (content === '') return null
        return {
          draftId,
          updatedAt: new Date(fileStat.mtimeMs).toISOString(),
          sizeBytes: fileStat.size,
          preview: buildDraftPreview(content)
        }
      } catch {
        return null
      }
    })
  )

  return metas
    .filter((meta): meta is UnsavedDraftMeta => meta !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/**
 * Deletes drafts older than DRAFT_RETENTION_DAYS. Returns the ids removed.
 *
 * This is the ONE place in this feature that deletes real user work without
 * an explicit user action, so it is worth stating the tradeoff rather than
 * burying it. Without it, a user who ignores the Home-screen recovery
 * section accumulates rows forever, and a list of forty untitled drafts is
 * not a safety net -- it is noise that makes the ONE draft that mattered
 * harder to find, which degrades the feature into uselessness by a slower
 * route than deleting it would. The window is deliberately the same 30 days
 * version-history already keeps at full granularity, and it is measured from
 * the last time the draft was WRITTEN (its mtime), so a draft that is still
 * being edited is never a candidate however old the document is.
 *
 * Best-effort: any failure -- listing, or one individual delete -- leaves the
 * draft in place. Failing to prune costs disk; failing safe costs nothing.
 */
export async function pruneExpiredDrafts(userDataDir: string, now: Date): Promise<string[]> {
  const cutoff = now.getTime() - DRAFT_RETENTION_DAYS * MS_PER_DAY
  const drafts = await listUnsavedDrafts(userDataDir)
  const expired = drafts.filter((draft) => new Date(draft.updatedAt).getTime() < cutoff)
  await Promise.all(
    expired.map(async (draft) => {
      try {
        await discardUnsavedDraft(userDataDir, draft.draftId)
      } catch {
        // Leave it; it will be reconsidered on the next run.
      }
    })
  )
  return expired.map((draft) => draft.draftId)
}

/**
 * A one-line, human-readable label for a draft. Pure, so it is directly
 * unit-testable and identical for every caller.
 *
 * Skips a leading YAML frontmatter block, because useCreateDocument applies
 * the user's default page config as frontmatter to every new blank document
 * -- so without this, the single most common draft in existence would be
 * labelled `pageSize: Letter`, which distinguishes nothing from any other
 * draft. The skip is conditional on actually FINDING a closing `---`: a
 * document whose first line is a thematic break rather than frontmatter would
 * otherwise have its entire body swallowed by the scan, so an unterminated
 * fence is treated as an ordinary line instead.
 *
 * Leading Markdown heading, list and blockquote markers are stripped so the
 * label reads as prose rather than as source, and a line that is ONLY a
 * thematic break is treated as blank. That last rule is not cosmetic: it is
 * what stops the unterminated-fence case above from labelling a draft `---`,
 * which was a real test failure while writing this, not a hypothetical.
 */
const THEMATIC_BREAK = /^(?:-{3,}|\*{3,}|_{3,})$/

export function buildDraftPreview(content: string, maxLength = 80): string {
  const lines = content.split('\n')
  let index = 0

  if (lines[0]?.trim() === '---') {
    const closing = lines.findIndex((line, i) => i > 0 && line.trim() === '---')
    if (closing !== -1) index = closing + 1
  }

  for (; index < lines.length; index += 1) {
    const stripped = lines[index]
      .replace(/^\s*#{1,6}\s+/, '')
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
      .replace(/^\s*>\s?/, '')
      .trim()
    if (stripped === '' || THEMATIC_BREAK.test(stripped)) continue
    return stripped.length > maxLength ? `${stripped.slice(0, maxLength - 1)}…` : stripped
  }
  return ''
}
