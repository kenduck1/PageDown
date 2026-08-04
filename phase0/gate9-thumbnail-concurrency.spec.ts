import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'

// Regression test for a real, verified bug: `src/main/thumbnail-generator.ts`'s
// `getThumbnail` drives a single shared sandboxed pagination harness
// (`resources/pagination-render/index.ts`), and that harness's render context
// tracks only ONE in-flight request at a time via a single `currentRequestId`
// module variable — it only publishes a result if `currentRequestId` still
// matches the request that just finished. A second `sendDocument` call
// dispatched before the first's async pagination work completes silently
// discards the first request's eventual result, and its caller in
// `pagination-window.ts` spins until its own 10s poll deadline and throws a
// timeout. This was invisible to every prior caller of this harness (Phase 0
// gates, always one full round trip at a time) but is real and user-visible
// for HomeScreen, which mounts several TemplateCard/RecentRow components in
// the same render pass, each independently calling `getThumbnail` on mount.
// Manual verification before the fix: 2 of 3 concurrent
// `window.api.getTemplateThumbnail` calls failed with "Pagination harness
// timed out waiting for a result"; sequential calls always succeeded.
//
// This gate drives the REAL renderer page (`win`), not the
// `__pagedownPhase0` bridge other gates use — `window.api` is only reachable
// there via the real contextBridge, which is exactly the path HomeScreen
// itself uses (`window.api.getTemplateThumbnail`), unlike `app.evaluate()`'s
// bare V8 context with no contextBridge access at all.
//
// Deliberately NOT `app.firstWindow()`: this app creates a SECOND window at
// startup (src/main/index.ts's Phase 0 spike wiring, `createPaginationHarness
// (mainWindow)`), whose page loads under the sandboxed `pagedown-render://`
// custom scheme and by design has zero contextBridge/`window.api` access.
// `firstWindow()` resolves on whichever of the two windows' pages loads
// first, which is a real race — confirmed directly: it returned the
// pagination-harness window instead of the app shell in a live repro,
// causing every subsequent `window.api` access to hang until timeout.
// `getMainWindow` below polls every open window explicitly and picks the
// real app shell instead.
//
// Matched by a POSITIVE `file://` check, not a negative "isn't
// pagedown-render://" exclusion: every window starts on `about:blank` before
// its real navigation completes, and `about:blank` also satisfies a
// negative "!startsWith('pagedown-render://')" filter — so a negative-only
// filter has its own narrow race where an un-navigated sandboxed window
// could be misidentified as the app shell, reproducing the exact
// hang-until-timeout class of failure this helper exists to eliminate. This
// app always launches the built production app here (`out/main/index.js`),
// whose real window loads via `mainWindow.loadFile(...)` in
// src/main/index.ts's `createWindow()` — i.e. always a `file://` URL — so
// requiring that positively rules out both `about:blank` and
// `pagedown-render://` at once, with no separate `about:blank` case needed.
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

let app: ElectronApplication
let win: Page

test.beforeAll(async () => {
  app = await electron.launch({ args: ['out/main/index.js'] })
  win = await getMainWindow(app)
  // Belt-and-suspenders: `getMainWindow` already waits for
  // 'domcontentloaded', but the preload script's contextBridge calls
  // (which is what actually publishes `window.api`) aren't guaranteed to
  // have run by that event — wait for the real signal this gate depends on.
  await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)
})

test.afterAll(async () => {
  await app.close()
})

test('Gate 9: concurrent getTemplateThumbnail calls all succeed (no harness race)', async () => {
  // Three distinct, sizeable documents fired via Promise.allSettled from the
  // SAME renderer-page evaluate call, so all three `template:getThumbnail`
  // IPC invocations reach the main process back-to-back, well before the
  // first's pagination round trip can finish — exactly the concurrent-caller
  // pattern HomeScreen produces on mount. Each is stamped with a fresh nonce
  // (`hashContent` hashes raw content, and getThumbnail's cache-hit path
  // reads straight from disk with no harness involvement at all) so this
  // gate is a guaranteed cache MISS, and therefore actually exercises the
  // harness queue, on every single run — not just the first time it's ever
  // executed against a given userData directory.
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const contents = ['A', 'B', 'C'].map(
    (label) =>
      `# Gate 9 Fixture ${label} ${nonce}\n\n` +
      `${'Paragraph one of fixture ' + label + '. '.repeat(30)}\n\n` +
      `${'Paragraph two of fixture ' + label + '. '.repeat(30)}\n\n` +
      `${'Paragraph three of fixture ' + label + '. '.repeat(30)}`
  )

  const results = await win.evaluate(async (docs) => {
    const api = (
      window as unknown as {
        api: {
          getTemplateThumbnail: (content: string) => Promise<{ dataUrl: string; pageCount: number }>
        }
      }
    ).api
    const settled = await Promise.allSettled(
      docs.map((content) => api.getTemplateThumbnail(content))
    )
    return settled.map((entry) =>
      entry.status === 'fulfilled'
        ? { status: entry.status, dataUrl: entry.value.dataUrl, pageCount: entry.value.pageCount }
        : { status: entry.status, reason: String(entry.reason) }
    )
  }, contents)

  for (const result of results) {
    expect(result.status, `expected 'fulfilled', got: ${JSON.stringify(result)}`).toBe('fulfilled')
  }

  for (const result of results) {
    if (result.status !== 'fulfilled') continue
    expect(result.dataUrl).toMatch(/^data:image\/png;base64,/)
    expect(result.pageCount).toBeGreaterThanOrEqual(1)
  }
})
