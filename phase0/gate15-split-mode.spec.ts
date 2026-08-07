import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchIsolatedApp } from './electron-launch'

// Real, end-to-end coverage for Split mode (docs/superpowers/specs/2026-08-
// 07-split-mode-design.md): a real renderer-page click on the toolbar's
// "Split" button, real typed keystrokes into the left pane's real Milkdown
// canvas, a real debounced IPC round trip through the real
// split-preview:sendDocument handler, into the real dedicated
// createSplitPreviewHarness (src/main/split-preview-window.ts), through the
// real sandboxed pagedown-render:// context -- and, separately, real proof
// that the resulting WebContentsView is genuinely a composited child of the
// real, on-screen mainWindow at the right place and size. This is the only
// automated coverage of that harness's lifecycle/positioning -- see this
// sub-project's design doc, "Testing" section.
//
// Uses launchIsolatedApp (phase0/electron-launch.ts), never a bare
// electron.launch() -- see that helper's own comment, and CLAUDE.md's
// Testing section, for why a bare launch silently reads/writes the
// developer's real userData directory.
//
// close() is wrapped in try/finally (via the bounded safeClose below),
// following gate14-autosave-version-history.spec.ts's own established
// template for this -- CLAUDE.md documents that most gate files still use a
// bare, unwrapped close() (a known, accepted gap) and that a test throwing
// before reaching that call leaks a live multi-process Electron tree. Also
// per gate14's own header comment, `_electron`'s app.close() (and even
// locating the main window) can hang for 60s+ under real host load on this
// development machine -- safeClose races close() against a bounded timeout
// and force-kills the process tree on expiry rather than trusting a
// possibly-wedged shutdown path.
//
// ASSERTION MECHANISM -- the bounded judgment call this task's own brief
// names explicitly. A WebContentsView isn't a top-level window, so
// app.windows() can't enumerate it, and this gate's first real attempt --
// monkey-patching window.api.sendSplitPreviewDocument from the renderer
// page to spy on SplitPreview.tsx's own real call, the "prefer a
// renderer-side path" option the brief itself suggests -- was tried and
// empirically DISPROVEN, not just assumed to work: contextBridge's
// exposeInMainWorld deep-freezes the object it installs (confirmed directly
// via Object.getOwnPropertyDescriptor from a throwaway debug spec:
// `window.api` itself and every one of its methods report
// `writable: false, configurable: false`; a plain reassignment silently
// no-ops in non-strict mode, and Object.defineProperty throws "Cannot
// redefine property"). That's a genuine Electron security property (it
// stops untrusted page content from tampering with a privileged bridge),
// not a gap in this codebase -- so no renderer-side interception of
// window.api is possible here, full stop. Falling back to the brief's other
// named option (a main-process probe) instead, but NOT by extending the
// phase0-only `__pagedownPhase0` bridge (CLAUDE.md: "don't extend it for
// new product features") -- there is a THIRD, already-established pattern
// in this exact codebase for exactly this class of problem:
// asset-evidence.ts's `readImageBoxes`, used by gate8/gate12, drives
// app.evaluate() directly against Electron's own public, always-available
// main-process API (webContents.getAllWebContents() + executeJavaScript
// against a matched pagedown-render:// context's own window.__pagedownResult)
// with ZERO product-code changes -- because the sandboxed render context is
// BY DESIGN unreachable from the renderer's contextBridge surface, so a
// main-process probe isn't a shortcut around a real renderer path here,
// it's the only path that ever existed for this fact. probeSplitPreviewView
// below is the same technique, adapted to also confirm the WebContentsView
// is a genuine, on-screen child of the real mainWindow.contentView (see its
// own comment for why bounds.x/y disambiguate it from the OTHER,
// permanently off-screen pagedown-render:// view this app already creates
// at startup for the Phase 0 spike). This closes the one open risk
// task-2-report.md flagged as unverified (mainWindow.capturePage() doesn't
// see WebContentsView children; OS-level screen capture needs a permission
// this environment doesn't have) with a stronger, exact-pixel, fully
// automated proof instead: a throwaway verification run of this exact
// probe measured the split view's real getBounds() as {x:558, y:123,
// width:342, height:483} -- an EXACT match, not merely "close", to the
// placeholder div's own getBoundingClientRect() at that instant.

const GET_MAIN_WINDOW_TIMEOUT_MS = 60_000

