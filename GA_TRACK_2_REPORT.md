# Track 2 Report: Formatting toolbar, Milkdown editing commands, real PDF export

## Summary

Built all three deliverables: real Milkdown editing commands on
`MilkdownEditorHandle`, a new `EditorToolbar` component matching the design
handoff, and a complete, real `file:exportPdf` IPC surface (main-process
module, IPC handler, preload API, Playwright gate). `EditorScreen.tsx`,
`documentStore.ts`, and the other explicitly-off-limits files were not
touched. All verification commands pass (see "Verification output" below).

## 1. `MilkdownEditorHandle` API additions

File: `src/renderer/src/milkdown/MilkdownEditor.tsx` (extended in place —
`flush()` untouched). New file: `src/renderer/src/milkdown/commands.ts`.

```ts
export interface MilkdownEditorHandle {
  flush: () => void // unchanged
  toggleBold: () => void
  toggleItalic: () => void
  toggleHeading: (level: 1 | 2 | 3) => void
  toggleBulletList: () => void
  toggleOrderedList: () => void
  insertLink: (href: string) => void
  insertTable: () => void
  insertPageBreak: () => void
  undo: () => void
  redo: () => void
}
```

Every method dispatches via `editor.action(callCommand(commandKey, payload))`
against the real live editor, exactly as specced. Command keys used, all
verified against real `.d.ts`/`.ts` source under `node_modules` (not assumed
from memory — see file comments for the exact verification path for each):

