# tests/

Two suites, with different purposes. Neither is the fast unit-test suite —
those live beside the code they test, as `*.test.ts(x)` under `src/`, and run
with `pnpm test:unit`.

| Directory | Command                                                | What it is                                                |
| --------- | ------------------------------------------------------ | --------------------------------------------------------- |
| `gates/`  | `pnpm test:gates`                                      | Playwright, driving the **real built app**.               |
| `spike/`  | `pnpm test:spike:vitest`, `pnpm test:spike:playwright` | A frozen feasibility spike. Some failures are deliberate. |

## `gates/`

43 specs that launch the real packaged Electron app and measure it. They exist
for the things no component test can reach: real pagination, the sandboxed
render context, real PDF and DOCX output, real keyboard dispatch through
Chromium, and anything needing a layout engine — jsdom has none, so it can
assert a component received `style={{ width: 794 }}` but never that anything
is 794 real pixels wide.

Each gate's measured result and methodology is recorded in the spec's own
header comment, not just asserted.

Two rules:

- **Always launch through `launchIsolatedApp`** (`gates/electron-launch.ts`),
  never a bare `_electron.launch()`. A bare launch inherits Electron's default
  userData path — the same directory your real app instance uses — and will
  read and write your actual recents list and thumbnail cache. This has
  already corrupted a real install once.
- **Write assertions that cannot pass vacuously.** Gates 28 and 29 are the
  pattern: they assert _both_ that the unclamped position would have
  overlapped _and_ that the clamped one does not, so widening the window makes
  the first half fail loudly rather than the second half pass silently.

### Reading a failure

A bare `Test timeout` plus `Worker teardown timeout` that never reaches an
assertion is the known environmental flake — repeated real-app launches hang
under host contention, measured at roughly 25–33% and confirmed by re-running
an unmodified build. Re-run the single spec (`-g "<test name>"`) before
concluding anything.

A **named** assertion failure (`Expected: 624, Received: 592.796875`) is a real
regression.

## `spike/`

The Milkdown/ProseMirror feasibility spike, kept frozen at the composition it
measured. **Some of these fail on purpose** — the failure _is_ the recorded
finding. Do not "fix" them by loosening assertions.

They are covered by neither `vitest.config.ts` nor `playwright.config.ts`, on
purpose: running a spike spec under the root configs would silently match
nothing and exit 0. Keep the configs disjoint.

## Naming

These were `phase0/` and `phase1/`, after the two feasibility spikes that
produced them. The numbers described _when_ the work happened rather than what
the directory holds, so they are named for their purpose now. `gates/` is
live coverage that must stay green; `spike/` is a frozen record.