// Same POSITIVE file:// match as gate9/gate11/gate12/gate14's own
// `getMainWindow` -- this app opens a SECOND window at startup (the Phase 0
// spike's sandboxed pagedown-render:// harness), and both `firstWindow()`
// and a negative "isn't pagedown-render://" filter would race/misidentify
// it (every window starts on about:blank, which a negative-only filter
// would also accept).
async function getMainWindow(app: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + GET_MAIN_WINDOW_TIMEOUT_MS
  while (Date.now() < deadline) {
    for (const candidate of app.windows()) {
      if (!candidate.url().startsWith('file://')) continue
      try {
        await candidate.waitForLoadState('domcontentloaded', { timeout: 2000 })
      } catch {
        continue
      }
      return candidate
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('Timed out locating the main app-shell window (only found the sandboxed one)')
}

const CLOSE_TIMEOUT_MS = 15_000

// Bounded close(), matching gate14-autosave-version-history.spec.ts's own
// safeClose almost verbatim -- see that file's header comment for the full
// measured rationale (repeated launch/close cycles under host load can hang
// indefinitely at app.close()). Races close() against CLOSE_TIMEOUT_MS and
// SIGKILLs the process tree directly on expiry, since launchIsolatedApp's
// own close() may never reach its rm() cleanup call if it's stuck awaiting
// app.close().
async function safeClose(app: ElectronApplication, close: () => Promise<void>): Promise<void> {
  const closeOutcome = close().then(
    () => 'closed' as const,
    () => 'closed' as const
  )
  const outcome = await Promise.race([
    closeOutcome,
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), CLOSE_TIMEOUT_MS))
  ])
  if (outcome === 'timeout') {
    try {
      // SIGKILL, not the default SIGTERM -- a hung app.close() means the
      // main process's own graceful-shutdown path is itself what isn't
      // completing, so a signal it could catch/defer is the wrong tool.
      app.process().kill('SIGKILL')
    } catch {
      // Best-effort -- if the process is already gone, there's nothing more
      // to do.
    }
  }
}

interface SplitPreviewProbe {
  bounds: { x: number; y: number; width: number; height: number }
  contentText: string
  pagedownResult: { pageCount: number; ready: boolean; layoutMs: number } | null
}

// Finds the real, on-screen split-preview WebContentsView -- if one is
// currently attached -- as a genuine child of the real mainWindow's own
// contentView, and reads back what it has actually rendered. Returns null
// if no such view exists (either Split mode was never entered, or it was
// just torn down).
//
// Disambiguation: this SAME mainWindow already hosts a SECOND, unrelated
// pagedown-render:// WebContentsView from app startup -- src/main/index.ts's
// "Phase 0 spike wiring" (`createPaginationHarness(mainWindow)`), positioned
// permanently off-screen at {x:-9999, y:-9999} specifically so it never
// covers real UI. Filtering to a genuinely on-screen rectangle
// (bounds.x >= 0 && bounds.y >= 0, both positive widths/heights) is what
// isolates the split-preview harness's own view from that pre-existing one
// -- confirmed directly via a throwaway debug run: exactly one
// pagedown-render:// child exists before Split mode is ever entered (the
// off-screen one), and exactly two exist once it is (the off-screen one,
// unchanged, plus the new on-screen one) -- never zero, never three.
async function probeSplitPreviewView(app: ElectronApplication): Promise<SplitPreviewProbe | null> {
  return app.evaluate(async ({ BrowserWindow, WebContentsView }) => {
    const mainWindow = BrowserWindow.getAllWindows().find(
      (w) => !w.isDestroyed() && w.webContents.getURL().startsWith('file://')
    )
    if (!mainWindow) return null

    const splitView = mainWindow.contentView.children.find(
      (child): child is InstanceType<typeof WebContentsView> => {
        if (!(child instanceof WebContentsView)) return false
        if (child.webContents.isDestroyed()) return false
        if (!child.webContents.getURL().startsWith('pagedown-render://')) return false
        const bounds = child.getBounds()
        return bounds.x >= 0 && bounds.y >= 0 && bounds.width > 0 && bounds.height > 0
      }
    )
    if (!splitView) return null

    // #content-root is resources/pagination-render/index.ts's own static
    // container -- Previewer.preview() appends the real paginated
    // .pagedjs_pages tree into it on every successful render, and the
    // module clears it (`root.innerHTML = ''`) at the start of each new
    // request, so its innerText at any instant is exactly "whatever the
    // most recently completed render actually produced," not a stale
    // accumulation across requests.
    const contentText = (await splitView.webContents.executeJavaScript(
      "document.getElementById('content-root') ? document.getElementById('content-root').innerText : ''"
    )) as string
    // window.__pagedownResult -- the same global sendDocument itself polls
    // (src/main/split-preview-window.ts) and asset-evidence.ts's own
    // readImageBoxes already reads from other harnesses' render contexts.
    const pagedownResult = (await splitView.webContents.executeJavaScript(
      'window.__pagedownResult || null'
    )) as { pageCount: number; ready: boolean; layoutMs: number } | null

    return { bounds: splitView.getBounds(), contentText, pagedownResult }
  })
}

