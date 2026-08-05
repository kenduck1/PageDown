# Track 4: Editor Status Bar — Report

## Status: DONE

Built a real, functional editor status bar (word count, page count, zoom,
autosave status, inert page-nav chevrons/jump-to-page) as an isolated
component, plus the real supporting word-count utility and a new
main-process page-count capability with its own IPC surface. Along the way,
found and fixed a real, previously-undiscovered performance bug in how this
project's pagination harnesses hide themselves off-screen — see "Notable
finding" below, since it's the single most important thing to know about
this sub-project.

## What was built

### 1. Word count utility — `src/renderer/src/lib/wordCount.ts`

`countWords(markdown: string): number`. Parses with a lightweight `unified`
processor using the exact same parse-affecting plugins as the canonical
pipeline (`remark-parse` + `remark-gfm` + `remark-frontmatter`), then walks
the resulting mdast tree and sums whitespace-delimited tokens from `text`
and `inlineCode` nodes only. Every other node type (`yaml`/`toml`
frontmatter, `code` blocks, `html`) is a `.value`-bearing leaf node whose
type is never `text`/`inlineCode`, so it's excluded automatically — no
regex-stripping step, no second parser. Deliberately does NOT reuse
`markdownToHtml` itself: that function's entire job is producing sanitized
HTML (remark-rehype + hast-util-raw + hast-util-sanitize), none of which
word counting needs.

Tests: `src/renderer/src/lib/wordCount.test.ts` — 15 tests covering plain
prose, headings, ordered/unordered lists, emphasis/strong, fenced and
indented code blocks (excluded), inline code (included), YAML frontmatter
(excluded), links (text counted, URL/brackets not), table cells, the
`<!-- pagebreak -->` marker (not counted), and a realistic mixed fixture
with a manually-verified expected count.

### 2. Page count — new main-process capability + IPC + hook

