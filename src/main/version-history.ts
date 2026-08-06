import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

// Electron-free by design, exactly like recent-files.ts: this module takes
// `userDataDir` as an explicit parameter and never imports `electron`, so it
// stays directly unit-testable under plain Vitest and callers (main-process
// code) are responsible for passing `app.getPath('userData')`.

const RETENTION_FULL_GRANULARITY_DAYS = 30
const MS_PER_DAY = 24 * 60 * 60 * 1000

// Filesystem mtime is not a monotonic clock directly comparable, bare, to a
// locally-generated Date#toISOString() timestamp:
//   - mtime GRANULARITY TRUNCATION. Snapshot timestamps are millisecond-
//     precision; mtime is not, on any filesystem short of APFS/ext4-with-ns
//     (exFAT/FAT32 -- USB sticks -- truncate to 2s; HFS+ and many SMB/NFS
//     shares to 1s).
//   - MTIME-PRESERVING RESTORES. `rsync -t`, `tar -x`, `unzip`, and most
//     backup/sync tools reinstate the original mtime.
// Chosen to comfortably exceed the coarsest realistic mtime granularity above
// (FAT32/exFAT's 2s).
//
// Lives HERE, not in file-io.ts, even though file-io.ts's
// resolveContentWithRecovery was its original (and still its most-documented)
// consumer: this module is Electron-free by design and file-io.ts imports
// `electron`, so the import can only point in this direction without dragging
// Electron into a plain-Vitest-testable module. Both consumers -- the
// recovery check that decides whether a snapshot is "meaningfully newer" than
// the file, and clearPendingAutosaveForFile's discard cutoff below -- MUST use
// the same value: they are two sides of the same "is this snapshot pending or
// already reflected on disk?" question, and letting them drift apart would
// carve out a window of snapshots that one side deletes and the other would
// have recovered (or vice versa). One exported constant, two call sites.
export const MTIME_TOLERANCE_MS = 2000

export interface SnapshotMeta {
  id: string
  timestamp: string
  sizeBytes: number
}

export interface SnapshotWithContent extends SnapshotMeta {
  content: string
}

// Matches exactly what generateSnapshotId produces: a `Date#toISOString()`
// timestamp (always 24 chars, always UTC/`Z`-suffixed, always this shape)
// followed by '-' and 4 lowercase hex chars. Anchored on both ends
// (^...$) so a conforming id can't have extra segments smuggled in before
// or after it.
const SNAPSHOT_ID_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z-[0-9a-f]{4}$/

function isValidSnapshotId(id: string): boolean {
  return SNAPSHOT_ID_PATTERN.test(id)
}

// Serializes every MUTATING operation (writeSnapshot, clearPendingAutosave) for
// the SAME document, keyed by its hash directory (hashDocumentPath(canonicalPath)).
// Same promise-chaining queue shape as thumbnail-generator.ts's
// enqueueHarnessWork -- CLAUDE.md names that as the required pattern for this
// exact class of problem, just keyed per-document here instead of a single
// shared queue.
//
// Without this, two overlapping calls for the same document (e.g. the 45s
// autosave timer and an explicit Save both firing within the same window --
// Task 3 wires exactly these two triggers) are both read-index -> compute ->
// write-index with no lock: both read the same starting index.json, both
// write their own snapshot .md file, but each computes its new index from the
// stale index it read. Whichever writeIndex finishes last overwrites
// index.json, omitting the other call's entry -- that snapshot file stays on
// disk but becomes permanently unreachable via listSnapshots/getLatestSnapshot
// /readSnapshotContent, and is never pruned by any future retention pass. Real
// data loss for a version-history feature.
//
// Keyed PER DOCUMENT (a Map, not one shared queue) so unrelated documents are
// never serialized against each other -- an autosave for doc A must not wait
// behind a slow write for unrelated doc B. The Map grows by one resolved-promise
// entry per distinct document touched in the app session and is never pruned;
// negligible in practice (a resolved Promise is tiny, and the number of
// distinct documents edited in one session is small), so no cleanup is added.
const documentQueues = new Map<string, Promise<unknown>>()

