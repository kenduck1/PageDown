import type { ElectronApplication } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

// Shared fixtures + evidence-reading helper for the local-asset-loading gate
// cases in gate8-thumbnail-generation.spec.ts and gate12-page-count.spec.ts.
// Both gates need the identical "did this <img> really load?" proof against
// two different generators (thumbnails, page count), so this lives here
// rather than being copy-pasted into both specs.

// Real, valid PNGs -- NOT placeholder strings. Using genuine image bytes is
// what makes a decode failure distinguishable from a load failure: a served
// -and-decoded image reports its true intrinsic size, whereas an image that
// 404'd reports naturalWidth/naturalHeight of 0 while still being `complete`
// (the exact signature tests/gates/gate4-export.spec.ts already asserts for the
// corpus's unserved images).
//
// The two are deliberately DIFFERENT sizes so a confinement failure is
// unambiguous rather than merely "something loaded": a document-local asset
// decodes to 1x1, while the out-of-tree file a traversal attempt targets
// decodes to 2x2. A denied traversal reads 0x0; a traversal that wrongly
// SUCCEEDED would read 2x2, which no legitimate fixture in these gates ever
// produces.
export const ONE_PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)

export const TWO_PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAD0lEQVR4nGNgYPgPRmAKABf2A/1+6zfzAAAAAElFTkSuQmCC',
  'base64'
)

export interface ImageBox {
  /** The `src` attribute exactly as `markdownToHtml`'s rewrite wrote it. */
  src: string
  /** That same URL after Chromium's own WHATWG parse/normalize. */
  resolvedSrc: string
  naturalWidth: number
  naturalHeight: number
}

export async function writeFixtureFile(path: string, contents: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents)
}

/**
 * Polls the real, running app's pagination render contexts for the
 * `imageBoxes` measurements (see resources/pagination-render/index.ts) of the
 * most recent render whose `<img>` set includes `srcFragment`, and returns
 * that render's COMPLETE box list (not just the matching entries -- a case
 * often needs to assert on a sibling image in the same document, e.g. a
 * denied reference alongside a loading one as its own control).
 *
 * Reads through `webContents.getAllWebContents()` + `executeJavaScript` from
 * the main process rather than through Playwright's own window tracking: the
 * thumbnail and page-count harnesses each live in a dedicated `show: false`
 * `BaseWindow` (see their generators' `getHarness`), and `executeJavaScript`
 * against the render context is exactly how `sendDocument` itself already
 * talks to it -- no assumption about which off-screen views Playwright
 * happens to surface as pages.
 *
 * Matching on a caller-supplied unique filename fragment (rather than "the
 * newest result on any harness") is what makes this deterministic: every
 * generator has its OWN harness, each harness holds only its own latest
 * `window.__pagedownResult`, and each gate case uses a nonce-stamped fixture
 * filename that appears in exactly one of them.
 */
export async function readImageBoxes(
  app: ElectronApplication,
  srcFragment: string,
  timeoutMs = 20_000
): Promise<ImageBox[]> {
  const deadline = Date.now() + timeoutMs
  let lastSeen: string[] = []

  while (Date.now() < deadline) {
    const results = await app.evaluate(async ({ webContents }) => {
      const collected: unknown[] = []
      for (const wc of webContents.getAllWebContents()) {
        if (wc.isDestroyed()) continue
        if (!wc.getURL().startsWith('pagedown-render://')) continue
        try {
          const result = await wc.executeJavaScript('window.__pagedownResult || null')
          if (result && Array.isArray(result.imageBoxes)) collected.push(result.imageBoxes)
        } catch {
          // A view torn down mid-poll (or still navigating) has no result to
          // contribute -- skip it rather than failing the whole read.
        }
      }
      return collected as Array<
        Array<{
          src: string
          resolvedSrc: string
          naturalWidth: number
          naturalHeight: number
        }>
      >
    })

    lastSeen = results.flat().map((box) => box.src)
    const matched = results.find((boxes) => boxes.some((box) => box.src.includes(srcFragment)))
    if (matched) return matched

    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  throw new Error(
    `Timed out waiting for a pagination render result containing an <img> whose src includes ` +
      `${JSON.stringify(srcFragment)}. Last observed srcs across all render contexts: ` +
      `${JSON.stringify(lastSeen)}`
  )
}

/**
 * The exact URL shape `src/markdown/pipeline.ts`'s `rewriteLocalImageSrcs`
 * produces for a given relative path: the asset scheme, a fresh 32-hex-char
 * per-render token, and the relative path as ONE `encodeURIComponent`-encoded
 * segment. Built here as a regex (not a literal) because the token is random
 * per render and unknowable to the test.
 */
export function assetUrlPattern(encodedRelativePath: string): RegExp {
  return new RegExp(
    `^pagedown-render://render/__asset__/[0-9a-f]{32}/${encodedRelativePath.replace(
      /[.*+?^${}()|[\]\\]/g,
      '\\$&'
    )}$`
  )
}
