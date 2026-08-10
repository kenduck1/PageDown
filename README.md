# PageDown

A page-first Markdown editor for desktop (Electron + React + TypeScript). Pages are the
primary editing unit — like a word processor — but the underlying document is real,
portable Markdown, not a custom markup language and not a continuous-scroll editor that
only paginates at export time. It's built for long-form documents meant to be printed or
exported (reports, résumés, letters) where exact page layout and print fidelity matter.

PageDown is an early-stage desktop app under active development — expect rough edges.
Known gaps worth naming up front: there is **no auto-update mechanism** (builds are not
signed or notarized either), a **never-saved document is not autosaved** — closing prompts
you, but a hard crash before the first save will lose it — and Split mode's editor and
preview panes **do not scroll in sync**.

## What it does

- **Format / Source / Split editing modes** — a WYSIWYG canvas (Milkdown/ProseMirror),
  plain raw-Markdown text editing, and a side-by-side live paginated preview.
- **Real pagination**, powered by Paged.js and rendered inside a sandboxed context, so
  the editor preview and the exported PDF stay pixel-consistent by construction.
- **PDF export and native printing**, both driven through that same pagination render
  context as the live preview.
- **Mermaid diagrams and KaTeX math**, rendered inside the sandboxed context only.
- **GitHub Flavored Markdown**: tables, task lists, footnotes, syntax-highlighted code
  fences.
- **Page Setup**: page size (Letter/A4/Legal/Custom), orientation, margins, header/footer
  content and page numbering, a typography theme, and a font — all stored in the
  document's own YAML frontmatter, so the document stays portable.
- **Comments**, stored inline in the Markdown source via an HTML-comment convention —
  no sidecar file required.
- **Writing tools for people who don't write Markdown by hand**: a formatting toolbar, a
  `/` slash command palette for inserting blocks, a selection bubble menu (including full
  table row/column/alignment editing), and the usual live Markdown input rules.
- **Find & Replace**, autosave with crash recovery and version history, image insertion by
  drag-and-drop or file picker, multi-window support, tabs, an outline sidebar, word and
  character counts, and app-level dark mode (the app chrome only — document content always
  renders light, matching what actually prints).
- **Export to PDF or self-contained HTML**, and native printing. The HTML export embeds its
  own fonts and inlines local images, so the file stands alone.
- **Desktop citizenship**: a real application menu with the shortcuts you'd expect
  (`Cmd/Ctrl+S`, `+O`, `+N`, `+P`, …), `.md` file associations, a single-instance lock,
  persisted window size and position, and a prompt before closing with unsaved work.

See `docs/superpowers/specs/` for the design docs behind these features, and
`CLAUDE.md` for the fuller architectural notes.

## Development

Requires [pnpm](https://pnpm.io) — this repo pins `pnpm@10.30.3` in `package.json`.

```bash
pnpm install
pnpm dev
```

## Building

```bash
pnpm build         # typecheck -> electron-vite build -> pagination-render bundle
pnpm build:mac     # macOS package, via electron-builder
pnpm build:win     # Windows package
pnpm build:linux   # Linux package (AppImage/snap/deb)
```

## Testing

Three separate suites, each covering a different layer:

```bash
pnpm test:unit             # Vitest: fast unit/component tests
pnpm test:phase0           # Playwright: gates against the real built app (engine-correctness checks)
pnpm test:phase1:vitest    # Vitest: gates for the Milkdown/WYSIWYG integration
pnpm test:phase1:playwright
```

`test:phase0` and `test:phase1:playwright` build the app first (via their own `pretest`
hooks, `pnpm run build`) and then drive the real built app with Playwright's Electron
driver — they're slower than `test:unit` and cover things a component test can't (real
pagination timing, the sandboxed render context, real PDF output).

Other useful scripts:

```bash
pnpm typecheck   # tsc --noEmit, main process + renderer (two separate tsconfigs)
pnpm lint        # eslint --cache .
pnpm format      # prettier --write .
```