test('Gate 15: typing in Split mode’s left pane produces a real, correctly-positioned rendered preview', async () => {
  test.setTimeout(90_000)

  let app: ElectronApplication | undefined
  let close: (() => Promise<void>) | undefined

  try {
    const launched = await launchIsolatedApp(['out/main/index.js'])
    app = launched.app
    close = launched.close

    const win = await getMainWindow(app)
    await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)

    // Real UI navigation: Home -> "New document" -> Editor, landing in
    // Format mode by default (appStore's initialAppState.viewMode ===
    // 'format') -- matches this task's brief ("Format mode by default").
    await win.getByRole('button', { name: 'New document' }).click()
    await win.waitForSelector('.milkdown-mount .ProseMirror')

    // Before Split mode is ever entered: no on-screen split-preview view
    // exists yet (only the permanently off-screen Phase 0 spike one, which
    // probeSplitPreviewView's own bounds filter excludes).
    expect(await probeSplitPreviewView(app)).toBeNull()

    // Real click on the real toolbar button -- EditorToolbar's segmented
    // control has no aria-label override for this one (only the
    // Split-left-pane toggle's Format/Source buttons do, specifically so
    // they don't collide with THIS control's own Format/Source buttons --
    // see EditorToolbar.tsx's own comment), so its accessible name is
    // exactly the visible text "Split". `exact: true` additionally rules
    // out the unrelated "Split cell" table toolbar button.
    await win.getByRole('button', { name: 'Split', exact: true }).click()

    // Structural proof of positioning wiring: the right pane's placeholder
    // div (SplitPreview.tsx's own mount target, which the main process
    // positions the real WebContentsView on top of) is on screen with a
    // sane, non-degenerate size -- not 0x0, not the whole window (which
    // would indicate the splitRatio-driven width style never applied).
    const placeholder = win.getByTestId('split-preview-placeholder')
    await expect(placeholder).toBeVisible()
    const placeholderBox = await placeholder.boundingBox()
    expect(placeholderBox).not.toBeNull()
    expect(placeholderBox!.width).toBeGreaterThan(50)
    expect(placeholderBox!.height).toBeGreaterThan(50)

    // Real typed keystrokes (page.keyboard.type, not a synthetic DOM
    // mutation) into the left pane's real, freshly-mounted Milkdown canvas
    // -- entering Split mode from Format mode with splitLeftMode==='format'
    // (the default) unmounts the old page-card and mounts a fresh one at a
    // different tree position (see EditorScreen.tsx's own handleSetViewMode
    // doc comment, "(2b) format<->split(format)"), so there is exactly one
    // '.milkdown-mount .ProseMirror' on screen to click into here.
    await win.click('.milkdown-mount .ProseMirror')
    await win.keyboard.type('# Gate 15 Split Mode Fixture')
    await win.keyboard.press('Enter')
    await win.keyboard.type(
      'First real paragraph, typed one keystroke at a time via page.keyboard.type, ' +
        'so the left pane genuinely exercises Milkdown’s own edit path rather than a ' +
        'synthetic DOM mutation.'
    )
    await win.keyboard.press('Enter')
    await win.keyboard.type(
      'Second real paragraph, giving Paged.js genuine multi-paragraph content to lay out ' +
        'in the right-hand preview pane once the debounce settles.'
    )

    // Real content this typing should have produced, read back from the
    // left pane's own DOM -- used below to assert the harness's real
    // render reflects genuinely typed content, not just "some render
    // happened."
    const typedText = await win.locator('.milkdown-mount .ProseMirror').innerText()
    expect(typedText).toContain('Gate 15 Split Mode Fixture')
    expect(typedText).toContain('Second real paragraph')

    // Poll the real main-process view -- past BOTH debounces stacked in
    // series: @milkdown/plugin-listener's own internal ~200ms
    // markdownUpdated debounce (CLAUDE.md's "Milkdown/ProseMirror" Quirk
    // note) feeds documentStore.content, whose change is what actually
    // restarts SplitPreview's own 500ms DEFAULT_DEBOUNCE_MS content-sync
    // effect -- so the real minimum latency from last keystroke to a fresh,
    // COMPLETED render is roughly 200ms + 500ms + a real Paged.js layout
    // pass, not 500ms alone. A broken pipeline -- SplitPreview never
    // calling through, the debounce never firing, the harness silently
    // swallowing the content, or a stubbed-out preview that never reaches
    // the sandboxed context at all -- would leave contentText permanently
    // empty/stale here and this poll would time out.
    let lastProbe: SplitPreviewProbe | null = null
    await expect
      .poll(
        async () => {
          lastProbe = await probeSplitPreviewView(app!)
          return lastProbe?.contentText.includes('Second real paragraph') ?? false
        },
        {
          message: 'expected the real split-preview WebContentsView to render the typed content',
          timeout: 15_000
        }
      )
      .toBe(true)

    const probe = lastProbe as SplitPreviewProbe | null
    expect(probe).not.toBeNull()
    expect(probe!.contentText).toContain('Gate 15 Split Mode Fixture')
    expect(probe!.contentText).toContain('Second real paragraph')

    // The real, non-stubbed PaginationResult this render produced -- not
    // the earlier empty-content mount-time short-circuit (pageCount: 0,
    // layoutMs: 0; see resources/pagination-render/index.ts's own
    // empty-content branch), which the contentText check above already
    // rules out by construction (that branch never populates #content-root
    // at all).
    expect(probe!.pagedownResult?.ready).toBe(true)
    expect(probe!.pagedownResult?.pageCount).toBeGreaterThanOrEqual(1)
    // A real Paged.js layout pass measured inside the sandboxed render
    // context takes real, non-zero wall-clock time (see
    // src/main/pagination-window.ts's own PaginationResult.layoutMs
    // comment) -- 0 would mean this never actually reached Paged.js.
    expect(probe!.pagedownResult?.layoutMs).toBeGreaterThan(0)

    // Positioning proof: the real WebContentsView's real getBounds() (DIP,
    // per Task 3's own empirically-verified getZoomFactor()-only
    // conversion -- see split-preview:setBounds's own comment in
    // src/main/index.ts) should match the placeholder's own
    // getBoundingClientRect() at essentially the same instant. Not just
    // "close" -- with no zoom applied (this app's Split-mode right pane
    // deliberately never applies EditorScreen's own CSS zoom transform; see
    // that JSX branch's own comment) and getZoomFactor() defaulting to 1.0
    // (nothing in this codebase calls setZoomFactor()), physical bounds
    // should equal CSS bounds exactly after rounding -- confirmed directly
    // by a throwaway verification run before this assertion was written: an
    // EXACT match, {x:558,y:123,width:342,height:483} on both sides. A
    // small tolerance (2px) is kept here anyway, purely to absorb any
    // ResizeObserver tick landing a frame later than this read.
    expect(Math.abs(probe!.bounds.x - placeholderBox!.x)).toBeLessThanOrEqual(2)
    expect(Math.abs(probe!.bounds.y - placeholderBox!.y)).toBeLessThanOrEqual(2)
    expect(Math.abs(probe!.bounds.width - placeholderBox!.width)).toBeLessThanOrEqual(2)
    expect(Math.abs(probe!.bounds.height - placeholderBox!.height)).toBeLessThanOrEqual(2)

    // Lifecycle proof: leaving Split mode back to Format tears the harness
    // down for real -- not just "SplitPreview's unmount effect fired" (which
    // this gate cannot observe directly, per the header comment's
    // contextBridge-freezing finding) but the actual, real consequence: the
    // WebContentsView is genuinely removed from mainWindow.contentView, so
    // the on-screen probe finds nothing anymore. The permanently off-screen
    // Phase 0 spike view is untouched by this (still excluded by the same
    // bounds filter either way), proving this teardown is scoped to the
    // split-preview harness alone.
    await win.getByRole('button', { name: 'Format', exact: true }).click()
    await expect(placeholder).not.toBeVisible()
    await expect
      .poll(async () => probeSplitPreviewView(app!), {
        message:
          'expected the split-preview WebContentsView to be removed after leaving Split mode',
        timeout: 5_000
      })
      .toBeNull()
  } finally {
    if (app && close) await safeClose(app, close)
  }
})
