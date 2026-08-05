import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchIsolatedApp } from './electron-launch'

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
    await close()
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
})
