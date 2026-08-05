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

39 new tests, all passing (30 + 9 — corrected; see the fix-wave addendum below
for counts after the subsequent review round): 30 in `src/markdown/page-config.test.ts`
(extraction validity/malformed-fallback/legacy-shorthand/adversarial-quoting
cases; write-path exact-string round-trip/preserve-ordering/append/
missing-frontmatter/trailing-newline/adversarial-quoting cases) + 9 in
`src/renderer/src/components/PageSetupModal.test.tsx` (pre-fill from
`initialConfig`, draft-only field edits, Apply payload correctness, Cancel/
`×`/scrim close without Apply, click-inside-dialog not bubbling to scrim,
re-seed-on-reopen). Full existing suite (`pnpm test:unit`) still passes at
192/192 — no regressions.

---

## Fix-wave addendum: review round 2 (CHANGES NEEDED → resolved)

Commit before this fix wave: `b8361c4cc04d1ff7c1c0c6908484105505e7a805`.

Review came back with two critical, independently-demonstrated data-
corruption bugs in `applyPageConfig`, plus two smaller items. All four are
fixed below; the optional lower-priority item was also addressed.

### Bug 1 (Critical) — indented comment after an owned key was deleted

**Confirmed repro** (reviewer's exact case, verified against real `js-yaml`
before fixing): the original block-boundary scan treated *any* line
indented deeper than column 0 immediately following an owned key's own line
as part of that key's value — so a YAML comment merely indented for
readability (not actually nested under the key) was silently swallowed and
deleted on the next unrelated write to that key. Reproduced for both a plain
scalar key (`theme:`) and the legacy `margins: 1in` shorthand, exactly as
reported.

**Fix**: replaced the "any indented line continues the block" rule with a
structural check (`STRUCTURAL_CONTINUATION` in `src/markdown/page-config.ts`)
that only treats a line as a genuine continuation if it's actually a nested
mapping entry (`  key: value` / `  key:`) or sequence item (`  - value` /
`  -`) — never a bare comment or blank line. A comment/blank line is only
swallowed if it's interior to a real continuation run (more structural lines
follow after it); a trailing comment with nothing structural after it is
left untouched. This is implemented in the new `findBlockEnd`/
`isCommentOrBlankLine` helpers, which replace the old inline `while
(/^[ \t]/.test(...))` loop.

**New regression tests** (`src/markdown/page-config.test.ts`):
- `regression (Bug 1): preserves an indented comment directly beneath a scalar key being rewritten`
- `regression (Bug 1): preserves an indented comment directly beneath the legacy bare-scalar margins shorthand`
- `regression (Bug 1): a comment genuinely interior to a nested block is not left as an orphaned duplicate` (documents the accepted narrower trade-off: a comment truly *inside* a multi-line block like `margins` doesn't survive that key's own rewrite, but no corruption/duplicate-key result is left behind either)

### Bug 2 (Critical) — `key : value` (space before colon) caused duplicate keys

**Confirmed repro** (verified `yaml.load('page : Letter\ndraft: true')` →
`{page: "Letter", draft: true}` before fixing, matching the reviewer's
claim): the key-matching regex was the unspaced `^key:`, so an existing
`page : Letter` key was never found, and a second `page: ...` line was
appended instead — producing a duplicate mapping key. `js-yaml` throws on
duplicate keys, so the very next `extractPageConfig` call on that corrupted
block returned `{}`, silently reverting every owned key to defaults.

**Fix**: the matcher is now `` `^${key}[ \t]*:` `` (tolerates any amount of
whitespace before the colon), so an existing key in this form is found and
replaced in place instead of duplicated.

**New regression tests**:
- `regression (Bug 2): finds and replaces an existing key written with whitespace before the colon, instead of duplicating it` — asserts exactly one `page` key in the output and that `extractPageConfig` no longer throws/reverts to defaults afterward
- `regression (Bug 2): whitespace-before-colon also works for the margins block anchor line`

### Item 3 — UI honesty gap (fixed)

