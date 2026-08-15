import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchIsolatedApp } from './electron-launch'
import { mergeRecentFiles, readRecentFiles, writeRecentFiles } from '../../src/main/recent-files'

// Gate 41 -- Drag-to-resize an image in the Format canvas, against the REAL
// built app, ending at the REAL bytes on disk.
//
// Numbered 41 because 40 (TOC and image sizing) was already taken; per
// CLAUDE.md, check `git ls-tree main tests/gates/` before claiming a number.
//
// WHY THIS GATE EXISTS -- what jsdom structurally cannot do here.
// image-security.test.tsx already covers the wiring: one transaction per
// gesture, one undo step, nothing written for a click that never moves, and
// the resize surviving into the saved Markdown. But every rect in those tests
// is STUBBED, because jsdom has no layout engine and no real pointer events.
// So they can prove the arithmetic is plumbed through; they cannot prove there
// is a grip, that it is at the image's corner, that it is big enough to hit,
// or that pressing and dragging it does anything at all. A grip positioned by
// a negative-margin inline-block on the baseline -- which is how this one is
// positioned, deliberately, because position:absolute would have needed the
// wrapper to stop being `display: inline` -- is exactly the kind of thing that
// can be perfectly correct in the DOM and land in the wrong place on screen.
// Only real Chromium doing real layout can answer that.
//
// THE FIXTURE USES A REAL PNG FILE REFERENCED RELATIVELY, NOT A `data:` URI.
// A data: image URI cannot carry a src through this pipeline at all --
// hast-util-sanitize pins protocols.src to http/https -- so a data: fixture
// would prove nothing about the surface under test and has already cost this
// suite one debugging cycle. A real file on disk next to a real document is
// also the only way the local-image resolver runs for real, which is what puts
// a genuinely decoded, genuinely sized image on screen to grab the corner of.
//
// THE MOST IMPORTANT ASSERTION IS THE LAST ONE: the saved file. A resize that
// existed only in the ProseMirror DOM would satisfy every visual check here
// and be silently discarded on save -- precisely the mistake
// columnResizingPlugin was deliberately not built to repeat (its widths live
// in a `colwidth` attr GFM cannot serialize). Reading the bytes back is what
// makes this a test of the FEATURE rather than of the affordance.

const GET_MAIN_WINDOW_TIMEOUT_MS = 60_000

