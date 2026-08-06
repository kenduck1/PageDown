import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

// Electron-free by design, exactly like recent-files.ts: this module takes
// `userDataDir` as an explicit parameter and never imports `electron`, so it
// stays directly unit-testable under plain Vitest and callers (main-process
// code) are responsible for passing `app.getPath('userData')`.

const RETENTION_FULL_GRANULARITY_DAYS = 30
const MS_PER_DAY = 24 * 60 * 60 * 1000

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

async function readIndex(userDataDir: string, canonicalPath: string): Promise<SnapshotMeta[]> {
  try {
    const raw = await readFile(indexPath(userDataDir, canonicalPath), 'utf8')
    return JSON.parse(raw) as SnapshotMeta[]
  } catch {
    return []
  }
}

async function writeIndex(
  userDataDir: string,
  canonicalPath: string,
  index: SnapshotMeta[]
): Promise<void> {
  await mkdir(documentDir(userDataDir, canonicalPath), { recursive: true })
  await writeFile(indexPath(userDataDir, canonicalPath), JSON.stringify(index), 'utf8')
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

  await writeIndex(userDataDir, canonicalPath, prunedIndex)
  return id
}

export async function getLatestSnapshot(
  userDataDir: string,
  canonicalPath: string
): Promise<SnapshotWithContent | null> {
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
  const index = await readIndex(userDataDir, canonicalPath)
  const toKeep = index.filter((entry) => entry.timestamp <= sinceIso)
  const toDelete = index.filter((entry) => entry.timestamp > sinceIso)
  await Promise.all(
    // See the matching comment in writeSnapshot's prune step: filtering by
    // isValidSnapshotId here is defense against a corrupted index.json, not
    // something normal operation ever exercises.
    toDelete
      .filter((entry) => isValidSnapshotId(entry.id))
      .map((entry) => rm(snapshotPath(userDataDir, canonicalPath, entry.id), { force: true }))
  )
  await writeIndex(userDataDir, canonicalPath, toKeep)
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