function enqueueDocumentWork<T>(documentHash: string, task: () => Promise<T>): Promise<T> {
  const previous = documentQueues.get(documentHash) ?? Promise.resolve()
  const result = previous.then(task)
  // Chain the queue's tail through a value- and rejection-swallowing
  // continuation, not `result` directly -- otherwise one rejected write would
  // permanently wedge every future write for this document, since a rejected
  // promise used as the next `.then()`'s receiver short-circuits every
  // subsequent `.then()` in the chain.
  documentQueues.set(
    documentHash,
    result.then(
      () => undefined,
      () => undefined
    )
  )
  return result
}

// 16 hex chars of a SHA-256 hash of the canonicalized document path -- a
// stable, filesystem-safe directory name. Not cryptographically sensitive
// (this isn't a security boundary, just a collision-avoiding key), so a
// truncated hash trades a theoretical, practically-negligible collision
// risk for much shorter, more inspectable directory names.
export function hashDocumentPath(canonicalPath: string): string {
  return createHash('sha256').update(canonicalPath).digest('hex').slice(0, 16)
}

function documentDir(userDataDir: string, canonicalPath: string): string {
  return join(userDataDir, 'version-history', hashDocumentPath(canonicalPath))
}

function indexPath(userDataDir: string, canonicalPath: string): string {
  return join(documentDir(userDataDir, canonicalPath), 'index.json')
}

function documentPathFilePath(userDataDir: string, canonicalPath: string): string {
  return join(documentDir(userDataDir, canonicalPath), 'document-path.json')
}

// `document-path.json` -- specified in the approved design spec's Storage
// section as "{ canonicalPath: '...' } -- for debugging/inspection, and as a
// defensive collision check: on any read, verify this matches the path being
// looked up; treat a mismatch as 'no history' rather than serving another
// document's snapshots." Nothing wrote or read it until the final
// whole-branch review found the gap.
//
// What it defends against: documentDir() keys storage by a 16-hex-char
// (64-bit) truncation of the canonical path's SHA-256. A collision is
// astronomically unlikely (that truncation is a deliberate, documented
// legibility-over-paranoia tradeoff), but its failure mode if it ever
// happened is nasty and completely silent -- document B's snapshots would be
// served as document A's history, and a restore would load B's content into A
// AND land it dirty, i.e. one Save away from overwriting A's real file with a
// different document's text. Cheap to close; expensive to debug if it isn't.
//
// Written with flag 'wx' (create-only) so it records the FIRST document to
// claim a directory and a colliding second document can never overwrite the
// marker to make itself look legitimate. Every failure -- already exists,
// unwritable, anything -- is swallowed: this is a defensive marker, and a
// snapshot write must never fail because of it (the feature's own "best
// effort, never block a real Save" invariant).
async function ensureDocumentPathFile(userDataDir: string, canonicalPath: string): Promise<void> {
  try {
    await writeFile(
      documentPathFilePath(userDataDir, canonicalPath),
      JSON.stringify({ canonicalPath }),
      { encoding: 'utf8', flag: 'wx' }
    )
  } catch {
    // Already claimed, or the write failed -- neither is worth failing a
    // snapshot write over.
  }
}

