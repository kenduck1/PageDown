# GA Track 1: Multi-document tab support — report

## What was built

1. **`src/renderer/src/store/documentStore.ts`** extended additively with tab
   state. The pre-existing single-document fields (`content`, `filePath`,
   `isDirty`, `revision`, `error`) are preserved as real top-level state
   fields — not getters — and are kept in sync with whichever tab is active
   on every action that can change it. This was a deliberate choice over a
   selector/derived-getter approach: Zustand consumers read plain state
   properties (`useDocumentStore((s) => s.content)`), and every existing
   test asserts against `useDocumentStore.getState().content` etc. directly,
   so keeping these as real fields that get written in lockstep with `tabs`
   was the path that required zero changes to any existing consumer or test.

2. **`src/renderer/src/components/EditorTabBar.tsx`** (new `components/`
   directory) — a self-contained, store-driven tab bar per the design
   handoff (`docs/design-handoff/README.md` §2 item 2, cross-checked against
   the literal markup in `docs/design-handoff/PageDown.dc.html` ~line 207).
   Reads `tabs`/`activeTabId` from `documentStore` directly; exposes no
   props. Renders one browser-style tab per open document (active = white,
   3-sided border, 8px top-radius; inactive = borderless, grey text), a
   fixed 6×6px accent square per tab (per the brief's explicit "no real
   per-document color-tagging yet" instruction — the mock itself only shows
   the square on the active tab, but the task brief said "each tab", which I
   followed), a close (`×`) affordance (always visible on the active tab,
   hover-revealed on inactive tabs), and a "+" new-tab button that opens a
   blank tab. Not wired into `EditorScreen.tsx` — per the constraint, that's
   a separate future integration step.

3. Tests: 13 new cases added to `documentStore.test.ts` (tab actions +
   explicit "single-document contract still holds with multiple tabs open"
   case) and a new `EditorTabBar.test.tsx` (6 cases, real
   `@testing-library/user-event` interactions, no direct handler calls).

## Final `documentStore.ts` API shape

### State

| Field | Type | Notes |
|---|---|---|
| `content` | `string` | Mirrors the active tab. Unchanged contract. |
| `filePath` | `string \| null` | Mirrors the active tab. Unchanged contract. |
| `isDirty` | `boolean` | Mirrors the active tab. Unchanged contract. |
| `error` | `string \| null` | **Global, not per-tab** (see Deviations). Unchanged contract. |
| `revision` | `number` | Unchanged contract (bumped by `newDocument`/`loadDocument`), **also now bumped by `openTab`/`switchTab`/`closeTab`** whenever the displayed tab changes, so `EditorScreen`'s `key={revision}` remount still fires correctly on a tab switch. |
| `tabs` | `DocumentTab[]` | **New.** All open documents. |
| `activeTabId` | `string` | **New.** id of the tab mirrored into the fields above. |

`DocumentTab`: `{ id: string; filePath: string | null; content: string; isDirty: boolean }`

### Actions

| Action | Signature | Status |
|---|---|---|
| `newDocument` | `(initialContent?: string) => void` | **Unchanged signature.** Now opens a new tab (delegates to `openTab(null, initialContent)`) instead of overwriting the active tab in place. |
| `loadDocument` | `(filePath: string, content: string) => void` | **Unchanged signature.** Now opens a new tab (delegates to `openTab(filePath, content)`). |
| `openFile` | `() => Promise<boolean>` | **Unchanged.** Still calls `loadDocument` internally, so it now also opens a new tab. |
| `openPath` | `(filePath: string) => Promise<boolean>` | **Unchanged.** Same as above. |
| `save` | `() => Promise<void>` | **Unchanged signature.** Internals updated to also write the resolved `filePath`/cleared `isDirty` back into the active tab's entry in `tabs`, not just the top-level mirror fields. |
| `updateContent` | `(content: string) => void` | **Unchanged signature.** Internals updated to also write into the active tab's entry in `tabs`. |
| `clearError` | `() => void` | Unchanged. |
| `openTab` | `(filePath: string \| null, content: string) => void` | **New.** Appends a new tab, makes it active, clears `error`, bumps `revision`. |
| `closeTab` | `(tabId: string) => void` | **New.** See behavior below. |
| `switchTab` | `(tabId: string) => void` | **New.** Makes the given tab active (no-op if already active or unknown id), clears `error`, bumps `revision`. |

