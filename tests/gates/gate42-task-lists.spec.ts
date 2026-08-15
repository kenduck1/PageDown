import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, writeFile, rm, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeRecentFiles, readRecentFiles, writeRecentFiles } from '../../src/main/recent-files'
import { PAGE_WIDTH_PX } from '../../src/typography/page-geometry'
import { launchIsolatedApp } from './electron-launch'

// Gate 42 -- GFM task lists render as real checkboxes, identically, on both
// surfaces.
//
// Numbered 42 after checking `git ls-tree main tests/gates/` (41 was the highest),
// per the convention CLAUDE.md records after Find&Replace and Page Navigation
// collided on 17 during parallel work.
//
// THE DEFECT, reported by a user as "why does the check box option create a
// bullet". Both surfaces were wrong, in two different ways, because neither
// had ever been named in document-typography.css:
//
//   - Canvas: @milkdown/preset-gfm's extendListItemSchemaForTask emits
//     `<li data-item-type="task" data-checked="false">` with NO <input>
//     anywhere -- it expects a consuming THEME to draw the control, and this
//     app imports no Milkdown theme CSS. The `ul > li { list-style-type: disc }`
//     rule then made a task item an ordinary bullet.
//   - Paginated: markdownToHtml emits `.contains-task-list` /
//     `.task-list-item` / a real `<input type="checkbox" disabled>`, with
//     nothing suppressing the marker -- a bullet AND a checkbox.
//
// WHY A GATE, i.e. what jsdom structurally cannot answer. Every claim below is
// about real layout:
//
//   1. THE MARKER IS GENUINELY GONE. `list-style-type` is only observable
//      through a real cascade against real CSS. jsdom applies no stylesheet at
//      all here, so a unit test can assert the rule's TEXT exists (which
//      nodes/task-item.test.ts does) and can never assert that it MATCHED.
//   2. THE CHECKBOX GENUINELY PAINTS. A control present in the DOM but
//      collapsed to a 0x0 box would pass every unit test in this repo and be
//      invisible to the user -- the same reason Gate 17 measures a non-zero
//      boundingBox() on its find highlight rather than trusting the DOM node.
//   3. THE TWO SURFACES PUT THE ITEM TEXT IN THE SAME PLACE. This is the Gate
//      10 question for a construct Gate 10's own fixture cannot contain: its
//      REPORT_TEMPLATE has no lists at all, so it can neither catch a
//      task-list divergence nor vouch for the fix.
//   4. A REAL CLICK ON THE REAL CONTROL REACHES DISK. The unit tests dispatch
//      a synthetic `change` event; only Playwright can prove the control is
//      genuinely hit-testable at its painted coordinates -- which is exactly
//      what Gate 27 failed on for the "Add comment" toolbar button, and the
//      failure that turned out to be a real reachability bug rather than a
//      test inconvenience.
//
// ANTI-VACUITY, the Gate 28/29 two-part pattern applied to a non-positional
// claim. "The task item has no marker" would pass trivially if the rule ever
// over-matched and killed EVERY list marker in the document -- a strictly
// worse bug than the one being fixed, and invisible to a one-sided assertion.
// So the fixture carries a PLAIN bullet as a sibling in the same list, and its
// marker is asserted to still be `disc` on both surfaces in the same run. A
// selector that over-matches fails that half loudly rather than passing the
// first half for free.
//
// THE TEXT-OFFSET COMPARISON IS SELF-NORMALIZING, deliberately: it measures
// `taskTextLeft - plainTextLeft` WITHIN each surface, then compares those two
// deltas. Comparing absolute x coordinates across an app-shell renderer and a
// sandboxed WebContentsView would be comparing two different viewport origins
// with two different pane insets, and would need continuous retuning as
// unrelated chrome moved. The delta is 0 on a surface whose checkbox is out of
// flow and ~+1em on one whose checkbox is inline -- which is precisely the
// divergence this fix exists to remove, expressed as a number that depends on
// nothing else.
//
// MEASURED VALUES at the app's default 1000x840 window, Letter/1in:
//   canvas    -- marker 'none' (plain sibling 'disc'), checkbox 14x14 rendered,
//                page 816px so scale 1.000 -> 14.00px in document space,
//                taskTextLeft - plainTextLeft = 0.00px
//   paginated -- marker 'none' (plain sibling 'disc'), checkbox 6.16x6.16
//                rendered, page 359.04px so scale 0.440 -> 13.99px in document
//                space, taskTextLeft - plainTextLeft = 0.00px
//
// Note the 0.440: the split preview is displayed smaller than the page it
// represents, which is WHY every cross-surface length below goes through
// inDocumentSpace() rather than being compared raw. That scale is not a
// constant of this feature and is expected to move as the divider, the window
// or the page size change -- which is exactly why it is measured per run from
// the page box rather than pinned as a number here. It was observed at both
// 0.440 and 0.700 during development, which is also the trap that made the
// underlying bug look several pixels wide when it is really 0.67px: two raw
// rects taken at two different scales are not comparable to each other either.
//
// FLAKE, and it is the documented environmental one rather than anything about
// this gate. Both tests here intermittently die on a bare `Test timeout` plus
// `Worker teardown timeout` having reached NO assertion, while passing 2/2 in
// ~2.4s whenever the host is healthy. THE DECISIVE CONTROL WAS RUN rather than
// assumed: an untouched, unrelated `gate11-editor-save-race.spec.ts` failed
// 3/3 with the identical signature in the same window. Two further pieces of
// evidence point the same way -- the failures hit test 2 as readily as test 1,
// though test 2 does no sandbox probing at all, and the MUTATED build (see the
// checkbox-size assertion below) failed 3/3 in ~1.2s each with a real named
// assertion during the same session. A regression in this gate surfaces as a
// NAMED assertion failure; a bare timeout here means "no information yet", so
// re-run on a quiet host before concluding anything.

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