// True ONLY when the marker exists, parses, carries a string `canonicalPath`,
// and that string disagrees with the path being looked up. Every other
// outcome -- file missing (a directory written before this marker existed, or
// one whose write failed), unreadable, unparseable JSON, wrong shape -- means
// "proceed normally," exactly matching how a corrupted index.json is already
// handled ("no history for this document, not an error", and here not even
// that). A defensive check that turned a corrupt marker into a total loss of
// visible history would be strictly worse than the collision it guards
// against.
async function hasDocumentPathMismatch(
  userDataDir: string,
  canonicalPath: string
): Promise<boolean> {
  try {
    const raw = await readFile(documentPathFilePath(userDataDir, canonicalPath), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    const recorded = (parsed as { canonicalPath?: unknown } | null)?.canonicalPath
    if (typeof recorded !== 'string') return false
    return recorded !== canonicalPath
  } catch {
    return false
  }
}

// SECURITY: `id` must be validated against SNAPSHOT_ID_PATTERN before it
// ever reaches this function. readSnapshotContent (the one path where `id`
// can originate outside this module -- a later task exposes it to the
// renderer as restoreVersionContent(filePath, snapshotId)) does that check
// and returns null early. This function asserts the same thing again as a
// backstop, so any future call site that skips the early-return check still
// can't build a path outside the snapshots directory from a hostile id like
// '../../../../etc/passwd'. Do not remove or relax this -- see CLAUDE.md's
// "File I/O security invariant" section for the class of bug this prevents.
function snapshotPath(userDataDir: string, canonicalPath: string, id: string): string {
  if (!isValidSnapshotId(id)) {
    throw new Error(`Invalid snapshot id: ${id}`)
  }
  return join(documentDir(userDataDir, canonicalPath), 'snapshots', `${id}.md`)
}

// A syntactically valid JSON file can still be the wrong shape (`{}`, `null`,
// or an array holding malformed entries) -- that parses fine, so a bare
// try/catch around readFile/JSON.parse never fires for it, and the first
// `.at(-1)` on a non-array (or on an entry missing a field a caller assumes is
// present) throws uncaught. The governing rule is "a corrupted or unreadable
// index.json is no history for this document, not an error." Mirrors
// recent-files.ts's isRecentFileEntry for exactly the same reason.
function isSnapshotMeta(value: unknown): value is SnapshotMeta {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as SnapshotMeta).id === 'string' &&
    typeof (value as SnapshotMeta).timestamp === 'string' &&
    typeof (value as SnapshotMeta).sizeBytes === 'number'
  )
}

