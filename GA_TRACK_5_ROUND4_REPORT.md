# GA Track 5 — Round 4 fix report

Scope: the Critical, content-destroying bug in `applyPageConfig`'s flow-bracket
branch (`src/markdown/page-config.ts`), plus the two factually-wrong claims and
two undocumented limitations called out in the round-4 review.

Files changed: `src/markdown/page-config.ts`, `src/markdown/page-config.test.ts`
(nothing else).

## Worktree note (read first)

`src/markdown/page-config.ts` did not exist in this worktree — Track 5's rounds
1–3 live on the sibling branch `worktree-agent-a72feac97b433fe0d`, which had
never been merged into this branch. Rather than hand-copy the two files (which
would have produced an add/add conflict against Track 5 on the next integration),
I merged that branch in first:

```
a81c64c Merge GA Track 5: surgical frontmatter page-config read/write (rounds 1-3)
```

The merge was verified conflict-free beforehand (`git merge-tree --write-tree`,
exit 0) and brought in `page-config.ts`, `page-config.test.ts`,
`PageSetupModal.tsx`, `PageSetupModal.test.tsx`, `GA_TRACK_5_REPORT.md`
unchanged. Baseline after merging: **43/43 tests passing**. The round-4 fix is a
separate commit on top that touches only the two permitted files.

## Fix approach: neither option 1 nor option 2 exactly — a bounded repair extension

I implemented **option 2's guard plus a strictly stronger bound than option 1**,
after an empirical finding that changes the framing of the whole branch.

### The finding that drove the design

Verified against real `js-yaml.load()` (v5.2.2, the pinned version), not reasoned
about abstractly:

| Input | Result |
| --- | --- |
| `margins: {\n  top: 1\n}\ndraft: true` (closer at column 0) | **THROWS** `deficient indentation (3:1)` |
| `margins: {\n  top: 1\n }\ndraft: true` (closer at column 1) | OK |
| `margins: {\n  top: 1,\n  bottom: 1\n  }\ndraft: true` (column 2) | OK |
| `tags: [\n  a,\n  b\n]\ndraft: true` (seq closer at column 0) | **THROWS** `deficient indentation (4:1)` |

So the premise round 2 built the branch on is false in both directions: a
top-level key's multi-line flow value **must** have every continuation line —
including its closing bracket — indented. Which means **the ordinary
indentation scan already bounds every *legal* multi-line flow value exactly**,
and the bracket-counting branch was never needed for valid YAML at all. Its only
real use is *repairing* the invalid column-0-closer shape (which looks like JSON
and is plausibly hand-authored).

### What I implemented

`findBlockEnd` now always runs the indentation scan first (round 3's logic,
extracted unchanged into `findIndentedBlockEnd`), then applies a narrow repair
extension gated on **two independent guards**:

1. `opensFlowCollection(line, valueOffset)` — the value's first non-space
   character after the key's `:` is actually `{` or `[`. This is option 2, and it
   alone fixes the reported repro (`footerCenter: Chapter {n` never enters flow
   mode). `valueOffset` is now threaded in from the caller, which matches the key
   with `exec` instead of `test` to get it.
2. `isFlowCloserOnlyLine(line)` — the extension may only ever consume lines
   consisting purely of closing brackets, commas, whitespace and an optional
   trailing comment (`}`, `] }`, `} # done`).

Because of guard 2 the scan is **bounded by construction** — it cannot reach past
a line carrying real content, so option 1's "ran to `lines.length`" failure mode
is structurally impossible rather than merely clamped. That is why I did not
implement option 1's `startIndex + 1` fallback: falling back to the indentation
scan's answer is strictly better (option 1's fallback would orphan an unclosed
flow's indented body lines, which then merge into the newly-written block as
duplicate keys and break the next parse).

Guard 2 also closes a case option 2 alone leaves open: `footerCenter: {n` +
`title: closing } brace` later. That value genuinely opens a flow collection, so
guard 1 admits it, but guard 2 stops the scan at the content-carrying line.

Net effect: the repair for the invalid column-0-closer shape is **preserved**
(nothing is weakened relative to round 2/3), while the data-destroying path is
gone.

## Verified behavior

Confirmed by direct execution against the fixed module (`tsx`):

- **Exact repro case fixed.** `footerCenter: Chapter {n` + `title` / `author` /
  `tags` (nested sequence) / `draft` → all five unrelated keys survive; output
  parses to the full expected object.
- **`[` variant fixed.** Same, with `Chapter [n`.
- **Any owned key, not just footer.** `theme: default [draft` → safe.
- **Stray unrelated `}` later in the document** → not treated as a closer.
- **Genuinely-valid multi-line flow still works** (indented closer, the case
  round 2 was trying to fix) → replaced in place, no orphaned bracket.
- **Invalid column-0-closer still repaired** → well-formed block, no stray `}`.
- **Unterminated flow** (`margins: {` / `  top: 1` / `draft: true`) → consumes
  only its own indented block, `draft: true` survives.
- **Single-line flow** unchanged.

### Randomized fuzz (independent of the unit tests)

I wrote a generator producing random *valid* YAML frontmatter blocks combining
12 owned-key value shapes (covering every past bug: spaced colon, block scalars,
plain wraps, indented trailing comments, stray brackets, single- and multi-line
flow) with 9 unrelated-key shapes (scalars, sequences, nested maps, block
scalars, values containing stray braces), applied a random update, and asserted
that the output still parses **and** that every unrelated key retains its exact
value.