**`src/main/page-count-generator.ts`** (new): `getPageCount(content: string):
Promise<{ pageCount: number }>`. Mirrors `thumbnail-generator.ts`'s exact
harness/queue pattern (a promise-chaining `enqueueHarnessWork` queue, a
memoized `harnessPromise` with self-healing on `destroyed`) — a fully
separate harness instance, never shared with `thumbnail-generator.ts`'s own
or the Phase-0-spike harness in `src/main/index.ts`. No disk caching (unlike
thumbnails, there's no expensive image encode/write step to amortize).

**IPC**: `file:getPageCount` registered in `src/main/index.ts`, taking raw
content directly (no `isKnownPath` check needed — same as
`template:getThumbnail`, since it never touches a filesystem path).

**Preload**: `getPageCount: (content: string) => Promise<{ pageCount:
number }>` added to `FileApi` (`src/preload/index.d.ts`) and wired in
`src/preload/index.ts`.

**Hook — `src/renderer/src/hooks/usePageCount.ts`**: `usePageCount(content:
string, debounceMs = 500): { pageCount: number | null; loading: boolean;
error: string | null }`. Debounces client-side before ever calling the IPC
(so a fast typing burst triggers one round trip after typing settles, not
one per keystroke — the harness only handles one in-flight request at a
time per CLAUDE.md's documented constraint), and guards against a stale
in-flight response landing after a newer one via a monotonic request-id
ref. Uses the same "adjust state during render" pattern as the existing
`useThumbnail.ts` hook (not a synchronous `setState` inside `useEffect`,
which `react-hooks/set-state-in-effect` correctly flags as a
cascading-render anti-pattern).

Tests: `src/renderer/src/hooks/usePageCount.test.ts` — 6 tests (resolve,
reject-as-error, debounce timing via fake timers, debounce-collapses-rapid-
changes, re-fetch-on-content-change, stale-response-ignored).

### 3. `src/renderer/src/components/EditorStatusBar.tsx` (new, + `components/` dir)

Props (exact, as specified):

```ts
interface EditorStatusBarProps {
  content: string
  isDirty: boolean
  zoom: number // scale multiplier, e.g. 1 = 100%, 0.5 = 50% -- NOT a percent
  onZoomChange: (zoom: number) => void
}
```

- **Word count**: `useMemo(() => countWords(content), [content])` — real,
  memoized, not recomputed unless `content` changes.
- **Page count**: `usePageCount(content)` — real, debounced, via the IPC
  above. Rendered as `Page 1 of {pageCount ?? '—'}` — the "1" is a static
  placeholder (see below); the total is real.
- **Page navigation (chevrons + "Page X of Y" jump-to-page trigger) is
  INERT by design**, per this task's explicit scoping decision: real
  chevron-click navigation and a real jump-to-page popover both require a
  live, incrementally-repaginated preview to navigate within, which is a
  separate, larger, deferred sub-project (Phase 0 Gate 7's findings on why
  naive full-relayout was rejected). All three controls are real, focusable
  `<button>` elements with `onClick={noop}` and a `title` attribute stating
  they're not available yet — visibly present, clearly non-functional,
  clearly commented in the component's own JSDoc and inline comments. "Page
  1" is a static placeholder because there's no live current-page state to
  read yet, only a real total page count.
- **Zoom (real)**: a `<select>` of preset scale values (50/75/90/100/125/
  150/200%) that calls `onZoomChange` with the corresponding numeric scale
  factor. See "Zoom integration note" below for exactly what a future
  integration step needs to do with this value.
- **Autosave status (right-aligned, subtle, no border/pill)**: `✓ Saved`
  (`text-tertiary`, matching the mockup's exact `#9aa0a6` spec) when
  `!isDirty`; `Unsaved changes` (`text-secondary`) when `isDirty` — the
  mockup only specifies the Saved state's styling, so the Unsaved styling
  is a reasoned, documented choice, not a literal spec value.
- Styling uses only existing tokens from `base.css`'s `@theme static` block
  (`chrome-dark`, `border-chrome`, `text-secondary`, `text-tertiary`,
  `text-11-5`, `radius-sm`) — no hardcoded hex values. Bar is `h-8` (32px)
  with `border-t border-border-chrome bg-chrome-dark`, matching the
  mockup's exact spec.

Tests: `src/renderer/src/components/EditorStatusBar.test.tsx` — 9 tests:
real word count rendering (plural/singular), Saved vs. Unsaved
text+exclusivity, zoom dropdown calling `onZoomChange` with the correct
numeric value, zoom dropdown reflecting the current `zoom` prop, real page
count fetched and displayed via `window.api.getPageCount`, a loading
placeholder, and the page-nav chevrons/jump-button being clickable no-ops.

### 4. `phase0/gate12-page-count.spec.ts` (new)

Follows `gate8`'s pattern (proving the harness returns a correct, real page
count) and `gate9`'s (proving no cross-request leakage under concurrency),
using `launchIsolatedApp` (not bare `electron.launch()`) and driving the
real `window.api.getPageCount` from the real renderer page (the
CLAUDE.md-preferred pattern for new gates, not the `__pagedownPhase0`
bridge). Three tests: a trivial document paginates to exactly 1 page; a
genuinely large (120-section) generated document paginates to a real
multi-page range (bounded, not pinned exactly, since Paged.js layout can
drift slightly across environments — this repo's own committed
`gate2-timing.json` shows exactly this kind of drift for a similarly-sized
tier); three concurrent calls for differently-sized documents each resolve
with their own correct, strictly-increasing, mutually-distinct page count
(proving the dedicated queue serializes correctly, the same property Gate 9
proved for `getThumbnail`).

## Notable finding (found while building this, not part of the original ask)

**Off-screen-positioned pagination harnesses are subject to a real,
severe Chromium rAF/requestIdleCallback throttling bug that this
sub-project is the first to actually expose.**

While building `getPageCount`, repeated/larger calls started intermittently
timing out or taking multiple seconds. Root cause, isolated via a series of
throwaway diagnostic Playwright scripts (not committed): every existing
harness consumer in this codebase (`thumbnail-generator.ts`,
`src/main/index.ts`'s Phase-0-spike wiring) positions its harness's
`WebContentsView` off-canvas within a real, visible parent window via
`setBounds({x:-9999,y:-9999,...})`. Chromium treats a view positioned
outside its parent's visible bounds as occluded, which throttles
`requestAnimationFrame`/`requestIdleCallback` for its renderer —
Paged.js's own `Chunker` uses exactly those APIs for its progressive,
per-chunk layout (`this.tick = requestAnimationFrame` in pagedjs's own
source). Measured directly against this codebase: a trivial ~2-page
document degraded from ~15ms of real layout time to a ~3s plateau after
2-3 calls on a reused off-canvas harness; a genuinely multi-page (~13-page)
document took **9+ seconds on its very first call**, comfortably enough to
blow past `sendDocument`'s 10-second poll deadline. `backgroundThrottling:
false` in `webPreferences` (tried first) does NOT fix this — that flag only
governs `setTimeout`/`setInterval` clamping, not rAF's separate
visibility-based throttling.

This was never caught before because every existing off-canvas consumer
either only tests trivial single-paragraph content (`gate8`) or fires a
small, fixed burst of calls immediately after harness creation (Home
screen's template thumbnails) — neither pattern gives the throttle enough
successive occluded frames to ramp up. A status bar's page count, called
repeatedly across an entire real editing session, is exactly the pattern
that exposes it.

**The fix** (scoped entirely to `page-count-generator.ts`, touching nothing
shared): attach the harness to a **private, dedicated, `show: false`
`BaseWindow`** that this module creates and owns itself, and leave the
child view at `createPaginationHarness`'s own default bounds (never call
`setBounds` to relocate it). Verified directly: consistently ~110-180ms per
call, including for the same 13-page document that took 9+ seconds
off-canvas, with zero escalation across repeated calls. (An `opacity: 0`
variant of a real, on-desktop, `show: true` window was also tried and also
worked, but `BaseWindow.setOpacity` is documented as win32/darwin-only in
Electron's own typings — no effect on Linux, which this project ships a
build target for — so it was rejected in favor of the platform-safe
`show: false` approach.) `getPageCount`'s signature therefore does NOT take
a `win: BaseWindow` parameter, unlike `getThumbnail` — it doesn't need the
caller's window at all. `src/main/page-count-generator.ts`'s own module
comment has the full writeup.

**This is very likely a real, live issue for `thumbnail-generator.ts` too**
(nothing about the bug is specific to page counting — any Paged.js layout
running on an off-canvas harness is subject to it, given enough chunking
work), and possibly explains why Home screen thumbnail generation for a
genuinely large real document could be slow or fail. Deliberately NOT fixed
there: re-architecting shared harness-hiding infrastructure that other
concurrently-developed tracks depend on is a materially bigger, riskier
change than this task's scope, and I can't fully regression-test every
other consumer (export, Mermaid, every phase0/phase1 gate) under this
task's time budget. Flagging prominently here for whoever owns that shared
code next, rather than silently working around it in more places at once.
I did verify the full existing `pnpm exec playwright test` (all 28
phase0 specs, including `gate8`/`gate9`/`gate11`) still passes unchanged
after my (reverted) exploration of `pagination-window.ts` — no other
harness consumer was touched.

## Zoom integration note (for whoever wires this into `EditorScreen.tsx`)

`EditorStatusBar`'s `zoom` prop is a **CSS scale multiplier** (`1` = 100%,
`0.5` = 50%, `2` = 200%), not a raw percentage. A future integration step
needs to:

1. Own a `zoom` piece of state (this component is stateless/controlled —
   it doesn't own the value itself).
2. Apply it as a CSS transform on the mounted editor's own scrollable
   container — e.g. on `MilkdownEditor`'s mount `div` or a wrapping
   element in `EditorScreen.tsx`:
   `style={{ transform: \`scale(${zoom})\`, transformOrigin: 'top center' }}`
   (or equivalent) — plus likely adjusting the container's own width/
   scroll-height accounting so scaled content doesn't get clipped or leave
   dead scroll space, since `transform: scale()` doesn't affect layout
   flow.
3. Pass that state and its setter down as `zoom`/`onZoomChange`.

I did not touch `MilkdownEditor.tsx` or `EditorScreen.tsx` (explicitly
forbidden) and built this as a fully isolated component in a separate
worktree, so I have no visibility into their exact current markup — this
is a description of the mechanism, not a diff.

## Deviations from the literal spec, and why

- `getPageCount`'s signature dropped the `win: BaseWindow` parameter
  `getThumbnail` has, and the IPC handler no longer passes `mainWindow`
  into it — a direct, necessary consequence of the throttling fix above
  (this harness owns its own dedicated window instead of attaching to the
  caller's). Everything else (queue pattern, `markdownToHtml` +
  `sendDocument`, no shared harness) matches the instructed pattern
  exactly.
- Extending `FileApi` with a new required method meant every test file that
  hand-constructs a full `window.api = {...}` mock had to gain one line
  (`getPageCount: vi.fn()...`) to keep satisfying the interface:
  `App.test.tsx`, `HomeScreen.test.tsx`, `EditorScreen.test.tsx`,
  `documentStore.test.ts`. These are mechanical, one-line-each additions,
  not logic changes, and none of the explicitly forbidden files
  (`EditorScreen.tsx`, `MilkdownEditor.tsx`, `documentStore.ts`,
  `appStore.ts`, etc. — the `.tsx`/`.ts` source files, not their
  `.test.tsx` siblings) were touched.
- `phase0/gate11-editor-save-race.spec.ts` (referenced in my dispatch as
  "the correct up-to-date pattern" for `launchIsolatedApp`) still uses a
  bare `electron.launch()` as of this writing — only `gate2` has actually
  been migrated to `launchIsolatedApp` so far. I used `launchIsolatedApp`
  for my new gate regardless, per the explicit instruction and
  `electron-launch.ts`'s own stated rationale.

## Verification output

```
$ pnpm run typecheck
✓ typecheck:node clean
✓ typecheck:web clean

$ pnpm run lint          (eslint --cache .)
✓ clean, 0 problems

$ pnpm exec prettier --check <every touched file>
All matched files use Prettier code style!

$ pnpm run test:unit
 Test Files  21 passed (21)
      Tests  183 passed (183)

$ pnpm run build
✓ typecheck -> electron-vite build -> pagination-render build, all clean

$ pnpm exec playwright test          (full suite, all 12 gates)
 28 passed (49.7s)
   -- includes gate8 (thumbnail correctness), gate9 (thumbnail
      concurrency), gate11 (save race), and the new gate12 (page-count
      correctness + concurrency), all unaffected by this sub-project's
      changes.

$ pnpm exec playwright test phase0/gate12-page-count.spec.ts   (run 3x standalone)
 3 passed, each run, ~250-450ms per test, no flakiness observed
```

## Test summary

30 new unit tests (15 word count + 6 `usePageCount` + 9 `EditorStatusBar`)
+ 3 new Playwright gate tests, all passing; full existing suite (183 unit
tests, 28 phase0 gates) unaffected.

## Files touched

New:
- `src/renderer/src/lib/wordCount.ts`, `wordCount.test.ts`
- `src/renderer/src/hooks/usePageCount.ts`, `usePageCount.test.ts`
- `src/renderer/src/components/EditorStatusBar.tsx`, `EditorStatusBar.test.tsx`
- `src/main/page-count-generator.ts`
- `phase0/gate12-page-count.spec.ts`

Modified:
- `src/main/index.ts` (new import + `file:getPageCount` IPC handler)
- `src/preload/index.ts`, `src/preload/index.d.ts` (`getPageCount` API)
- `src/renderer/src/App.test.tsx`, `src/renderer/src/screens/HomeScreen.test.tsx`,
  `src/renderer/src/screens/EditorScreen.test.tsx`,
  `src/renderer/src/store/documentStore.test.ts` (one-line mock addition
  each, to satisfy the widened `FileApi` interface)

Not modified: `EditorScreen.tsx`, `MilkdownEditor.tsx`, `documentStore.ts`,
`appStore.ts`, `EditorTabBar.tsx`, `EditorToolbar.tsx`, `EditorOutline.tsx`,
`EditorSidebar.tsx`, `PageSetupModal.tsx`, `pagination-window.ts`,
`thumbnail-generator.ts` — all as required.

---

## Fix round addendum (post-review)

Review came back CHANGES NEEDED with two required fixes and a few smaller
items. This section documents what changed and the exact evidence for each.
Note: the reviewer separately confirmed and is independently handling a
*worse* version of the throttling finding above (`thumbnail-generator.ts`
hard-fails outright above ~12 pages, not just "possibly slow") — that fix is
out of scope here per the coordinator's instruction; `thumbnail-generator.ts`
remains untouched by this sub-project.

### Required fix 1: app-quit regression

**The bug.** `page-count-generator.ts`'s dedicated harness lives on its own
`BaseWindow` — but nothing ever destroyed that window when the app's real
window closed. Since `BrowserWindow` is built on `BaseWindow` in this
Electron version, `BaseWindow.getAllWindows()` (what `window-all-closed`'s
firing condition is based on) kept counting the harness window forever after
even one `getPageCount` call, so `window-all-closed` never fired and the app
process never quit on Windows/Linux. Separately, the harness's own
self-heal path (`webContents.once('destroyed') → harnessPromise = null`)
never destroyed the *old* `BaseWindow` before dropping the reference, so
every self-heal cycle leaked one more window on top of that.

**The fix**, both in `src/main/page-count-generator.ts`:
- Added a module-level `harnessWindow: BaseWindow | null` alongside
  `harnessPromise`, set whenever a harness is created.
- Exported `destroyPageCountHarness(): void` — destroys `harnessWindow` (if
  any and not already destroyed) and clears both memoized references. Safe
  to call with no harness created yet (no-op) and safe to call more than
  once.
- The self-heal `webContents.once('destroyed', ...)` handler now also calls
  `win.destroy()` on the specific window that owned the dead webContents
  (captured via closure, not the possibly-already-reassigned module
  variable), closing the leak.
- `src/main/index.ts`: `createWindow()`'s `mainWindow` now registers
  `mainWindow.on('closed', () => destroyPageCountHarness())`, unconditional
  on platform (not gated behind the existing `process.platform !== 'darwin'`
  check in the separate `window-all-closed` handler — the window needs
  tearing down on every platform, including macOS, so a later `activate` →
  new-window cycle doesn't inherit a stale reference to the destroyed
  original harness or leak the old one).

**Empirical verification** (not just code-reading — via a throwaway
diagnostic Playwright script against the real built app, deleted after use,
same methodology as the original sub-project's own diagnostics):

Before the fix (reviewer's own finding, reproduced independently before
patching): 1 `getPageCount` call → `BaseWindow.getAllWindows().length`
stays at 2 forever after `mainWindow.close()` (the hidden harness window
never goes away) → `window-all-closed` never fires.

After the fix, driving the real IPC surface end-to-end:

```
windows BEFORE getPageCount: [{"isVisible":true,"isDestroyed":false}]
windows AFTER getPageCount:  [{"isVisible":false,"isDestroyed":false},{"isVisible":true,"isDestroyed":false}]
windows AFTER mainWindow.close(): []
window-all-closed fired: true
```

i.e.: 1 window before the call, 2 after (mainWindow + the hidden harness
window), **0** after closing mainWindow, and `window-all-closed` genuinely
fires (verified via a real listener registered in the main process,
`app.on('window-all-closed', ...)`, checked from the test after closing).
The pre-existing `if (process.platform !== 'darwin') app.quit()` body of
that handler is untouched, so on Windows/Linux this now results in a real
`app.quit()` call; on macOS the intentional no-quit-on-window-all-closed
behavior is preserved, but the window count still correctly reaches 0 so a
later `activate` doesn't inherit anything stale.

Separately verified the two secondary properties:
- **No leak on repeated normal use**: 5 sequential `getPageCount` calls on
  the same app instance → window count stays at exactly 2 after every
  single call (main + one harness, never growing).
- **Self-heal no longer leaks**: after a `getPageCount` call (window count
  = 2), force-destroying the hidden harness's `webContents` directly
  (simulating an external crash, bypassing `destroyPageCountHarness`
  entirely) → window count immediately drops to 1 (the dead harness window
  was destroyed by the fixed self-heal handler, not just orphaned) → a
  fresh `getPageCount` call afterward succeeds normally (`{"pageCount":1}`)
  and brings the count back to exactly 2, not 3 — proving the old window
  was genuinely destroyed, not merely forgotten-but-still-alive.

### Required fix 2: word count under-counting at inline-element boundaries

**The bug**, confirmed with the reviewer's own four examples. The original
`countWords` walked every mdast `text`/`inlineCode` node independently and
split each one's value on whitespace on its own. Whenever an inline element
(bold/italic/link/inline-code) sat directly adjacent to surrounding text
with *no* whitespace between them in the source — extremely common real
prose, e.g. a sentence ending in a bold/linked/coded word, or a word
fragment wrapped in emphasis — this either manufactured a spurious
one-character "word" out of trailing punctuation, or (for a mid-word split)
undercounted by treating the fragments as separate words instead of one.
Every one of the original 15 tests happened to place whitespace after the
inline element, which is exactly why the bug survived all of them.

**The fix**, in `src/renderer/src/lib/wordCount.ts`: instead of counting
words per individual `text`/`inlineCode` node, `countWords` now visits only
the three mdast/GFM node types that hold phrasing content *directly* as
children (`paragraph`, `heading`, `tableCell` — an exhaustive enumeration
of the grammar's leaf-block types, not "every node with children"), and for
each one recursively concatenates its *entire* inline text content into one
string first (`concatenateInlineText`, transparently walking through
`strong`/`emphasis`/`link`/`delete`/etc., treating a hard `break` node as a
single space so words on either side of an explicit line break never
wrongly merge) — only splitting into words *after* that full concatenation.
`visit`'s `SKIP` is returned after handling each matched container, since
its subtree has already been fully consumed by the recursive concatenation
and structurally none of the three container types can nest inside one
another anyway.

**Empirical verification** — all four of the reviewer's examples, exactly
as given, now pass as real test assertions (`src/renderer/src/lib/
wordCount.test.ts`):

| input | before (wrong) | after (fixed) | reviewer's expected |
|---|---|---|---|
| `See [the docs](https://example.com).` | 4 | **3** | 3 |
| `This is **bold**.` | 4 | **3** | 3 |
| `` Use `npm`, then stop. `` | 5 | **4** | 4 |
| `un*bel*ievable word` | 4 | **2** | 2 |

```
$ pnpm exec vitest run src/renderer/src/lib/wordCount.test.ts
 Test Files  1 passed (1)
      Tests  19 passed (19)
```

(15 original tests, still passing unchanged — every one of them had
whitespace surrounding its inline elements, so the fix is a strict
superset-correct generalization for them — plus the 4 new regression tests
above, one per reviewer example.)

### Smaller items, also fixed

- **Comment inaccuracy** (`wordCount.ts`): the old comment claimed both
  `yaml` and `toml` frontmatter node types were excluded from the count.
  Only `['yaml']` is actually passed to `remarkFrontmatter` (matching
  `pipeline.ts`'s own real config) — a `+++`-delimited TOML frontmatter
  block isn't recognized as frontmatter at all by this parser
  configuration, so its content parses as ordinary paragraph text and DOES
  count as prose. This was a comment-accuracy fix only (the actual
  behavior already matched the shared pipeline's own real config, so
  there was no logic bug to fix, just a misleading comment) — corrected in
  the module comment to state this explicitly.
- **`usePageCount` no longer flashes to "Page 1 of —" on every debounce
  cycle**: the render-phase reset on content change now keeps the previous
  `pageCount` value (only `error` is cleared, `loading` still flips `true`)
  instead of resetting to `null`. New test:
  `'keeps the last known page count visible (not null) while a new fetch
  is in flight'` in `usePageCount.test.ts` (renders with content that
  resolves to `pageCount: 5`, changes content, asserts `pageCount` is still
  `5` — not `null` — while `loading === true`, then confirms it updates to
  the new value once the fetch resolves).
- **In-memory content-cache in `getPageCount`**: a single-entry
  `lastContent`/`lastResult` pair, compared by direct string equality
  (deliberately not a hash — for a single in-memory slot, direct
  comparison is simpler and strictly more precise than hashing, with no
  real cost difference). A cache hit skips the harness/queue entirely.
  Verified via a new gate12 test (`'a second call for identical content is
  a fast in-memory cache hit'`): two identical-content calls return the
  same `pageCount`, and the second resolves in under 25ms — an order of
  magnitude faster than a real harness dispatch (60-450ms+ elsewhere in
  this same gate file) — confirmed stable across 3 standalone runs.

### Re-verification (full suite, after all fixes above)

```
$ pnpm exec vitest run src/renderer/src/lib/wordCount.test.ts
 Test Files  1 passed (1) — 19 passed (19)

$ pnpm exec vitest run src/renderer/src/hooks/usePageCount.test.ts
 Test Files  1 passed (1) — 7 passed (7)

$ pnpm run test:unit
 Test Files  21 passed (21)
      Tests  188 passed (188)

$ pnpm run typecheck
✓ typecheck:node clean
✓ typecheck:web clean

$ pnpm run lint
✓ clean, 0 problems

$ pnpm exec prettier --check <every touched/new file>
All matched files use Prettier code style!

$ pnpm run build
✓ typecheck -> electron-vite build -> pagination-render build, all clean

$ pnpm exec playwright test phase0/gate12-page-count.spec.ts   (standalone, 3x)
 4 passed each run (~250-450ms per test; cache-hit test ~190-210ms;
 no flakiness across 3 consecutive runs)

$ pnpm exec playwright test          (full suite)
 First run: 28 passed, 1 failed — phase0/gate5-sandbox.spec.ts's "repeated
 sendDocument calls do not leak Polisher <style> elements" hit its own 60s
 timeout. Investigated before assuming it was fine: that test uses its OWN
 never-shown BaseWindow (not mainWindow, not page-count-generator.ts, no
 off-canvas setBounds -- the exact "safe" configuration this sub-project's
 own throttling fix relies on), so it isn't touching any code this
 sub-project changed. Re-ran it standalone: passed in 978ms. Re-ran the
 FULL suite a second time immediately after: clean.
 Second (clean) full run: 29 passed (49.9s) -- 28 pre-existing gates + the
 now-4-test gate12 (28 - 3 + 4 = 29). Zero failures. The one-off failure is
 attributed to transient resource contention on the shared dev machine
 (multiple other worktree-agent sessions were running concurrently at the
 time, confirmed via `git worktree list` showing 5 other active,
 lock-held worktrees) rather than a real regression -- consistent with a
 sub-1-second test timing out at 60 seconds only under contention, not
 deterministically.
```

### Status: DONE

Commit: see the two commits below (feature + fix round). Both required
fixes are implemented and empirically verified (not just reasoned about);
both smaller "worth doing if cheap" items were also implemented, since both
were in fact cheap. No remaining known concerns from this fix round beyond
the pre-existing, explicitly-scoped-out items already noted above
(`thumbnail-generator.ts`'s throttling bug — confirmed worse than
originally characterized, now owned by a separate fix; the Zoom/`
EditorScreen.tsx` integration step, not yet wired by design since this
component is intentionally isolated).
