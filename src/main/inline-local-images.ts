// Inlines local `<img>` references in a rendered HTML fragment as `data:`
// URIs, for HTML export (html-exporter.ts). Split out of that file into its
// own module for one reason: html-exporter.ts also imports several `?asset`
// paths (electron-vite's own font/CSS asset-embedding mechanism -- see that
// file's header comment), which plain Vitest's own Vite pipeline has no
// configured loader for, so a test importing html-exporter.ts directly would
// need that risk sorted out first. This module imports neither `?asset`
// paths nor `electron` itself directly (only pagination-window.ts's already-
// exported, already-unit-test-precedented `resolveAssetPath`/
// `sniffImageContentType`/`MAX_ASSET_BYTES`, and pipeline.ts's own pure
// helpers) -- see inline-local-images.test.ts's own header for exactly how
// it stubs `electron` just enough to import those real functions.
import { readFile, stat } from 'node:fs/promises'
import { isRelativeLocalPath, urlToRelativePath } from '../markdown/pipeline'
import { resolveAssetPath, sniffImageContentType, MAX_ASSET_BYTES } from './pagination-window'

// Every `<img>` tag as a whole, quote-aware -- NOT a naive `<img[^>]*>`,
// which breaks the moment an attribute value (most plausibly `alt`, which
// carries arbitrary Markdown-authored text) contains a literal `>`: HTML
// parsing (and hast-util-to-html's own serialization, which rehype-stringify
// uses) does not treat an UNESCAPED `>` inside a quoted attribute value as
// ending the tag, so a naive scan would stop early and either miss the src
// entirely or truncate the tag mid-attribute. This alternates "anything but
// a quote or the tag-ending `>`" with "a whole double- or single-quoted
// string", so a `>` inside quotes is consumed as part of that string instead
// of ending the match.
const IMG_TAG_PATTERN_SOURCE = String.raw`<img\b(?:[^"'>]|"[^"]*"|'[^']*')*>`
// The `src` attribute's value, matched the same quote-aware way, scoped to
// operate on an already-isolated single tag string (see inlineLocalImages
// below) rather than the whole document, so it can never accidentally cross
// a tag boundary.
const SRC_ATTR_PATTERN_SOURCE = String.raw`\bsrc=(?:"([^"]*)"|'([^']*)')`

function matchSrc(tag: string): string | null {
  const match = new RegExp(SRC_ATTR_PATTERN_SOURCE, 'i').exec(tag)
  if (!match) return null
  return match[1] ?? match[2] ?? null
}

// Resolves ONE local image reference to a `data:` URI, reusing the exact
// same security-vetted resolution the pagedown-render://__asset__ protocol
// handler uses for the sandboxed preview (resolveAssetPath's own symlink-
// resolving, `..`-escape-denying, absolute-path-denying confinement check)
// plus the identical size cap and real magic-byte content-type sniff --
// deliberately NOT a second, independently-reasoned-about implementation of
// any of those three security properties. Returns null (leaving the
// reference as a plain, now-broken relative path in the exported file) for
// every denial reason alike, matching resolveAssetPath's own "don't give a
// hostile document an oracle for probing the filesystem" convention -- an
// export that can't find/read/verify an image degrades to a missing picture
// icon when the file is later opened, never a thrown error that would abort
// the whole export over one bad reference.
async function resolveLocalImageDataUri(documentDir: string, src: string): Promise<string | null> {
  const relativePath = urlToRelativePath(src)
  const resolved = await resolveAssetPath(documentDir, relativePath)
  if (!resolved) return null
  // Stat-before-read, matching the protocol handler's own "10 MiB cap via
  // stat BEFORE reading" discipline (CLAUDE.md's local-asset invariant) --
  // this function reads the WHOLE file into memory to base64-encode it, so
  // skipping the pre-read size check here specifically would reopen exactly
  // the unbounded-read risk that invariant exists to close.
  const stats = await stat(resolved).catch(() => null)
  if (!stats || stats.size > MAX_ASSET_BYTES) return null
  const buffer = await readFile(resolved)
  const contentType = sniffImageContentType(buffer)
  if (!contentType) return null
  return `data:${contentType};base64,${buffer.toString('base64')}`
}

// Inlines every LOCAL image reference in `html` as a `data:` URI so the
// exported file is genuinely self-contained -- opening it anywhere else
// (another machine, a browser with no PageDown installed) must not depend on
// this app's own pagedown-render://__asset__ scheme, which only resolves
// inside this app's own sandboxed session and would 404 everywhere else.
// `documentDir` is null for an unsaved document (no directory to resolve
// against), in which case this is a no-op and every local reference is left
// exactly as markdownToHtml produced it -- the same "no validated path ->
// deny all local assets" posture every other renderer surface in this app
// already takes (CLAUDE.md's File I/O security invariant section).
//
// Operates on the final HTML STRING via regex, not the hast tree
// rewriteLocalImageSrcs (pipeline.ts) walks -- a deliberate difference, not
// an oversight. That function's rewrite step needs no I/O (it only builds a
// URL string) and runs synchronously inside markdownToHtml's own single-pass
// pipeline; THIS step needs to `stat`/read real files off disk, which is
// asynchronous, and markdownToHtml's own signature is relied upon (by five+
// other call sites: thumbnail-generator.ts, page-count-generator.ts,
// pdf-exporter.ts, print-exporter.ts, split-preview-window.ts) to stay
// synchronous. Threading an async local-image step into that shared
// function would force every one of those call sites to become async for a
// capability only this one, brand-new caller needs -- a much larger, riskier
// change than the regex approach here, which only has to correctly
// recognize the specific, sanitizer-controlled `<img ... src="...">` shape
// hast-util-to-html actually emits (asserted directly against real
// markdownToHtml output in inline-local-images.test.ts, not just a
// synthetic string).
export async function inlineLocalImages(html: string, documentDir: string | null): Promise<string> {
  if (!documentDir) return html
  const tags = html.match(new RegExp(IMG_TAG_PATTERN_SOURCE, 'g'))
  if (!tags) return html

  const dataUriBySrc = new Map<string, string>()
  await Promise.all(
    tags.map(async (tag) => {
      const src = matchSrc(tag)
      if (!src || dataUriBySrc.has(src) || !isRelativeLocalPath(src)) return
      const dataUri = await resolveLocalImageDataUri(documentDir, src)
      if (dataUri) dataUriBySrc.set(src, dataUri)
    })
  )
  if (dataUriBySrc.size === 0) return html

  return html.replace(new RegExp(IMG_TAG_PATTERN_SOURCE, 'g'), (tag) => {
    const src = matchSrc(tag)
    const dataUri = src ? dataUriBySrc.get(src) : undefined
    if (!dataUri) return tag
    return tag.replace(new RegExp(SRC_ATTR_PATTERN_SOURCE, 'i'), `src="${dataUri}"`)
  })
}
