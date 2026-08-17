# Changelog

Notable changes per release. Dates are release dates, not development dates.

This project is pre-1.0: minor versions may contain breaking changes, and the
Markdown a document round-trips to is not yet frozen (see the note on
normalisation under 0.1.0).

## 0.1.0 — 2026-08-16

First public build. PageDown has been in development for some time; this is the
first version packaged for download rather than run from source.

### Editing

- Three modes — **Format** (WYSIWYG canvas), **Source** (raw Markdown), and
  **Split** (editor plus live paginated preview).
- Real page boundaries drawn in the Format canvas, recovered from the same
  pagination engine that produces the PDF rather than computed separately.
- Formatting toolbar, `/` slash palette, selection bubble menu with table
  row/column/alignment editing, Find & Replace, and inline comments stored in
  the Markdown itself.
- Tabs, multiple windows, outline sidebar, word and character counts.

### Layout

- Page size (Letter, A4, Legal, Custom), orientation, per-side margins.
- Running headers and footers with real page numbering, rendered on every
  surface including the editor canvas.
- Typography themes and document fonts, with bundled OFL typefaces so text
  metrics — and therefore page counts — do not vary by machine.
- Page breaks, table of contents with real page numbers, image sizing and
  drag-to-resize.

### Output

- PDF export and native printing, both driven through the same render context
  as the live preview.
- Self-contained HTML export with embedded fonts and inlined local images.
- Word (`.docx`) export.

### Safety

- Autosave with crash recovery and version history for saved documents; a
  separate draft store protects never-saved documents.
- Prompts before closing or quitting with unsaved work.
- External-change detection on save, so two windows editing one file cannot
  silently clobber each other.
- Document content renders in a sandboxed, separate-origin context with no IPC
  or filesystem access. Remote images are blocked by default per document.

### Known limitations

- **Builds are unsigned.** macOS Gatekeeper and Windows SmartScreen will warn on
  first launch; the README documents the exact steps.
- **No auto-update.** Watch releases for new versions.
- **The first edit to a document normalises its whole Markdown file** to the
  editor's canonical form — bullet style, emphasis markers, fence style, a
  trailing newline. An untouched file's bytes are preserved exactly; an edited
  one is not guaranteed byte-identical outside the edit. Inherent to WYSIWYG
  over Markdown.
- **Split mode re-paginates the whole document per settled edit.** Around 170ms
  for 20 pages, ~2.5s for 300 — fine for reports and letters, degrading for
  very long documents.
- Orphan and widow control is not implemented.
- Split mode's two panes follow each other by page rather than scrolling in
  exact sync, and can drift on documents with heavy break avoidance.