async function readIndex(userDataDir: string, canonicalPath: string): Promise<SnapshotMeta[]> {
  try {
    const raw = await readFile(indexPath(userDataDir, canonicalPath), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(isSnapshotMeta) : []
  } catch {
    return []
  }
}

// Write-then-rename, matching recent-files.ts's writeRecentFiles: a crash or
// kill mid-write would otherwise leave a truncated index.json, silently
// destroying a document's whole visible history. rename(2) is atomic within a
// filesystem, and the temp file is a sibling of the target, so a reader only
// ever sees the old file or the complete new one, never a partial write.
async function writeIndex(
  userDataDir: string,
  canonicalPath: string,
  index: SnapshotMeta[]
): Promise<void> {
  await mkdir(documentDir(userDataDir, canonicalPath), { recursive: true })
  // Written alongside the index, right after the directory is (possibly)
  // created -- a create-only no-op on every call after the first. This is the
  // one place both mutating entry points (writeSnapshot and
  // clearPendingAutosave) funnel through, so no document directory can exist
  // without its marker.
  await ensureDocumentPathFile(userDataDir, canonicalPath)
  const finalPath = indexPath(userDataDir, canonicalPath)
  const tempPath = `${finalPath}.tmp`
  await writeFile(tempPath, JSON.stringify(index), 'utf8')
  await rename(tempPath, finalPath)
}

// Takes the timestamp as a parameter (rather than calling `new Date()`
// internally) so a caller can derive both the id and a separate
// `meta.timestamp` field from a single `new Date()` call. writeSnapshot
// relies on this: the interface contract is that `id` encodes the exact
// same timestamp value stored in `meta.timestamp`, and calling `new Date()`
// twice can straddle a millisecond boundary and silently violate that.
function generateSnapshotId(timestamp: string): string {
  return `${timestamp}-${randomBytes(2).toString('hex')}`
}

export async function writeSnapshot(
  userDataDir: string,
  canonicalPath: string,
  content: string
): Promise<string> {
  return enqueueDocumentWork(hashDocumentPath(canonicalPath), async () => {
    const index = await readIndex(userDataDir, canonicalPath)
    const latest = index.at(-1)
    if (latest) {
      const latestContent = await readSnapshotContent(userDataDir, canonicalPath, latest.id)
      if (latestContent === content) return latest.id
    }

    const timestamp = new Date().toISOString()
    const id = generateSnapshotId(timestamp)
    await mkdir(join(documentDir(userDataDir, canonicalPath), 'snapshots'), { recursive: true })
    await writeFile(snapshotPath(userDataDir, canonicalPath, id), content, 'utf8')

    const meta: SnapshotMeta = { id, timestamp, sizeBytes: Buffer.byteLength(content) }
    const newIndex = [...index, meta]

    const toPrune = new Set(computeSnapshotsToPrune(newIndex, new Date()))
    const prunedIndex = newIndex.filter((entry) => !toPrune.has(entry.id))

    // Index written BEFORE the now-pruned snapshot files are deleted (and
    // atomically, via writeIndex's write-then-rename): if a crash lands
    // between these two steps, the recoverable failure mode is an orphaned
    // .md file nothing references (harmless disk usage), not an index entry
    // pointing at a file that's already gone (which readSnapshotContent
    // already degrades to `null` for, but which listSnapshots would still
    // advertise as restorable). Prefer the recoverable ordering.
    await writeIndex(userDataDir, canonicalPath, prunedIndex)

    await Promise.all(
      // isValidSnapshotId filters defensively here (every id this module itself
      // generates is always valid, so this only matters against a corrupted/
      // hand-edited index.json) rather than letting snapshotPath's validation
      // throw abort the whole prune -- a malformed entry is dropped from the
      // index either way; we just skip trying to delete a file for it.
      [...toPrune]
        .filter(isValidSnapshotId)
        .map((pruneId) => rm(snapshotPath(userDataDir, canonicalPath, pruneId), { force: true }))
    )

    return id
  })
}

// The document-path.json collision check (see hasDocumentPathMismatch) is
// applied HERE, in each PUBLIC read, rather than inside readIndex -- a
// deliberate placement, not an oversight. writeSnapshot and
// clearPendingAutosave both call readIndex to compute their next index, so a
// mismatch short-circuiting readIndex to [] would make the colliding
// document's very next write REPLACE the incumbent's index.json with a
// one-entry array -- destroying the history this check exists to protect
// instead of merely declining to serve it. Reads degrade; writes are left
// alone. (Residual, accepted: a colliding document's writes still append into
// the incumbent's directory, so the incumbent's own reads would then see
// entries it didn't create. The spec specifies only the read-side defense,
// and at 64 bits of hash this is a belt-and-braces guard against something
// that realistically never happens -- deliberately not expanded into a
// re-keying/migration scheme.)
export async function getLatestSnapshot(
  userDataDir: string,
  canonicalPath: string
): Promise<SnapshotWithContent | null> {
  if (await hasDocumentPathMismatch(userDataDir, canonicalPath)) return null
  const index = await readIndex(userDataDir, canonicalPath)
  const latest = index.at(-1)
  if (!latest) return null
  const content = await readSnapshotContent(userDataDir, canonicalPath, latest.id)
  if (content === null) return null
  return { ...latest, content }
}

export async function listSnapshots(
  userDataDir: string,
  canonicalPath: string
): Promise<SnapshotMeta[]> {
  if (await hasDocumentPathMismatch(userDataDir, canonicalPath)) return []
  return readIndex(userDataDir, canonicalPath)
}

export async function readSnapshotContent(
  userDataDir: string,
  canonicalPath: string,
  id: string
): Promise<string | null> {
  // SECURITY: `id` is untrusted past this module's boundary -- a later task
  // exposes this function to the renderer as
  // restoreVersionContent(filePath, snapshotId). Validate against the exact
  // shape generateSnapshotId produces BEFORE building any filesystem path
  // from it. Without this check, an id like '../../../../etc/passwd' would
  // escape the snapshots directory and read an arbitrary local file --
  // exactly the class of bug CLAUDE.md's "File I/O security invariant"
  // section exists to prevent. Do not "simplify" this away; snapshotPath's
  // own internal check is a backstop, not a substitute, for this early
  // return, since returning null here (rather than throwing) is part of
  // this function's documented contract.
  if (!isValidSnapshotId(id)) return null
  // Same document-path.json collision check as the two readers above -- this
  // is the read that actually hands content to the renderer for a restore,
  // so it is the one where serving another document's snapshot would do real
  // damage (it lands in the editor AND lands dirty, one Save away from
  // overwriting this document's real file with a different document's text).
  // Checked independently rather than relying on the callers above, since
  // this is a public entry point in its own right (the renderer reaches it
  // directly as restoreVersionContent). Its only in-module caller besides
  // getLatestSnapshot is writeSnapshot's dedup read, where a null just means
  // "don't dedup" -- an extra snapshot, never a wrong one.
  if (await hasDocumentPathMismatch(userDataDir, canonicalPath)) return null
  try {
    return await readFile(snapshotPath(userDataDir, canonicalPath, id), 'utf8')
  } catch {
    return null
  }
}

export async function clearPendingAutosave(
  userDataDir: string,
  canonicalPath: string,
  sinceIso: string
): Promise<void> {
  return enqueueDocumentWork(hashDocumentPath(canonicalPath), async () => {
    const index = await readIndex(userDataDir, canonicalPath)
    const toKeep = index.filter((entry) => entry.timestamp <= sinceIso)
    const toDelete = index.filter((entry) => entry.timestamp > sinceIso)

    // Same ordering rationale as writeSnapshot's prune step: write the index
    // first (atomically), delete the now-unreferenced files after, so a crash
    // in between leaves harmless orphaned files rather than a dangling index
    // entry.
    await writeIndex(userDataDir, canonicalPath, toKeep)

    await Promise.all(
      // See the matching comment in writeSnapshot's prune step: filtering by
      // isValidSnapshotId here is defense against a corrupted index.json, not
      // something normal operation ever exercises.
      toDelete
        .filter((entry) => isValidSnapshotId(entry.id))
        .map((entry) => rm(snapshotPath(userDataDir, canonicalPath, entry.id), { force: true }))
    )
  })
}

// CRITICAL FIX (fix-round-2 review): computes the discard cutoff from the
// document's OWN on-disk mtime via a real stat() call, then delegates to
// clearPendingAutosave above -- extracted into this Electron-free module
// (rather than left inline in index.ts's IPC handler) specifically so this
// real, previously-buggy code path is directly unit-testable under plain
// Vitest, matching this file's own "Electron-free by design" header
// comment and the established isKnownPath/canonicalizeDocumentPath
// precedent (CLAUDE.md's File I/O security invariant section) for exactly
// this reason.
//
// The bug this replaces: an earlier version of the caller (EditorScreen's
// "Don't Save" handler) passed `new Date().toISOString()` -- the moment of
// the click -- as clearPendingAutosave's own `sinceIso` parameter directly.
// That function only deletes entries with `timestamp > sinceIso`, but
// every snapshot that already exists was necessarily written in the PAST
// relative to "now," so that comparison was false for every real entry and
// NOTHING was ever deleted -- confirmed empirically against this exact
// module. The pending snapshot then survived, compared as meaningfully
// newer than the file's own untouched mtime (file-io.ts's
// MTIME_TOLERANCE_MS check), and got silently recovered on the very next
// open: a direct violation of this feature's own core promise that a
// deliberately discarded edit must never reappear. The design spec's own
// wording -- "deletes every snapshot newer than ... the file's own on-disk
// mtime" -- is what this function actually implements: `filePath` must be
// a real, currently-existing file (the caller's own isKnownPath check has
// already validated it before this is ever reached), and its mtime, not a
// caller-supplied instant, is the only correct cutoff. `canonicalPath` is
// accepted separately (not derived here) so callers keep using the same
// canonicalization this whole module's storage keying depends on
// (CLAUDE.md's "keyed off the CANONICAL path" note) -- this function only
// ever adds the ONE extra piece (the real mtime) that was missing before.
export async function clearPendingAutosaveForFile(
  userDataDir: string,
  canonicalPath: string,
  filePath: string
): Promise<void> {
  const fileStat = await stat(filePath)
  // The cutoff is the file's mtime PLUS MTIME_TOLERANCE_MS, not the bare
  // mtime -- a real bug found in the final whole-branch review, verified
  // empirically (autosave C1 -> Save C2 -> autosave C3 -> clear: C1 survived,
  // but C2 -- the SAVED one -- and C3 were both deleted).
  //
  // Why the bare mtime is wrong: documentStore.save() writes its own
  // version-history snapshot AFTER the disk write has already completed (a
  // deliberate ordering -- a snapshot write must never block, delay, or fail
  // a real Save), so a Save-triggered snapshot's timestamp is ALWAYS a few
  // milliseconds GREATER than the mtime of the very write it records.
  // `clearPendingAutosave` deletes everything with `timestamp > sinceIso`, so
  // a bare-mtime cutoff deletes the version-history entry for the user's most
  // recent explicit Save. Not disk data loss (the file itself is untouched),
  // but the History list is then left advertising a PRE-Save autosave as its
  // newest "version," so restoring "the latest version" hands back content
  // that was never saved -- and it contradicts the design spec's own wording,
  // "deletes every snapshot newer than the document's last explicit Save."
  //
  // Why adding the tolerance is safe rather than merely convenient: a GENUINE
  // pending autosave structurally cannot land inside this 2s margin.
  // `useAutosave` restarts its 45s countdown on every clean->dirty transition
  // and a Save always clears `isDirty`, so the earliest possible autosave tick
  // after a Save is a full 45s after the user's next edit -- far outside the
  // margin. (Multi-tab caveat: see useAutosave's own note that a true->true
  // tab switch doesn't restart the countdown; that only ever makes a tick land
  // EARLIER than 45s, never inside 2s of a Save on a different tab's file.)
  // It also makes this cutoff self-consistent with file-io.ts's recovery
  // check, which uses the SAME constant to decide a snapshot within the margin
  // isn't meaningfully newer than the file -- i.e. exactly the snapshots this
  // now keeps are exactly the ones recovery would never have restored anyway.
  const sinceIso = new Date(fileStat.mtimeMs + MTIME_TOLERANCE_MS).toISOString()
  return clearPendingAutosave(userDataDir, canonicalPath, sinceIso)
}

// Pure: last 30 days kept in full; older than that, thinned to the single
// LATEST snapshot per calendar day (local time). The single most recent
// snapshot overall is never pruned, regardless of age, so a document that
// hasn't been touched in months still has at least one restorable state.
export function computeSnapshotsToPrune(snapshots: SnapshotMeta[], now: Date): string[] {
  if (snapshots.length === 0) return []
  const mostRecentId = snapshots.at(-1)?.id
  const cutoff = now.getTime() - RETENTION_FULL_GRANULARITY_DAYS * MS_PER_DAY

  const old = snapshots.filter(
    (entry) => new Date(entry.timestamp).getTime() < cutoff && entry.id !== mostRecentId
  )

  const latestPerDay = new Map<string, SnapshotMeta>()
  for (const entry of old) {
    const day = new Date(entry.timestamp).toDateString()
    const existing = latestPerDay.get(day)
    if (!existing || entry.timestamp > existing.timestamp) {
      latestPerDay.set(day, entry)
    }
  }
  const keepIds = new Set([...latestPerDay.values()].map((entry) => entry.id))

  return old.filter((entry) => !keepIds.has(entry.id)).map((entry) => entry.id)
}