| Method                 | Underlying command(s)                                                                   | Source package                          |
| ---------------------- | --------------------------------------------------------------------------------------- | --------------------------------------- |
| `toggleBold`           | `toggleStrongCommand`                                                                   | `@milkdown/preset-commonmark`           |
| `toggleItalic`         | `toggleEmphasisCommand`                                                                 | `@milkdown/preset-commonmark`           |
| `toggleHeading(level)` | `wrapInHeadingCommand` (level, or `0` for "already this level → back to paragraph")     | `@milkdown/preset-commonmark`           |
| `toggleBulletList`     | `wrapInBulletListCommand` / `liftListItemCommand`                                       | `@milkdown/preset-commonmark`           |
| `toggleOrderedList`    | `wrapInOrderedListCommand` / `liftListItemCommand`                                      | `@milkdown/preset-commonmark`           |
| `insertLink(href)`     | `toggleLinkCommand` (`{ href }`)                                                        | `@milkdown/preset-commonmark`           |
| `insertTable`          | `insertTableCommand` (`{ row: 2, col: 2 }`)                                             | `@milkdown/preset-gfm`                  |
| `insertPageBreak`      | `insertPagebreakCommand` (new, this project's own)                                      | `src/renderer/src/milkdown/commands.ts` |
| `undo` / `redo`        | `undoCommand` / `redoCommand` (new, wrapping `prosemirror-history`'s own `undo`/`redo`) | `src/renderer/src/milkdown/commands.ts` |

### Key findings from empirical verification

- **`wrapInHeadingCommand`/`wrapInBulletListCommand`/`wrapInOrderedListCommand` are NOT toggles by themselves** — confirmed by reading each package's real TS source (`node_modules/.pnpm/@milkdown+preset-commonmark@7.21.3/.../src/node/heading.ts`, `bullet-list.ts`, `ordered-list.ts`). `wrapInHeadingCommand` always `setBlockType`s to the given level; `wrapIn*ListCommand` always calls ProseMirror's plain `wrapIn`. `toggleHeading`/`toggleBulletList`/`toggleOrderedList` add the actual toggle logic themselves: `toggleHeading` inspects `view.state.selection.$from.parent` and calls `wrapInHeadingCommand` with `0` (documented paragraph-fallback behavior) if the block is already that heading level; `toggleBulletList`/`toggleOrderedList` walk selection ancestors (`isInListType` helper) and call the new `liftListItemCommand` instead of wrapping if already inside that list type.
- **`prosemirror-history` was not wired into this project at all before this task** — confirmed by reading both presets' `composed/plugins.ts` (neither references `history`). Added via `commands.ts`'s `historyProse` plugin (`$prose(() => history())`) plus `undoCommand`/`redoCommand` (`$command` wrapping `prosemirror-history`'s own `undo`/`redo`, which are already `Command`-typed — no extra wrapping needed). **Re-verified, per `MilkdownEditor.tsx`'s own pre-existing comment that explicitly flagged this as required "if undo/redo is added later"**: read `prosemirror-history`'s real source (`histTransaction` in its `dist/index.cjs`) and confirmed its undo/redo transactions never set `addToHistory: false` on themselves — so `editedTrackerProse`'s existing `addToHistory !== false` filter still correctly treats a document-changing undo/redo as a real edit.
- **jsdom's Selection/Range API does not sync into ProseMirror's `state.selection`** — verified with a throwaway scratch test (deleted after use): setting a real, non-collapsed `Range`/`Selection` over existing rendered text left `state.selection` collapsed at its original position regardless. Setting the selection via a direct `view.dispatch(tr.setSelection(...))` **does** work and correctly drives `toggleMark`-backed commands. This directly shaped the test strategy (below) and is documented in-line in the test file.
- `insertTableCommand`'s `row` parameter counts the header row (confirmed by reading `@milkdown/preset-gfm`'s `createTable` helper source) — `{ row: 2, col: 2 }` is genuinely a minimal 2×2 table (one header row, one body row), not 2 body rows.

### Tests (`MilkdownEditor.test.tsx`)

Two new `describe` blocks, extending the file's existing patterns:

1. **`MilkdownEditorHandle mark-toggle commands — API pattern verification`** (new, mirrors the file's pre-existing "listener plugin" raw-`Editor` verification block) — for `toggleBold`/`toggleItalic`/`insertLink`, since these need a real _ranged_ selection (jsdom can't produce one — see above). Builds a raw `Editor` with the exact shipped plugin composition (`EDITOR_SCHEMA_PLUGINS` + `EDITOR_COMMAND_PLUGINS`, imported, not hand-copied), dispatches a real `TextSelection` transaction, then calls `editor.action(callCommand(...))` — the exact mechanism the handle methods wrap — and asserts real `<strong>`/`<em>`/`<a href>` in the rendered DOM, both applying and (for bold/italic) removing the mark.
2. Extended the existing `MilkdownEditor` describe block (full mounted component + `ref`) with 6 new tests for `toggleHeading`, `toggleBulletList`, `toggleOrderedList`, `insertTable`, `insertPageBreak`, and `undo`/`redo` — using the editor's own default initial cursor position (inside the first/only block), since that's testable without needing DOM-driven selection.

All 16 tests in the file pass: 7 pre-existing + 9 new (3 in the new mark-toggle "API pattern verification" block, 6 added to the existing `MilkdownEditor` describe block).

## 2. `EditorToolbar` component

New files: `src/renderer/src/components/EditorToolbar.tsx`,
`EditorToolbar.test.tsx`.

Props: `{ editorRef: RefObject<MilkdownEditorHandle | null> }`. Reads
`viewMode`/`setViewMode`/`pageSetupOpen`/`openPageSetup` from `useAppStore`
directly (existing established pattern, no new store needed), and
`content` from `useDocumentStore` directly (same rationale — `documentStore.ts`
is off-limits, and there's no dedicated "export" action to call there
instead). Only Tailwind tokens from `base.css`'s `@theme static` block are
used; icon SVGs are 24×24 viewBox, `stroke="currentColor"`, no fill (except
bullet-list dots and ordered-list numerals, called out below), adapted from
real markup in `docs/design-handoff/PageDown.dc.html` (undo/redo, link,
image, table, split-cell, page-break, find, page-setup, view-mode, Export
PDF icons all traced from that file's own `<svg>` elements).

**Wired (calls a real `MilkdownEditorHandle` method):** Bold, Italic,
Bulleted list, Numbered list, Insert link (prompts via `window.prompt` for
a URL, then calls `insertLink`), Insert table, Insert page break, Undo,
Redo, paragraph-style dropdown's Heading 1/2/3 options (`toggleHeading`).
View-mode segmented control and page-setup gear call the real `useAppStore`
actions. Export PDF calls the real `window.api.exportPdf(content)`.

**Deliberately unwired (present, matches mockup, but no command exists in
scope for it — documented per-button in code comments):** Underline,
text-color swatch, checkbox-list, Insert image, Split cell, Find (the
design handoff's own README explicitly calls Find an "unwired placeholder
trigger"), font-family dropdown, font-size control, and the paragraph-style
dropdown's "Normal text" option (see deviation below).

**One mockup-fidelity correction found while building this:** the design
handoff's own prose describes bullet/numbered/checkbox list as "a dropdown
group," but the actual prototype markup (`PageDown.dc.html`) renders them as
three plain icon buttons with no dropdown/chevron at all. Built to match the
real markup, not the prose description.

### Tests (`EditorToolbar.test.tsx`)

15 tests against a fake `MilkdownEditorHandle` ref (all methods `vi.fn()`),
covering every wired button (Bold, Italic, both list types, Undo, Redo,
Insert table, Insert page break, Insert link with/without a prompt value,
paragraph-style dropdown), the view-mode segmented control, the page-setup
button, Export PDF success and failure paths, and a defensive "safe to
click with `editorRef.current === null`" test. All pass.

## 3. PDF export plumbing

New file: `src/main/pdf-exporter.ts`. Modified: `src/main/index.ts`,
`src/preload/index.ts`, `src/preload/index.d.ts`.

**IPC surface:**

- Handler: `ipcMain.handle('file:exportPdf', (_event, content: string) => exportDocumentToPdf(mainWindow, content))` in `src/main/index.ts`.
- Preload: `exportPdf: (content: string) => ipcRenderer.invoke('file:exportPdf', content)` in `src/preload/index.ts`.
- Type (`src/preload/index.d.ts`, `FileApi`): `exportPdf: (content: string) => Promise<{ filePath: string } | null>`.

`exportDocumentToPdf(win, content)` (`pdf-exporter.ts`): real
`dialog.showSaveDialog` (PDF filter, `document.pdf` default name) →
returns `null` on cancel (matching `saveFile`'s own contract) → real
`markdownToHtml(content)` → sends the HTML to a **dedicated pagination
harness, created and memoized lazily inside this module** (separate
`WebContentsView` instance from both the Phase-0-spike harness in
`src/main/index.ts` and `thumbnail-generator.ts`'s own harness — per this
codebase's "don't couple unrelated harness consumers" convention) → the
unchanged `exportToPdf()` (`src/export/export-pdf.ts`) does the real
`printToPDF` → writes the resulting `Buffer` to the chosen path via
`fs/promises.writeFile`. All harness-dependent work runs through its own
`enqueueHarnessWork` promise-chaining queue (same pattern, and same reason,
as `thumbnail-generator.ts`'s own queue — the render harness only tracks one
in-flight request at a time).

**`isKnownPath` invariant:** not applicable here and not added — the
destination path comes from a real native `dialog.showSaveDialog()` result,
not a renderer-supplied path, exactly the case CLAUDE.md's File I/O
security section calls out as already-vetted (matching `saveFile`'s own
Save-As dialog path).

### Gate (`phase0/gate12-pdf-export-ipc.spec.ts`)

Uses `launchIsolatedApp` (not bare `electron.launch()`), per the explicit
instruction. Two tests:

1. **Real end-to-end export.** Drives the real renderer page's
   `window.api.exportPdf(content)` (through the real contextBridge, matching
   Gate 9's established "renderer-page, not the `__pagedownPhase0` bridge"
   convention). The one piece mocked is `dialog.showSaveDialog` itself
   (a real native OS modal that would otherwise hang the test forever) —
   monkey-patched via `app.evaluate(({ dialog }) => {...})`, the same
   "electron argument passed directly into the callback" mechanism
   `gate2`/`gate11` already use to reach `app`/`BaseWindow` without
   `require()`/dynamic `import()`. Everything else (harness, `markdownToHtml`,
   `printToPDF`, disk write) is real and unmocked. Asserts: the returned
   `{ filePath }` matches the mocked dialog's path, the file exists with
   non-zero size, and its first 5 bytes are the literal `%PDF-` magic
   string.
2. **Cancel path.** Same setup with `dialog.showSaveDialog` mocked to
   `canceled: true`; asserts `window.api.exportPdf(...)` resolves to `null`
   and (implicitly, since no `filePath` exists) nothing is written.

Both pass; ran the full existing `phase0` suite afterward (27/27 pass,
including the pre-existing deliberate Gate 10 `test.fail()`) to confirm no
regression.

## Deviations from the brief, and why

- **`insertLink`'s URL comes from a real `window.prompt()`**, not a new
  modal/panel — the design handoff has no link-URL-entry UI designed, and
  building one (new component, new state) was out of this track's scope.
  `window.prompt` is a real, functional, native interaction, not a
  decorative stub — clicking the link button genuinely inserts a real link
  with a real URL the user typed.
- **The paragraph-style dropdown's "Normal text" option is a real `<select>`
  option but currently a no-op.** `toggleHeading` only clears a heading back
  to a paragraph when called with the level that's _already_ active, and
  this toolbar has no live selection-state tracking (a separate, larger
  "bubble menu / active formatting state" feature, out of scope here) to
  know which level that is. Documented in the component's own code comment
  rather than guessing and risking clearing/creating the wrong heading
  level.
- **`toggleBulletList`/`toggleOrderedList` only lift out a single level of
  list nesting** (`liftListItemCommand`, once) when toggling off — correct
  for the common single-level case this task's tests cover, but a
  deeply-nested list would need repeated lifts to fully un-list. Not
  exercised by the brief's scope; noted here rather than silently assumed
  correct for every depth.
- **Four pre-existing test files needed a one-line fix** (`App.test.tsx`,
  `EditorScreen.test.tsx`, `HomeScreen.test.tsx`, `documentStore.test.ts`):
  each hand-builds a `window.api` mock object satisfying the `FileApi`
  type, and adding `exportPdf` as a new required member broke all four at
  typecheck time. Added `exportPdf: vi.fn()` to each — a mechanical,
  required fix for a shared type extension, not a scope violation of the
  "don't touch other tracks' files" constraint (none of those four files
  are on the explicit do-not-touch list).

## Verification output

**`pnpm run typecheck`** — clean, exit 0 (both `typecheck:node` and
`typecheck:web`).

**`pnpm exec eslint .`** (whole repo) — clean, exit 0, zero warnings.

**`pnpm exec prettier --check`** on every touched/created file — `All
matched files use Prettier code style!`

**`pnpm exec vitest run`** (full unit suite) — `Test Files 19 passed (19)`,
`Tests 177 passed (177)`.

**`pnpm run build`** — clean: `typecheck` → `electron-vite build` (main
752 KB, preload 3.2 KB, renderer 1.59 MB JS) → `build:pagination-render`
(6.6 MB render-context bundle), all succeeded.

**`pnpm exec playwright test phase0/gate12-pdf-export-ipc.spec.ts`**:

```
Running 2 tests using 1 worker

  ✓  1 … Gate 12: window.api.exportPdf writes a real PDF file to the chosen path (1.1s)
  ✓  2 … Gate 12: window.api.exportPdf resolves to null (writes nothing) when the Save dialog is cancelled (0.5s)

  2 passed (1.8s)
```

**`pnpm exec playwright test`** (full `phase0` suite, to confirm no
regression) — `27 passed (48.1s)`, including the pre-existing deliberate
Gate 10 `test.fail()` (reports as an "expected failure," correctly counted
toward the passing total per its own documented convention).

**`pnpm run test:phase1:vitest`** — pre-existing, documented deliberate
failures only (Gate 1: 5 of 7 tests fail on purpose, per
`docs/superpowers/plans/2026-07-28-phase1-findings.md` and CLAUDE.md); not
touched or affected by this work.

## One-line test summary

177/177 unit tests pass, 27/27 phase0 Playwright gates pass (2 new for this
track), typecheck/lint/prettier/build all clean.

## Files touched

- `src/renderer/src/milkdown/MilkdownEditor.tsx` (extended)
- `src/renderer/src/milkdown/MilkdownEditor.test.tsx` (extended)
- `src/renderer/src/milkdown/commands.ts` (new)
- `src/renderer/src/components/EditorToolbar.tsx` (new)
- `src/renderer/src/components/EditorToolbar.test.tsx` (new)
- `src/main/pdf-exporter.ts` (new)
- `src/main/index.ts` (new IPC handler)
- `src/preload/index.ts`, `src/preload/index.d.ts` (new `exportPdf` method)
- `phase0/gate12-pdf-export-ipc.spec.ts` (new)
- `src/renderer/src/App.test.tsx`, `src/renderer/src/screens/EditorScreen.test.tsx`, `src/renderer/src/screens/HomeScreen.test.tsx`, `src/renderer/src/store/documentStore.test.ts` (mechanical `exportPdf: vi.fn()` mock fix)

Not touched (per constraints): `EditorScreen.tsx`, `documentStore.ts`,
`EditorTabBar.tsx`, `EditorOutline.tsx`, `EditorSidebar.tsx`,
`EditorStatusBar.tsx`, `PageSetupModal.tsx`.

---

# Fix-round addendum

Independent code review came back CHANGES NEEDED with 7 numbered items (1
HIGH, 5 MEDIUM, 1 LOW-MEDIUM) plus item-7 cleanups. All are addressed below.
The `editedSinceMountRef`/undo-redo integration the review called out as
independently re-verified safe was not touched.

**Note (per the coordinator's message, not something to act on):** Track 4,
running in parallel, also created a file it calls "Gate 12"
(`phase0/gate12-page-count.spec.ts`). No literal git conflict with this
track's `phase0/gate12-pdf-export-ipc.spec.ts` (different filenames), but
both internally claim gate number 12. Flagged as known/already-tracked for
integration-time renumbering; not fixed here.

**Also per the coordinator's message:** the toolbar is still not mounted
anywhere (`EditorScreen.tsx` doesn't import `EditorToolbar`) — this remains
a deliberate constraint of this track's scope, not an oversight, restated
here explicitly for integration-time tracking.

## Item 1 (HIGH) — PDF export harness reuse causing severe slowdown/failures

**Status: fixed and verified, but the true root cause was NOT what the
first fix attempt assumed** — worth reading in full, since two intermediate
"fixes" were tried, measured, and found not to work before the real cause
was isolated.

**Attempt 1 — fresh harness per export (what the review's own suggested
direction was).** Implemented: no more memoized `harnessPromise`, every
export gets its own `WebContentsView` via `createPaginationHarness`, torn
down after use. Measured via the new Gate 12 repeated-export test (below),
through the real IPC path: **488ms, 3584ms, 4392ms** — still an ~8-9x
slowdown. This did NOT reproduce the review's own reported "~300ms flat"
result for the same fix direction.

**Attempt 2 — isolated session/partition per export**, on top of Attempt 1
(hypothesis: the shared, memoized `renderSession`/`StoragePartition` every
harness routes through, fresh WebContentsView or not, was where state
accumulated). Implemented by parameterizing
`pagination-window.ts`'s `ensureRenderInfraRegistered`/`createPaginationHarness`
to accept a caller-supplied partition name, and generating a unique one
(`pagedown-render-export-<uuid>`) per export. Measured: **1467ms, 3431ms,
4310ms** — still degrading, statistically indistinguishable from Attempt 1.
Also tested (even more targeted): disabling `generateTaggedPDF` entirely
(temporarily, diagnostic-only, reverted immediately after) — **491ms,
3472ms, 4371ms** — still degrading. Both hypotheses ruled out by
measurement, not argument. The partition-parameterization change was
reverted back out of `pagination-window.ts` afterward (see that file's own
note); the only trace it leaves is a comment explaining it was tried.

**Root cause, isolated via a controlled A/B diagnostic** (a throwaway
Playwright script, written and deleted, using the existing
`__pagedownPhase0` bridge to call `createPaginationHarness`/`printToPDF`
directly — bypassing IPC/dialog entirely to isolate variables): with the
harness's `WebContentsView` attached to its own **dedicated, never-shown
`BaseWindow`** instead of the real app-shell `mainWindow`, BOTH a memoized
harness (3 `printToPDF` calls on one harness) AND a fresh-harness-per-call
approach measured **flat, fast timing** — memoized: `[85, 70, 69]`ms; fresh:
`[78, 71, 75]`ms. Reusing vs. recreating the harness turned out not to
matter **at all**. What mattered was that every previous version of
`pdf-exporter.ts` (including both fix attempts above) attached the
harness's view to the real, visible, actively-composited/focused
`mainWindow` — repeatedly adding/removing a child `WebContentsView` on that
window accumulates real overhead across repeated `printToPDF` calls, even
positioned off-screen. A dedicated, always-hidden `BaseWindow` used for
nothing else doesn't have that cost.

**Actual fix** (`src/main/pdf-exporter.ts`): `withFreshHarness` now creates
a dedicated `new BaseWindow({ show: false })` per export, attaches the
harness to _that_, and calls `harnessWindow.destroy()` in its `finally`
block (destroying the window destroys its owned view/webContents with it —
no separate `removeChildView`/`webContents.close()` needed). `win` (the
real `mainWindow`, still passed into `exportDocumentToPdf`) is now used
**only** for `dialog.showSaveDialog`'s modality, never as the harness's
parent window.

**Verified fix, before/after, exact numbers:**

|                                                                                  | 1st export | 2nd export                     | 3rd export |
| -------------------------------------------------------------------------------- | ---------- | ------------------------------ | ---------- |
| Reviewer's original finding (memoized harness, real IPC path)                    | 325ms      | 3642ms → 4059ms (5 more calls) |
| This track's Attempt 1 (fresh harness, still on mainWindow)                      | 488ms      | 3584ms                         | 4392ms     |
| This track's Attempt 2 (fresh harness + isolated partition, still on mainWindow) | 1467ms     | 3431ms                         | 4310ms     |
| **Actual fix (dedicated hidden BaseWindow), run 1**                              | **404ms**  | **401ms**                      | **395ms**  |
| **Actual fix, run 2**                                                            | **426ms**  | **419ms**                      | **414ms**  |
| **Actual fix, run 3**                                                            | **443ms**  | **431ms**                      | **430ms**  |
| **Actual fix, run 4**                                                            | **431ms**  | **419ms**                      | **414ms**  |

Five independent full runs of Gate 12 (each launching a fresh app instance)
all show flat timing in the 380-450ms range with no growth pattern — a
~9-10x improvement over the degraded steady state, and (more importantly)
no timeout risk regardless of how many exports happen in one session.

**`sendDocument`'s timeout was parameterized** as asked
(`src/main/pagination-window.ts`): `sendDocument(html: string, timeoutMs?:
number)`, defaulting to the existing `10_000`ms for every pre-existing
caller (fully backward compatible — verified no other caller passes a
second argument). `pdf-exporter.ts` requests `30_000`ms
(`EXPORT_PAGINATION_TIMEOUT_MS`), matching Gate 7's own reasoning for giving
a known-heavier workload more headroom than the routine default.

**New Gate 12 test**, exactly as asked: exports the same 60-paragraph
document 3 times in one app session (`phase0/gate12-pdf-export-ipc.spec.ts`,
`Gate 12: exporting the same multi-paragraph document repeatedly in one app
session does not degrade`), logs each duration, and asserts no later export
exceeds `max(first * 5, 5000)`ms — a generous regression guard (not a tight
performance bound) sized to catch a real return of the ~8-12x-slowdown
signature without being flaky against ordinary machine noise. The original
Gate 12 exported once per launched app and structurally could not have
caught this class of regression; this closes that gap.

**One known, accepted limitation**: `BaseWindow.destroy()`'s child-view
cleanup was verified via the _absence_ of the slowdown returning across
repeated real exports (5 full-suite/gate runs, no zombie process
accumulation observed via `ps aux` during the investigation) rather than
via an explicit process-count assertion in the gate itself — asserting on
OS-level process counts from inside a Playwright test would be its own can
of worms (process counts vary by platform/Electron version) and wasn't
asked for; noted here for transparency rather than silently assumed clean.

## Item 2 (MEDIUM) — mark-command test coverage gap (bold/italic/link untested against the real handle)

**Fixed.** Root cause: the pre-fix-round "API pattern verification" test
block called `editor.action(callCommand(toggleStrongCommand.key))` directly
with a **hardcoded command key**, never actually invoking
`MilkdownEditorHandle.toggleBold` itself — so rewiring `toggleBold` to
dispatch `toggleEmphasisCommand` (the reviewer's mutation test) changed
nothing the test suite could see.

**Fix**: extracted the command-building logic that used to live inline in
`MilkdownEditor.tsx`'s mount effect into a new, standalone, exported
function — `buildEditorCommands(editor: Editor): EditorCommands`
(`src/renderer/src/milkdown/editor-commands.ts`, new file). The mounted
component now just calls `commandsRef.current = buildEditorCommands(created)`
instead of building the object inline. Tests now call
`buildEditorCommands(editor)` directly (with a real ProseMirror selection
established via direct transaction dispatch — jsdom's Selection/Range API
still doesn't sync into `state.selection`, verified again this round) and
assert on the real DOM result. This is the literal, single, shared
implementation the mounted component also uses — a wiring bug like the
mutation-tested one now fails directly, since there's no second
hand-written copy of the dispatch logic to go out of sync.

**Why a separate file, not just exported from `MilkdownEditor.tsx`:**
eslint's `react-refresh/only-export-components` rule flagged exporting a
plain function (`buildEditorCommands`) alongside the component in the same
file as a real error (not a style nit) once the extraction was attempted
in-place — Fast Refresh assumes a component file only exports components
(plus types). Moving `buildEditorCommands`/`EditorCommands`/the
list-ancestor helper to `editor-commands.ts` resolved it cleanly;
`MilkdownEditorHandle` (in `MilkdownEditor.tsx`) now `extends
EditorCommands` and adds only `flush()`.

**New/changed tests** (`MilkdownEditor.test.tsx`): the mark-toggle
describe block (renamed to `MilkdownEditorHandle commands needing a real
ranged selection — wired-implementation verification`) now calls
`buildEditorCommands(editor).toggleBold()` /`.toggleItalic()`
/`.insertLink()` instead of raw `callCommand(...)`. Re-verified by
temporarily re-running the reviewer's own mutation (swapping
`toggleStrongCommand` for `toggleEmphasisCommand` inside
`buildEditorCommands`) against the new tests: the `toggleBold` test failed
immediately (`Hello <em>World</em>` where `Hello <strong>World</strong>`
was expected) — confirmed the gap is closed, then reverted the mutation.

## Item 3 (MEDIUM) — switching list type was a silent no-op

**Fixed.** `findAncestorListType` (renamed from `isInListType`,
`editor-commands.ts`) now returns _which_ list type (`'bullet_list'` /
`'ordered_list'` / `null`) the selection is inside, not just whether it
matches one target type. `toggleBulletList`/`toggleOrderedList` now
distinguish three real cases: already the target type → lift out (toggle
off, unchanged from before); inside the OTHER list type → lift out of that
first, then wrap in the target type (new); not in any list → wrap
(unchanged). The two `callCommand` calls for the "switch" case are
dispatched synchronously back to back inside one `editor.action` callback —
verified directly (not assumed) that the second one sees the state the
first one's dispatch just produced, via the new tests described next.

**New tests** (`MilkdownEditor.test.tsx`, through the real mounted
component + ref): `Fix-round: toggleBulletList() SWITCHES an ordered list
to a bullet list (not a silent no-op)` (starts the document already inside
a real `1. Ordered item` ordered list, asserts `toggleBulletList()`
converts it to `<ul><li>` with the `<ol>` gone) and the symmetric
`toggleOrderedList()` test starting from `- Bullet item`. Both pass.

## Item 4 (MEDIUM) — "Normal text" doesn't work, and the code comment's reasoning was wrong

**Fixed, and the incorrect comment corrected** (both in code and here).
Added `setParagraph()` to `MilkdownEditorHandle`/`EditorCommands`:
`editor.action(callCommand(wrapInHeadingCommand.key, 0))` — 3 lines, exactly
as the reviewer said, and verified directly: `wrapInHeadingCommand(0)`
converts to a paragraph **unconditionally**, with no dependency on the
block's current type. The original comment's claim ("no level this toolbar
could safely pass here that's guaranteed to be the right one to clear") was
checking the wrong thing — clearing to a paragraph was never conditional on
knowing the active _heading level_ in the first place; `setParagraph` needs
no such knowledge, unlike `toggleHeading(2)`'s own genuinely-conditional
"is it already an h2" check.

`EditorToolbar.tsx`'s paragraph-style dropdown now calls
`editorRef.current?.setParagraph()` for the "Normal text" option instead of
the previous no-op branch.

**New tests**: `setParagraph() unconditionally converts the current block
to a plain paragraph` (from h1) and `setParagraph() works from a deeper
heading level too (h3), not just h1` (`MilkdownEditor.test.tsx`, through the
real mounted component); `Selecting "Normal text" in the paragraph-style
dropdown calls editorRef.current.setParagraph()` (`EditorToolbar.test.tsx`,
against the fake handle).

**Correction to this report's own earlier text** (original "Deviations"
section, item "The paragraph-style dropdown's 'Normal text' option is a
real `<select>` option but currently a no-op"): that paragraph's stated
reasoning was factually wrong in the same way the code comment was, for the
same reason. Left in place above (not deleted) as an honest record of what
was actually claimed at the time, rather than quietly rewritten; this
addendum is the correction of record.

## Item 5 (MEDIUM) — paragraph-style dropdown gets visually stuck

**Fixed** via the reviewer's second suggested option: restructured as a
stateless action trigger rather than a controlled indicator of live state.
`EditorToolbar.tsx`'s `headingChoice` React state (which controlled the
`<select>`'s `value`) was removed entirely, replaced with a
`headingSelectResetKey` counter used as the `<select>`'s own `key`. Every
`onChange` bumps the counter, forcing React to unmount and remount a
**fresh** `<select>` DOM node (via `defaultValue="paragraph"`, uncontrolled)
after every use. A real browser fires no `change` event when the same
option is re-selected with no other selection in between (the exact bug the
review found) — remounting fresh means the NEXT selection of the same
option is always a genuine value change from the browser's point of view
(`paragraph` → whatever was clicked), not a no-op re-selection.

**Why not "resync to live selection" (the review's first option)**: that
requires building real selection-change subscription/tracking into the
toolbar, which doesn't exist anywhere in this codebase yet (per
`MilkdownEditor.tsx`'s and `EditorToolbar.tsx`'s own module comments, a
separate, larger "bubble menu / active formatting state" feature, out of
scope for this track). The stateless-trigger restructuring fixes the actual
reported bug (silently doing nothing on a legitimate repeat selection)
without requiring that larger feature.

**New test** (`EditorToolbar.test.tsx`): `Fix-round: the paragraph-style
dropdown resets to its default display after each selection, so
re-selecting the same heading level fires again` — selects Heading 2,
asserts the handle was called once, re-queries the (now-remounted) select
and asserts its `.value` reset to `'paragraph'`, selects Heading 2 again,
asserts the handle was called a SECOND time. Note (documented in the test
itself): this environment's own `userEvent.selectOptions` fires a change
event unconditionally even without the remount fix (confirmed by reading
the review's own note that this is exactly why the original bug wasn't
caught by the pre-existing test suite) — so this test verifies the fix
**mechanism** (the DOM node genuinely resets) rather than being able to
reproduce the real browser's exact "no event fires" quirk in this
environment; that's the strongest verification available here, not a
weaker substitute chosen for convenience.

## Item 6 (LOW-MEDIUM) — page break over a selection silently deleted the selection

**Fixed.** `insertPagebreakCommand` (`src/renderer/src/milkdown/commands.ts`)
now collapses the selection to its start first
(`TextSelection.create(state.doc, state.selection.from)`) via
`state.tr.setSelection(...)`, THEN calls `.replaceSelectionWith(...)` on
that now-empty selection — inserting at the collapsed point rather than
replacing whatever range was selected, while still getting
`replaceSelectionWith`'s own block-splitting behavior for a mid-paragraph
insertion point.

**New test** (`MilkdownEditor.test.tsx`, in the "wired-implementation
verification" describe block, since it needs a real ranged selection):
`insertPageBreak() does not delete a non-empty selection -- selected text
survives the insertion` — reproduces the exact reviewer repro ("Hello
World" with "Hello" selected), asserts the pagebreak node is present AND
both "Hello" and "World" are still present in the document afterward.

## Item 7 — LOW cleanups

- **CLAUDE.md store-action deviation**: explicitly documented, in code, at
  the top of `EditorToolbar.tsx`'s own module comment (not just in this
  report) — `window.api.exportPdf`/`useDocumentStore.setState` calls stay
  direct because `documentStore.ts` remains off-limits in this fix round
  for the same reason it was during the original build (owned by a
  concurrent track). Flagged as a required follow-up for whoever integrates
  this component and can touch `documentStore.ts`.
- **Unconditional `error: null` clear on export success**: fixed —
  `handleExportPdf`'s success path no longer touches `documentStore.error`
  at all, so an unrelated pre-existing error (e.g. a failed Save) survives
  an unrelated successful export. New test: `Export PDF success does NOT
clear an unrelated, pre-existing error message`.
- **`aria-pressed="false"` on non-toggle buttons**: fixed —
  `ToolbarIconButton`'s `active` prop no longer defaults to `false`;
  omitting it entirely now omits the `aria-pressed` attribute (React's own
  behavior for `undefined` DOM attribute values). Only genuinely toggleable
  buttons (Bold, Italic, Underline, Bulleted list, Numbered list, Checklist)
  now pass `active={false}` explicitly; one-shot buttons (Undo, Redo, Insert
  link/image/table/split-cell/page-break, Find, Page setup) pass nothing.
  New test: `One-shot action buttons omit aria-pressed entirely; genuine
toggle buttons render it`.
- **Raw IPC error strings shown to users**: fixed — `handleExportPdf`'s
  catch block now logs the real error via `console.error` (for diagnosis)
  and sets a fixed, friendly `documentStore.error` message ("Failed to
  export PDF. Please try again.") instead of the raw
  `err.message`/Electron's own wrapped IPC error string. New test: `Export
PDF surfaces a failure as a friendly message, not the raw IPC error
string`.
- **Inaccurate queue rationale in `pdf-exporter.ts`**: fixed — the comment
  above `exportQueue`/`enqueueExport` no longer claims the queue exists
  because of contention with thumbnail-generator.ts's harness (confirmed
  inaccurate: the two are fully separate instances and cannot race each
  other). It now correctly states the real reason: avoiding several
  back-to-back "Export PDF" clicks spinning up multiple full pagination
  render contexts concurrently for no benefit.

## Fix-round verification output

**`pnpm run typecheck`** — clean, exit 0.

**`pnpm exec eslint .`** (whole repo) — clean, exit 0, zero warnings (this
also caught and required fixing the `react-refresh/only-export-components`
error from Item 2's first extraction attempt, described above).

**`pnpm exec prettier --check`** on every touched/created file — `All
matched files use Prettier code style!`

**`pnpm exec vitest run`** (full unit suite):

```
Test Files  19 passed (19)
     Tests  186 passed (186)
```

(up from 177 before this fix round — 9 net new tests: 4 for item 2's
wired-implementation verification including the new pagebreak-selection
test, 4 for items 3/4's list-switching/setParagraph coverage, plus the
mechanical net effect of consolidating/renaming the mark-toggle describe
block. `EditorToolbar.test.tsx` grew from 15 to 19 tests: `setParagraph`
wiring, the dropdown-reset mechanism, the friendly-error-message rewrite,
the unrelated-error-preservation test, and the aria-pressed distinction
test.)

**`pnpm run build`** — clean: typecheck → electron-vite build →
build:pagination-render, all succeeded.

**`pnpm exec playwright test`** (full `phase0` suite) — **28 passed**,
including all 3 Gate 12 tests and the pre-existing deliberate Gate 10
`test.fail()`. (Two transient, unrelated flakes were observed mid-investigation
in a single run — `Gate 11` (untouched by this track) and `Gate 12`'s first
test both hit `getMainWindow`'s "Timed out locating the main app-shell
window" on the SAME run, after many consecutive real Electron app launches
during the timing investigation above; both passed cleanly on immediate
retry, and 3 subsequent full-suite runs were clean. Not a regression from
this track's changes — noted for transparency, not swept under the rug.)

## One-line test summary (fix-round)

186/186 unit tests pass (up from 177), 28/28 phase0 Playwright gates pass
(3 Gate 12 tests, up from 2), typecheck/lint/prettier/build all clean; PDF
export repeated-export timing confirmed flat (~400ms, no degradation) across
5 independent runs, down from the original ~12x-degrading steady state (and
down from two earlier fix attempts that measured statistically identical
degradation to the original bug before the real root cause was found).

---

# Second fix-round addendum

Re-review came back CHANGES NEEDED, light — and independently confirmed the
PDF-export root-cause diagnosis from the previous addendum: the coordinator's
own message states the reviewer built and measured all four variants
(memoized/fresh harness × mainWindow/hidden-window) themselves and found the
parent window, not harness reuse, is the causal variable — matching this
track's own finding exactly. Two small items were flagged; both fixed and
verified below (not just asserted).

## Item 1 (MEDIUM) — Gate 12's regression guard was weaker than it looked

**Fixed and verified.** `phase0/gate12-pdf-export-ipc.spec.ts`'s guard
changed from `Math.max(first * 5, 5000)` to `Math.max(first * 5, 2000)`. The
review's own finding was exact: a healthy first export (~390-450ms in this
environment) makes `first * 5` land around 2000-2250, so the 5000ms floor
dominated in practice and would not have caught a return of the
"fresh-harness-per-export, but still on mainWindow" (Attempt 1) partial-fix
regression — all three of that attempt's own measured values (488/3584/4392ms)
sit under 5000.

**Verified directly** (not just argued): temporarily reconstructed Attempt
1 in `src/main/pdf-exporter.ts` (a fresh harness per export, but attached to
the real `mainWindow` instead of a dedicated hidden `BaseWindow` — the exact
shape of the previously-tried, previously-measured, non-working fix), backed
up the real fix first, rebuilt, and ran Gate 12's repeated-export test
against it:

```
Gate 12 repeated-export timings (ms): [ 444, 3548, 4324 ]
Error: expect(received).toBeLessThan(expected)
Expected: < 2220
Received:   3548
1 failed
```

The tightened guard correctly fails against this reconstruction (threshold
`max(444*5, 2000) = 2220`, and `3548 > 2220`) — confirming it now catches
the exact class of regression the review was concerned about. The real fix
(dedicated `BaseWindow`) was then restored byte-for-byte (diffed against a
pre-change backup to confirm) and re-verified passing:

```
Gate 12 repeated-export timings (ms): [ 381, 384, 378 ]
3 passed (3.5s)
```

## Item 2 (MEDIUM-LOW) — three command delegations were unverified by any test

**Fixed and verified.** The gap was real and precise: the previous round's
`buildEditorCommands(editor)`-based tests (in the renamed "wired-
implementation verification" describe block) exercise `editor-commands.ts`'s
own internal command wiring directly, but never go through
`MilkdownEditor.tsx`'s `useImperativeHandle` at all — so a wrong delegation
there (e.g. `toggleBold: () => commandsRef.current?.toggleItalic()`) was
invisible to every existing test. This was already covered for
`toggleHeading`/`setParagraph`/both list toggles/`insertTable`/
`insertPageBreak`/`undo`/`redo` via existing mounted-`ref` tests — genuinely
missing only for `toggleBold`, `toggleItalic`, `insertLink`, the three
routed around mounted-`ref` testing in the previous round specifically
because they need a real selection.

**Fix**: three new tests in `MilkdownEditor.test.tsx`'s `MilkdownEditor`
describe block (through the real mounted component + `ref`, not
`buildEditorCommands` directly), using the reviewer's own suggested
mechanism — a COLLAPSED cursor, so no selection-setup problem exists at
all: call `ref.current.toggleBold()`/`.toggleItalic()`/`.insertLink(href)`
(setting a stored mark, since the underlying commands are all `toggleMark`-
backed), then simulate typing one character via the same raw-DOM-mutation
technique this file's existing "real edit" tests already use, and assert
the new character renders wrapped in `<strong>`/`<em>`/a real `<a href>`.

**Empirical groundwork before writing these** (two throwaway scratch tests,
deleted after use): first tried `@testing-library/user-event`'s
`.click()` + `.type()` (the more obvious approach) — this does NOT work in
this environment: it produced plain unmarked text, and separately threw an
uncaught `TypeError` from ProseMirror's own `posAtCoords` during the
`mousedown` handler `user.click()` triggers (jsdom doesn't implement
`document.elementFromPoint`). Second, tried the existing raw-DOM-mutation
"type" technique instead (`p.firstChild.textContent = ...`) — this DOES
correctly pick up the stored mark, confirmed both empirically and by reading
`prosemirror-state`'s own `Transaction.insertText` source (which reads
`this.storedMarks` when constructing the inserted text node, reached via
prosemirror-view's `readDOMChange` → "simply insert text" path for an
inline, same-text-node mutation — exactly the shape this project's existing
edit-simulation technique already produces).

**Verified each of the three new tests actually catches a wrong-delegation
mutation**, reproducing the reviewer's own exact mutation style, one at a
time, each followed by an immediate revert:

- `toggleBold: () => commandsRef.current?.toggleItalic()` → new test failed:
  `expected undefined to be 'X'` (DOM showed `<em>X</em>`, no `<strong>`
  element to query).
- `insertLink: () => commandsRef.current?.toggleBold()` → new test failed
  the same way (DOM showed `<strong>X</strong>`, no `<a>` element).
- `toggleItalic: () => commandsRef.current?.undo()` → new test failed the
  same way (DOM showed plain `HelloX`, no mark at all).

All three mutations were reverted immediately after observing the failure;
`git diff`/`grep` confirmed each delegation line matches its pre-mutation
state before moving on.

## Optional (non-blocking) — `editor.destroy()` moved into `afterEach`

Done, since already in this file. The "wired-implementation verification"
describe block's 4 tests (`toggleBold`, `toggleItalic`, `insertLink`,
`insertPageBreak`) each used to call `await editor.destroy()` as the last
line of their own test body — a real assertion failure earlier in the body
throws before reaching that line, leaking that test's `Editor` instance
(and its `createTestEditor`-appended DOM node) into every later test in the
same file for the rest of the run. Replaced with a shared `currentEditor`
variable, assigned by each test right after `createTestEditor` resolves,
destroyed in a block-level `afterEach` that runs regardless of whether the
test body threw.

## Second fix-round verification output

**`pnpm run typecheck`** — clean, exit 0.

**`pnpm exec eslint .`** (whole repo) — clean, exit 0, zero warnings.

**`pnpm exec prettier --check`** on every touched file — `All matched files
use Prettier code style!`

**`pnpm exec vitest run`** (full unit suite):

```
Test Files  19 passed (19)
     Tests  189 passed (189)
```

(up from 186 — the 3 new collapsed-cursor delegation tests.)

**`pnpm run build`** — clean.

**`pnpm exec playwright test`** (full `phase0` suite) — **28 passed**,
including all 3 Gate 12 tests (now under the tightened 2000ms-floor guard)
and the pre-existing deliberate Gate 10 `test.fail()`.

## Second fix-round one-line summary

189/189 unit tests pass (up from 186), 28/28 phase0 Playwright gates pass;
Gate 12's regression guard tightened from a 5000ms floor to a 2000ms floor
and directly verified to now catch a reconstructed Attempt-1-style ~9x
partial regression (3548ms > 2220ms threshold) while still passing cleanly
against the real fix (381/384/378ms); three new collapsed-cursor tests close
the `useImperativeHandle` delegation gap for `toggleBold`/`toggleItalic`/
`insertLink`, each directly verified against the reviewer's own
wrong-delegation mutation style before being accepted as done.