`src/renderer/src/components/PageSetupModal.tsx` now renders a real, always-
visible notice banner directly beneath the header row (outside the
scrollable settings column, so it can't be scrolled out of view): "These
settings are saved to the document, but don't change the page layout in the
preview or exported PDF yet." Previously this limitation existed only in
code comments and this report, never in the actual rendered UI. Covered by
a new test: `shows a visible, persistent notice that these settings do not
yet affect rendering`.

### Item 4 — test-count typo (fixed)

The original "Test summary" section said "34 new tests" for a 30+9 split;
corrected to 39 above (confirmed via `grep -c "  it("` at the time).

### Optional item — multi-line flow-style margins (addressed, not just documented)

Given the bracket-aware scanning already needed to be introduced cleanly
alongside the Bug 1 structural-continuation fix, this was cheap enough to
fix rather than merely document. `findBlockEnd` now detects when an owned
key's own line opens an unbalanced flow bracket (`{`/`[`) and, in that case,
bounds the block by running bracket-depth balance (`bracketDelta`) across
subsequent lines — regardless of indentation — until the depth returns to
zero, rather than by indentation at all. This correctly captures a
multi-line `margins: { ... }` whose closing `}` sits on its own unindented
line, which previously left an orphaned `}` behind (a second corruption
vector in the same family as Bug 2 — the stray bracket breaks the next
`yaml.load`, reverting every owned key to defaults).

This is explicitly a best-effort, quote/comment-aware character scan, not a
real YAML tokenizer — documented as a known limitation in the file-level
comment ("Known limitations of the surgical write path") rather than
claimed as fully general.

**New tests**:
- `optional: replaces a multi-line flow-style margins value (closing brace on its own unindented line) without leaving an orphaned bracket`
- `optional: replaces a single-line flow-style margins value in place` (confirms the common, already-working case wasn't broken by the new bracket-depth code path)

### Verification commands run (this worktree, after the fix wave)

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
      Tests  200 passed (200)

$ pnpm exec prettier --check src/markdown/page-config.ts src/markdown/page-config.test.ts \
    src/renderer/src/components/PageSetupModal.tsx src/renderer/src/components/PageSetupModal.test.tsx
Checking formatting...
All matched files use Prettier code style!

$ pnpm run lint   # full eslint --cache . over the whole repo
(no output — clean)

$ grep -c "  it(" src/markdown/page-config.test.ts
37
$ grep -c "  it(" src/renderer/src/components/PageSetupModal.test.tsx
10
```

### Confirmation both Critical bugs no longer reproduce

- Bug 1: `applyPageConfig('title: X\ntheme: default\n  # this indented note describes something else entirely\ntags:\n  - a\ndraft: true', { theme: 'resume' })` now preserves the comment line byte-for-byte, only replacing `theme: default` → `theme: resume` — asserted exactly by the new regression test.
- Bug 2: `applyPageConfig('page : Letter\ndraft: true', { pageSize: 'A4' })` now produces `'page: A4\ndraft: true'` (one `page` key, no duplicate), and `extractPageConfig` on the result no longer throws or reverts to defaults — asserted exactly by the new regression test.

### Updated test summary (post fix-wave)

47 tests total across both files, all passing: 37 in
`src/markdown/page-config.test.ts` (30 original + 7 new: 3 for Bug 1, 2 for
Bug 2, 2 for the optional flow-style case) + 10 in
`src/renderer/src/components/PageSetupModal.test.tsx` (9 original + 1 new,
the visible-notice test). Full existing suite (`pnpm test:unit`) passes at
200/200 — no regressions.

---

## Fix-wave addendum: review round 3 (CHANGES NEEDED → resolved)

Commit before this fix wave: `c80cb48b18d0c6f2af6ddb6cbe94f9aec6bd8660`
(the round-2 fix-wave commit above).

Re-review confirmed all 4 round-2 items (both Critical bugs, the UI notice,
the report typo) plus the bonus flow-style fix genuinely fixed, by direct
reproduction rather than trusting the tests alone. It then found ONE new
Critical regression introduced by the round-2 Bug 1 fix itself.

### The regression: `findBlockEnd`'s narrowed continuation check didn't recognize block-scalar (`|`/`>`) or plain multi-line-wrapped values

**Root cause**: the round-2 fix for Bug 1 replaced "any indented line
continues the block" with "only a line shaped like a mapping entry
(`key:`) or sequence item (`- item`) continues the block"
(`STRUCTURAL_CONTINUATION`). That correctly stopped an indented *comment*
from being swallowed (fixing Bug 1), but it also stopped recognizing a
block scalar's own content lines, or a plain scalar's line-folded
continuation, as part of the preceding key's block — neither looks like
`key:` or `- item`. Both left orphaned lines behind on a rewrite, and
`js-yaml.load` then throws on the corrupted result (`bad indentation of a
mapping entry`), reverting every owned key to defaults on the next
`extractPageConfig` call — the same severity/class as Bug 2.

**Confirmed via real js-yaml before fixing** (not assumed):

```
$ node -e "console.log(JSON.stringify(require('js-yaml').load('footerCenter: |\n  Some text\n  that spans\n  multiple lines\ndraft: true')))"
{"footerCenter":"Some text\nthat spans\nmultiple lines\n","draft":true}

$ node -e "console.log(JSON.stringify(require('js-yaml').load('footerCenter: this is a long value\n  that wraps onto a second physical line\ndraft: true')))"
{"footerCenter":"this is a long value that wraps onto a second physical line","draft":true}
```

Both parse as ordinary, single-key values in real YAML — confirming the
reviewer's repros were genuine valid-YAML shapes this module needed to
handle, not edge cases outside scope.

**A key piece of extra verification that shaped the fix**: to decide how
broad the fix should be without reopening Bug 1, I checked whether an
indented line that merely *looks* like an unrelated mapping entry directly
after a scalar could ever be a competing valid interpretation:

```
$ node -e "require('js-yaml').load('theme: default\n  nested: value')"
THROWS: bad indentation of a mapping entry (2:9)
```

This confirms there is no third, valid interpretation of "an indented line
directly following one of PageDown's own (always column-0) keys" other
than: that key's own continuation, or a comment/blank line. There is no
real-world case where such an indented line is legitimately unrelated
content that a narrower "must look like `key:`/`- item`" check is needed to
protect against.

**Fix**: `src/markdown/page-config.ts`'s `findBlockEnd` no longer uses the
`STRUCTURAL_CONTINUATION` regex. The block-style branch now treats *any*
indented line as a continuation (`isIndented`), with the comment/blank
exclusion (and its "swallow only if interior" lookahead) kept exactly as
round 2 left it — that exclusion is what actually fixed Bug 1, and remains
correct and sufficient on its own per the js-yaml verification above. This
is a deliberate departure from the reviewer's suggested mechanism (a
dedicated third branch that detects `|`/`>` indicators specifically,
mirroring the flow-bracket-depth branch): a single, simpler, YAML-
semantics-justified rule handles both the block-scalar and the plain-wrap
case uniformly, without needing to parse the block-scalar indicator
grammar (chomping/indentation modifiers) at all. This reasoning, and the
two-round history, is documented directly in `findBlockEnd`'s own comment
and the file-level "Known limitations" section.

**New regression tests** (`src/markdown/page-config.test.ts`):
- `regression (round 3): isolated single-key case -- a block-scalar value is replaced in place with no orphaned lines and no append-vs-replace ambiguity` (uses a single already-present key so the "no orphaned lines" property is unambiguous, independent of the footer-object append-vs-replace-in-place behavior)
- `regression (round 3): preserves a block-scalar (`|`) value by replacing its own content lines, not orphaning them` (the reviewer's exact repro 1)
- `regression (round 3): preserves a plain multi-line-wrapped scalar value (no `|`/`>` indicator) by replacing its own continuation line, not orphaning it` (the reviewer's exact repro 2)
- `regression (round 3): a `>` folded block-scalar value round-trips the same way as `|`` (the other block-scalar indicator, not just the literal one)
- `regression (round 3): re-confirms Bug 1 is still fixed after the block-scalar/plain-wrap widening...` (exact same repro as the round-2 Bug 1 test, re-run against the round-3 code)
- `regression (round 3): re-confirms Bug 2 is still fixed after the block-scalar/plain-wrap widening...` (exact same repro as the round-2 Bug 2 test, re-run against the round-3 code)

### Full regression pass (not just page-config's own tests, per the review's explicit request)

```
$ pnpm exec eslint src/markdown/page-config.ts src/markdown/page-config.test.ts
(no output — clean)

$ pnpm run typecheck
> tsc --noEmit -p tsconfig.node.json --composite false
> tsc --noEmit -p tsconfig.web.json --composite false
(both clean, no output)

$ pnpm test:unit
 Test Files  20 passed (20)
      Tests  206 passed (206)

$ pnpm exec prettier --check src/markdown/page-config.ts src/markdown/page-config.test.ts
Checking formatting...
All matched files use Prettier code style!

$ pnpm run lint   # full eslint --cache . over the whole repo
(no output — clean)

$ grep -c "  it(" src/markdown/page-config.test.ts
43
```

### Confirmation: both new repro cases fixed, nothing else regressed

- **Repro 1 (block scalar `|`)**: `applyPageConfig('footerCenter: |\n  Some text\n  that spans\n  multiple lines\ndraft: true', { footer: { left: '', center: 'new value', right: '' } })` now produces `footerCenter: "new value"` immediately followed by `draft: true` (plus `footerLeft`/`footerRight` appended after, since those two keys didn't previously exist) — no orphaned `  Some text`/`  that spans`/`  multiple lines` lines, and `extractPageConfig` on the result no longer throws or reverts to defaults.
- **Repro 2 (plain multi-line wrap)**: same shape and same fix, for `footerCenter: this is a long value\n  that wraps onto a second physical line\ndraft: true`.
- **Bug 1 (round 2)**: re-run against the round-3 code with the identical repro — indented comment still fully preserved, only `theme:`'s own line changes.
- **Bug 2 (round 2)**: re-run against the round-3 code with the identical repro — `page : Letter` (space before colon) still found and replaced in place, no duplicate key, `extractPageConfig` no longer throws afterward.
- **Flow-style fix (round 2 bonus item)**: covered by the existing `optional: replaces a multi-line flow-style margins value...` and `optional: replaces a single-line flow-style margins value...` tests, both still passing unchanged (the flow-bracket-depth branch in `findBlockEnd` is untouched by this round's fix — it's checked first and returns early, before the block-style branch that changed).
- **Full suite**: `pnpm test:unit` passes 206/206 (up from 200/200 after round 2 — 6 new tests, all in `page-config.test.ts`), confirming no regression anywhere else in the app.

### Updated test summary (post round-3 fix-wave)

`src/markdown/page-config.test.ts` now has 43 tests (37 after round 2 + 6
new: 1 isolated single-key case, 2 for the reviewer's exact repros, 1 for
the `>` variant, 2 re-confirming Bug 1/Bug 2 still hold). Combined with
`PageSetupModal.test.tsx`'s unchanged 10, that's 53 tests across both
files, all passing. Full suite: 206/206.
