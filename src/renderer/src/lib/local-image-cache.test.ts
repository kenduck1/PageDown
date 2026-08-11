import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearLocalImageCache,
  localImageCacheStats,
  resolveCachedLocalImage,
  type LocalImageLoader
} from './local-image-cache'

// A recognisable, correctly-shaped data: URI per call, so a test can tell
// "served from cache" from "re-read" by value rather than only by call count.
function loaderReturning(
  values: (string | null)[]
): LocalImageLoader & { mock: { calls: unknown[] } } {
  let index = 0
  return vi.fn(
    async () => values[Math.min(index++, values.length - 1)]
  ) as unknown as LocalImageLoader & {
    mock: { calls: unknown[] }
  }
}

const DOC = '/docs/note.md'

beforeEach(() => {
  clearLocalImageCache()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  clearLocalImageCache()
})

describe('resolveCachedLocalImage', () => {
  it('returns what the loader resolved', async () => {
    const load = loaderReturning(['data:image/png;base64,AAA'])
    await expect(resolveCachedLocalImage(DOC, 'a.png', load)).resolves.toBe(
      'data:image/png;base64,AAA'
    )
  })

  it('serves a second lookup from cache without calling the loader again', async () => {
    const load = loaderReturning(['data:image/png;base64,FIRST', 'data:image/png;base64,SECOND'])

    await resolveCachedLocalImage(DOC, 'a.png', load)
    const again = await resolveCachedLocalImage(DOC, 'a.png', load)

    expect(again).toBe('data:image/png;base64,FIRST')
    expect(load).toHaveBeenCalledTimes(1)
  })

  // The reason the cache exists at all: EditorScreen's key={revision} remount
  // rebuilds every image node view, and a document can reference the same
  // image many times. Both would otherwise be N disk reads.
  it('collapses concurrent lookups of the same image into ONE loader call', async () => {
    let resolveLoad: (value: string) => void = () => {}
    const load = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          resolveLoad = resolve
        })
    )

    const all = Promise.all([
      resolveCachedLocalImage(DOC, 'a.png', load),
      resolveCachedLocalImage(DOC, 'a.png', load),
      resolveCachedLocalImage(DOC, 'a.png', load)
    ])
    resolveLoad('data:image/png;base64,ONCE')

    expect(await all).toEqual([
      'data:image/png;base64,ONCE',
      'data:image/png;base64,ONCE',
      'data:image/png;base64,ONCE'
    ])
    expect(load).toHaveBeenCalledTimes(1)
  })

  // Same filename, two documents in two directories -- the exact collision
  // thumbnail-generator.ts/page-count-generator.ts already key their own
  // caches against.
  it('keys on the document path as well as the src', async () => {
    const load = loaderReturning(['data:image/png;base64,DOC1', 'data:image/png;base64,DOC2'])

    const first = await resolveCachedLocalImage('/a/note.md', 'chart.png', load)
    const second = await resolveCachedLocalImage('/b/note.md', 'chart.png', load)

    expect(first).toBe('data:image/png;base64,DOC1')
    expect(second).toBe('data:image/png;base64,DOC2')
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('re-reads once the positive TTL has expired -- never serves stale bytes forever', async () => {
    const load = loaderReturning(['data:image/png;base64,OLD', 'data:image/png;base64,NEW'])

    await resolveCachedLocalImage(DOC, 'a.png', load)
    vi.setSystemTime(Date.now() + 31_000)
    const after = await resolveCachedLocalImage(DOC, 'a.png', load)

    expect(after).toBe('data:image/png;base64,NEW')
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('caches a miss briefly, then re-checks -- an image added after the fact still appears', async () => {
    const load = loaderReturning([null, 'data:image/png;base64,ARRIVED'])

    await expect(resolveCachedLocalImage(DOC, 'a.png', load)).resolves.toBeNull()
    // Still inside the (shorter) negative TTL: no second read.
    await expect(resolveCachedLocalImage(DOC, 'a.png', load)).resolves.toBeNull()
    expect(load).toHaveBeenCalledTimes(1)

    vi.setSystemTime(Date.now() + 4_000)

    await expect(resolveCachedLocalImage(DOC, 'a.png', load)).resolves.toBe(
      'data:image/png;base64,ARRIVED'
    )
  })

  it('treats a rejected loader as a plain miss rather than propagating', async () => {
    const load = vi.fn(async () => {
      throw new Error('IPC exploded')
    })

    await expect(resolveCachedLocalImage(DOC, 'a.png', load)).resolves.toBeNull()
  })

  it('treats an empty-string result as a miss', async () => {
    const load = loaderReturning([''])
    await expect(resolveCachedLocalImage(DOC, 'a.png', load)).resolves.toBeNull()
  })

  // The bound that actually matters: each entry can be ~13MB of base64 for a
  // maximal (10 MiB) image, so an entry-count cap alone bounds nothing useful.
  it('evicts by total bytes, keeping the cache under its byte ceiling', async () => {
    // ~8MB each, so the third cannot coexist with the first two under a 24MB
    // ceiling without eviction.
    const big = `data:image/png;base64,${'A'.repeat(8 * 1024 * 1024)}`
    const load = vi.fn(async () => big)

    await resolveCachedLocalImage(DOC, 'one.png', load)
    await resolveCachedLocalImage(DOC, 'two.png', load)
    await resolveCachedLocalImage(DOC, 'three.png', load)
    await resolveCachedLocalImage(DOC, 'four.png', load)

    expect(localImageCacheStats().bytes).toBeLessThanOrEqual(24 * 1024 * 1024)
    expect(localImageCacheStats().entries).toBeLessThan(4)
  })

  it('evicts by entry count once past its ceiling', async () => {
    const load = vi.fn(async () => 'data:image/png;base64,AAA')

    for (let i = 0; i < 40; i += 1) {
      await resolveCachedLocalImage(DOC, `image-${i}.png`, load)
    }

    expect(localImageCacheStats().entries).toBeLessThanOrEqual(32)
  })

  it('evicts least-recently-USED, not merely least-recently-written', async () => {
    const load = vi.fn(async (_path: string, src: string) => `data:image/png;base64,${src}`)

    for (let i = 0; i < 32; i += 1) {
      await resolveCachedLocalImage(DOC, `image-${i}.png`, load)
    }
    // Touch the oldest entry, promoting it to most-recently-used.
    await resolveCachedLocalImage(DOC, 'image-0.png', load)
    const callsAfterTouch = load.mock.calls.length

    // Push one new entry in, forcing exactly one eviction.
    await resolveCachedLocalImage(DOC, 'newcomer.png', load)
    const callsAfterNewcomer = load.mock.calls.length
    expect(callsAfterNewcomer).toBe(callsAfterTouch + 1)

    // image-0 survived (a FIFO cache would have evicted it as the oldest
    // WRITE), so re-reading it costs no new loader call...
    await resolveCachedLocalImage(DOC, 'image-0.png', load)
    expect(load).toHaveBeenCalledTimes(callsAfterNewcomer)

    // ...while image-1, the genuine least-recently-USED, is gone and must be
    // re-read.
    await resolveCachedLocalImage(DOC, 'image-1.png', load)
    expect(load).toHaveBeenCalledTimes(callsAfterNewcomer + 1)
  })
})