`closeTab` behavior:
- Unknown id → no-op.
- Closing a background (non-active) tab → removed from `tabs`, active tab/mirror fields/`revision` untouched (no remount needed).
- Closing the active tab with others remaining → activates the tab that slides into the closed tab's index (or the new last tab if it was rightmost) — conventional browser tab-close behavior.
- Closing the last remaining tab → replaced with one fresh blank "Untitled" tab; **the app can never reach zero tabs.**

## Deviations from the brief, and why

- **`error` stays a single global field, not per-tab.** Every producer of an
  error (`openFile`, `openPath`, `save`) only ever acts on the currently
  active tab, so a per-tab error would be state nothing in the app could
  observe today. Documented in-code (`documentStore.ts`'s `DocumentStateValues`
  comment) as a decision to revisit if a future feature needs a background
  tab to carry its own error independently.
- **Tab-close confirmation for a dirty tab is deliberately deferred, not built.**
  `closeTab` performs a simple in-memory discard with no "Save changes?"
  prompt, exactly as the brief allowed. Documented on the action itself in
  `documentStore.ts` and here per the brief's explicit instruction not to
  silently skip mentioning it. `EditorScreen`'s existing
  `window.api.confirmDiscardChanges` dirty-check flow only guards navigating
  away from the editor screen entirely — it is untouched and still applies
  there; it does **not** currently cover per-tab close, since `EditorTabBar`
  isn't wired into `EditorScreen` yet (out of scope per the brief's
  constraints).
- **Two colors in the mock's literal HTML (`#80858b`, used for inactive-tab
  text and the "+" icon) don't have an exact token match** in
  `base.css`'s `@theme static` block. Mapped to the existing `text-secondary`
  token (`#5f6368`) — the closest existing "de-emphasized UI chrome text"
  token, already used for this same role elsewhere (e.g. `EditorScreen`'s
  "← Home" button) — rather than hardcoding a new hex, per the
  tokens-exclusively styling convention. Every other color in the tab bar
  (`chrome-light`, `border-chrome`, `page`, `text-primary`, `text-tertiary`,
  `accent`) is an exact match to an existing token.
- **No `HomeScreen.tsx` changes were needed.** `newDocument`/`openFile`/
  `openPath`'s signatures and return types are unchanged, so `HomeScreen.tsx`
  required zero modification — confirmed by running its full existing test
  suite unmodified (see below).
- Tab ids are generated by a simple monotonically-increasing module-level
  counter (`tab-1`, `tab-2`, …), not `crypto.randomUUID()`. They're only ever
  used as React keys / internal `tabs` lookups within one running session, so
  uniqueness (not unguessability) is the only real requirement, and this
  sidesteps any doubt about `crypto.randomUUID` availability across every
  test/runtime environment this store runs in.

## Verification output

`pnpm test:unit` (full suite, includes all pre-existing tests unmodified plus the 19 new cases):
```
 Test Files  19 passed (19)
      Tests  172 passed (172)
```

`pnpm typecheck`:
```
> tsc --noEmit -p tsconfig.node.json --composite false
> tsc --noEmit -p tsconfig.web.json --composite false
```
(no output — clean)

`pnpm lint` (full project, `eslint --cache .`):
```
(no output — clean)
```

`pnpm exec prettier --check` on every file touched (`documentStore.ts`, `documentStore.test.ts`, `EditorTabBar.tsx`, `EditorTabBar.test.tsx`):
```
Checking formatting...
All matched files use Prettier code style!
```

Targeted re-run of the pre-existing suites this task's brief specifically
required to keep passing unmodified:
```
pnpm exec vitest run src/renderer/src/store/documentStore.test.ts src/renderer/src/screens/EditorScreen.test.tsx src/renderer/src/screens/HomeScreen.test.tsx
 Test Files  3 passed (3)
      Tests  37 passed (37)
```
(that 37 is the pre-existing test count, run before the 13 new documentStore
tests were added, to confirm zero regressions against the untouched files)

## One-line test summary

172/172 unit tests pass (153 pre-existing + 13 new `documentStore` tab tests + 6 new `EditorTabBar` tests), typecheck/lint/prettier all clean.
