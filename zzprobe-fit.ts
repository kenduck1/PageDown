import { launchIsolatedApp } from './tests/gates/electron-launch'
import type { ElectronApplication, Page } from '@playwright/test'

async function getMainWindow(app: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    for (const c of app.windows()) {
      if (!c.url().startsWith('file://')) continue
      try { await c.waitForLoadState('domcontentloaded', { timeout: 2000 }) } catch { continue }
      return c
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('no window')
}

async function main(): Promise<void> {
  const { app, close } = await launchIsolatedApp(['out/main/index.js'])
  try {
    const win = await getMainWindow(app)
    await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)
    await win.getByRole('button', { name: 'New document' }).click()
    await win.waitForSelector('.milkdown-mount .ProseMirror')
    await win.click('.milkdown-mount .ProseMirror')
    await win.keyboard.type('# Fit probe')
    await win.getByRole('button', { name: 'Split', exact: true }).click()
    await win.waitForSelector('[data-testid="split-preview-placeholder"]')
    await win.waitForTimeout(6000)

    const out = await app.evaluate(async ({ BrowserWindow, WebContentsView }) => {
      const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.webContents.getURL().startsWith('file://'))
      if (!w) return null
      const v = w.contentView.children.find((c): c is InstanceType<typeof WebContentsView> => {
        if (!(c instanceof WebContentsView)) return false
        if (c.webContents.isDestroyed()) return false
        if (!c.webContents.getURL().startsWith('pagedown-render://')) return false
        const b = c.getBounds()
        return b.x >= 0 && b.y >= 0 && b.width > 0 && b.height > 0
      })
      if (!v) return null
      const measured = await v.webContents.executeJavaScript(`(() => {
        const page = document.querySelector('.pagedjs_page');
        const body = document.body;
        return {
          viewportWidth: window.innerWidth,
          documentScrollWidth: document.documentElement.scrollWidth,
          pageOffsetWidth: page ? page.offsetWidth : null,
          pageRectWidth: page ? page.getBoundingClientRect().width : null,
          bodyTransform: getComputedStyle(body).transform,
          bodyZoom: getComputedStyle(body).zoom
        };
      })()`)
      return { viewBounds: v.getBounds(), ...measured }
    })
    console.log(JSON.stringify(out, null, 2))
  } finally { await close() }
}
main()
