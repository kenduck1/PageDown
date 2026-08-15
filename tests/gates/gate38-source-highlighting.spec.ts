import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeRecentFiles, readRecentFiles, writeRecentFiles } from '../../src/main/recent-files'
import { launchIsolatedApp } from './electron-launch'

// Gate 38 -- Source-mode syntax highlighting, against the REAL built app.
//
// WHY THIS GATE EXISTS, and why no unit test can replace it.
//
// Source mode is a real <textarea> whose text is rendered TRANSPARENT, sitting
// over a <pre> that paints the same characters in colour (see
// src/renderer/src/components/SourceEditor.tsx). The user sees the <pre> and
// interacts with the <textarea>, so the entire feature rests on one property
// that is a statement about LAYOUT: every glyph the <pre> paints lands exactly
// on the character the <textarea> believes is there. jsdom has no layout
// engine, so a component test can prove the mirror contains the right
// characters and can prove nothing whatsoever about where they are -- and a
// mirror one pixel, one column or one line out of register is a caret that
// sits next to the wrong letter, which is invisible to every assertion that
// does not measure.
//
// The alignment assertion below is deliberately triangulated rather than
// self-referential. It derives where a token OUGHT to be from the TEXTAREA's
// own computed style (its padding, its font, its line-height) plus an
// independent canvas text measurement, then compares that against where the
// MIRROR actually painted it. Neither element supplies both sides, so a
// one-sided edit to either -- the exact failure mode source-editor.css's
// single shared metrics rule exists to prevent -- moves one side and not the
// other and fails here.

const GET_MAIN_WINDOW_TIMEOUT_MS = 60_000

// Same helper (and same reasoning) as gate17/gate24: this app launches a
// SECOND window at startup whose page loads under the sandboxed
// `pagedown-render://` scheme with zero contextBridge access. Matched by a
// POSITIVE `file://` check rather than a negative exclusion, because every
// window starts on `about:blank` before its real navigation completes.
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

// The line the alignment probe measures. Kept SHORT (so it cannot wrap at any
// plausible window width, which would make "column N" ambiguous) and placed
// near the top of the fixture (so it is on screen at scrollTop 0).
const PROBE_LINE = 'Prose with **bold text** and more.'
const PROBE_TOKEN = '**bold text**'

// Long enough to wrap several times at this app's default 1000px window, and
// repeated enough that a content-width divergence of even a few pixels would
// re-wrap some of them and change the mirror's total height. This is the half
// of the contract that a scrollbar-width mismatch breaks -- CLAUDE.md's
// standing warning about mirrored overlays ("breaks silently on resize").
const LONG_LINE =
  'This paragraph is deliberately long so that it wraps across several visual ' +
  'rows inside the editing surface, because wrapping is where a content-width ' +
  'divergence between the textarea and its mirror first becomes visible, and a ' +
  'divergence of even a single scrollbar width re-flows the text differently.'

function buildFixture(): string {
  const lines: string[] = ['# Gate 38 alignment fixture', '', PROBE_LINE, '']
  // Enough body to guarantee a vertical scrollbar exists (so the gutter
  // measurement is exercised on platforms with classic scrollbars) and to make
  // the typing-latency sample below a measurement of a real long document
  // rather than of a toy one.
  for (let i = 0; i < 120; i++) {
    lines.push(`## Section ${i}`)
    lines.push('')
    lines.push(`${LONG_LINE} (${i})`)
    lines.push('')
    lines.push(`- item with \`code ${i}\` and [a link](https://example.com/${i})`)
    lines.push('')
  }
  return lines.join('\n')
}

interface OpenedFixture {
  app: ElectronApplication
  close: () => Promise<void>
  win: Page
  fixtureDir: string
  restoreRecents: () => Promise<void>
}