interface TaskListProbe {
  taskMarker: string
  plainMarker: string
  checkboxWidth: number
  checkboxHeight: number
  checkboxCount: number
  /**
   * Rendered width of this surface's own page box. The two surfaces do NOT
   * share a coordinate space -- see pageScale() below -- so every length has to
   * be divided by (this / PAGE_WIDTH_PX) before it can be compared across
   * them.
   */
  pageRenderedWidth: number
  /** taskTextLeft - plainTextLeft; 0 when the control is out of the inline flow. */
  textOffsetDelta: number
}

// The measurement, written ONCE as a string and evaluated verbatim in BOTH
// contexts -- the app-shell renderer via page.evaluate, and the sandboxed
// pagination view via webContents.executeJavaScript. Sharing the source text
// is what makes "the two surfaces agree" a comparison of two measurements
// rather than of two measuring methods; two hand-written probes could differ
// in what they consider the text's left edge and the disagreement would be
// invisible.
//
// The text anchor is a Range over the item's first text node, NOT the first
// child element's rect. The surfaces genuinely differ in structure -- a TIGHT
// paginated item is `<li><input> alpha</li>` with no <p> at all, while the
// canvas is always `<li><input><div><p>alpha</p></div></li>` -- so any
// element-based anchor would be measuring different elements on each side. A
// Range over the text itself is the one anchor both surfaces genuinely share.
const PROBE_SOURCE = `(() => {
  const taskLi = document.querySelector('li[data-item-type="task"], li.task-list-item')
  if (!taskLi) return null
  const plainLi = Array.from(document.querySelectorAll('li')).find(
    (li) => !li.hasAttribute('data-item-type') && !li.classList.contains('task-list-item')
  )
  if (!plainLi) return null

  const textLeft = (li) => {
    const walker = document.createTreeWalker(li, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    while (node && !node.textContent.trim()) node = walker.nextNode()
    if (!node) return NaN
    const range = document.createRange()
    range.selectNodeContents(node)
    return range.getBoundingClientRect().left
  }

  const box = taskLi.querySelector('input[type="checkbox"]')
  const boxRect = box ? box.getBoundingClientRect() : { width: 0, height: 0 }

  return {
    taskMarker: getComputedStyle(taskLi).listStyleType,
    plainMarker: getComputedStyle(plainLi).listStyleType,
    checkboxWidth: boxRect.width,
    checkboxHeight: boxRect.height,
    checkboxCount: document.querySelectorAll('input[type="checkbox"]').length,
    pageRenderedWidth: (
      document.querySelector('.pagedjs_page') ||
      document.querySelector('[data-testid="page-card"]')
    ).getBoundingClientRect().width,
    textOffsetDelta: textLeft(taskLi) - textLeft(plainLi)
  }
})()`

