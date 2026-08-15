import { test, expect } from '@playwright/test'
import { realpath } from 'node:fs/promises'
import { type PageGeometry } from '../../src/typography/page-geometry'
import { type DocumentStyle } from '../../src/typography/document-style'
import { launchIsolatedApp } from './electron-launch'
// The shared DEFAULT (no-frontmatter, Letter/portrait/1in) geometry every
// harness-driving gate paginates at, plus the shared default DocumentStyle
// sendDocument now also requires -- see gate-geometry.ts for why they're one
// shared pair, and why they have to be threaded through app.evaluate()'s
// own single argument rather than referenced from inside the callback.
import { LETTER_GEOMETRY, DEFAULT_STYLE } from './gate-geometry'

// electronApplication.evaluate() runs each callback below in a bare V8
// context reached via CDP — no `require`, no working dynamic `import()`
// (confirmed empirically: the former throws ReferenceError, the latter
// throws "A dynamic import callback was not specified") — so tests can't
// reach src/main/pagination-window.ts directly. The running app exposes
// createPaginationHarness on globalThis for exactly this reason (see
// src/main/index.ts). Playwright serializes each evaluate() callback
// standalone (it can't close over outer helper functions/state), so the
// `globalThis.__pagedownPhase0` lookup is necessarily repeated in each test
// below rather than factored out.

test('Gate 5: sandboxed render context loads under its own origin and completes a data round trip', async () => {
  const { app, close, userDataDir } = await launchIsolatedApp(['.'])

  try {
    // Direct, non-vacuous proof that launchIsolatedApp's --user-data-dir
    // switch actually took effect for the app instance THIS test launched —
    // not inferred indirectly (e.g. snapshotting the real recent-files.json
    // before/after and hoping it stayed byte-identical, which says nothing
    // for a gate that never calls file:open/file:save in the first place; see
    // this task's own report for why that check was rejected as too weak).
    // `app.getPath('userData')`, read from the real running main process via
    // a fresh app.evaluate() call, is Electron's own runtime source of truth
    // for where this instance believes its userData directory is. Comparing
    // it against the EXACT temp directory launchIsolatedApp created (not just
    // asserting it's "some" temp path) also rules out a bug where the switch
    // is silently ignored in favor of some other default — if isolation had
    // silently failed, this would resolve to the developer's real
    // ~/Library/Application Support/pagedown instead.
    //
    // Both sides are run through realpath() before comparing: on macOS,
    // node:os's tmpdir() (what launchIsolatedApp's mkdtemp() is rooted under)
    // returns a path through the /var symlink, but Electron's own
    // app.getPath('userData') resolves it to the real, symlink-free
    // /private/var target — confirmed empirically (the unresolved comparison
    // fails with exactly that /var vs /private/var prefix mismatch, on an
    // otherwise-identical path). Not a sign isolation failed; realpath()
    // normalizes both sides the same way Electron already normalizes its own
    // side, so the comparison stays a genuine equality check rather than
    // silently passing via a loosened assertion (e.g. suffix-only matching).
    const actualUserDataDir = await app.evaluate(({ app: electronApp }) =>
      electronApp.getPath('userData')
    )
    const expectedUserDataDir = await realpath(userDataDir)
    expect(await realpath(actualUserDataDir)).toBe(expectedUserDataDir)

    const result = await app.evaluate(
      async ({ BaseWindow }, { geometry, documentStyle }) => {
        const { createPaginationHarness } = (
          globalThis as unknown as {
            __pagedownPhase0: {
              createPaginationHarness: (typeof import('../../src/main/pagination-window'))['createPaginationHarness']
            }
          }
        ).__pagedownPhase0
        const win = new BaseWindow({ show: false })
        const harness = await createPaginationHarness(win)

        // Confirm the scheme resolved to a real, distinct pagedown-render://
        // origin rather than silently falling back to something else (e.g.
        // about:blank or file://) — this is the thing that would happen quietly
        // if `standard: true` registration in pagination-scheme.ts didn't take
        // effect before app ready.
        const url = harness.view.webContents.getURL()
        if (!url.startsWith('pagedown-render://')) {
          throw new Error(`Expected pagedown-render:// origin, got: ${url}`)
        }

        // Collect console messages from the render context so a CSP violation
        // (which Chromium reports as a console error, not a thrown/rejected
        // promise) would be visible to the test rather than silently ignored.
        // createPaginationHarness() already awaited the initial load before
        // returning, so that load's console output is gone — attach the
        // listener now and force a fresh navigation so we observe the page
        // (re-)evaluating its own `script-src 'self'` CSP against `./index.js`
        // with the listener in place.
        //
        // IMPORTANT: this event's first argument carries the message directly
        // (`{ frame, level, message, lineNumber, sourceId }`); the second
        // argument is just the numeric level, not a "details" object. Confirmed
        // by empirically forcing a real CSP violation and logging every
        // argument's shape — reading `.message` off the wrong argument silently
        // produces `undefined` for every message, which would make any
        // "no CSP violations" assertion below pass unconditionally regardless
        // of what actually happened.
        const consoleMessages: string[] = []
        harness.view.webContents.on('console-message', (event) => {
          consoleMessages.push(event.message)
        })
        await harness.view.webContents.loadURL('pagedown-render://render/index.html')

        const sendResult = await harness.sendDocument(
          '<h1>Test</h1><p>Hello from the sandbox.</p>',
          geometry,
          documentStyle
        )

        // Runtime proof (not just code inspection) that the render context has
        // no Node/Electron surface: with sandbox: true, contextIsolation: true,
        // nodeIntegration: false and no preload, none of these should exist in
        // the page's own main-world global scope.
        const sandboxLeaks = await harness.view.webContents.executeJavaScript(
          `({
          require: typeof require,
          process: typeof process,
          module: typeof module,
          electron: typeof (window).electron,
          ipcRenderer: typeof (window).ipcRenderer
        })`
        )

        return { url, sendResult, consoleMessages, sandboxLeaks }
      },
      { geometry: LETTER_GEOMETRY, documentStyle: DEFAULT_STYLE }
    )

    expect(result.url).toBe('pagedown-render://render/index.html')
    expect(result.sendResult.ready).toBe(true)
    expect(result.sendResult.pageCount).toBe(1)

    // This only proves a clean 'self'-script load produces no violation —
    // expected either way, and doesn't by itself prove CSP is blocking
    // anything. The positive test below (injecting something CSP *should*
    // block) is the one that actually exercises enforcement.
    const cspViolations = result.consoleMessages.filter((m) =>
      /content security policy|refused to/i.test(m)
    )
    expect(cspViolations).toEqual([])

    expect(result.sandboxLeaks).toEqual({
      require: 'undefined',
      process: 'undefined',
      module: 'undefined',
      electron: 'undefined',
      ipcRenderer: 'undefined'
    })
  } finally {
    await close()
  }
})