// Launches the real app, seeds a real fixture .md into the real
// recent-files.json allowlist (which is what makes `file:openPath` accept it --
// see CLAUDE.md's File I/O security invariant), and clicks into the editor
// through the real Home screen UI. Same approach as gate11/gate17's own setup.
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

  const fixtureDir = await mkdtemp(join(tmpdir(), 'pagedown-gate38-'))
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const fixtureFilename = `gate38-fixture-${nonce}.md`
  await writeFile(join(fixtureDir, fixtureFilename), body, 'utf8')

  const originalRecents = await readRecentFiles(userDataDir)
  const restoreRecents = async (): Promise<void> => {
    await writeRecentFiles(userDataDir, originalRecents)
  }
  const seeded = mergeRecentFiles(
    originalRecents,
    join(fixtureDir, fixtureFilename),
    new Date().toISOString()
  )
  await writeRecentFiles(userDataDir, seeded)

  // HomeScreen fetches its recent-file list once on mount, which already ran
  // with the PRE-seed allowlist by the time getMainWindow() returned.
  await win.reload()
  await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)
  await win
    .getByRole('button', { name: new RegExp(fixtureFilename.replace(/[.]/g, '\\.')) })
    .click()
  await win.waitForSelector('.milkdown-mount .ProseMirror')

  return { app, close, win, fixtureDir, restoreRecents }
}

