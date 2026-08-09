import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { mergeRecentFiles, readRecentFiles, writeRecentFiles } from '../src/main/recent-files'
import { launchIsolatedApp } from './electron-launch'
import {
  ONE_PX_PNG,
  TWO_PX_PNG,
  assetUrlPattern,
  readImageBoxes,
  writeFixtureFile
} from './asset-evidence'

// This gate proves the EditorStatusBar sub-project's new `file:getPageCount`
// IPC handler (src/main/index.ts -> src/main/page-count-generator.ts)
// returns a REAL page count from a real Paged.js layout pass through a real
// dedicated pagination harness -- not a fake/hardcoded number -- and that
// its own harness/queue (deliberately separate from thumbnail-generator.ts's
// and the Phase-0-spike harness's) is safe under concurrent callers, the
// same architectural risk phase0/gate9-thumbnail-concurrency.spec.ts already
// proved for `getThumbnail`'s harness.
//
// Uses `launchIsolatedApp` (phase0/electron-launch.ts), not a bare
// `electron.launch()` -- see that helper's own comment for why a bare launch
// silently reads/writes the developer's real userData directory.
//
// Drives the REAL renderer page's `window.api.getPageCount` (the exact path
// `usePageCount`/`EditorStatusBar` use), not the `__pagedownPhase0` bridge --
// per CLAUDE.md's own stated preference for new gates (established by Gate
// 9), and per this gate's own goal of proving the real contextBridge-exposed
// surface, not a main-process-only shortcut.
//
// Matched by a POSITIVE `file://` check, same as gate9/gate11's own
// `getMainWindow` -- this app opens a SECOND window at startup (the Phase 0
// spike's sandboxed `pagedown-render://` harness), and `firstWindow()` races
// between the two.
async function getMainWindow(app: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    for (const candidate of app.windows()) {
      try {
        await candidate.waitForLoadState('domcontentloaded', { timeout: 500 })
      } catch {
        continue
      }
      if (candidate.url().startsWith('file://')) {
        return candidate
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('Timed out locating the main app-shell window (only found the sandboxed one)')
}

// A handful of filler paragraphs, cycled, so generated fixtures don't
// paginate identically to each other by coincidence -- same technique as
// phase0/corpus/generate-long.ts.
const FILLER_PARAGRAPHS = [
  'The committee reviewed the quarterly submission and found the methodology sound, though several reviewers noted that the sampling window could be extended in future cycles to capture seasonal variation.',
  'Subsequent analysis revealed a consistent pattern across all four regions, with the northern district showing the most pronounced deviation from the projected baseline established in the prior fiscal year.',
  'It is recommended that the working group reconvene no later than the end of next month to finalize the revised timeline and communicate any changes to the affected stakeholders in writing.'
]

function generateSections(sectionCount: number, label: string): string {
  let out = `# Fixture ${label}\n\n`
  for (let section = 1; section <= sectionCount; section++) {
    out += `## Section ${section}\n\n`
    out += `${FILLER_PARAGRAPHS[section % FILLER_PARAGRAPHS.length]}\n\n`
    out += `${FILLER_PARAGRAPHS[(section + 1) % FILLER_PARAGRAPHS.length]}\n\n`
  }
  return out
}

test.describe('Gate 12: real page counts via the dedicated getPageCount harness', () => {
  let app: ElectronApplication
  let close: () => Promise<void>
  let win: Page

  test.beforeAll(async () => {
    const isolated = await launchIsolatedApp(['out/main/index.js'])
    app = isolated.app
    close = isolated.close
    win = await getMainWindow(app)
    await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)
  })

  test.afterAll(async () => {
    // Guarded: if beforeAll's launchIsolatedApp itself threw, `close` was
    // never assigned, and an unguarded call here would mask that real
    // failure with a TypeError.
    if (close) await close()
  })

  test('a trivial one-paragraph document paginates to exactly 1 page', async () => {
    const result = await win.evaluate(() =>
      (
        window as unknown as {
          api: { getPageCount: (c: string) => Promise<{ pageCount: number }> }
        }
      ).api.getPageCount('# Trivial\n\nJust one short paragraph of content.')
    )
    expect(result.pageCount).toBe(1)
  })

  test('a genuinely long document paginates to many pages, not a hardcoded/stubbed value', async () => {
    const content = generateSections(120, 'Long')
    const result = await win.evaluate(
      (c) =>
        (
          window as unknown as {
            api: { getPageCount: (c: string) => Promise<{ pageCount: number }> }
          }
        ).api.getPageCount(c),
      content
    )
    // Not pinned to an exact value -- Paged.js layout is sensitive to font
    // metrics that can drift slightly across environments/versions (this
    // repo's own committed phase0/results/gate2-timing.json shows the
    // "429 sections" tier measuring 99 pages in one run and 108 in another
    // real, committed run) -- but a real multi-hundred-word, 120-section
    // document laying out to a mere handful of pages, or to a suspiciously
    // round/hardcoded number, would both be real bugs this range would
    // catch.
    expect(result.pageCount).toBeGreaterThan(15)
    expect(result.pageCount).toBeLessThan(45)
  })

  test('a second call for identical content is a fast in-memory cache hit', async () => {
    const content = generateSections(60, 'CacheHit')

    const firstStart = Date.now()
    const first = await win.evaluate(
      (c) =>
        (
          window as unknown as {
            api: { getPageCount: (c: string) => Promise<{ pageCount: number }> }
          }
        ).api.getPageCount(c),
      content
    )
    const firstElapsedMs = Date.now() - firstStart

    const secondStart = Date.now()
    const second = await win.evaluate(
      (c) =>
        (
          window as unknown as {
            api: { getPageCount: (c: string) => Promise<{ pageCount: number }> }
          }
        ).api.getPageCount(c),
      content
    )
    const secondElapsedMs = Date.now() - secondStart

    expect(second.pageCount).toBe(first.pageCount)
    // The real proof this was a cache hit, not just "also happened to be
    // fast": a genuine cache hit skips the harness/queue/sendDocument round
    // trip entirely and resolves in low single-digit milliseconds, an order
    // of magnitude faster than a real dispatch (which this repo's own
    // measurements put at 60-450ms+ even for a warm, already-created
    // harness -- see this file's other tests and page-count-generator.ts's
    // own module comment). A generous 25ms threshold comfortably separates
    // the two without being sensitive to normal IPC/CI timing noise.
    expect(secondElapsedMs).toBeLessThan(25)
    expect(secondElapsedMs).toBeLessThan(firstElapsedMs)
  })

  test('concurrent getPageCount calls for differently-sized documents each resolve with their OWN correct count', async () => {
    // Three fixtures deliberately sized to paginate to clearly distinct page
    // counts -- proving the dedicated harness/queue serializes correctly
    // under concurrency (each caller gets its own answer, not a shared or
    // swapped one), the same property phase0/gate9-thumbnail-concurrency.spec.ts
    // already proved for getThumbnail's own separate harness.
    const fixtures = [
      { label: 'A', sections: 1 },
      { label: 'B', sections: 40 },
      { label: 'C', sections: 100 }
    ].map(({ label, sections }) => generateSections(sections, label))

    const results = await win.evaluate(async (docs) => {
      const api = (
        window as unknown as {
          api: { getPageCount: (c: string) => Promise<{ pageCount: number }> }
        }
      ).api
      const settled = await Promise.allSettled(docs.map((content) => api.getPageCount(content)))
      return settled.map((entry) =>
        entry.status === 'fulfilled'
          ? { status: entry.status, pageCount: entry.value.pageCount }
          : { status: entry.status, reason: String(entry.reason) }
      )
    }, fixtures)

    for (const result of results) {
      expect(result.status, `expected 'fulfilled', got: ${JSON.stringify(result)}`).toBe(
        'fulfilled'
      )
    }

    const pageCounts = results
      .filter((r): r is { status: 'fulfilled'; pageCount: number } => r.status === 'fulfilled')
      .map((r) => r.pageCount)

    // Strictly increasing, matching the strictly increasing section counts
    // above -- the real property under test. If the harness's queue leaked
    // a result across callers (the exact class of bug Gate 9 found for
    // getThumbnail), this would show up as two equal or out-of-order counts
    // instead.
    expect(pageCounts[0]).toBeLessThan(pageCounts[1])
    expect(pageCounts[1]).toBeLessThan(pageCounts[2])
    expect(new Set(pageCounts).size).toBe(3)
  })

  // --- Local asset loading (2026-08-05 sub-project) ------------------------
  //
  // The same two properties gate8 proves for thumbnail generation (a real
  // local image loads; a `../` escape does not), against the OTHER generator
  // wired in the same task -- `page-count-generator.ts` owns its own harness,
  // its own queue and its own result cache, so nothing about gate8's result
  // carries over to it by construction.
  //
  // Plus the one behavior that is unique to this generator: `file:
  // getPageCount` newly accepts a renderer-supplied path, so it validates it
  // with `isKnownPath` -- and DROPS an unknown one rather than throwing (page
  // counting itself never needs a path, and throwing would break a working
  // status bar for a document whose allowlist entry is simply missing).

  async function seedRecentFile(userDataDir: string, filePath: string): Promise<void> {
    const existing = await readRecentFiles(userDataDir)
    await writeRecentFiles(
      userDataDir,
      mergeRecentFiles(existing, filePath, new Date().toISOString())
    )
  }

  async function getPageCountViaApi(
    page: Page,
    content: string,
    filePath: string | null
  ): Promise<{ pageCount: number }> {
    return page.evaluate(
      (args) =>
        (
          window as unknown as {
            api: {
              getPageCount: (c: string, f?: string | null) => Promise<{ pageCount: number }>
            }
          }
        ).api.getPageCount(args.content, args.filePath),
      { content, filePath }
    )
  }

  test('a local relative image reference in the counted document actually loads', async () => {
    test.setTimeout(90_000)
    const userDataDir = await app.evaluate(({ app }) => app.getPath('userData'))
    const fixtureDir = await mkdtemp(join(tmpdir(), 'pagedown-gate12-assets-'))
    const nonce = randomBytes(6).toString('hex')

    try {
      await writeFixtureFile(join(fixtureDir, 'figures', `plot-${nonce}.png`), ONE_PX_PNG)
      const docPath = join(fixtureDir, `doc-${nonce}.md`)
      const content = `# Gate 12 asset fixture ${nonce}\n\n![plot](./figures/plot-${nonce}.png)\n`
      await writeFixtureFile(docPath, content)
      await seedRecentFile(userDataDir, docPath)

      const result = await getPageCountViaApi(win, content, docPath)
      expect(result.pageCount).toBe(1)

      const boxes = await readImageBoxes(app, `plot-${nonce}.png`)
      expect(boxes).toHaveLength(1)
      expect(boxes[0].src).toMatch(assetUrlPattern(`.%2Ffigures%2Fplot-${nonce}.png`))
      expect(boxes[0].resolvedSrc).toBe(boxes[0].src)
      expect(boxes[0].naturalWidth).toBe(1)
      expect(boxes[0].naturalHeight).toBe(1)
    } finally {
      await rm(fixtureDir, { recursive: true, force: true })
    }
  })

  test('a local image reference using ../ escaping the counted document directory does NOT load', async () => {
    test.setTimeout(90_000)
    const userDataDir = await app.evaluate(({ app }) => app.getPath('userData'))
    const fixtureDir = await mkdtemp(join(tmpdir(), 'pagedown-gate12-traversal-'))
    const nonce = randomBytes(6).toString('hex')

    try {
      // A real, valid, decodable 2x2 PNG outside the document's directory —
      // so a denial here is genuine confinement, not "no such file".
      await writeFixtureFile(join(fixtureDir, `secret-${nonce}.png`), TWO_PX_PNG)
      const docPath = join(fixtureDir, 'doc', 'sub', `doc-${nonce}.md`)
      const content = `# Gate 12 traversal fixture ${nonce}\n\n![escape](../../secret-${nonce}.png)\n`
      await writeFixtureFile(docPath, content)
      await seedRecentFile(userDataDir, docPath)

      const result = await getPageCountViaApi(win, content, docPath)
      expect(result.pageCount).toBe(1)

      const boxes = await readImageBoxes(app, `secret-${nonce}.png`)
      expect(boxes).toHaveLength(1)
      expect(boxes[0].src).toMatch(assetUrlPattern(`..%2F..%2Fsecret-${nonce}.png`))
      expect(boxes[0].resolvedSrc).toBe(boxes[0].src)
      expect(boxes[0].naturalWidth).toBe(0)
      expect(boxes[0].naturalHeight).toBe(0)
    } finally {
      await rm(fixtureDir, { recursive: true, force: true })
    }
  })

  test('an unknown (non-allowlisted) document path is dropped, not thrown — the count still resolves and local assets stay denied', async () => {
    test.setTimeout(90_000)
    const fixtureDir = await mkdtemp(join(tmpdir(), 'pagedown-gate12-unknown-'))
    const nonce = randomBytes(6).toString('hex')

    try {
      // Everything a successful load needs EXCEPT an allowlist entry: a real
      // directory, a real image inside it, a real relative reference. The
      // only thing missing is `isKnownPath`, which is exactly what must make
      // the difference.
      await writeFixtureFile(join(fixtureDir, `unknown-${nonce}.png`), ONE_PX_PNG)
      const docPath = join(fixtureDir, `doc-${nonce}.md`)
      const content = `# Gate 12 unknown-path fixture ${nonce}\n\n![u](./unknown-${nonce}.png)\n`
      await writeFixtureFile(docPath, content)
      // Deliberately NOT seeded into recent-files.

      // Resolves normally rather than rejecting: dropping the path must not
      // regress the status bar's page count for a document whose allowlist
      // entry is missing.
      const result = await getPageCountViaApi(win, content, docPath)
      expect(result.pageCount).toBe(1)

      // ...but with no asset root registered, the rewrite never happens at
      // all: the src stays the raw relative path, which the render context's
      // own `pagedown-render://render/` origin resolves against the render
      // bundle and 404s -- the pre-fix behavior, correctly preserved for an
      // unvalidated path.
      const boxes = await readImageBoxes(app, `unknown-${nonce}.png`)
      expect(boxes).toHaveLength(1)
      expect(boxes[0].src).toBe(`./unknown-${nonce}.png`)
      expect(boxes[0].src).not.toContain('__asset__')
      expect(boxes[0].naturalWidth).toBe(0)
      expect(boxes[0].naturalHeight).toBe(0)
    } finally {
      await rm(fixtureDir, { recursive: true, force: true })
    }
  })
})