test('Gate 5: CSP blocks inline script execution in rendered content', async () => {
  const { app, close } = await launchIsolatedApp(['.'])

  try {
    const result = await app.evaluate(
      async ({ BaseWindow }, { geometry, documentStyle }) => {
        const { createPaginationHarness } = (
          globalThis as unknown as {
            __pagedownPhase0: {
              createPaginationHarness: (typeof import('../../src/main/pagination-window'))['createPaginationHarness']
            }
          }
        ).__pagedownPhase0
        const win = new BaseWindow({ show: false })
        const harness = await createPaginationHarness(win)

        const consoleMessages: string[] = []
        harness.view.webContents.on('console-message', (event) => {
          consoleMessages.push(event.message)
        })

        // A plain `<script>` tag is NOT a meaningful test here: per the DOM
        // spec, <script> elements inserted via `.innerHTML` (which is exactly
        // what resources/pagination-render/index.ts does with the incoming
        // document) are marked inert and never execute at all, CSP or no CSP —
        // testing with one would pass "no script ran" vacuously regardless of
        // whether CSP does anything. An inline event-handler attribute (e.g.
        // `onerror`) *does* still fire via the normal DOM event dispatch path
        // when innerHTML-inserted, and IS governed by `script-src` (blocked
        // without 'unsafe-inline'/a nonce/a hash) — this is the actual XSS
        // vector real Markdown-derived HTML could contain (e.g. a raw HTML
        // block with `<img onerror=...>`), and the one that proves the CSP
        // boundary is doing real work.
        const payload = '<img src="this-file-does-not-exist.png" onerror="window.__pwned = true">'
        await harness.sendDocument(payload, geometry, documentStyle)

        // sendDocument()'s own round trip only waits for the synthetic
        // pagination result, which the render script publishes synchronously
        // right after the innerHTML assignment — before the image has even
        // attempted to load, let alone failed and fired its (would-be-blocked)
        // onerror handler. Give that a moment to happen.
        await new Promise((resolve) => setTimeout(resolve, 500))

        const pwned = await harness.view.webContents.executeJavaScript(`typeof (window).__pwned`)

        return { pwned, consoleMessages }
      },
      { geometry: LETTER_GEOMETRY, documentStyle: DEFAULT_STYLE }
    )

    // The assertion that actually proves the boundary holds: the inline
    // event-handler attribute must NOT have executed.
    expect(result.pwned).toBe('undefined')

    // And CSP should have said so — a real, non-vacuous violation this time.
    const cspViolations = result.consoleMessages.filter((m) =>
      /content security policy|refused to/i.test(m)
    )
    expect(cspViolations.length).toBeGreaterThan(0)
  } finally {
    await close()
  }
})