test('Gate 38: the highlight mirror paints each token exactly over its own character', async () => {
  test.setTimeout(180_000)

  const fixture = await openFixtureDocument(buildFixture())
  const { close, win, fixtureDir, restoreRecents } = fixture

  try {
    await win.getByRole('button', { name: 'Source', exact: true }).click()
    const textarea = win.getByRole('textbox', { name: 'Markdown source' })
    await expect(textarea).toBeVisible()
    await win.waitForSelector('pre.pagedown-source-highlight .pagedown-src-strong')

    // ---------------------------------------------------------------------
    // 1. The mirror paints EXACTLY the bytes the textarea holds.
    // ---------------------------------------------------------------------
    const textFidelity = await win.evaluate(() => {
      const ta = document.querySelector<HTMLTextAreaElement>('.pagedown-source-editor')!
      const pre = document.querySelector<HTMLPreElement>('pre.pagedown-source-highlight')!
      return { equal: pre.textContent === ta.value + '\n', valueLength: ta.value.length }
    })
    expect(textFidelity.valueLength).toBeGreaterThan(25_000)
    expect(
      textFidelity.equal,
      'the mirror must paint the textarea value verbatim (plus its one trailing newline)'
    ).toBe(true)

    // ---------------------------------------------------------------------
    // 2. THE alignment assertion. Where the token was painted, versus where
    //    the TEXTAREA's own metrics say that character is.
    // ---------------------------------------------------------------------
    const alignment = await win.evaluate(
      (probe) => {
        const ta = document.querySelector<HTMLTextAreaElement>('.pagedown-source-editor')!
        const span = document.querySelector<HTMLElement>('.pagedown-src-strong')!

        // Locate the token in the REAL textarea value, by content -- never by an
        // offset the mirror supplied, which would make this self-referential.
        const index = ta.value.indexOf(probe.token)
        const before = ta.value.slice(0, index)
        const lineIndex = before.split('\n').length - 1
        const column = index - (before.lastIndexOf('\n') + 1)
        const lineText = ta.value.split('\n')[lineIndex]

        // Everything below comes from the TEXTAREA's computed style, so the
        // expectation is independent of anything the mirror declares.
        const cs = getComputedStyle(ta)
        const context = document.createElement('canvas').getContext('2d')!
        context.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
        const lineHeight = parseFloat(cs.lineHeight)
        const taRect = ta.getBoundingClientRect()
        const expectedLeft =
          taRect.left +
          parseFloat(cs.paddingLeft) +
          context.measureText(lineText.slice(0, column)).width
        const expectedWidth = context.measureText(probe.token).width
        // The vertical CENTRE of the line box, not its top: a span's client rect
        // is its font's content box, inset from the line box by half-leading,
        // so a top-to-top comparison would encode that leading as an error.
        const expectedCentreY =
          taRect.top + parseFloat(cs.paddingTop) + (lineIndex + 0.5) * lineHeight - ta.scrollTop

        const rect = span.getBoundingClientRect()
        return {
          token: span.textContent,
          lineIndex,
          column,
          lineHeight,
          fontFamily: cs.fontFamily,
          actualLeft: rect.left,
          expectedLeft,
          actualWidth: rect.width,
          expectedWidth,
          actualCentreY: rect.top + rect.height / 2,
          expectedCentreY
        }
      },
      { token: PROBE_TOKEN }
    )

    console.log('Gate 38 alignment probe:', JSON.stringify(alignment, null, 2))

    // Sanity: the probe found the token we meant, on the line we meant.
    expect(alignment.token).toBe(PROBE_TOKEN)
    expect(alignment.lineIndex).toBe(2)
    expect(alignment.column).toBe(PROBE_LINE.indexOf(PROBE_TOKEN))

    expect(
      Math.abs(alignment.actualLeft - alignment.expectedLeft),
      'the painted token must start at the character offset the textarea metrics imply'
    ).toBeLessThan(1)
    expect(
      Math.abs(alignment.actualWidth - alignment.expectedWidth),
      'the painted token must be exactly as wide as its own characters'
    ).toBeLessThan(1)
    expect(
      Math.abs(alignment.actualCentreY - alignment.expectedCentreY),
      'the painted token must sit on the line the textarea puts that character on'
    ).toBeLessThan(1)

    // ---------------------------------------------------------------------
    // 3. Wrapping parity. The two elements must lay a long line out over the
    //    same number of visual rows, which they only do if their CONTENT
    //    widths agree -- i.e. only if the mirror compensates for the width the
    //    textarea's own scrollbar takes away. On macOS overlay scrollbars that
    //    compensation is zero; on Windows/Linux it is not, which is exactly
    //    why the invariant is asserted rather than the mechanism.
    // ---------------------------------------------------------------------
    const boxes = await win.evaluate(() => {
      const ta = document.querySelector<HTMLTextAreaElement>('.pagedown-source-editor')!
      const pre = document.querySelector<HTMLPreElement>('pre.pagedown-source-highlight')!
      const tas = getComputedStyle(ta)
      const pres = getComputedStyle(pre)
      const content = (el: Element, cs: CSSStyleDeclaration): number =>
        el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
      return {
        gutter: ta.offsetWidth - ta.clientWidth,
        publishedGutter: getComputedStyle(
          document.querySelector<HTMLElement>('.pagedown-source-shell')!
        ).getPropertyValue('--pagedown-source-gutter'),
        textareaContentWidth: content(ta, tas),
        mirrorContentWidth: content(pre, pres),
        textareaScrollHeight: ta.scrollHeight,
        mirrorScrollHeight: pre.scrollHeight,
        lineHeight: parseFloat(tas.lineHeight),
        scrollable: ta.scrollHeight > ta.clientHeight
      }
    })

    console.log('Gate 38 box parity:', JSON.stringify(boxes))

    // Not a vacuous run: the document really is taller than the viewport, so
    // the scrollbar (and therefore the gutter) is genuinely in play.
    expect(boxes.scrollable, 'the fixture must actually overflow vertically').toBe(true)
    expect(boxes.publishedGutter.trim()).toBe(`${boxes.gutter}px`)
    expect(
      boxes.mirrorContentWidth,
      'both surfaces must wrap at the same column, so their content widths must match'
    ).toBeCloseTo(boxes.textareaContentWidth, 1)

    // Same total height, to within the mirror's one deliberate extra trailing
    // newline. With 200 wrapping long lines in this fixture, a content-width
    // divergence would re-flow many of them and blow this by far more than one
    // line. The >= half also pins the property scrolling depends on: the
    // mirror is never SHORTER than the textarea, so it can always be scrolled
    // as far.
    expect(boxes.mirrorScrollHeight).toBeGreaterThanOrEqual(boxes.textareaScrollHeight)
    expect(
      boxes.mirrorScrollHeight - boxes.textareaScrollHeight,
      'the mirror must wrap the whole document into the same rows as the textarea'
    ).toBeLessThanOrEqual(boxes.lineHeight)

    // ---------------------------------------------------------------------
    // 4. Scroll sync: the mirror follows the textarea's own scroll, and the
    //    painted token moves by exactly the scrolled distance.
    // ---------------------------------------------------------------------
    const beforeScroll = (await win.locator('.pagedown-src-strong').first().boundingBox())!
    await win.evaluate(() => {
      const ta = document.querySelector<HTMLTextAreaElement>('.pagedown-source-editor')!
      ta.scrollTop = 640
      ta.dispatchEvent(new Event('scroll'))
    })
    const scrolled = await win.evaluate(() => {
      const ta = document.querySelector<HTMLTextAreaElement>('.pagedown-source-editor')!
      const pre = document.querySelector<HTMLPreElement>('pre.pagedown-source-highlight')!
      return { textareaScrollTop: ta.scrollTop, mirrorScrollTop: pre.scrollTop }
    })
    const afterScroll = (await win.locator('.pagedown-src-strong').first().boundingBox())!
    console.log('Gate 38 scroll sync:', JSON.stringify({ scrolled, beforeScroll, afterScroll }))
    expect(scrolled.mirrorScrollTop).toBe(scrolled.textareaScrollTop)
    expect(
      beforeScroll.y - afterScroll.y,
      'the painted token must move by exactly the distance the textarea scrolled'
    ).toBeCloseTo(scrolled.textareaScrollTop, 1)

    await win.evaluate(() => {
      const ta = document.querySelector<HTMLTextAreaElement>('.pagedown-source-editor')!
      ta.scrollTop = 0
      ta.dispatchEvent(new Event('scroll'))
    })

    // ---------------------------------------------------------------------
    // 5. The colouring is genuinely painted, and the real text is genuinely
    //    invisible -- i.e. what the user reads is the mirror.
    // ---------------------------------------------------------------------
    const paint = await win.evaluate(() => {
      const ta = document.querySelector<HTMLTextAreaElement>('.pagedown-source-editor')!
      const pre = document.querySelector<HTMLPreElement>('pre.pagedown-source-highlight')!
      const colourOf = (selector: string): string => {
        const el = pre.querySelector(selector)
        return el ? getComputedStyle(el).color : 'MISSING'
      }
      return {
        textareaColor: getComputedStyle(ta).color,
        textareaCaretColor: getComputedStyle(ta).caretColor,
        mirrorBase: getComputedStyle(pre).color,
        heading: colourOf('.pagedown-src-heading'),
        code: colourOf('.pagedown-src-code'),
        linkUrl: colourOf('.pagedown-src-link-url'),
        list: colourOf('.pagedown-src-list'),
        marker: colourOf('.pagedown-src-marker')
      }
    })
    console.log('Gate 38 painted colours (light):', JSON.stringify(paint))

    expect(paint.textareaColor, 'the real text must be invisible').toBe('rgba(0, 0, 0, 0)')
    expect(paint.textareaCaretColor, 'but the caret must not be').not.toBe('rgba(0, 0, 0, 0)')
    // Every kind resolved to a real colour, and to a DIFFERENT one from plain
    // body text -- a class that matched no rule would silently inherit the base
    // colour and this feature would look exactly like its own absence.
    for (const kind of ['heading', 'code', 'linkUrl', 'list', 'marker'] as const) {
      expect(paint[kind], `${kind} must resolve to a real colour`).toMatch(/^rgb/)
      expect(paint[kind], `${kind} must not be plain body text`).not.toBe(paint.mirrorBase)
    }
    // The real shipped light-mode values, pinned the way gate24 pins its own.
    expect(paint.heading).toBe('rgb(36, 97, 192)')
    expect(paint.code).toBe('rgb(155, 47, 97)')
    expect(paint.list).toBe('rgb(154, 91, 0)')

    // ---------------------------------------------------------------------
    // 6. Keystroke latency, on this real ~50KB document. Measured from the
    //    real keydown to the first animation frame after it, i.e. everything
    //    React and the browser did in response to that key before the next
    //    paint. jsdom-based timing could not include layout at all.
    // ---------------------------------------------------------------------
    await win.evaluate(() => {
      const ta = document.querySelector<HTMLTextAreaElement>('.pagedown-source-editor')!
      const samples: number[] = []
      ;(window as unknown as { __gate38: number[] }).__gate38 = samples
      ta.addEventListener('keydown', () => {
        const started = performance.now()
        requestAnimationFrame(() => samples.push(performance.now() - started))
      })
    })
    await textarea.click()
    await win.keyboard.type('The quick brown fox jumps.', { delay: 30 })
    const latency = await win.evaluate(() => {
      const samples = (window as unknown as { __gate38: number[] }).__gate38
      const sorted = [...samples].sort((a, b) => a - b)
      return {
        count: sorted.length,
        median: sorted[Math.floor(sorted.length / 2)],
        p95: sorted[Math.floor(sorted.length * 0.95)],
        max: sorted[sorted.length - 1]
      }
    })
    console.log('Gate 38 keystroke latency (ms) on a real long document:', JSON.stringify(latency))
    expect(latency.count).toBeGreaterThan(20)
    expect(
      latency.p95,
      'a keystroke must not cost anything close to a dropped-frame budget'
    ).toBeLessThan(100)

    // The typing landed in the real document and the mirror kept up with it.
    const afterTyping = await win.evaluate(() => {
      const ta = document.querySelector<HTMLTextAreaElement>('.pagedown-source-editor')!
      const pre = document.querySelector<HTMLPreElement>('pre.pagedown-source-highlight')!
      return {
        hasTyped: ta.value.includes('The quick brown fox jumps.'),
        inSync: pre.textContent === ta.value + '\n'
      }
    })
    expect(afterTyping.hasTyped).toBe(true)
    expect(afterTyping.inSync, 'the mirror must still match after real typing').toBe(true)
  } finally {
    await restoreRecents()
    await rm(fixtureDir, { recursive: true, force: true })
    await close()
  }
})

