// Product-completeness audit 2.5: "No file associations, no open-with, no
// single-instance lock." Windows/Linux never deliver a double-clicked
// document via a dedicated Electron event the way macOS's `open-file` does
// (see src/main/index.ts's own listener for that half) -- the OS instead
// launches `pagedown.exe "C:\path\to\file.md"` (electron-builder.yml's
// `fileAssociations` is what wires the OS up to do this at all) or, for an
// already-running single-instance app, delivers the SAME argv shape through
// `second-instance`'s own `argv` parameter. This module is the ONE place
// that argv shape is parsed into a single candidate path.
//
// Deliberately Electron-free (same testability rationale as
// recent-files.ts/preferences.ts: a plain `pnpm exec vitest run` exercises
// the real function, no `vi.mock('electron')` needed) -- this module's own
// job is narrow and synchronous: "does this argv list look like it names a
// .md/.markdown file", nothing more. It does NOT touch the filesystem and
// does NOT decide whether the named path is safe to trust -- that's a
// separate, async, real-file-touching step (src/main/index.ts's own
// `resolveOsOpenedMarkdownPath`) that runs on whatever this function
// returns before it is EVER treated as a real, openable document. Splitting
// "does this look like a file-open request" from "is that path real and
// safe" the same way isKnownPath's own allowlist check is kept separate
// from path *parsing* elsewhere in this codebase.
const MARKDOWN_EXTENSION_PATTERN = /\.(md|markdown)$/i

// Extracts a single candidate Markdown path from a raw argv list, or
// `undefined` if none is present. Two things make this more than a bare
// `argv.find(a => a.endsWith('.md'))`:
//
//   - argv[0] (the executable/script path) is explicitly excluded, walking
//     from the END rather than the start. A real file-association launch
//     always appends the document path LAST, after whatever Chromium/
//     Electron switches the OS or a wrapper script inserted ahead of it
//     (Electron itself, `electron-vite dev`'s own dev-mode launch, and
//     Squirrel/NSIS installers on Windows are all known to prepend their
//     own flags) -- walking from the end finds the real trailing document
//     argument regardless of how many such flags precede it, without this
//     module needing to know or enumerate them.
//   - Any argument starting with `-` is skipped outright, so a switch that
//     happens to (implausibly) end in `.md` can never be misread as a
//     document path.
export function extractMarkdownPathFromArgv(argv: readonly string[]): string | undefined {
  for (let i = argv.length - 1; i >= 1; i--) {
    const candidate = argv[i]
    if (candidate.startsWith('-')) continue
    if (MARKDOWN_EXTENSION_PATTERN.test(candidate)) return candidate
  }
  return undefined
}

// Cheap, synchronous, extension-only check for a path that ALREADY arrived
// through a channel that hands over a bare path rather than a full argv
// list -- macOS's `open-file` event delivers exactly one path directly (no
// argv parsing involved at all), so this is the shared "does this look like
// a Markdown file" test both that path and extractMarkdownPathFromArgv's
// own result are checked against before either is trusted any further.
export function looksLikeMarkdownPath(candidate: string): boolean {
  return MARKDOWN_EXTENSION_PATTERN.test(candidate)
}