test('Gate 5: navigation away from the render context origin is blocked', async () => {
  const { app, close } = await launchIsolatedApp(['.'])

  try {
    const result = await app.evaluate(
      async ({ BaseWindow }, { geometry, documentStyle }) => {
        const { createPaginationHarness } = (
          globalThis as unknown as {
            __pagedownPhase0: {
              createPaginationHarness: (typeof import('../../src/main/pagination-window'))['createPaginationHarness']
            }
          }
        ).__pagedownPhase0
        const win = new BaseWindow({ show: false })
        const harness = await createPaginationHarness(win)

        const urlBefore = harness.view.webContents.getURL()

        // This is the exact escape a security reviewer confirmed against the
        // unguarded implementation: CSP (including `connect-src 'none'`) does
        // not govern top-level navigation, so a meta-refresh in rendered
        // content silently sent the whole view to an attacker-controlled
        // origin, after which every subsequent sendDocument() call would post
        // (and read results from) that attacker page instead of the sandboxed
        // render context. This regression test would have caught it.
        await harness.sendDocument(
          '<meta http-equiv="refresh" content="0;url=https://example.invalid/leak">',
          geometry,
          documentStyle
        )

        // Give the (should-be-blocked) navigation timer a chance to fire.
        await new Promise((resolve) => setTimeout(resolve, 500))

        const urlAfter = harness.view.webContents.getURL()

        return { urlBefore, urlAfter }
      },
      { geometry: LETTER_GEOMETRY, documentStyle: DEFAULT_STYLE }
    )

    expect(result.urlBefore).toBe('pagedown-render://render/index.html')
    expect(result.urlAfter).toBe('pagedown-render://render/index.html')
  } finally {
    await close()
  }
})

// The three tests below regression-test Task 6's error-handling/cleanup
// fixes end to end (real harness, real Paged.js, real timing) rather than
// only by code inspection — added after a review found the original
// error-handling fix left two more silent-hang paths, one of which
// (empty/near-empty content) can permanently brick the reused harness.

test('Gate 5: empty document does not hang the harness or brick it for subsequent documents', async () => {
  const { app, close } = await launchIsolatedApp(['.'])

  try {
    const result = await app.evaluate(
      async ({ BaseWindow }, { geometry, documentStyle }) => {
        const { createPaginationHarness } = (
          globalThis as unknown as {
            __pagedownPhase0: {
              createPaginationHarness: (typeof import('../../src/main/pagination-window'))['createPaginationHarness']
            }
          }
        ).__pagedownPhase0
        const win = new BaseWindow({ show: false })
        const harness = await createPaginationHarness(win)

        // markdownToHtml('') and frontmatter-only Markdown both produce exactly
        // this: an empty string. Paged.js's own Previewer.preview() treats a
        // falsy `content` argument as "none was passed" and falls back to
        // wrapContent(), which replaces the entire <body> (including
        // #content-root) with an inert <template> -- permanently, since nothing
        // short of a fresh navigation restores it. Timed explicitly: the bug
        // this regresses was a full, silent 10-second hang, not just a wrong
        // return value.
        const emptyStart = Date.now()
        const emptyResult = await harness.sendDocument('', geometry, documentStyle)
        const emptyElapsedMs = Date.now() - emptyStart

        // The actual regression: a SUBSEQUENT real document must still work.
        // Before the fix, #content-root was gone for good after the empty-input
        // call, so this would hang for the harness's own full 10-second
        // deadline.
        const afterStart = Date.now()
        const afterResult = await harness.sendDocument(
          '<h1>Still alive</h1><p>Real content.</p>',
          geometry,
          documentStyle
        )
        const afterElapsedMs = Date.now() - afterStart

        return { emptyResult, emptyElapsedMs, afterResult, afterElapsedMs }
      },
      { geometry: LETTER_GEOMETRY, documentStyle: DEFAULT_STYLE }
    )

    expect(result.emptyResult.ready).toBe(true)
    expect(result.emptyResult.pageCount).toBe(0)
    // Generous relative to the ~10s timeout this regresses against, but tight
    // enough that a reversion back to the silent-hang path would fail this.
    expect(result.emptyElapsedMs).toBeLessThan(5000)

    expect(result.afterResult.ready).toBe(true)
    expect(result.afterResult.pageCount).toBeGreaterThanOrEqual(1)
    expect(result.afterElapsedMs).toBeLessThan(5000)
  } finally {
    await close()
  }
})