test('Gate 38: the source palette repaints for dark mode and stays off the document surfaces', async () => {
  test.setTimeout(120_000)

  const { app, close } = await launchIsolatedApp(['out/main/index.js'])
  void app
  const win = await getMainWindow(app)

  try {
    await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)

    // Real user action, through the real Settings screen -- the same path
    // gate24 drives.
    await win.getByRole('button', { name: 'Settings' }).click()
    await win.getByRole('combobox', { name: 'Color scheme' }).selectOption('dark')
    await expect
      .poll(() => win.evaluate(() => document.documentElement.dataset.theme), {
        message: 'expected <html data-theme="dark"> after selecting Dark',
        timeout: 10_000
      })
      .toBe('dark')

    await win.getByRole('button', { name: '← Home' }).click()
    await win.getByRole('button', { name: 'New document' }).click()
    await win.waitForSelector('.milkdown-mount .ProseMirror')
    await win.getByRole('button', { name: 'Source', exact: true }).click()

    const textarea = win.getByRole('textbox', { name: 'Markdown source' })
    await expect(textarea).toBeVisible()
    await textarea.click()
    await win.keyboard.type('# Heading\n\nProse with `code` and a [link](https://example.com).\n')
    await win.waitForSelector('pre.pagedown-source-highlight .pagedown-src-heading')

    const dark = await win.evaluate(() => {
      const pre = document.querySelector<HTMLPreElement>('pre.pagedown-source-highlight')!
      const colourOf = (selector: string): string => {
        const el = pre.querySelector(selector)
        return el ? getComputedStyle(el).color : 'MISSING'
      }
      return {
        shellBackground: getComputedStyle(
          document.querySelector<HTMLElement>('.pagedown-source-shell')!
        ).backgroundColor,
        base: getComputedStyle(pre).color,
        heading: colourOf('.pagedown-src-heading'),
        code: colourOf('.pagedown-src-code'),
        linkUrl: colourOf('.pagedown-src-link-url')
      }
    })
    console.log('Gate 38 painted colours (dark):', JSON.stringify(dark))

    // The real shipped DARK values, and each is genuinely different from its
    // light counterpart asserted in the first test -- proving the palette's
    // :root[data-theme='dark'] block really is reached rather than the light
    // values simply surviving on a dark background.
    expect(dark.heading).toBe('rgb(76, 141, 255)')
    expect(dark.heading).not.toBe('rgb(36, 97, 192)')
    expect(dark.code).toBe('rgb(239, 151, 193)')
    expect(dark.code).not.toBe('rgb(155, 47, 97)')
    // Body text and the surface it sits on both flipped too, so this is a real
    // dark surface rather than dark-coloured tokens on a light one.
    expect(dark.base).toBe('rgb(232, 232, 234)')
    expect(dark.shellBackground).toBe('rgb(24, 24, 26)')

    // The highlight classes must exist ONLY on this surface. The Milkdown
    // canvas and, more importantly, the sandboxed pagination context render
    // the DOCUMENT -- source colouring there would print. (The sandbox never
    // loads base.css at all, so this is a check that nothing leaked into the
    // app shell's own document canvas.)
    await win.getByRole('button', { name: 'Format', exact: true }).click()
    await win.waitForSelector('.milkdown-mount .ProseMirror')
    const leaked = await win.evaluate(
      () => document.querySelectorAll('.milkdown-mount [class*="pagedown-src-"]').length
    )
    expect(leaked, 'source token classes must never appear in the document canvas').toBe(0)
  } finally {
    await close()
  }
})
