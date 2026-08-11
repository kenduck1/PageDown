// A small, bounded, TTL'd cache in front of `window.api.resolveLocalImage`
// (main's `file:resolveLocalImage` handler), shared by every image node view
// in every mounted editor in this window.
//
// WHY A MODULE-LEVEL CACHE RATHER THAN PER-NODE-VIEW OR PER-MOUNT STATE:
// this app remounts the whole Milkdown editor a lot -- `key={revision}` in
// EditorScreen fires on every view-mode switch, Page Setup apply, History
// restore and tab load -- and each remount rebuilds every image node view
// from scratch. Cache state living on the node view (or on the editor
// instance) would therefore be thrown away on transitions the user
// experiences as "nothing changed", re-reading every image off disk and
// re-base64ing it through IPC each time. A module-level cache survives
// remounts by construction while still being per-WINDOW (each window is its
// own renderer process, so there is no cross-window sharing to reason about)
// and per-run (nothing is persisted; a relaunch starts empty).
//
// WHY A TTL RATHER THAN A PERMANENT CACHE: the bytes are a snapshot of a
// real file the user can edit in another program at any moment. Caching
// forever means a corrected chart never updates until relaunch. The other
// obvious designs were ruled out: an fs.watch-based invalidation needs a
// main-process watcher per document directory plus debouncing and teardown
// (real machinery, and CLAUDE.md already records file watching as
// deliberately not built); and an mtime-keyed cache saves nothing, because
// learning the mtime costs the same IPC round trip and `stat` that just
// re-reading the file does. A short TTL gets most of the benefit -- it
// collapses the burst of identical lookups a remount causes -- with a bound
// on staleness that needs no new mechanism anywhere.
//
// WHY `data:` URIs RATHER THAN BLOB URLs: a blob: URL would avoid holding
// base64 in JS strings, but it must be explicitly revoked or it leaks for
// the lifetime of the document -- exactly the "don't leak across the
// key={revision} remounts this app does" hazard -- and revoking correctly
// would mean reference-counting one URL against N node views across M
// remounts. It would also need `blob:` added to the privileged renderer's
// own `img-src` CSP. A `data:` URI is plain garbage-collectable string data
// that the existing `img-src 'self' data:` policy already permits, so the
// only thing to bound is how much of it is held at once -- which is what
// MAX_ENTRIES/MAX_CACHED_BYTES below do.

export type LocalImageLoader = (filePath: string, src: string) => Promise<string | null>

// Long enough to absorb a burst of remounts and a document-wide scroll;
// short enough that "I fixed the image and switched back" shows the fix
// without a relaunch.
const POSITIVE_TTL_MS = 30_000
// A miss is far cheaper to re-check than a hit is to re-read (no file read,
// no base64), and a genuinely missing file is the case most likely to be
// fixed within seconds -- the user is probably in the middle of putting the
// file where the document says it is.
const NEGATIVE_TTL_MS = 3_000

const MAX_ENTRIES = 32
// Each entry can legitimately be up to MAX_ASSET_BYTES (10 MiB) of file,
// which base64 inflates by ~4/3, so MAX_ENTRIES alone bounds nothing useful:
// 32 maximal entries would be ~426 MiB. This second, byte-denominated bound
// is the one that actually matters; the entry count only keeps the map from
// filling up with thousands of tiny icons.
const MAX_CACHED_BYTES = 24 * 1024 * 1024

interface CacheEntry {
  dataUri: string | null
  storedAt: number
}

// Keyed on document path AND src, never src alone: two documents in two
// directories routinely reference `chart.png` and they are different files.
// This is the same reasoning `thumbnail-generator.ts`/`page-count-generator.ts`
// already apply to their own caches (CLAUDE.md: "Both generators' caches key
// on the document directory, not content alone").
//
// A NUL separator rather than a plain delimiter: NUL cannot appear in a
// POSIX path or in a Markdown image destination, so no (filePath, src) pair
// can be made to collide with a different one by embedding the separator.
function cacheKey(filePath: string, src: string): string {
  return `${filePath}\u0000${src}`
}