// THE TWO SURFACES DO NOT SHARE A COORDINATE SPACE, and this gate's first run
// proved it rather than assuming it: the same document measured `pageRectW`
// 816 in the canvas and 359.04 in the sandboxed preview, with the task item's
// own box coming back 596px computed / 262.24px rendered on that side -- one
// consistent 0.44 factor, which is the preview being displayed smaller than
// the page it represents. Any raw rect comparison across the two is therefore
// meaningless.
//
// Dividing by (rendered page width / the real page width) converts a rendered
// length back into DOCUMENT space -- CSS pixels of the actual page -- which is
// the only space in which "the editor and the paginator agree" is a
// well-formed claim. PAGE_WIDTH_PX is the shared constant both surfaces
// already size from, so this anchors to the same number the app does rather
// than to a figure observed once and pasted here.
//
// This is what caught the real bug below: the paginated checkbox was 21.2px in
// document space against the canvas's 14px, which the raw rects (9.33 vs 14)
// happened to understate.
function pageScale(probe: TaskListProbe): number {
  return probe.pageRenderedWidth / PAGE_WIDTH_PX
}

/** A rendered length converted back into document space. */
function inDocumentSpace(probe: TaskListProbe, length: number): number {
  return length / pageScale(probe)
}

// A PER-CALL BOUND ON THE SANDBOX PROBE, and it is a real fix for an observed
// hang rather than defensive padding.
//
// `expect.poll` re-invokes its callback only once the previous invocation has
// SETTLED -- its own timeout bounds the polling loop, not any single call. So
// an `executeJavaScript` into the split preview's WebContentsView that never
// resolves (the sandboxed renderer being mid-Paged.js-layout, which under host
// contention it frequently is) hangs the poll indefinitely, straight past the
// poll's own 30s and into the 90s test timeout. That is exactly the signature
// this repo's flake rule warns is uninformative: a bare `Test timeout` plus a
// `Worker teardown timeout` reaching no assertion. Observed three times here,
// including once at load average 4.8, while test 2 -- same launch path, no
// sandbox probe -- passed in under a second in the same runs.
//
// Resolving to null on expiry hands control back to the poll so it can simply
// try again. It cannot mask a real regression: if the preview genuinely never
// renders the task list, every attempt returns null and the poll still fails
// by name on its own timeout.
async function withBound<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function probeCanvas(win: Page): Promise<TaskListProbe | null> {
  return win.evaluate(PROBE_SOURCE) as Promise<TaskListProbe | null>
}

// Same mechanism as gate35's probePreviewFit / gate18's probePageScroll --
// app.evaluate() + mainWindow.contentView.children + executeJavaScript --
// because the paginated DOM lives only inside a WebContentsView with no
// preload and no contextBridge. Filtering to a genuinely on-screen rectangle
// isolates the split preview from the Phase 0 spike harness's own view, parked
// permanently off-screen at {x:-9999,y:-9999}.
async function probePaginated(app: ElectronApplication): Promise<TaskListProbe | null> {
  return app.evaluate(async ({ BrowserWindow, WebContentsView }, probeSource) => {
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

    return (await splitView.webContents.executeJavaScript(probeSource)) as TaskListProbe | null
  }, PROBE_SOURCE)
}

interface OpenedFixture {
  app: ElectronApplication
  close: () => Promise<void>
  win: Page
  fixtureDir: string
  fixturePath: string
  restoreRecents: () => Promise<void>
}

// The same seed-into-recents-then-click-through-Home approach every other
// fixture-driving gate here uses (gate17/20/27/28/29/35), so the fixture path
// is a genuinely KNOWN path through the real isKnownPath allowlist -- which is
// also what lets the later Save in test 2 write straight to it.
async function openFixtureDocument(body: string): Promise<OpenedFixture> {
  const {
    app,
    close,
    userDataDir: expectedUserDataDir
  } = await launchIsolatedApp(['out/main/index.js'])
  const win = await getMainWindow(app)
  await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)

  const userDataDir = await app.evaluate(({ app }) => app.getPath('userData'))
  expect(await realpath(userDataDir)).toBe(await realpath(expectedUserDataDir))

  const fixtureDir = await mkdtemp(join(tmpdir(), 'pagedown-gate42-'))
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const fixtureFilename = `gate42-fixture-${nonce}.md`
  const fixturePath = join(fixtureDir, fixtureFilename)
  await writeFile(fixturePath, body, 'utf8')

  const originalRecents = await readRecentFiles(userDataDir)
  const restoreRecents = async (): Promise<void> => {
    await writeRecentFiles(userDataDir, originalRecents)
  }
  await writeRecentFiles(
    userDataDir,
    mergeRecentFiles(originalRecents, fixturePath, new Date().toISOString())
  )

  await win.reload()
  await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)
  await win
    .getByRole('button', { name: new RegExp(fixtureFilename.replace(/[.]/g, '\\.')) })
    .click()
  await win.waitForSelector('.milkdown-mount .ProseMirror')

  return { app, close, win, fixtureDir, fixturePath, restoreRecents }
}

