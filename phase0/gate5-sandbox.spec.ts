import { test, expect, _electron as electron } from '@playwright/test'

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
  const app = await electron.launch({ args: ['.'] })

  const result = await app.evaluate(async ({ BaseWindow }) => {
    const { createPaginationHarness } = (
      globalThis as unknown as {
        __pagedownPhase0: {
          createPaginationHarness: (typeof import('../src/main/pagination-window'))['createPaginationHarness']
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

    const sendResult = await harness.sendDocument('<h1>Test</h1><p>Hello from the sandbox.</p>')

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
  })

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

  await app.close()
})

test('Gate 5: CSP blocks inline script execution in rendered content', async () => {
  const app = await electron.launch({ args: ['.'] })

  const result = await app.evaluate(async ({ BaseWindow }) => {
    const { createPaginationHarness } = (
      globalThis as unknown as {
        __pagedownPhase0: {
          createPaginationHarness: (typeof import('../src/main/pagination-window'))['createPaginationHarness']
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
    await harness.sendDocument(payload)

    // sendDocument()'s own round trip only waits for the synthetic
    // pagination result, which the render script publishes synchronously
    // right after the innerHTML assignment — before the image has even
    // attempted to load, let alone failed and fired its (would-be-blocked)
    // onerror handler. Give that a moment to happen.
    await new Promise((resolve) => setTimeout(resolve, 500))

    const pwned = await harness.view.webContents.executeJavaScript(`typeof (window).__pwned`)

    return { pwned, consoleMessages }
  })

  // The assertion that actually proves the boundary holds: the inline
  // event-handler attribute must NOT have executed.
  expect(result.pwned).toBe('undefined')

  // And CSP should have said so — a real, non-vacuous violation this time.
  const cspViolations = result.consoleMessages.filter((m) =>
    /content security policy|refused to/i.test(m)
  )
  expect(cspViolations.length).toBeGreaterThan(0)

  await app.close()
})

test('Gate 5: navigation away from the render context origin is blocked', async () => {
  const app = await electron.launch({ args: ['.'] })

  const result = await app.evaluate(async ({ BaseWindow }) => {
    const { createPaginationHarness } = (
      globalThis as unknown as {
        __pagedownPhase0: {
          createPaginationHarness: (typeof import('../src/main/pagination-window'))['createPaginationHarness']
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
      '<meta http-equiv="refresh" content="0;url=https://example.invalid/leak">'
    )

    // Give the (should-be-blocked) navigation timer a chance to fire.
    await new Promise((resolve) => setTimeout(resolve, 500))

    const urlAfter = harness.view.webContents.getURL()

    return { urlBefore, urlAfter }
  })

  expect(result.urlBefore).toBe('pagedown-render://render/index.html')
  expect(result.urlAfter).toBe('pagedown-render://render/index.html')

  await app.close()
})
