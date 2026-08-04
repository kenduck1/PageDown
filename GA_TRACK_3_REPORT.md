# Track 3: Editor Sidebar (Pages/Outline pill switcher + real Outline view)

## What was built

Three new files, all under `src/renderer/src/`, none of them touching any file on the
"do not modify" list:

1. **`src/renderer/src/lib/extractOutline.ts`** — pure heading-extraction function.
2. **`src/renderer/src/components/EditorOutline.tsx`** — pure Outline-tab component.
3. **`src/renderer/src/components/EditorSidebar.tsx`** — the sidebar container (pill switcher +
   Pages/Outline content), reading/writing `useAppStore`'s existing `sidebarTab`/`setSidebarTab`.

Plus their test files:

- `src/renderer/src/lib/extractOutline.test.ts` (13 tests)
- `src/renderer/src/components/EditorOutline.test.tsx` (8 tests)
- `src/renderer/src/components/EditorSidebar.test.tsx` (7 tests, includes some added beyond the
  brief's minimum)

`src/renderer/src/components/` did not exist before this task; created it.

## Component interfaces (for future integration)

```ts
// src/renderer/src/lib/extractOutline.ts
export interface OutlineHeading {
  depth: number // 1-6
  text: string // flattened plain text
  sourceOffset: number // node.position.start.offset into the raw Markdown source
}
export function extractOutline(source: string): OutlineHeading[]
```

```tsx
// src/renderer/src/components/EditorOutline.tsx
export interface EditorOutlineProps {
  content: string
  onSelectHeading: (sourceOffset: number) => void
  activeSourceOffset?: number // optional; highlights the closest-preceding heading
}
export default function EditorOutline(props: EditorOutlineProps): React.JSX.Element
```

```tsx
// src/renderer/src/components/EditorSidebar.tsx
export interface EditorSidebarProps {
  content: string
  onSelectHeading: (sourceOffset: number) => void
  activeSourceOffset?: number
  pageCount?: number // optional; honest "not available" note if omitted
}
export default function EditorSidebar(props: EditorSidebarProps): React.JSX.Element
```

`EditorSidebar` reads `sidebarTab`/`setSidebarTab` directly from `useAppStore` (no props for
those, per the brief). Nothing yet mounts `EditorSidebar` into `EditorScreen.tsx` — that wiring
(supplying real `content`, a real `onSelectHeading` that maps a source offset to an editor
scroll/cursor position, and a real `activeSourceOffset`/`pageCount` once those exist) is
explicitly out of scope here, since `EditorScreen.tsx` is on the "do not modify" list for this
track.

## `extractOutline` design notes

- Parses with `unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter, ['yaml'])` —
  the exact same parse-time plugins and options `src/markdown/pipeline.ts`'s `markdownToHtml`
  uses. Deliberately **not** importing `pipeline.ts` directly: its remaining stages
  (`remarkPagebreak`, `remarkRehype`, sanitize/stringify) exist only to produce sanitized render
  HTML and never touch `heading` nodes, so pulling them in would add a `.runSync()` dependency for
  no behavioral difference. This is a second *processor construction*, not a second, differently-
  behaving Markdown parser — it stays in lockstep with `pipeline.ts`'s parse-time plugin set by
  convention/comment, flagged in-code for whoever touches either file next.
- Heading text flattening walks `text`/`inlineCode` leaves via `unist-util-visit` rather than
  importing `mdast-util-to-string`. That package is only a *transitive* dependency here (not in
  `package.json`), so under pnpm's strict `node_modules` layout a plain `import` of it from
  application code isn't resolvable — confirmed by checking `node_modules/mdast-util-to-string`
  is absent at the top level despite being in `pnpm-lock.yaml`. Adding a new declared dependency
  for this felt like overkill for "concatenate a heading's leaf text nodes," so I wrote the ~8-line
  walk instead.
- Verified against the actual parser (not just assumed) that: a bold-only paragraph is never
  promoted to a heading, `#nofollow` (no space after `#`) is not an ATX heading, YAML frontmatter
  key/value lines containing a literal `#` are not mistaken for headings, and Setext-style
  (underlined) headings are found too. All 13 tests passed on the first run with no need to adjust
  the implementation — a good signal the extraction logic is a faithful, unsurprising use of the
  shared parser rather than something reimplementing its own heading-detection rules.

## Styling notes / deviations from the task brief's literal token suggestion

The task brief suggested the pill-switcher track use "grey (`chrome-light`)". I diverged from that
literal suggestion after finding `docs/design-handoff/PageDown.dc.html` — the actual exported
prototype markup, not just the README summary — which gives the *exact* computed styles:

- Track: `background: rgba(0,0,0,.05); border-radius: 7px; padding: 3px` sitting on top of the
  216px rail's own `#f6f6f7` (chrome-light) background.
- Compositing `rgba(0,0,0,.05)` over `#f6f6f7` computes to ≈`#eaeaec` — a near-exact match for the
  existing **`chrome-dark`** token (`#ececee`), not `chrome-light` (which is the rail's own
  background — using it for the track too would make the track invisible against its own
  backdrop, contradicting "grey track" being a visibly distinct element). I used `bg-chrome-dark`
  for the track. Flagging this explicitly since it contradicts the brief's literal wording, in
  case that wording was intentional for a reason I'm not seeing — I believe `chrome-dark` is
  correct here, backed by the actual prototype's own computed color, but noting the deviation as
  instructed.
- Active pill: `background: #ffffff` (`bg-page`), `box-shadow: 0 1px 2px rgba(0,0,0,.1)`. No exact
  existing token matches that shadow; used **`shadow-flat`** (`0 1px 3px rgba(0,0,0,.08)`) as the
  closest existing token — this also matches the brief's own explicit instruction to use
  `shadow-flat` here.
- Outline rows: exact values read from the prototype's own inline styles for the Outline tab
  (`padding:7px 8px` / `font-size:12.5px` / `color:#202124` for H1 rows; `padding:6px 8px 6px 20px`
  / `font-size:11.5px` / `color:#5f6368` for nested rows; active row:
  `font-weight:700; color:#2461c0; background:rgba(36,97,192,.09)`). Mapped to existing tokens
  exactly: `text-12-5`/`text-11-5` (exact font-size token matches), `text-text-primary`/
  `text-text-secondary` (exact color matches), `bg-accent/9` + `text-accent` + `font-bold` (exact
  match for the active row, including using `font-bold` — not `font-semibold` — since the
  prototype's own weight for the active row is 700), `rounded-sm` (6px token vs. the prototype's
  6px radius — exact match). The nested-row left padding of 20px vs. the H1 rows' 8px gives
  exactly the "+12px indent" the brief calls for, and both values are exact standard Tailwind
  spacing-scale hits (`pl-5` = 20px, `pl-2` = 8px) — no arbitrary bracket value needed there.
  Vertical padding (`py-[7px]` for H1 rows) is an arbitrary-bracket value since 7px isn't on
  Tailwind's default 4px spacing scale — consistent with this codebase's existing convention of
  bracket values for pixel-precise layout (e.g. `HomeScreen.tsx`'s `w-[168px]`, `w-[220px]`).
- Added a `hover:bg-chrome-dark` state on inactive outline rows for click affordance — not present
  in the static prototype (which has no interaction states shown for row hover), but a reasonable,
  minimal addition for real clickable rows using an existing token; flagging it as a deliberate
  small addition beyond the literal visual spec, not an oversight.
- Sidebar rail width is `w-[216px]` (arbitrary bracket, matching the brief's and prototype's exact
  216px, and the codebase's existing precedent for pixel-precise layout widths).

No new hex colors, no new font-size tokens were introduced anywhere. Every color and font-size
class used already existed in `src/renderer/src/assets/base.css`'s `@theme static` block.

## Pages-tab placeholder

Renders a real, honest summary, never a fabricated thumbnail or number:

- If `pageCount` is supplied: `"{N} page(s)"` (singular/plural handled) plus a note that per-page
  thumbnails aren't built yet.
- If `pageCount` is omitted: a note that the page count isn't available yet *and* thumbnails
  aren't built yet — never guesses a number.

## Deviations from the brief

- Track color token (`chrome-dark` instead of the brief's suggested `chrome-light`) — explained
  above, backed by reading the actual prototype markup rather than only the README summary.
- Added `hover:bg-chrome-dark` on outline rows (interaction affordance not in the static mock).
- Outline list wrapper uses `overflow-y-auto` rather than the prototype's static `overflow:hidden`
  — a real, functioning list with an unbounded number of headings needs to scroll; the prototype
  never needed to since it's a fixed six-row mockup image.
- No token additions were needed or made; no gaps worth flagging for a future token addition were
  found (the two arbitrary-bracket values used — `w-[216px]`, `py-[7px]` — are layout/spacing
  values, not colors or font sizes, which is what the task's tokens-only rule targets, and both
  already have precedent as bracket values elsewhere in this codebase).

## Verification commands run (final, on the actual touched files)

```
$ pnpm exec prettier --check src/renderer/src/lib/extractOutline.ts src/renderer/src/lib/extractOutline.test.ts src/renderer/src/components/EditorOutline.tsx src/renderer/src/components/EditorOutline.test.tsx src/renderer/src/components/EditorSidebar.tsx src/renderer/src/components/EditorSidebar.test.tsx
Checking formatting...
All matched files use Prettier code style!

$ pnpm exec eslint .
(no output -- clean, whole repo)

$ pnpm typecheck
> tsc --noEmit -p tsconfig.node.json --composite false
> tsc --noEmit -p tsconfig.web.json --composite false
(no errors)

$ pnpm test:unit
 Test Files  21 passed (21)
      Tests  180 passed (180)
```

## Test summary

27 new tests added across `extractOutline.test.ts` (13), `EditorOutline.test.tsx` (8), and
`EditorSidebar.test.tsx` (7) — all passing; full project unit suite (`pnpm test:unit`) is 180/180
passing with zero regressions; `pnpm typecheck` and `pnpm exec eslint .` are both clean across the
whole repo.