test('Gate 5: a render-context failure surfaces as a prompt rejection, not a 10-second hang', async () => {
  const { app, close } = await launchIsolatedApp(['.'])

  try {
    const result = await app.evaluate(
      async ({ BaseWindow }, { geometry, documentStyle }) => {
        const { createPaginationHarness } = (
          globalThis as unknown as {
            __pagedownPhase0: {
              createPaginationHarness: (typeof import('../../src/main/pagination-window'))['createPaginationHarness']
            }
          }
        ).__pagedownPhase0
        const win = new BaseWindow({ show: false })
        const harness = await createPaginationHarness(win)

        // Deliberately passes a non-string `html` (bypassing sendDocument's own
        // TypeScript signature -- real callers, via paginateAndTime, can never
        // produce this; markdownToHtml always returns a string) so that
        // `html.trim()` throws a genuine TypeError inside the render context's
        // try block, exercising the real catch-and-publish-error path end to
        // end rather than only via code inspection. This is exactly the class
        // of failure Tasks 7-10 are expected to hit for real (a rejecting
        // previewer.preview() call), just triggered here through a reliable,
        // synthetic input instead of a hard-to-construct real one. Only the
        // `html` parameter bypasses the real signature here -- `geometry` and
        // `documentStyle` are still genuine, real values, so this test exercises
        // exactly one deliberate deviation (non-string html) rather than
        // conflating it with a second, unintended one (missing geometry/style).
        const sendDocumentUnsafe = harness.sendDocument as unknown as (
          html: unknown,
          geometry: PageGeometry,
          documentStyle: DocumentStyle
        ) => Promise<unknown>

        const start = Date.now()
        let errorMessage: string | null = null
        try {
          await sendDocumentUnsafe(null, geometry, documentStyle)
        } catch (err) {
          errorMessage = err instanceof Error ? err.message : String(err)
        }
        const elapsedMs = Date.now() - start

        // The harness must still work afterward -- a caught, published error
        // must not brick anything either.
        const afterResult = await harness.sendDocument(
          '<h1>Still alive</h1><p>Real content.</p>',
          geometry,
          documentStyle
        )

        return { errorMessage, elapsedMs, afterResult }
      },
      { geometry: LETTER_GEOMETRY, documentStyle: DEFAULT_STYLE }
    )

    expect(result.errorMessage).not.toBeNull()
    expect(result.errorMessage).toMatch(/Pagination failed in render context/)
    // The whole point: this resolves quickly, not after the full 10s deadline.
    expect(result.elapsedMs).toBeLessThan(5000)
    expect(result.afterResult.ready).toBe(true)
  } finally {
    await close()
  }
})

test('Gate 5: repeated sendDocument calls do not leak Polisher <style> elements into <head>', async () => {
  const { app, close } = await launchIsolatedApp(['.'])

  try {
    const result = await app.evaluate(
      async ({ BaseWindow }, { geometry, documentStyle }) => {
        const { createPaginationHarness } = (
          globalThis as unknown as {
            __pagedownPhase0: {
              createPaginationHarness: (typeof import('../../src/main/pagination-window'))['createPaginationHarness']
            }
          }
        ).__pagedownPhase0
        const win = new BaseWindow({ show: false })
        const harness = await createPaginationHarness(win)

        const styleCounts: number[] = []
        for (let i = 0; i < 5; i++) {
          await harness.sendDocument(
            `<h1>Run ${i}</h1><p>Some real paragraph content for run ${i}.</p>`,
            geometry,
            documentStyle
          )
          const count = await harness.view.webContents.executeJavaScript(
            `document.head.querySelectorAll('style').length`
          )
          styleCounts.push(count)
        }

        return { styleCounts }
      },
      { geometry: LETTER_GEOMETRY, documentStyle: DEFAULT_STYLE }
    )

    // Each run's OWN Polisher is still present at the moment its count is
    // sampled (destruction happens at the START of the NEXT run, not
    // immediately after) -- so the assertion that matters is that the count
    // stays flat across repeated runs, not that it's some particular small
    // number. Before the fix, this grew by (at least) 2 on every single call,
    // unbounded; after the fix, run N's count should equal run 1's count.
    expect(result.styleCounts.length).toBe(5)
    expect(new Set(result.styleCounts).size).toBe(1)
  } finally {
    await close()
  }
})
