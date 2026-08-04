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

| Method | Underlying command(s) | Source package |
|---|---|---|
| `toggleBold` | `toggleStrongCommand` | `@milkdown/preset-commonmark` |
| `toggleItalic` | `toggleEmphasisCommand` | `@milkdown/preset-commonmark` |
| `toggleHeading(level)` | `wrapInHeadingCommand` (level, or `0` for "already this level → back to paragraph") | `@milkdown/preset-commonmark` |
| `toggleBulletList` | `wrapInBulletListCommand` / `liftListItemCommand` | `@milkdown/preset-commonmark` |
| `toggleOrderedList` | `wrapInOrderedListCommand` / `liftListItemCommand` | `@milkdown/preset-commonmark` |
| `insertLink(href)` | `toggleLinkCommand` (`{ href }`) | `@milkdown/preset-commonmark` |
| `insertTable` | `insertTableCommand` (`{ row: 2, col: 2 }`) | `@milkdown/preset-gfm` |
| `insertPageBreak` | `insertPagebreakCommand` (new, this project's own) | `src/renderer/src/milkdown/commands.ts` |
| `undo` / `redo` | `undoCommand` / `redoCommand` (new, wrapping `prosemirror-history`'s own `undo`/`redo`) | `src/renderer/src/milkdown/commands.ts` |

### Key findings from empirical verification

- **`wrapInHeadingCommand`/`wrapInBulletListCommand`/`wrapInOrderedListCommand` are NOT toggles by themselves** — confirmed by reading each package's real TS source (`node_modules/.pnpm/@milkdown+preset-commonmark@7.21.3/.../src/node/heading.ts`, `bullet-list.ts`, `ordered-list.ts`). `wrapInHeadingCommand` always `setBlockType`s to the given level; `wrapIn*ListCommand` always calls ProseMirror's plain `wrapIn`. `toggleHeading`/`toggleBulletList`/`toggleOrderedList` add the actual toggle logic themselves: `toggleHeading` inspects `view.state.selection.$from.parent` and calls `wrapInHeadingCommand` with `0` (documented paragraph-fallback behavior) if the block is already that heading level; `toggleBulletList`/`toggleOrderedList` walk selection ancestors (`isInListType` helper) and call the new `liftListItemCommand` instead of wrapping if already inside that list type.
- **`prosemirror-history` was not wired into this project at all before this task** — confirmed by reading both presets' `composed/plugins.ts` (neither references `history`). Added via `commands.ts`'s `historyProse` plugin (`$prose(() => history())`) plus `undoCommand`/`redoCommand` (`$command` wrapping `prosemirror-history`'s own `undo`/`redo`, which are already `Command`-typed — no extra wrapping needed). **Re-verified, per `MilkdownEditor.tsx`'s own pre-existing comment that explicitly flagged this as required "if undo/redo is added later"**: read `prosemirror-history`'s real source (`histTransaction` in its `dist/index.cjs`) and confirmed its undo/redo transactions never set `addToHistory: false` on themselves — so `editedTrackerProse`'s existing `addToHistory !== false` filter still correctly treats a document-changing undo/redo as a real edit.
- **jsdom's Selection/Range API does not sync into ProseMirror's `state.selection`** — verified with a throwaway scratch test (deleted after use): setting a real, non-collapsed `Range`/`Selection` over existing rendered text left `state.selection` collapsed at its original position regardless. Setting the selection via a direct `view.dispatch(tr.setSelection(...))` **does** work and correctly drives `toggleMark`-backed commands. This directly shaped the test strategy (below) and is documented in-line in the test file.
- `insertTableCommand`'s `row` parameter counts the header row (confirmed by reading `@milkdown/preset-gfm`'s `createTable` helper source) — `{ row: 2, col: 2 }` is genuinely a minimal 2×2 table (one header row, one body row), not 2 body rows.

### Tests (`MilkdownEditor.test.tsx`)

Two new `describe` blocks, extending the file's existing patterns:

1. **`MilkdownEditorHandle mark-toggle commands — API pattern verification`** (new, mirrors the file's pre-existing "listener plugin" raw-`Editor` verification block) — for `toggleBold`/`toggleItalic`/`insertLink`, since these need a real *ranged* selection (jsdom can't produce one — see above). Builds a raw `Editor` with the exact shipped plugin composition (`EDITOR_SCHEMA_PLUGINS` + `EDITOR_COMMAND_PLUGINS`, imported, not hand-copied), dispatches a real `TextSelection` transaction, then calls `editor.action(callCommand(...))` — the exact mechanism the handle methods wrap — and asserts real `<strong>`/`<em>`/`<a href>` in the rendered DOM, both applying and (for bold/italic) removing the mark.
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
  to a paragraph when called with the level that's *already* active, and
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
