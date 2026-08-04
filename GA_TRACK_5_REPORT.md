# Track 5 report: Page Setup modal + surgical frontmatter persistence

## What was built

1. **`src/markdown/page-config.ts`** — the first structured reader/writer for
   PageDown's own YAML frontmatter keys, layered on top of the existing
   opaque-string handling (`remark-frontmatter` / `frontmatterNode`). Exports:
   - `PageConfig` type (and its sub-types `PageSize`, `Orientation`,
     `PageMargins`, `PageFooter`, `PageNumberFormat`, `PageTheme`), exactly the
     shape specified in the task.
   - `DEFAULT_PAGE_CONFIG` — sensible defaults (`Letter`, `portrait`, 1in all
     around, header off / footer on with the `Page {n} of {total}` token,
     `decimal`, `default` theme).
   - `extractPageConfig(rawFrontmatterYaml): Partial<PageConfig>` — read-only,
     uses `js-yaml` (already a pinned dependency) to parse, then picks out
     only the owned keys, falling back to omitting a key (never throwing) on
     malformed YAML or a malformed/wrong-type/out-of-enum individual value.
   - `applyPageConfig(rawFrontmatterYaml, updates): string` — the surgical
     write path. Operates line-by-line on the existing raw text: an owned
     key's existing line (or, for `margins`, its whole indented block) is
     replaced in place; a key that doesn't exist yet is appended at the end.
     Never parses-then-fully-reserializes the whole YAML object.
   - `src/markdown/page-config.test.ts` — 30 tests.

2. **`src/renderer/src/components/PageSetupModal.tsx`** — the modal itself
   (new `components/` directory), plus
   **`src/renderer/src/components/PageSetupModal.test.tsx`** — 9 tests.

