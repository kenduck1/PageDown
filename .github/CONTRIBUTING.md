# Contributing to PageDown

Thanks for your interest. PageDown is an early-stage desktop app, so the most
useful contributions right now are bug reports with a document that reproduces
the problem, and fixes for things that are plainly broken.

Please read [ARCHITECTURE.md](../docs/ARCHITECTURE.md) before making a substantial
change. It documents several invariants that fail _silently_ when broken — no
error, no failing test, just wrong output.

One thing that surprises people early: many source comments cite `CLAUDE.md`
or a path under `docs/superpowers/`. Those are internal working documents and
are deliberately not published here, so those paths will not exist in your
checkout — nothing is missing or misconfigured. ARCHITECTURE.md is the
contributor-facing distillation of that material.

## Setup

Requires **[pnpm](https://pnpm.io)**. The version is pinned in
`package.json`'s `packageManager` field; Corepack or `pnpm/action-setup` will
honour it automatically.

```bash
pnpm install
pnpm dev
```

Node 22 is what CI uses.

## The loop

```bash
pnpm dev          # run the app with hot reload
pnpm typecheck    # tsc --noEmit, main process + renderer (two tsconfigs)
pnpm lint         # eslint --cache .
pnpm format       # prettier --write .
pnpm test:unit    # vitest
```

Before opening a pull request, run:

```bash
pnpm verify   # typecheck + lint + test:unit, exactly what CI's check job runs
```

CI runs those three, plus a `pnpm build` on macOS, Windows and Linux — that
last job exists to catch a specific failure that only appears in the compiled
main-process bundle (see ARCHITECTURE.md).

## Tests

Three suites, covering different layers. See the Testing section of
[ARCHITECTURE.md](../docs/ARCHITECTURE.md) for what belongs where.

```bash
pnpm test:unit                    # fast; jsdom
pnpm test:gates                  # Playwright against the real built app
pnpm test:spike:vitest           # frozen Milkdown spike gates
pnpm test:spike:playwright
```

Single files and single tests:

```bash
pnpm exec vitest run src/renderer/src/store/appStore.test.ts
pnpm exec vitest run -t "goEditor switches screen"
pnpm exec playwright test tests/gates/gate2-performance.spec.ts
pnpm exec playwright test tests/gates/gate15-split-mode.spec.ts -g "Split mode"
```

`test:gates` and `test:spike:playwright` build the app first via their own
`pretest` hooks, then drive the real binary. They are much slower than
`test:unit`.

### Two things to know before you chase a gate failure

**A bare timeout is probably not your bug.** The gates in `tests/gates` launch a real
multi-process Electron app repeatedly, and under host load those launches
intermittently hang. The measured rate is roughly 25–33%, confirmed by
re-running an unmodified build. The signature is a bare `Test timeout` plus a
`Worker teardown timeout` that never reaches an assertion.

A **named** assertion failure (`Expected: 624, Received: 592.796875`) is a real
regression. Take that seriously.

If a gate fails, re-run that spec alone (`-g "<test name>"`) before concluding
anything. And if you are testing a change, A/B against _your change removed_ —
a passing unrelated control gate rules out the environment, it does not
exonerate your diff.

**Some tests/spike gates fail deliberately.** Their failure is the recorded finding
from a frozen feasibility spike. Don't loosen their assertions.

## Code style

Prettier enforces it (`.prettierrc.yaml`): **no semicolons, single quotes,
100-character print width, no trailing commas.** Match this in hand-written
snippets; `pnpm format` will fix the rest.

Beyond formatting, match the surrounding code. This codebase comments _why_
rather than _what_, and it is unusually dense with comments explaining why an
obvious-looking simplification is wrong. If you find one of those, please read
it before simplifying past it — most were written after the simplification was
tried and reverted.

## Screenshots

`docs/screenshots/` is captured from the real built app, never hand-edited:

```bash
pnpm build && pnpm exec tsx scripts/capture-screenshots.ts
```

**Changing a starter template invalidates `home.png`, and nothing enforces
that.** The Home screen renders real thumbnails of the real template content,
so editing `src/renderer/src/templates/` leaves the committed screenshot
showing text that no longer exists. The same applies to any change that
alters the editor chrome, the page card, or Page Setup. Re-run the capture and
commit the result alongside the change.

Split mode's screenshot is a composite of two real captures — its preview pane
is a native `WebContentsView` with its own compositing surface, which a
single `capturePage()` cannot see. The script pastes the preview's own capture
at the bounds the app reports. See its header comment; every pixel is real
output at its real position, and nothing in it is mocked.

## Pull requests

- One logical change per PR.
- Explain the _why_ in the description. If you fixed a bug, say how it
  reproduced.
- Add a test at the layer that can actually catch a regression. A unit test is
  right for pure logic; if the behaviour only exists in a real browser or a
  real window (layout, keyboard dispatch, the sandboxed renderer), it needs a
  gate.
- If you change the default window size, **re-run Gates 28 and 29** — their
  clamp assertions become vacuous above roughly 1050px wide, so a pass after
  a width increase may mean the test stopped testing anything.
- If you add an ESM-only dependency imported from main-process code, add it to
  `externalizeDeps.exclude` in `electron.vite.config.ts`. See ARCHITECTURE.md;
  this passes every test and fails only in the compiled build.

## Reporting bugs

Use the issue templates. The two most useful things you can include are the
**minimal Markdown document** that reproduces the problem — with its
frontmatter, since page size, margins and theme all affect layout — and
**which editing mode** you were in. A lot of behaviour differs between Format,
Source and Split.

## Security

Please don't open a public issue for a security problem. See
[SECURITY.md](SECURITY.md).

## Licence

By contributing, you agree that your contributions are licensed under the MIT
Licence, the same as the rest of the project.
