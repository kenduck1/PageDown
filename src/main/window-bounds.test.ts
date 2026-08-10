import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_WINDOW_WIDTH,
  DEFAULT_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  MIN_WINDOW_HEIGHT,
  readWindowState,
  writeWindowState,
  boundsAreOnScreen,
  resolveInitialWindowBounds,
  type WindowBounds,
  type DisplayWorkArea
} from './window-bounds'
import { drainConfigWarnings, resetConfigWarningsForTest } from './config-warnings'

describe('readWindowState / writeWindowState', () => {
  it('round-trips real bounds through a real temp directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pagedown-window-state-'))
    try {
      const bounds: WindowBounds = { x: 120, y: 80, width: 1300, height: 900 }
      await writeWindowState(dir, bounds)
      expect(await readWindowState(dir)).toEqual(bounds)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns null when no file exists yet', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pagedown-window-state-'))
    try {
      expect(await readWindowState(dir)).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('degrades an unparseable file to null rather than throwing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pagedown-window-state-'))
    try {
      await writeFile(join(dir, 'window-state.json'), 'not valid json{{{', 'utf8')
      expect(await readWindowState(dir)).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('degrades a well-formed but malformed-fields file to null', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pagedown-window-state-'))
    try {
      await writeFile(
        join(dir, 'window-state.json'),
        JSON.stringify({ x: 'not a number', y: 0, width: 800, height: 600 }),
        'utf8'
      )
      expect(await readWindowState(dir)).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('clamps a saved width/height below the minimum back up to it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pagedown-window-state-'))
    try {
      await writeFile(
        join(dir, 'window-state.json'),
        JSON.stringify({ x: 0, y: 0, width: 10, height: 10 }),
        'utf8'
      )
      const result = await readWindowState(dir)
      expect(result).toEqual({ x: 0, y: 0, width: MIN_WINDOW_WIDTH, height: MIN_WINDOW_HEIGHT })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('a truncated (crash-mid-write) file degrades to null rather than throwing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pagedown-window-state-'))
    try {
      await writeFile(join(dir, 'window-state.json'), '{"x": 0, "y": 0, "widt', 'utf8')
      expect(await readWindowState(dir)).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('readWindowState corrupt-file reporting', () => {
  beforeEach(() => {
    resetConfigWarningsForTest()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    resetConfigWarningsForTest()
  })

  it('records a warning for an unparseable file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pagedown-window-state-'))
    try {
      await writeFile(join(dir, 'window-state.json'), '{ broken', 'utf8')
      expect(await readWindowState(dir)).toBeNull()
      expect(drainConfigWarnings()).toHaveLength(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('stays SILENT when the file simply does not exist yet', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pagedown-window-state-'))
    try {
      expect(await readWindowState(dir)).toBeNull()
      expect(drainConfigWarnings()).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('boundsAreOnScreen', () => {
  const primaryDisplay: DisplayWorkArea = { x: 0, y: 0, width: 1920, height: 1080 }

  it('is true when bounds sit entirely within a connected display', () => {
    const bounds: WindowBounds = { x: 100, y: 100, width: 800, height: 600 }
    expect(boundsAreOnScreen(bounds, [primaryDisplay])).toBe(true)
  })

  it('is true when bounds only partially overlap a connected display', () => {
    // A window straddling a display's edge is still visible/draggable, not
    // fully off-screen.
    const bounds: WindowBounds = { x: 1800, y: 100, width: 800, height: 600 }
    expect(boundsAreOnScreen(bounds, [primaryDisplay])).toBe(true)
  })

  it('is false when bounds sit entirely off every connected display', () => {
    // The common real case: a window last positioned on a since-disconnected
    // second monitor to the right of the primary one.
    const bounds: WindowBounds = { x: 2200, y: 100, width: 800, height: 600 }
    expect(boundsAreOnScreen(bounds, [primaryDisplay])).toBe(false)
  })

  it('is false with no connected displays at all', () => {
    const bounds: WindowBounds = { x: 100, y: 100, width: 800, height: 600 }
    expect(boundsAreOnScreen(bounds, [])).toBe(false)
  })

  it('checks every connected display, not just the first', () => {
    const secondDisplay: DisplayWorkArea = { x: 1920, y: 0, width: 1920, height: 1080 }
    const bounds: WindowBounds = { x: 2000, y: 100, width: 800, height: 600 }
    expect(boundsAreOnScreen(bounds, [primaryDisplay, secondDisplay])).toBe(true)
  })
})

describe('resolveInitialWindowBounds', () => {
  const primaryDisplay: DisplayWorkArea = { x: 0, y: 0, width: 1920, height: 1080 }

  it('falls back to the real default size with no position when nothing was saved', () => {
    expect(resolveInitialWindowBounds(null, [primaryDisplay])).toEqual({
      width: DEFAULT_WINDOW_WIDTH,
      height: DEFAULT_WINDOW_HEIGHT
    })
  })

  it('restores saved bounds verbatim when they are on-screen', () => {
    const saved: WindowBounds = { x: 200, y: 150, width: 1300, height: 900 }
    expect(resolveInitialWindowBounds(saved, [primaryDisplay])).toEqual(saved)
  })

  it('keeps the saved size but drops the position when it is fully off-screen', () => {
    // Simulates a monitor that was unplugged since the bounds were saved --
    // the size the user chose is still worth honoring, but restoring the
    // exact x/y would strand the window off every connected display.
    const saved: WindowBounds = { x: 5000, y: 5000, width: 1300, height: 900 }
    expect(resolveInitialWindowBounds(saved, [primaryDisplay])).toEqual({
      width: 1300,
      height: 900
    })
  })
})