async function getMainWindow(application: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + GET_MAIN_WINDOW_TIMEOUT_MS
  while (Date.now() < deadline) {
    for (const candidate of application.windows()) {
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

// A real, decodable 40x40 PNG. Deliberately NOT 1x1 like Gate 34's: this gate
// grabs the image's bottom-right corner with a real mouse, so the image has to
// occupy real, hittable area on screen. A 1x1 image would render as one pixel
// and the drag would have nothing to start from.
const REAL_40X40_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAIAAAADnC86AAAAMElEQVR4nO3NQQkAAAgEsItjHGMb' +
    'yxKCn8H+y3S9iFgsFovFYrFYLBaLxWKxWHxnAY8m0GozORegAAAAAElFTkSuQmCC',
  'base64'
)

let app: ElectronApplication | undefined
let close: (() => Promise<void>) | undefined
let fixtureRoot: string | undefined

test.setTimeout(120_000)

test('Gate 41: dragging an image corner resizes it and saves real {width=N%} Markdown', async () => {
  const launched = await launchIsolatedApp(['out/main/index.js'])
  app = launched.app
  close = launched.close
  const userDataDir = launched.userDataDir

  try {
    const win = await getMainWindow(app)
    await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)

    fixtureRoot = await mkdtemp(join(tmpdir(), 'pagedown-gate41-'))
    const documentDir = join(fixtureRoot, 'doc')
    await mkdir(documentDir, { recursive: true })
    await writeFile(join(documentDir, 'photo.png'), REAL_40X40_PNG)

    const filename = `gate41-${Date.now()}.md`
    const documentPath = join(documentDir, filename)
    // The image starts at `{width=80%}` rather than unsized, and that is a
    // real methodology choice rather than convenience: a 40x40 image rendered
    // at its natural size gives a ~40px-wide grab target whose corner is a few
    // pixels from the paragraph's left edge, so a leftward drag would clamp at
    // the floor immediately and a rightward one would have hundreds of pixels
    // of slack. Starting wide puts the corner in the middle of the column,
    // where a drag in EITHER direction produces a value that is neither
    // clamped nor unchanged -- so the assertion cannot pass for the wrong
    // reason.
    await writeFile(
      documentPath,
      ['# Gate 41', '', '![photo](photo.png){width=80%}', '', 'Trailing prose.', ''].join('\n'),
      'utf8'
    )

    const originalRecents = await readRecentFiles(userDataDir)
    await writeRecentFiles(
      userDataDir,
      mergeRecentFiles(originalRecents, documentPath, new Date().toISOString())
    )

    await win.reload()
    await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)
    await win.getByRole('button', { name: new RegExp(filename.replace(/[.]/g, '\\.')) }).click()
    await win.waitForSelector('.milkdown-mount .ProseMirror')
    console.log('Gate 41: document opened, ProseMirror mounted')

    // Wait for the local image to genuinely resolve and decode -- the grip is
    // only offered for a really-rendering image (`data-state="ok"`), so this
    // is a precondition of the drag, not merely of the picture looking right.
    const imageProbe = async (): Promise<{
      state: string | null
      naturalWidth: number
      width: string | null
      renderedWidth: number
    }> =>
      win.evaluate(() => {
        const wrapper = document.querySelector('.milkdown-mount .pagedown-image')
        const img = wrapper?.querySelector('img') as HTMLImageElement | null
        return {
          state: wrapper?.getAttribute('data-state') ?? null,
          naturalWidth: img?.naturalWidth ?? 0,
          width: img?.getAttribute('width') ?? null,
          renderedWidth: img?.getBoundingClientRect().width ?? 0
        }
      })

    await expect
      .poll(async () => (await imageProbe()).naturalWidth, {
        message: 'expected the document-local image to genuinely decode in the Format canvas',
        timeout: 20_000
      })
      .toBeGreaterThan(0)

    const before = await imageProbe()
    console.log('Gate 41: before =', JSON.stringify(before))
    expect(before.state).toBe('ok')
    // The starting size came from the document's own `{width=80%}`, so the
    // paginated-surface mechanism is already live on this element.
    expect(before.width).toBe('80%')
    expect(before.renderedWidth).toBeGreaterThan(100)

    const img = win.locator('.milkdown-mount .pagedown-image img').first()
    const handle = win.locator('.milkdown-mount .pagedown-image-resize-handle').first()

    // 1. THE AFFORDANCE IS DISCOVERABLE BY POINTING AT THE PICTURE. Hidden
    //    until the pointer is over the image, then a real, hittable box.
    //    The pointer has to be parked explicitly first: clicking the recent-file
    //    row leaves it wherever that row was, which lands on the image once the
    //    document renders -- so without this the "hidden" half would fail for a
    //    reason that has nothing to do with the rule under test.
    await win.mouse.move(2, 2)
    await expect(handle).toBeHidden()
    await img.hover()
    await expect(handle).toBeVisible()

    // 1b. REVEALING THE GRIP MUST NOT MOVE THE DOCUMENT. This is not a
    //     hypothetical: an in-flow grip was measured growing the paragraph by
    //     one 23.8px line box (an inline wrapper holding block-level children
    //     is split into anonymous blocks, and the extra block earns its own
    //     line), i.e. the text shifted under the pointer on hover. Out-of-flow
    //     positioning makes that impossible, and this pins it.
    const paragraphHeight = async (): Promise<number> =>
      win.evaluate(
        () =>
          document
            .querySelector('.milkdown-mount .pagedown-image')
            ?.parentElement?.getBoundingClientRect().height ?? -1
      )
    const hoveredHeight = await paragraphHeight()
    await win.mouse.move(2, 2)
    await expect(handle).toBeHidden()
    const restingHeight = await paragraphHeight()
    console.log('Gate 41: paragraph height hovered/resting =', hoveredHeight, restingHeight)
    expect(hoveredHeight).toBeCloseTo(restingHeight, 3)
    await img.hover()

    const imageBox = (await img.boundingBox())!
    const handleBox = (await handle.boundingBox())!
    console.log('Gate 41: imageBox =', JSON.stringify(imageBox))
    console.log('Gate 41: handleBox =', JSON.stringify(handleBox))

    // 2. IT IS AT THE IMAGE'S BOTTOM-RIGHT CORNER, IN REAL SCREEN PIXELS.
    //    This is the assertion jsdom cannot make at all, and the one the
    //    chosen positioning scheme most plausibly gets wrong: a relatively
    //    positioned inline wrapper would have put the grip on the text
    //    baseline instead. Tolerances are one grip-width, i.e. "overlapping
    //    the corner", not "exactly on it".
    expect(handleBox.width).toBeGreaterThanOrEqual(8)
    expect(handleBox.height).toBeGreaterThanOrEqual(8)
    expect(Math.abs(handleBox.x + handleBox.width - (imageBox.x + imageBox.width))).toBeLessThan(13)
    expect(Math.abs(handleBox.y + handleBox.height - (imageBox.y + imageBox.height))).toBeLessThan(
      13
    )

    // 3. A REAL DRAG. Playwright's own mouse, moving in several steps, exactly
    //    as a hand does -- so the intermediate pointermove handling is genuinely
    //    exercised rather than a single synthetic jump.
    const dragFrom = { x: handleBox.x + handleBox.width / 2, y: handleBox.y + handleBox.height / 2 }
    const dragToX = dragFrom.x - 150
    await win.mouse.move(dragFrom.x, dragFrom.y)
    await win.mouse.down()
    for (const step of [1, 2, 3, 4]) {
      await win.mouse.move(dragFrom.x + ((dragToX - dragFrom.x) * step) / 4, dragFrom.y)
    }
    await win.mouse.up()

    await expect
      .poll(async () => (await imageProbe()).width, {
        message: 'expected the drag to change the width attribute on the real <img>',
        timeout: 10_000
      })
      .not.toBe('80%')

    const after = await imageProbe()
    console.log('Gate 41: after =', JSON.stringify(after))

    // 4. THE PICTURE ACTUALLY GOT SMALLER ON SCREEN, not merely the attribute.
    //    An attribute a stylesheet overrode would satisfy every string check
    //    above and leave the image exactly where it was.
    expect(after.width).toMatch(/^\d+%$/)
    expect(Number.parseInt(after.width!, 10)).toBeLessThan(80)
    expect(after.renderedWidth).toBeLessThan(before.renderedWidth - 50)

    // 5. THE FILE ON DISK. The whole point: the resize is portable Markdown
    //    every other surface already understands, not a ProseMirror-only attr
    //    that the paginator, the PDF and the thumbnails know nothing about and
    //    that a save would silently discard.
    // The real Save control, not a synthetic Cmd+S: the accelerator lives on
    // the native application Menu, which a key event dispatched into the web
    // contents does not reach (measured -- the file was still unchanged after
    // 15s). Gate 11 clicks this same button for the same reason.
    await win.getByRole('button', { name: 'Save' }).click()
    await expect
      .poll(async () => readFile(documentPath, 'utf8'), {
        message: 'expected the dragged width to reach the real file on disk',
        timeout: 15_000
      })
      .toContain(`{width=${after.width}}`)

    const saved = await readFile(documentPath, 'utf8')
    console.log('Gate 41: saved =', JSON.stringify(saved))
    expect(saved).toContain('![photo](photo.png){width=')
    expect(saved).not.toContain('{width=80%}')
    // The rest of the document is untouched -- a resize is not a licence to
    // rewrite the prose around it.
    expect(saved).toContain('# Gate 41')
    expect(saved).toContain('Trailing prose.')
  } finally {
    if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true })
    if (app && close) await close()
  }
})