const cache = new Map<string, CacheEntry>()
// One in-flight request per key. Without this, a document with the same
// image referenced twenty times fires twenty simultaneous IPC round trips on
// mount -- and every one of them reads the same file off disk.
const inFlight = new Map<string, Promise<string | null>>()
let cachedBytes = 0

function entryBytes(entry: CacheEntry): number {
  return entry.dataUri ? entry.dataUri.length : 0
}

function isFresh(entry: CacheEntry, now: number): boolean {
  const ttl = entry.dataUri === null ? NEGATIVE_TTL_MS : POSITIVE_TTL_MS
  return now - entry.storedAt < ttl
}

function dropEntry(key: string): void {
  const existing = cache.get(key)
  if (!existing) return
  cachedBytes -= entryBytes(existing)
  cache.delete(key)
}

function store(key: string, dataUri: string | null): void {
  dropEntry(key)
  const entry: CacheEntry = { dataUri, storedAt: Date.now() }
  cache.set(key, entry)
  cachedBytes += entryBytes(entry)
  // Map iteration order is insertion order, and every read re-inserts (see
  // resolveCachedLocalImage), so `cache.keys().next()` is genuinely the
  // least-recently-USED key, not merely the oldest-written one.
  while (cache.size > MAX_ENTRIES || cachedBytes > MAX_CACHED_BYTES) {
    const oldest = cache.keys().next()
    if (oldest.done) break
    // Never evict the entry just stored -- with a single image larger than
    // MAX_CACHED_BYTES/2 this loop would otherwise immediately discard the
    // thing the caller is about to render, on every single lookup, turning
    // the cache into a guaranteed miss for exactly the documents that most
    // need it.
    if (oldest.value === key) break
    dropEntry(oldest.value)
  }
}

// Resolves `src` (a document-relative image reference, exactly as it appears
// in the Markdown) against `filePath` (the document's own path), returning a
// `data:` URI or `null`. Never rejects: `load` is expected not to either,
// but an IPC-layer failure would otherwise reject inside a node view with
// nothing to catch it, so a thrown error is cached as a plain miss.
//
// `load` is injected rather than reaching for `window.api` here so this
// module is directly unit-testable without a preload bridge -- the same
// reasoning that keeps `isKnownPath`/`canonicalizeDocumentPath` out of
// electron-importing modules on the main side.
export function resolveCachedLocalImage(
  filePath: string,
  src: string,
  load: LocalImageLoader
): Promise<string | null> {
  const key = cacheKey(filePath, src)
  const now = Date.now()

  const cached = cache.get(key)
  if (cached) {
    if (isFresh(cached, now)) {
      // Re-insert to move this key to the end of the iteration order, which
      // is what makes the eviction loop above LRU rather than FIFO.
      cache.delete(key)
      cache.set(key, cached)
      return Promise.resolve(cached.dataUri)
    }
    dropEntry(key)
  }

  const pending = inFlight.get(key)
  if (pending) return pending

  const request = load(filePath, src)
    .catch(() => null)
    .then((dataUri) => {
      const value = typeof dataUri === 'string' && dataUri.length > 0 ? dataUri : null
      store(key, value)
      return value
    })
    .finally(() => {
      inFlight.delete(key)
    })

  inFlight.set(key, request)
  return request
}

// Exported for tests. Deliberately NOT called from product code: there is no
// event in this app that means "every local image everywhere is now stale"
// (a save writes the .md, not the images; a dropped image always lands on a
// fresh, collision-numbered filename), so a product-code caller would be
// papering over a staleness question the TTL already answers.
export function clearLocalImageCache(): void {
  cache.clear()
  inFlight.clear()
  cachedBytes = 0
}

// Exported for tests only -- lets the bounding behaviour above be asserted
// directly rather than inferred from how many times a spy was called.
export function localImageCacheStats(): { entries: number; bytes: number } {
  return { entries: cache.size, bytes: cachedBytes }
}