// A TIGHT list, which is what a user actually types, and which is also the
// harder case: the paginated surface renders a tight item with no <p> wrapper
// at all while the canvas always has one, so any measurement that survives
// this survives the loose case too. The plain bullet is the anti-vacuity
// control described in the header.
const FIXTURE = `# Gate 42 Task Lists

- [ ] alpha task
- [x] beta task
- plain bullet
`

test('Gate 42: a task item has no bullet, has a painted checkbox, and aligns with its plain sibling on BOTH surfaces', async () => {
  test.setTimeout(90_000)

  const { app, close, win, fixtureDir, restoreRecents } = await openFixtureDocument(FIXTURE)

  try {
    const canvas = await probeCanvas(win)
    expect(canvas, 'the editor canvas should contain a task list item').not.toBeNull()

    // --- Split mode, so the real sandboxed paginated surface exists ---------
    await win.getByRole('button', { name: 'Split' }).click()
    await expect
      .poll(async () => (await withBound(probePaginated(app), 5_000))?.checkboxCount ?? -1, {
        timeout: 30_000
      })
      .toBe(2)
    const paginated = await withBound(probePaginated(app), 10_000)
    expect(
      paginated,
      'the sandboxed paginated surface should have rendered the task list'
    ).not.toBeNull()

    console.log(
      `Gate 42 canvas    -- taskMarker ${canvas!.taskMarker}, plainMarker ${canvas!.plainMarker}, ` +
        `checkbox ${canvas!.checkboxWidth}x${canvas!.checkboxHeight}, ` +
        `textOffsetDelta ${canvas!.textOffsetDelta.toFixed(2)}px` +
        ` | page ${canvas!.pageRenderedWidth}px (scale ${pageScale(canvas!).toFixed(3)}), ` +
        `checkbox in document space ${(canvas!.checkboxWidth / pageScale(canvas!)).toFixed(2)}px`
    )
    console.log(
      `Gate 42 paginated -- taskMarker ${paginated!.taskMarker}, plainMarker ${paginated!.plainMarker}, ` +
        `checkbox ${paginated!.checkboxWidth}x${paginated!.checkboxHeight}, ` +
        `textOffsetDelta ${paginated!.textOffsetDelta.toFixed(2)}px` +
        ` | page ${paginated!.pageRenderedWidth}px (scale ${pageScale(paginated!).toFixed(3)}), ` +
        `checkbox in document space ${(paginated!.checkboxWidth / pageScale(paginated!)).toFixed(2)}px`
    )

    // --- 1. The marker is gone, on both -- and ONLY on task items ----------
    expect(canvas!.taskMarker, 'canvas task item should have no list marker').toBe('none')
    expect(paginated!.taskMarker, 'paginated task item should have no list marker').toBe('none')
    // The anti-vacuity half. If the marker suppression ever over-matched, this
    // is what fails, rather than the assertions above passing for free.
    expect(canvas!.plainMarker, 'canvas plain bullet must KEEP its marker').toBe('disc')
    expect(paginated!.plainMarker, 'paginated plain bullet must KEEP its marker').toBe('disc')

    // --- 2. The checkbox genuinely paints, on both -------------------------
    expect(canvas!.checkboxCount, 'the canvas had NO checkbox at all before this fix').toBe(2)
    expect(paginated!.checkboxCount).toBe(2)
    for (const [name, probe] of [
      ['canvas', canvas!],
      ['paginated', paginated!]
    ] as const) {
      expect(
        probe.checkboxWidth,
        `${name} checkbox must have a real painted width`
      ).toBeGreaterThan(1)
      expect(
        probe.checkboxHeight,
        `${name} checkbox must have a real painted height`
      ).toBeGreaterThan(1)
    }

    // One shared CSS rule sizes both, so in DOCUMENT space they must come out
    // identical -- see pageScale() for why the raw rects cannot be compared.
    //
    // THIS ASSERTION FOUND A REAL BUG on its first run, and it is the one thing
    // in this feature no unit test could have reached. A form control does NOT
    // inherit font-size -- Chromium's UA stylesheet gives it its own -- so the
    // shared rule's `width: 1em` resolved against the CONTROL's font rather
    // than the list item's. The editor never saw it because Tailwind Preflight
    // already pins `font-size: 100%` on form controls; the sandboxed context
    // has no Preflight, so the identical CSS produced a 14px control in the
    // canvas and a 21.2px one in the preview and the exported PDF. Fixed by
    // adding `font-size: 1em` to that rule -- the same one-declaration fix,
    // for the same reason, that document-typography.css already applies to
    // `pre`/`code`.
    const canvasBox = inDocumentSpace(canvas!, canvas!.checkboxWidth)
    const paginatedBox = inDocumentSpace(paginated!, paginated!.checkboxWidth)
    const canvasBoxH = inDocumentSpace(canvas!, canvas!.checkboxHeight)
    const paginatedBoxH = inDocumentSpace(paginated!, paginated!.checkboxHeight)

    // TOLERANCE CHOSEN FROM BOTH BOUNDS RATHER THAN BY FEEL, because the
    // regression it has to catch is genuinely small. Chromium's UA font for a
    // form control is 13.3333px against this document's inherited 14px, so the
    // bug above is a 0.67px divergence in document space -- not the several
    // pixels a first reading of the raw rects (9.33 vs 14) suggests, since
    // those two numbers were taken at different preview scales.
    //   - measured agreement WITH the fix: 0.009px (14.000 vs 13.991)
    //   - measured divergence WITHOUT it:  0.683px (14.000 vs 13.317)
    // 0.25px sits an order of magnitude above the former and well under half
    // the latter. `toBeCloseTo(_, 0)` was tried first and rejected: its 0.5
    // threshold does catch the regression, but with only 0.18px of headroom,
    // which is not enough to survive an unrelated change in the preview scale.
    const MAX_CROSS_SURFACE_PX = 0.25
    expect(
      Math.abs(paginatedBox - canvasBox),
      `the editor and the paginator must draw the same size control ` +
        `(canvas ${canvasBox.toFixed(3)}px, paginated ${paginatedBox.toFixed(3)}px)`
    ).toBeLessThan(MAX_CROSS_SURFACE_PX)
    expect(
      Math.abs(paginatedBoxH - canvasBoxH),
      `the editor and the paginator must draw the same size control ` +
        `(canvas ${canvasBoxH.toFixed(3)}px, paginated ${paginatedBoxH.toFixed(3)}px)`
    ).toBeLessThan(MAX_CROSS_SURFACE_PX)

    // --- 3. The item text starts in the same place, on both ----------------
    // Out of flow on each surface means each delta is 0; the checkbox being
    // inline on EITHER surface would push that surface's number to about one
    // em (~17px at the 14px body size) and fail here.
    expect(
      canvas!.textOffsetDelta,
      'canvas task text should start where its plain sibling does'
    ).toBeCloseTo(0, 1)
    expect(
      paginated!.textOffsetDelta,
      'paginated task text should start where its plain sibling does'
    ).toBeCloseTo(0, 1)
    // And the headline: the two surfaces agree with each other. This is the
    // assertion Gate 10 would make if its fixture contained a list.
    expect(
      paginated!.textOffsetDelta,
      'the editor and the paginator must place task text identically'
    ).toBeCloseTo(canvas!.textOffsetDelta, 1)
  } finally {
    await restoreRecents()
    await rm(fixtureDir, { recursive: true, force: true })
    await close()
  }
})