Both files are new; nothing else in the repo was modified (confirmed via
`git status` before committing — the only changes are the four new files
above, satisfying the "don't touch EditorScreen/MilkdownEditor/documentStore/
appStore/EditorTabBar/EditorToolbar/EditorOutline/EditorSidebar/
EditorStatusBar/frontmatter.ts" constraint by construction).

## YAML key convention chosen

`phase0/corpus/foreign-frontmatter.md` already established `page:` (bare
scalar page-size name) and `margins:` (bare scalar, e.g. `margins: 1in`) as
the intended key names from earlier design-doc-referenced examples. This
module keeps both names and extends `margins:` to a nested per-side object
(PageConfig needs 4 independent numbers, which a single scalar can't
represent) while still *tolerating* the old bare-scalar form on read as a
"uniform margin on every side" shorthand, so an existing document using it
isn't treated as malformed.

Full convention:

```yaml
page: Letter                # 'Letter' | 'A4' | 'Legal' | 'Custom'
orientation: portrait       # 'portrait' | 'landscape'
margins:
  top: 1
  bottom: 1
  left: 1
  right: 1
header: true                 # showHeader
footer: true                 # showFooter
footerLeft: ""
footerCenter: "Page {n} of {total}"
footerRight: ""
pageNumberFormat: decimal    # 'decimal' | 'roman'
theme: default                # 'default' | 'resume' | 'letter' | 'report'
```

Footer *visibility* (`footer: true/false`) and footer *content*
(`footerLeft`/`footerCenter`/`footerRight`) are deliberately separate flat
top-level keys rather than one nested `footer: {show, left, center, right}`
object: PageConfig itself has no header-content fields (only footer gets an
L/C/R row per the mockup), so nesting would create an asymmetric shape; flat
keys also keep every owned key at most one YAML "block" deep except
`margins`, keeping the line-based surgical mutation simple and predictable.

String values (`footerLeft`/`footerCenter`/`footerRight`) are always
double-quoted on write (via `JSON.stringify`, a safe subset of YAML
double-quoted-scalar escaping) since they're free-form author text that can
legally contain a colon or the literal sequence `---`. Enum-like values
(`page`, `orientation`, `header`, `footer`, `pageNumberFormat`, `theme`) are
written unquoted, matching the existing fixture's own unquoted style.

A document with no existing frontmatter block (`applyPageConfig('', updates)`)
gets a fresh block synthesized with just the provided keys, one per line, in
PageConfig's own field order — wrapping that back in `---` fences and
splicing it into the document is explicitly left to the caller (out of
scope here; this module only ever deals in the raw YAML text, matching
`frontmatterNode`'s own `value`-attribute boundary).

## Component prop interface

```ts
interface PageSetupModalProps {
  open: boolean
  initialConfig: PageConfig
  onApply: (config: PageConfig) => void
  onClose: () => void
}
```

Renders `null` when `open` is false. Draft state re-seeds from
`initialConfig` on every closed→open transition (or if `initialConfig`
itself changes while open) via React's documented render-phase
prev-value-comparison pattern (not `useEffect`, to avoid eslint's
`react-hooks/set-state-in-effect` — calling `setState` inside an effect body
for a plain "adjust state on prop change" case forces an avoidable extra
render). Scrim click, `×`, and Cancel all call `onClose()` only; Apply calls
`onApply(draft)`; clicking inside the dialog body calls `stopPropagation()`
so it never reaches the scrim's handler.

Renders: page-size pills (Letter/A4/Legal/Custom) + orientation toggle,
margins 2×2 numeric grid, header/footer toggle switches (`role="switch"`)
plus a footer Left/Center/Right field row (the Center field renders its
entire text in `text-accent` while its value still contains `{n}`/`{total}`
— a native `<input>` can't color one substring differently from the rest, so
whole-field accent color while a placeholder token is present is the chosen
approximation of the mockup's intent), page-number-format pills, and 4 theme
cards. All styling uses only existing tokens from `base.css`'s `@theme
static` block (`bg-scrim`, `bg-page`, `border-border-subtle`, `text-text-*`,
`bg-accent`/`text-accent`, `shadow-modal`, `shadow-glow-accent`, `shadow-flat`,
`rounded-lg`, etc.) — no hardcoded hex values anywhere in the component.

A real, reactive live-preview column (230px, matches the mockup's spec) shows
a miniature page whose dashed margin inset, header/footer text, and resolved
`{n}`/`{total}` sample tokens (formatted per the selected `decimal`/`roman`
format, using a small `toRoman` helper) all genuinely reflect the current
draft state — not a static image.

## Documented simplifications (given time constraints, stated explicitly)

- Theme cards use small static CSS "line-drawing" bars (`ThemeGlyph`) rather
  than the Home screen's live-rendered-thumbnail convention (`TemplateCard`
  in `HomeScreen.tsx`, which calls `getTemplateThumbnail` through real IPC
  into the main-process pagination harness). This keeps the component
  Electron-free and directly unit-testable; wiring live thumbnails in later
  would not require any prop/behavior change.
- The orientation toggle is text-only (Portrait/Landscape), omitting the
  mockup's small icon glyphs — not load-bearing for a first functional pass.
- The theme card literally named "Letter" collides with the page-size pill
  also named "Letter"; disambiguated with `aria-label="Theme: Letter"` (etc.)
  on the theme cards, visible text unchanged.

## Explicit limitation — restated per the task's requirement

**Changing any setting in this modal has NO visible effect on the pagination
preview or the exported PDF today.** The sandboxed pagination render context
(`resources/pagination-render/index.ts`) calls
`previewer.preview(container, [], root)` with a hardcoded empty stylesheet
array — it does not accept `@page` CSS (page size, margins, headers/footers)
from ANY document yet, not just ones edited through this modal. Teaching
that render context to accept real `@page` CSS is separate, larger,
out-of-scope work. What IS real and shipped here: the settings genuinely
persist to the document's YAML frontmatter via `applyPageConfig` (once a
future track wires this modal's `onApply`/`initialConfig` up to
`documentStore`/`EditorScreen`, which this task deliberately does not do —
those files are owned by other concurrent tracks per the task's explicit
constraints) — the persistence layer itself is real, tested, and not a
stub. This limitation is also stated in `PageSetupModal.tsx`'s own file-level
doc comment.

## Deviations from the task's literal wording

- The task's `PageConfig` type, prop interface, and function signatures were
  followed verbatim; no deviation there.
- No new dependency was added — `js-yaml` was already pinned in
  `package.json` and ships its own TypeScript types.
- Not wired into `EditorScreen`/`appStore`/`documentStore` — per the task's
  own explicit "do NOT modify" list for those files, this is intentional
  scope, not an oversight.

## Verification commands run (this worktree)

```
$ pnpm exec eslint src/markdown/page-config.ts src/markdown/page-config.test.ts \
    src/renderer/src/components/PageSetupModal.tsx src/renderer/src/components/PageSetupModal.test.tsx
(no output — clean)

$ pnpm run typecheck
> tsc --noEmit -p tsconfig.node.json --composite false
> tsc --noEmit -p tsconfig.web.json --composite false
(both clean, no output)

$ pnpm test:unit
 Test Files  20 passed (20)
      Tests  192 passed (192)

$ pnpm exec prettier --check src/markdown/page-config.ts src/markdown/page-config.test.ts \
    src/renderer/src/components/PageSetupModal.tsx src/renderer/src/components/PageSetupModal.test.tsx
Checking formatting...
All matched files use Prettier code style!

$ pnpm run lint   # full eslint --cache . over the whole repo
(no output — clean)

$ git status
Untracked files: src/markdown/page-config.test.ts, src/markdown/page-config.ts,
                  src/renderer/src/components/  (PageSetupModal.tsx + .test.tsx)
(nothing else modified)
```

## Test summary

34 new tests, all passing: 30 in `src/markdown/page-config.test.ts`
(extraction validity/malformed-fallback/legacy-shorthand/adversarial-quoting
cases; write-path exact-string round-trip/preserve-ordering/append/
missing-frontmatter/trailing-newline/adversarial-quoting cases) + 9 in
`src/renderer/src/components/PageSetupModal.test.tsx` (pre-fill from
`initialConfig`, draft-only field edits, Apply payload correctness, Cancel/
`×`/scrim close without Apply, click-inside-dialog not bubbling to scrim,
re-seed-on-reopen). Full existing suite (`pnpm test:unit`) still passes at
192/192 — no regressions.