- Fixed implementation: `checked=17382 skippedInvalidInput=2618 failures=0`
- Pre-fix implementation (same seed): `checked=385 ... failures=5` — it hit the
  5-failure cap almost immediately, e.g. losing `u2`, a standalone comment,
  `theme` and `u4` in one document.

So the fuzz harness is demonstrably sensitive to this bug class, and finds
nothing after the fix.

## Corrections to factually-wrong claims

1. **File-level "Flow-style values" limitation** (was ~line 99-111) claimed a
   flow collection's closing bracket "has no required indentation at all, and
   may legally sit at column 0." That is false — verified above. Rewritten to
   state the real rule, to name the false premise explicitly as the cause of the
   round-4 bug, and to explain that `bracketDelta` now only gates a bounded
   repair (so its acknowledged miscount risk is no longer content-destroying).
2. **`bracketDelta`'s own comment** (was ~line 397-405) repeated the same false
   claim as its justification. Rewritten to describe its actual, now-narrow job.
3. **Test fixture** (`page-config.test.ts`, was ~line 412-421) used the invalid
   column-0-closer document, i.e. it asserted against an input no correct
   document can contain. Its closer is now indented, and the test **guards its
   own fixture** with `expect(() => load(raw)).not.toThrow()` plus an exact
   `load(raw)` equality assertion, so it can't silently drift back to testing
   invalid YAML. The column-0 variant is retained as a *separate* test explicitly
   labelled as the malformed-input repair case, asserting `load(raw)` throws.

## Newly documented limitations (accepted, not fixed)

Added to the file-level "Known limitations" section, and each pinned by a test so
it stays a known quantity:

- **(a) Trailing `#`-leading line in a block-scalar value.** Comment detection is
  purely textual, so a block-scalar content line that starts with `#` can't be
  told from a real comment. I measured the exact boundary rather than assuming:
  only a `#`-leading line at the **end** of the block (including when it is the
  sole content line) is left behind; one with further indented content after it
  is correctly swallowed (first-of-two, middle, and sole-line positions all
  tested). The residue is cosmetic — verified the result is still valid,
  re-parseable YAML with correct owned values, and that re-applying is
  idempotent.
- **(b) Anchors.** Replacing an owned key carrying `&name` drops the anchor and
  orphans any `*name` alias; verified `load` then throws `unidentified alias
  "fc"` and `extractPageConfig` returns `{}`. Exotic in frontmatter; not fixed.

## Tests

11 tests added (43 → 54): 7 round-4 regressions, 1 column-0 repair case, 3
limitation-pinning tests.

**Proof the regressions are real:** I stashed only the implementation file and
re-ran the new suite against round 3's code — all 7 round-4 tests fail there and
pass with the fix:

```
× regression (round 4): an unbalanced `{` in a plain scalar value must not delete the rest of the frontmatter block
× regression (round 4): the full reported repro (6 unrelated keys, incl. a nested sequence) survives intact
× regression (round 4): the same bug via an unbalanced `[` instead of `{`
× regression (round 4): an unbalanced bracket on a NON-footer owned key is equally safe
× regression (round 4): a stray unrelated `}` later in the document is not treated as closing an earlier value
× regression (round 4): even a value that really does start with `{` will not consume a later line carrying other content
× regression (round 4): an unterminated flow collection consumes no more than its own indented block
Tests  7 failed | 47 passed (54)
```

## Verification command output

```
$ pnpm exec vitest run src/markdown/page-config.test.ts
 Test Files  1 passed (1)
      Tests  54 passed (54)

$ pnpm exec eslint src/markdown/page-config.ts src/markdown/page-config.test.ts
(no output, exit 0)

$ pnpm run typecheck
> tsc --noEmit -p tsconfig.node.json --composite false
> tsc --noEmit -p tsconfig.web.json --composite false
(no errors)

$ pnpm exec prettier --check src/markdown/page-config.ts src/markdown/page-config.test.ts
Checking formatting...
All matched files use Prettier code style!

$ pnpm test:unit
 Test Files  24 passed (24)
      Tests  263 passed (263)
```

(Prettier initially flagged one wrapping issue in the new test code; fixed with
`prettier --write` and re-checked clean, then the suite was re-run.)

## Concerns

1. **The merge described at the top is the main thing to review.** This branch
   now contains Track 5's rounds 1–3 as well as round 4. If the integrator
   intended to merge `worktree-agent-a72feac97b433fe0d` separately, that still
   works (common ancestry, no duplication), but it's worth knowing.
2. **`bracketDelta` remains a best-effort scanner, not a YAML tokenizer.** It can
   still miscount an adversarial line (unbalanced bracket inside a single-quoted
   string with an escaped quote). This is now low-consequence by design — a
   miscount can only cause a closer-only line to be consumed or not — but it is
   not *impossible* for it to matter, and it stays documented.
3. **Documented limitation (a) is cosmetic residue that a user could notice.** A
   trailing `#`-leading block-scalar line survives as an orphaned-looking
   indented comment. Harmless and idempotent, but if Page Setup ever writes to
   documents with block-scalar footer values it may look like a bug to a user.
4. **I did not re-run `test:phase0` / `test:phase1`.** Those launch the real
   built app and are unrelated to this pure-function change; `pnpm test:unit`
   (263 tests, including the merged `PageSetupModal` suite) is green.
