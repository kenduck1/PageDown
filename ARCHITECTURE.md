# Architecture

Orientation for anyone working on PageDown. It covers the decisions that are
hard to infer from the code, and the invariants that are easy to break without
getting an error.

> **A note on in-code references.** Many source comments point at
> `CLAUDE.md` or `docs/superpowers/…`. Those are internal working documents —
> a candid engineering log and the per-sub-project design specs — and they are
> not part of the public repository. This file is their contributor-facing
> distillation. A dangling reference in a comment is not a missing file in
> your checkout.

## The premise

PageDown is a page-first Markdown editor. Pages are the primary editing unit,
the way they are in a word processor — not a continuous scroll that only
paginates at export time. The underlying document is nevertheless real,
portable Markdown: no custom markup language, no sidecar files.

That combination is the whole design problem. Everything below follows from
it:

- **Anything the app adds must survive a round trip through other Markdown
  tools.** Page configuration lives in YAML frontmatter. Page breaks,
  comments, tables of contents and image sizing use HTML-comment or
  attribute-block conventions that other renderers ignore harmlessly.
- **The editor and the paginated output must agree.** If the WYSIWYG canvas
  and the exported PDF disagree about where page 2 begins, the product has no
  reason to exist. This is enforced by a shared stylesheet and a gate that
  measures both surfaces (see [Typography parity](#typography-parity)).
- **Document content is untrusted.** A `.md` file can come from anywhere and
  can contain raw HTML. It is rendered in a sandboxed context with no
  filesystem or IPC reach (see [Security model](#security-model)).

## Repository layout

```
src/main/          Electron main process — lifecycle, windows, file I/O,
                   harness management, export, printing
src/preload/       contextBridge surface (the typed `window.api`)
src/renderer/      The React app shell — all UI
src/markdown/      The Markdown pipeline (parse, render, frontmatter, plugins)
src/typography/    Shared page geometry, document styling, the stylesheet
                   BOTH rendering surfaces consume
src/pagination/    Pagination helpers shared with the sandboxed context
src/export/        PDF / HTML / DOCX export
resources/         The sandboxed pagination render context (built separately)
phase0/            Playwright gates against the real built app
phase1/            Frozen Milkdown feasibility-spike gates
```

## Execution contexts

There are **three** distinct runtime contexts. Know which one a file belongs
to before editing it — they have very different capabilities.

### 1. Main process (`src/main/`)

Full Node and Electron privileges. Owns windows, file I/O, the render
harnesses, export and printing.

### 2. Renderer / app shell (`src/renderer/`)

The React UI. Runs with `contextIsolation: true` and `nodeIntegration: false`,
and reaches the main process only through the typed `window.api` bridge
defined in `src/preload/`.

Note that `contextBridge.exposeInMainWorld` **deep-freezes** what it exposes:
every method on `window.api` is non-writable and non-configurable. You cannot
spy on or stub it from renderer-side test code.

### 3. Pagination render context (`resources/pagination-render/`)

A **sandboxed, separate-origin** context with **zero IPC and zero
contextBridge access**, served from a registered custom scheme
(`pagedown-render://`) rather than an in-page iframe. It runs Paged.js,
Mermaid and KaTeX against untrusted document HTML.

This is deliberate defense in depth. Rendering a document's HTML in a context
that also had disk access would turn a hostile `<img onerror>` into a local
file read/write, not merely XSS.

Several harnesses use this context, all serving the same bundle:

| Harness                   | Purpose                   | Visibility                 |
| ------------------------- | ------------------------- | -------------------------- |
| `thumbnail-generator.ts`  | Home-screen thumbnails    | Off-screen                 |
| `page-count-generator.ts` | Status-bar page count     | Off-screen                 |
| `pdf-exporter.ts`         | PDF export and printing   | Off-screen, fresh per call |
| `split-preview-window.ts` | Split mode's live preview | **Visible**, long-lived    |

> **The render context handles exactly ONE in-flight request at a time.**
> It tracks the active request in a single module variable and discards a
> result whose request has been superseded. A second `sendDocument` dispatched
> before the first completes silently drops the first, and its caller then
> spins to its own timeout. Every concurrent caller must serialize itself —
> see `enqueueHarnessWork` in `thumbnail-generator.ts` and
> `enqueueSplitPreviewWork` in `src/main/index.ts` for the two existing
> queues. Do not assume a new concurrent caller will "just work".

> **A `WebContentsView` composites above ALL DOM, unconditionally** —
> including modals. Split mode's preview will cover any overlay that shares
> its screen area. `PageSetupModal` works around this by reporting a
> zero-size rectangle for the preview while it is open. Anything new that can
> float over the editor needs the same treatment, or it must be a **layout
> row** rather than an overlay (which is why `FindBar`, `CommentComposer` and
> `RemoteImageBanner` are all rows).

## Security model

See [SECURITY.md](SECURITY.md) for reporting. The boundaries themselves:

**Untrusted document content never runs privileged.** Mermaid and KaTeX render
only inside the sandboxed context. The app-shell renderer never renders
either.

**Renderer-supplied paths are allowlisted.** Any `file:*` IPC handler that
accepts a path from the renderer must validate it with `isKnownPath()`
(`src/main/recent-files.ts`). A path is "known" only if it came from a real
native dialog or is already in the persisted recents allowlist. Two real
vulnerabilities — arbitrary file read via `openPath`, arbitrary write via
`save` — existed before this check. There is a fourth trust source: a path
delivered by the OS via file association, which is unforgeable by a renderer.

**Local assets resolve only through a per-call token registry.** The
`pagedown-render://` protocol handler symlink-resolves both sides with
`fs.realpath`, denies absolute paths and `..` escapes, enforces a size cap via
`stat` before reading, sniffs real magic bytes rather than trusting the
extension, and serves with `nosniff` and a restrictive CSP. Denials return a
single undifferentiated `null` so a hostile document gets no filesystem
oracle.

**Remote images are blocked by default, per document.** `http`/`https` are in
`hast-util-sanitize`'s own default `src` allowlist, so blocking is done
explicitly in the pipeline, after sanitization. Consent is per-tab and
session-only. The sandboxed context's `img-src` permits remote URLs as a
coarse backstop only — a render without consent contains no remote `src` at
all, so there is nothing for it to permit. `connect-src` stays `'none'`.

## The Markdown pipeline

`src/markdown/pipeline.ts`.

**One parser everywhere.** `unified` + `remark-parse` / `remark-gfm` /
`remark-frontmatter` / `remark-math` / `remark-rehype` / `remark-stringify`,
with every stringify option pinned explicitly. Do not introduce a second
Markdown parser for any surface that renders a document — two parsers mean the
preview, the PDF and the editor can disagree about what a document _means_.

(`src/renderer/src/lib/markdown-source-tokens.ts` is a line-oriented scanner
used for Source-mode syntax colouring. It never produces document HTML and its
output is discarded when you leave Source mode, so it is not a second parser
in the sense that matters. It exists because reusing remark's positions
measured 72ms on an ordinary document, on every keystroke.)

### Ordering rules that are easy to break silently

The pipeline runs `sanitize()` over the whole tree in one pass, and **three
things must run after it**:

1. **Local image `src` rewriting.** `hast-util-sanitize` pins `protocols.src`
   to `http`/`https`, so a `pagedown-render://` URL inserted _before_
   sanitization is stripped and the feature silently does nothing. Do not
   "fix" this by allowlisting the scheme — that would let a document's own raw
   HTML mint asset URLs.
2. **Remote image policy.** Running after sanitization means it also catches a
   remote `<img>` written as raw HTML, not only one from `![]()` syntax.
3. **`rehype-highlight`.** Its `hljs` classes would not survive the sanitize
   schema, so running afterwards avoids widening the allowlist.

### Raw HTML

`remark-rehype` runs with `allowDangerousHtml: true`, `hast-util-raw`
reassembles the whole tree into one HTML string and re-parses it, and only
then is the entire tree sanitized in one pass. Per-node sanitization was tried
and reverted: CommonMark can split one logical raw-HTML tag across sibling
mdast nodes (`<span>text **bold** more</span>` parses as three siblings), so
resolving a split tag requires the whole document at once.

### The page-break marker

`<!-- pagebreak -->` becomes a `<div class="pagedown-pagebreak">`. Two
non-obvious details:

- **The sanitize exception matches a per-render random token, not the public
  class name.** Otherwise a document's own raw HTML could type
  `<div class="pagedown-pagebreak">` and forge a real page break in someone
  else's document. A fresh token is generated per call, after the source is
  fixed, and string-replaced back to the public class name at the end.
- **Its CSS rule is the one rule in `document-typography.css` NOT scoped under
  `.pagedown-document`, and it must stay that way.** Paged.js's `Breaks`
  handler intercepts `break-after` while parsing the stylesheet, deletes it
  from the CSS, and re-applies it against the content _fragment_ being
  chunked — which has no `<body>` and therefore no `.pagedown-document`
  ancestor. A scoped selector matches nothing there and the break silently
  never happens. Any future rule whose property Paged.js pre-processes
  (`break-before`, `break-inside`, `string-set`, …) needs the same treatment.

## Pagination and page geometry

Paged.js runs inside the sandboxed context. A document's own frontmatter drives
every rendering surface:

- `resolvePageConfig(source)` (`src/markdown/page-config.ts`) is the one way to
  get a `PageConfig` out of raw Markdown. Use it rather than hand-rolling
  extract-plus-spread — it merges over `DEFAULT_PAGE_CONFIG`, which is what
  stops a document specifying only `page: A4` from reading `.top` off
  `undefined`.
- `computePageGeometry(config)` (`src/typography/page-geometry.ts`) turns that
  into real pixel geometry. **It clamps margins**, and that clamp is a safety
  guard rather than validation: frontmatter is hand-editable and untrusted, and
  a plausible typo (`6` instead of `0.6`) yields negative content height, which
  makes Paged.js emit roughly one page per source node with the whole document
  duplicated on each — thousands of pages, indistinguishable from a hang. The
  clamp lives in this one pure function precisely because all five consuming
  surfaces route through it, where an input `min`/`max` would cover exactly one
  entry point.
- `resolveDocumentStyle(config)` (`src/typography/document-style.ts`) does the
  same for the non-geometric half: theme, font, running header/footer.

> **`page-geometry.ts` and `document-style.ts` must import `PageConfig` with
> `import type`.** Both are bundled into the sandboxed context; a runtime
> import would drag `unified`, `remark-parse` and `remark-frontmatter` into the
> one context that deliberately renders untrusted HTML. The tempting change
> that breaks this is importing `DEFAULT_PAGE_CONFIG` for a default parameter
> value — it compiles, passes every test, and only shows up as a bigger bundle
> nobody diffs.

Running header/footer content is CSS-escaped at the source
(`escapeCssString`), because it comes from hand-editable frontmatter and lands
inside a CSS string literal. Paged.js margin boxes render _inside_ the page
margin and consume zero content space, so enabling a header cannot change page
counts.

## The editor

`src/renderer/src/milkdown/`. Milkdown (ProseMirror) provides the Format-mode
WYSIWYG canvas. `@milkdown/react` is deliberately not a dependency; the mount
lifecycle is hand-rolled in `MilkdownEditor.tsx`.

**Data flow is one-directional.** `documentStore.content` seeds
`defaultValueCtx` at construction only — the editor is uncontrolled after
mount. Edits flow back out through `listenerCtx.markdownUpdated`.

> **`markdownUpdated` is debounced ~200ms and is not synchronous with the
> edit.** Clicking Save immediately after typing used to save the file
> _without_ the edit. `MilkdownEditorHandle.flush()` exists to bypass the
> debounce and is called before Save, before Home navigation, and on unmount.
> Milkdown's own `destroy()` calls the debounced handler's `.cancel()`, not
> `.flush()`, so without this an edit made within the debounce window is
> simply lost. Any timing-sensitive code near an edit needs to account for
> this.

**Loading a different document remounts the editor** via a `revision` counter
used as a React `key`. ProseMirror has no first-class "replace the whole
document" operation, so destroy-and-recreate is the mechanism.

**Accepted characteristic, not a bug:** the first real edit to a document
normalizes the whole file to Milkdown's canonical Markdown form (bullet style,
emphasis markers, fence style, trailing newline) on the next flush — not just
the edited region. An untouched document's bytes are preserved exactly; an
edited one is not guaranteed byte-identical outside the edit. This is inherent
to WYSIWYG over Markdown.

### View modes

`ViewMode` is `'format' | 'split' | 'source'`. Split mode's left pane is
independently Format or Source (`splitLeftMode`).

Mode transitions go through `EditorScreen`'s `handleSetViewMode`, never the
bare `setViewMode` — the transitions need flush/remount coordination with the
live Milkdown instance. Source mode is a plain, fully controlled `<textarea>`
(deliberately not CodeMirror: the point is showing the file as it actually is),
and its `value={content}` binding must stay genuinely controlled, because
external rewrites (History restore, Page Setup apply) land through the store.

## Typography parity

The single most important invariant in the codebase.

`src/typography/document-typography.css` is shared verbatim by **both**
rendering surfaces: the Milkdown mount and the sandboxed context's `<body>`.
`phase0/gate10-editor-layout-parity.spec.ts` measures per-block position
deltas between them and asserts **0.000px** drift.

Three rules follow:

1. **Every selector is scoped under `.pagedown-document`**, which both surfaces
   carry independently. Unscoped tag selectors were found bleeding into
   unrelated app chrome (Home screen headings rendering serif, modal headings,
   sidebar list margins). The page-break rule is the one documented exception,
   for the reason given above.
2. **Name the element, or it silently diverges.** The file is an allowlist,
   and anything it forgets falls through to the app shell's Tailwind Preflight
   on one surface and Chromium's UA defaults on the other. Lists once rendered
   with no bullets in the editor and UA bullets in the preview.
3. **Any new `var(--…)` must be added to the sandbox's own `:root` block**
   in `resources/pagination-render/index.ts`. That context has no Tailwind and
   no `base.css`. An unresolved `var()` is invalid-at-computed-value-time, and
   because `font-size` and `font-family` inherit, it silently takes the nearest
   ancestor's value instead of erroring. `src/typography/document-typography.test.ts`
   cross-checks all three files mechanically so this fails at `pnpm test:unit`.

**Editor-only styling — Find highlights, comment marks, page-break guides,
Source-mode colouring — belongs in `base.css`, never in the shared file.**
That file feeds the sandboxed context, and an exported PDF renders the
document, not a view of it.

**Fonts are bundled, never fetched.** Source Serif 4, Inter and Source Code Pro
are vendored under `src/renderer/src/assets/fonts/`. An unbundled system font
stack makes text metrics — and therefore page counts — depend on what is
installed on the machine, which undercuts the whole determinism argument. The
sandbox emits exactly the faces a given document needs, because Paged.js's
`Chunker.flow()` awaits _every_ registered `FontFace` regardless of use.

## State management

Zustand, in separate stores by concern:

- `appStore` — per-window UI state (`screen`, `viewMode`, `sidebarTab`,
  `splitLeftMode`, `splitRatio`, `zoom`).
- `documentStore` — tabs, content, file paths, dirty state. Encapsulates every
  `window.api` call; screens call its actions rather than the bridge directly.
- `findStore`, `preferencesStore` — as named.

The per-tab versus per-window split is deliberate. `currentPage` is per-tab
(structural reset via a new tab object, never a timing-based effect).
`viewMode` and `zoom` are per-window: view mode is reported to the main
process as window state and drives the application menu, and Split's preview
is one native view per window, so "two tabs in different view modes" has no
representable meaning.

## Build system

`pnpm build` = `typecheck` → `electron-vite build` → a separate esbuild step.

**The pagination render context is built by `scripts/build-pagination-render.ts`,
not by electron-vite.** electron-vite pins its renderer config's Vite root to
`src/renderer`, which is wrong for a second, independent HTML entry point.
Do not try to fold this into `electron.vite.config.ts`.

> **The `externalizeDeps.exclude` trap.** electron-vite externalizes every
> `package.json` dependency in the main-process build, emitting a raw
> `require(...)`. ESM-only packages (`unified`, every `remark-*` / `rehype-*`)
> break silently under Node's `require(esm)` interop: the call succeeds but
> returns the namespace object instead of the default export, and it only
> fails when the **compiled** `out/main/index.js` actually runs. Vitest's own
> transform resolves these correctly regardless, so such a bug passes every
> test. **Any new ESM-only dependency imported from main-process code must be
> added to the exclude list.** CI compiles on all three platforms specifically
> to catch this class of bug.

A related build-layer gotcha: `.css?asset` does **not** work in the main
build — Vite's CSS plugin intercepts the specifier ahead of the asset plugin.
Use `?raw` with an ambient type declaration.

## Testing

Three suites with different purposes. Do not blur them.

| Command              | What it is                                                           |
| -------------------- | -------------------------------------------------------------------- |
| `pnpm test:unit`     | Vitest + jsdom. Fast unit and component tests.                       |
| `pnpm test:phase0`   | Playwright driving the **real built app**. Engine-correctness gates. |
| `pnpm test:phase1:*` | Frozen Milkdown feasibility-spike gates.                             |

**`phase0` gates exist for things no component test can reach**: real
pagination timing, the sandboxed render context, real PDF output, real
keyboard dispatch through Chromium, and anything requiring a layout engine
(jsdom has none — it can assert a component received `style={{width: 794}}`,
never that anything is 794 real pixels wide).

**Every gate that launches the app must go through `launchIsolatedApp`**
(`phase0/electron-launch.ts`), never a bare `_electron.launch()`. A bare launch
inherits Electron's default userData path — the same directory a developer's
real app instance uses — and will read and write your actual recents list and
thumbnail cache. This is a hard rule because it has already broken a real
install once.

**Some `phase1` gates fail on purpose.** Their failure _is_ the recorded
finding from a feasibility spike that is now frozen. Do not "fix" them by
loosening assertions.

**Write assertions that cannot pass vacuously.** The clamp checks in Gates 28
and 29 assert _both_ that the unclamped position would have overlapped _and_
that the clamped one does not. Widening the window far enough makes the first
half fail loudly rather than the second half pass silently. Any assertion of
the form "X is inside Y after an adjustment" should carry its own
would-have-failed-without-it half.

**Reading a gate failure:** a bare `Test timeout` plus `Worker teardown
timeout` that reaches no assertion is a known environmental flake under host
contention (measured around 25–33%, confirmed by A/B against an unmodified
build). A **named** assertion failure is a real regression. That distinction
matters; do not collapse it into "the gates are flaky".

## Deliberate non-goals

Recorded so they are not mistaken for oversights:

- **Track changes.** Cannot be represented portably in plain Markdown without
  a sidecar. (Comments _can_, and are built, using an HTML-comment convention.)
- **Auto-update.** `publish: null` is the honest state. A real updater needs a
  release host, code signing _and_ notarization, and an update UI. A broken
  updater is worse than a documented absence.
- **Incremental re-layout.** Split mode does a full re-layout per settled
  edit, debounced at 500ms. Roughly 170ms for a 20-page document, ~2.5s for 300. Fine for the reports-and-letters use case this app targets, degrading
  for true long-document live editing. A checkpoint-resume engine was proven
  feasible but requires a DOM-splicing layer over undocumented Paged.js
  internals.
- **Live syntax highlighting in the Format-mode canvas.** Code blocks get a
  real box but no token colour; that needs a CodeMirror node view or a
  decoration-based highlighter re-run per transaction.
- **Autosave for never-saved documents' version history.** Untitled documents
  _are_ crash-protected via a separate draft store, but version history is
  keyed on canonical file path and a path-less document has no such key.
- **Full RTL/CJK.** A document-level `direction:` frontmatter key gives basic
  RTL; vertical writing and CJK justification are out of scope.
