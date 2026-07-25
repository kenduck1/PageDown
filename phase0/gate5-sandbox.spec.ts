import { test, expect, _electron as electron } from '@playwright/test'

test('Gate 5: sandboxed render context loads under its own origin and completes a data round trip', async () => {
  const app = await electron.launch({ args: ['.'] })

  const result = await app.evaluate(async ({ BaseWindow }) => {
    // electronApplication.evaluate() runs this callback in a bare V8
    // context — no `require`, no working dynamic `import()` — so we can't
    // reach src/main/pagination-window.ts directly from here. The running
    // app exposes createPaginationHarness on globalThis for exactly this
    // reason (see src/main/index.ts).
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
    const consoleMessages: string[] = []
    harness.view.webContents.on('console-message', (_event, messageDetails) => {
      consoleMessages.push(messageDetails.message)
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