test('Gate 42: clicking the canvas checkbox toggles the task and reaches disk', async () => {
  test.setTimeout(90_000)

  const { close, win, fixtureDir, fixturePath, restoreRecents } = await openFixtureDocument(FIXTURE)

  try {
    // A real Playwright click, which runs the full actionability check --
    // visible, stable, receives events, not obscured. That check is the point:
    // it is what proves the control is genuinely hit-testable where it is
    // painted, in the marker gutter, rather than merely present in the DOM.
    const box = win.locator('li[data-item-type="task"] input[type="checkbox"]').first()
    await expect(box).not.toBeChecked()
    await box.click()
    await expect(box).toBeChecked()

    await win.getByRole('button', { name: 'Save' }).click()

    // Reaching DISK is the only real proof the click produced a document
    // transaction rather than just flipping a DOM property: a checkbox that
    // ticks visually and is discarded on save is exactly the
    // columnResizingPlugin failure this codebase already refused once.
    await expect
      .poll(async () => await readFile(fixturePath, 'utf8'), { timeout: 20_000 })
      .toContain('- [x] alpha task')

    const saved = await readFile(fixturePath, 'utf8')
    console.log(`Gate 42 saved document:\n${saved}`)
    // The other two items must be untouched -- a toggle that rewrote its
    // siblings would be a much worse bug than the one being fixed.
    expect(saved).toContain('- [x] beta task')
    expect(saved).toContain('- plain bullet')
  } finally {
    await restoreRecents()
    await rm(fixtureDir, { recursive: true, force: true })
    await close()
  }
})
