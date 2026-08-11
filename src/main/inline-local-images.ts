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
import { dirname } from 'node:path'
import { isRelativeLocalPath, urlToRelativePath } from '../markdown/local-image-src'
import { isKnownPath } from './recent-files'
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
//
// EXPORTED for a second consumer: the `file:resolveLocalImage` IPC handler
// (src/main/index.ts), which backs the Format-mode editor canvas's own image
// rendering. That surface has exactly the same problem HTML export has -- it
// needs real image bytes somewhere that cannot use the `pagedown-render://`
// asset scheme (the privileged app-shell renderer has no such protocol
// registered, and giving it one would hand a context with full
// contextBridge/disk access a URL-shaped file-read primitive) -- so it needs
// the same answer, produced by the same checks. Reusing this function rather
// than writing a second "read an image the document points at" path is the
// whole point: every one of the four security properties above (absolute-path
// denial, symlink-resolved confinement, the 10 MiB stat-before-read cap, and
// magic-byte sniffing) is enforced once, here, for both callers.
export async function resolveLocalImageDataUri(
  documentDir: string,
  src: string
): Promise<string | null> {
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

// The whole body of the `file:resolveLocalImage` IPC handler, extracted here
// rather than written inline in src/main/index.ts for one reason: `index.ts`
// has NO unit tests at all (CLAUDE.md: app bootstrap and IPC registration
// around already-unit-tested functions, verified via gates instead), and the
// guards below are the security boundary of the whole editor-canvas image
// feature. Living here they are directly unit-testable -- and directly
// MUTATION-testable, which is the point: removing either guard has to make a
// named test fail, not merely make a gate time out. Same precedent, and the
// same reasoning, as `clearPendingAutosaveForFile` being pulled out of its
// own handler into version-history.ts.
//
// Resolves one of `documentPath`'s own relative local image references to a
// self-contained `data:` URI. Three guards, in order, each closing something
// the next one does not:
//
//  1. `isRelativeLocalPath(src)` -- refuses anything scheme-prefixed
//     (`file:`, `http:`, `data:`) or root-absolute BEFORE any path join
//     happens. This is also what makes it structurally impossible for this
//     function to be the way a REMOTE image renders: it cannot resolve one
//     at all, so the per-document remote-image consent decision
//     (documentStore.remoteImagesAllowed, enforced in pipeline.ts) has no
//     bypass here, with or without consent.
//  2. `isKnownPath(userDataDir, documentPath)` -- CLAUDE.md's File I/O
//     security invariant. `documentPath` is renderer-supplied and its
//     DIRECTORY becomes the root every subsequent read is confined to, so
//     without this the function is a read-any-directory primitive: name
//     `/Users/someone/.ssh/config` as the "document" and its directory
//     becomes readable one file at a time.
//  3. `resolveAssetPath` (inside resolveLocalImageDataUri) -- the
//     symlink-resolved confinement check that denies `..` escapes and
//     symlinks planted to point outside the document's own directory, plus
//     the 10 MiB stat-before-read cap and the real magic-byte sniff.
//
// Guard 2 chooses WHICH directory; guard 3 keeps the read inside it. Neither
// substitutes for the other, and the tests mutation-check them separately.
//
// Returns `null` for every denial reason alike -- never throws, never
// distinguishes -- matching resolveAssetPath's own "don't hand a hostile
// document an oracle for probing the filesystem" convention. An unknown
// document path DROPS rather than throwing, matching file:getPageCount's
// documented asymmetry with file:getThumbnail: a document aged out of the
// 10-entry recents allowlist still opens and still edits, it just shows
// unresolved-image placeholders, where throwing would produce one rejected
// IPC call per image node on every editor remount.
export async function resolveDocumentLocalImage(
  userDataDir: string,
  documentPath: unknown,
  src: unknown
): Promise<string | null> {
  if (typeof documentPath !== 'string' || documentPath.length === 0) return null
  if (typeof src !== 'string' || !isRelativeLocalPath(src)) return null
  if (!(await isKnownPath(userDataDir, documentPath))) return null
  return resolveLocalImageDataUri(dirname(documentPath), src)
}
