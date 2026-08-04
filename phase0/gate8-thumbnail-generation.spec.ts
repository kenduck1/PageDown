import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

let app: ElectronApplication

test.beforeAll(async () => {
  app = await electron.launch({ args: ['out/main/index.js'] })
  await app.firstWindow()
})

test.afterAll(async () => {
  await app.close()
})

test('Gate 8: getThumbnail generates a real PNG, caches it, and reports a correct page count', async () => {
  const userDataDir = await app.evaluate(({ app }) => app.getPath('userData'))

  const first = await app.evaluate(async ({ BrowserWindow }, dir) => {
    const win = BrowserWindow.getAllWindows()[0]
    const globalAny = global as unknown as {
      __pagedownPhase0: {
        getThumbnail: (
          win: unknown,
          content: string,
          dir: string
        ) => Promise<{ dataUrl: string; pageCount: number }>
      }
    }
    return globalAny.__pagedownPhase0.getThumbnail(
      win,
      '# Gate 8 Fixture\n\nOne page of content.',
      dir
    )
  }, userDataDir)

  expect(first.dataUrl).toMatch(/^data:image\/png;base64,/)
  expect(first.pageCount).toBeGreaterThanOrEqual(1)

  const thumbnailFiles = await readdir(join(userDataDir, 'thumbnails'))
  expect(thumbnailFiles.some((f) => f.endsWith('.png'))).toBe(true)

  const pngFile = thumbnailFiles.find((f) => f.endsWith('.png'))!
  const stats = await stat(join(userDataDir, 'thumbnails', pngFile))
  expect(stats.size).toBeGreaterThan(0)

  // Second call for identical content must be a cache hit: same dataUrl,
  // no new file appears, and — the real proof it didn't regenerate, since
  // the deterministic hash-derived filename and deterministic render output
  // mean a regression that always regenerates would still produce the same
  // filename and likely the same bytes — the existing file's mtime is
  // unchanged (an overwrite-on-regenerate would bump it even if the bytes
  // happened to come out identical).
  const filesBefore = (await readdir(join(userDataDir, 'thumbnails'))).length
  const statsBeforeSecondCall = await stat(join(userDataDir, 'thumbnails', pngFile))
  const mtimeBeforeSecondCall = statsBeforeSecondCall.mtimeMs
  const second = await app.evaluate(async ({ BrowserWindow }, dir) => {
    const win = BrowserWindow.getAllWindows()[0]
    const globalAny = global as unknown as {
      __pagedownPhase0: {
        getThumbnail: (
          win: unknown,
          content: string,
          dir: string
        ) => Promise<{ dataUrl: string; pageCount: number }>
      }
    }
    return globalAny.__pagedownPhase0.getThumbnail(
      win,
      '# Gate 8 Fixture\n\nOne page of content.',
      dir
    )
  }, userDataDir)
  const filesAfter = (await readdir(join(userDataDir, 'thumbnails'))).length

  expect(second.dataUrl).toBe(first.dataUrl)
  expect(second.pageCount).toBe(first.pageCount)
  expect(filesAfter).toBe(filesBefore)

  const statsAfterSecondCall = await stat(join(userDataDir, 'thumbnails', pngFile))
  expect(statsAfterSecondCall.mtimeMs).toBe(mtimeBeforeSecondCall)
})
