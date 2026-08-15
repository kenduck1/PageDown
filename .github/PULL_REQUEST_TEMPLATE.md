<!--
Thanks for the pull request. Please read CONTRIBUTING.md if you haven't
already — particularly the note about invariants that fail silently.
-->

## What this changes

<!-- And, more importantly, why. If it fixes a bug, how did the bug reproduce? -->

## How it was verified

<!--
Which of these did you run, and what happened? Paste real output rather than
asserting it passed.

  pnpm typecheck
  pnpm lint
  pnpm test:unit
  pnpm test:phase0   (if this touches rendering, pagination, export or window behaviour)
-->

## Checklist

- [ ] `pnpm typecheck`, `pnpm lint` and `pnpm test:unit` pass locally
- [ ] Added or updated a test at a layer that can actually catch a regression
- [ ] If this touches `document-typography.css`, both rendering surfaces were
      considered (see ARCHITECTURE.md — naming an element on only one surface
      diverges silently)
- [ ] If this adds an ESM-only dependency used from main-process code, it is in
      `externalizeDeps.exclude`
- [ ] If this changes the default window size, Gates 28 and 29 were re-run
      (their clamp assertions can go vacuous)
