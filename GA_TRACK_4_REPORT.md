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
