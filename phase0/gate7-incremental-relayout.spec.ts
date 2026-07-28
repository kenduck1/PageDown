import { test, _electron as electron } from '@playwright/test'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { markdownToHtml } from '../src/markdown/pipeline'

// Same reasoning as gate1-source-offset.spec.ts/gate2-performance.spec.ts
// for both mechanical deviations from a hypothetical literal brief sample:
// `__dirname` (not `import.meta.url`) for corpus paths, since this file
// transpiles to CommonJS; and the `globalThis.__pagedownPhase0` bridge (not
// a dynamic `import()` inside `app.evaluate()`), since that callback runs
// in a bare V8 context with no working dynamic import — confirmed
// empirically in Task 3/Gate 5. `markdownToHtml` itself, unlike
// `createPaginationHarness`/`sendGate7Phase1`/`sendGate7Phase2`, IS reached
// via a plain top-level Node import here (not the bridge) — it runs entirely
// in this file's own Node/Playwright-test process, not inside
// `app.evaluate()`, exactly like gate1's own top-level `markdownToHtml`
// import. See src/main/index.ts's bridge comment for why Gate 7 specifically
// needs two separate `app.evaluate()` round trips (not one, unlike gate2):
// phase 1's result has to come back out to THIS process so an edited
// markdown string can be built and run back through `markdownToHtml` before
// phase 2 can run.
//
// See resources/pagination-render/index.ts's block comment (right above its
// gate7-phase1/gate7-phase2 message handlers) for the full Paged.js
// Chunker-internals writeup this spike is exercising, and
// docs/superpowers/plans/2026-07-25-phase0-findings.md's Gate 7 section for
// the final writeup of what this run actually found.

interface Gate7Phase1Result {
  fullOriginalMs: number
  totalPagesOriginal: number
  sectionNumberAtBreakpoint: number | null
  resumeNoEditMs: number
  totalPagesAfterResumeNoEdit: number
  baselinePagesText: string[]
  resumedNoEditPagesText: string[]
}

interface Gate7Phase2Result {
  resumeWithEditMs: number
  totalPagesAfterEdit: number
  resumedWithEditPagesText: string[]
  resumedPrefixPagesText: string[]
  fullEditedMs: number
  totalPagesEdited: number
  controlPagesText: string[]
  controlPrefixPagesText: string[]
}

// Inserts `markerText` at the end of the FIRST paragraph following
// "## Section {sectionNumber}" in `markdown`. Matches on
// "## Section {N}\n\n" followed immediately by one line of paragraph text —
// exactly phase0/corpus/generate-long.ts's generated shape — so this can't
// accidentally match inside e.g. "## Section 65" while looking for
// "## Section 6" (the literal "\n\n" immediately after the number rules that
// out).
function insertMarkerIntoSection(
  markdown: string,
  sectionNumber: number,
  markerText: string
): string {
  const headingPattern = new RegExp(`(## Section ${sectionNumber}\\n\\n)([^\\n]+)\\n\\n`)
  const match = headingPattern.exec(markdown)
  if (!match) {
    throw new Error(
      `Could not find "## Section ${sectionNumber}" heading + first paragraph in the source markdown`
    )
  }
  const replacement = `${match[1]}${match[2]} ${markerText}\n\n`
  return (
    markdown.slice(0, match.index) + replacement + markdown.slice(match.index + match[0].length)
  )
}

// Element-wise comparison of two page-text arrays. Returns whether they're
// exactly equal (same length, same text per page) plus enough detail
// (mismatch count, first mismatching index) to report a real finding rather
// than a bare boolean either way.
function comparePageTexts(
  a: string[],
  b: string[]
): {
  allMatch: boolean
  lengthMatch: boolean
  pagesCompared: number
  mismatchCount: number
  firstMismatchIndex: number
} {
  const lengthMatch = a.length === b.length
  const pagesCompared = Math.min(a.length, b.length)
  let mismatchCount = 0
  let firstMismatchIndex = -1
  for (let i = 0; i < pagesCompared; i++) {
    if (a[i] !== b[i]) {
      mismatchCount++
      if (firstMismatchIndex === -1) firstMismatchIndex = i
    }
  }
  return {
    allMatch: lengthMatch && mismatchCount === 0,
    lengthMatch,
    pagesCompared,
    mismatchCount,
    firstMismatchIndex
  }
}

test('Gate 7: attempt incremental re-layout from a retained breakToken', async () => {
  const app = await electron.launch({ args: ['.'] })

  const fullMarkdown = readFileSync(join(__dirname, 'corpus', 'very-long.md'), 'utf8')
  const { html: fullHtml } = markdownToHtml(fullMarkdown)
  // "around page 150" per the brief. 0-indexed: this resumes AT the 151st
  // page (pages[150]), retaining pages[0..149] (150 pages) as the untouched
  // prefix — very-long.md paginates to 322 pages (Gate 2's measured value
  // as of Task 10 — was 297 before Task 10's KeepWithNextHandler; see
  // Gate 2's own findings-doc section for why), so this still sits close
  // to the middle.
  const targetPageIndex = 150

  // --- Phase 1: full paginate, capture the breakToken at targetPageIndex,
  // then an immediate resume-with-NO-edit as the simplest possible sanity
  // check of the mechanism (see pagination-window.ts/index.ts for what
  // actually runs). ---
  const phase1 = (await app.evaluate(
    async ({ BaseWindow }, { fullHtml, targetPageIndex }) => {
      const bridge = (
        globalThis as unknown as {
          __pagedownPhase0: {
            createPaginationHarness: (typeof import('../src/main/pagination-window'))['createPaginationHarness']
            sendGate7Phase1: (typeof import('../src/main/pagination-window'))['sendGate7Phase1']
          }
        }
      ).__pagedownPhase0

      const win = new BaseWindow({ show: false })
      const harness = await bridge.createPaginationHarness(win)
      // Stashed on a main-process global so the SECOND app.evaluate() call
      // below can reach the exact same render-context page — that's where
      // the live chunker/breakToken phase 2 needs actually live (see
      // resources/pagination-render/index.ts's module-level gate7State).
      ;(globalThis as unknown as { __gate7Harness?: unknown }).__gate7Harness = harness

      return bridge.sendGate7Phase1(harness, fullHtml, targetPageIndex)
    },
    { fullHtml, targetPageIndex }
  )) as Gate7Phase1Result

  console.log(
    'Gate 7 phase 1:',
    JSON.stringify(
      {
        fullOriginalMs: phase1.fullOriginalMs,
        totalPagesOriginal: phase1.totalPagesOriginal,
        sectionNumberAtBreakpoint: phase1.sectionNumberAtBreakpoint,
        resumeNoEditMs: phase1.resumeNoEditMs,
        totalPagesAfterResumeNoEdit: phase1.totalPagesAfterResumeNoEdit
      },
      null,
      2
    )
  )

  const resumeNoEditComparison = comparePageTexts(
    phase1.baselinePagesText,
    phase1.resumedNoEditPagesText
  )
  console.log(
    'Gate 7 phase 1 resume-no-edit equivalence check:',
    JSON.stringify(resumeNoEditComparison)
  )

  if (phase1.sectionNumberAtBreakpoint == null) {
    // A genuine, reportable finding in its own right (the backward walk
    // from the breakToken's node to the nearest "## Section N" heading
    // found nothing) — write out what we have so far rather than throwing
    // partway through and losing phase 1's results entirely.
    mkdirSync(join(__dirname, 'results'), { recursive: true })
    writeFileSync(
      join(__dirname, 'results', 'gate7-findings.json'),
      JSON.stringify(
        {
          chunkerEntryPointFound:
            'Chunker.render(source, breakToken) + Chunker.removePages(fromIndex)',
          resumptionAttempted: true,
          resumptionWorked: null,
          notes:
            'Phase 1 completed (full paginate + resume-no-edit) but could not determine a section number near the captured breakToken, so phase 2 (the real edit) did not run. See resumeNoEditComparison for the resume-no-edit mechanism check on its own.',
          targetPageIndex,
          phase1,
          resumeNoEditComparison
        },
        null,
        2
      )
    )
    await app.close()
    throw new Error(
      'Phase 1 could not determine a section number near the captured breakToken — see phase0/results/gate7-findings.json for partial results'
    )
  }

  // --- Build the edited document: a real edit strictly after the retained
  // prefix (sectionNumberAtBreakpoint + a safety margin, so it's not
  // adjacent to the breakToken itself), applied both as a literal
  // markdown-string edit (for the from-scratch control run below) and, in
  // phase 2, as a direct DOM mutation on the SAME retained chunker.source
  // tree (for the resumed run) — both paths insert the exact same
  // `markerText`, so the two runs are laying out genuinely equivalent
  // content, not just similarly-shaped content. ---
  const editSectionNumber = phase1.sectionNumberAtBreakpoint + 20
  const markerText = `GATE7-EDIT-MARKER-${Date.now()}: this sentence was inserted to simulate a live edit for the Task 7 incremental re-layout spike.`
  const editedMarkdown = insertMarkerIntoSection(fullMarkdown, editSectionNumber, markerText)
  const { html: editedHtml } = markdownToHtml(editedMarkdown)

  // --- Phase 2: apply the edit to the retained chunker.source tree, resume
  // from the retained breakToken, and time that against a from-scratch full
  // layout of the edited document. ---
  const phase2 = (await app.evaluate(
    async (_electronNS, { editSectionNumber, markerText, editedHtml, targetPageIndex }) => {
      const bridge = (
        globalThis as unknown as {
          __pagedownPhase0: {
            sendGate7Phase2: (typeof import('../src/main/pagination-window'))['sendGate7Phase2']
          }
        }
      ).__pagedownPhase0
      const harness = (
        globalThis as unknown as { __gate7Harness: Parameters<typeof bridge.sendGate7Phase2>[0] }
      ).__gate7Harness
      return bridge.sendGate7Phase2(harness, {
        editSectionNumber,
        markerText,
        editedHtml,
        targetPageIndex
      })
    },
    { editSectionNumber, markerText, editedHtml, targetPageIndex }
  )) as Gate7Phase2Result

  console.log(
    'Gate 7 phase 2:',
    JSON.stringify(
      {
        editSectionNumber,
        resumeWithEditMs: phase2.resumeWithEditMs,
        totalPagesAfterEdit: phase2.totalPagesAfterEdit,
        fullEditedMs: phase2.fullEditedMs,
        totalPagesEdited: phase2.totalPagesEdited
      },
      null,
      2
    )
  )

  const resumeWithEditComparison = comparePageTexts(
    phase2.resumedWithEditPagesText,
    phase2.controlPagesText
  )
  console.log(
    'Gate 7 phase 2 resume-vs-control equivalence check:',
    JSON.stringify(resumeWithEditComparison)
  )

  // The retained prefix (pages before targetPageIndex): never touched by
  // the resumed run at all, compared here against the control run's own
  // same-numbered pages (unaffected by the edit, which lands well
  // downstream) — checks that the untouched prefix is actually equivalent
  // to a from-scratch layout of the same content, rather than assuming it
  // is just because the resume "didn't touch it."
  const prefixComparison = comparePageTexts(
    phase2.resumedPrefixPagesText,
    phase2.controlPrefixPagesText
  )
  console.log('Gate 7 phase 2 retained-prefix equivalence check:', JSON.stringify(prefixComparison))

  const speedupRatio = phase2.fullEditedMs / phase2.resumeWithEditMs
  const genuineSpeedup = phase2.resumeWithEditMs < phase2.fullEditedMs

  // Feasibility verdict: resumption "works" only if (a) the resume-no-edit
  // sanity check reproduced the original run's pages exactly, (b) the
  // resume-with-edit run's pages from targetPageIndex onward match a
  // from-scratch full layout of the equivalently-edited document, (c) the
  // retained prefix itself matches a from-scratch layout of the same
  // unedited content, AND (d) it was actually faster than a full
  // re-layout — a "resume" that's correct but no faster, or fast but
  // wrong, is not a usable mechanism.
  const resumptionWorked =
    resumeNoEditComparison.allMatch &&
    resumeWithEditComparison.allMatch &&
    prefixComparison.allMatch &&
    genuineSpeedup

  const findings = {
    chunkerEntryPointFound:
      "Chunker.render(source, breakToken) + Chunker.removePages(fromIndex), bypassing flow()/Previewer.preview() entirely for the resumed call. This is the exact sequence Paged.js's own flow() uses internally in its cancel/retry loop (chunker.js:172-176: `let rendered = await this.render(parsed, this.breakToken); while (rendered.canceled) { this.start(); rendered = await this.render(parsed, this.breakToken); }`) to recover when a page overflows during its own initial layout -- this spike invokes render()/removePages() from outside that loop instead of from within it. (addPage()'s onOverflow handler also contains a second, more direct-looking `this.render(this.source, this.breakToken)` call of its own, chunker.js:447-459 -- traced closely and confirmed DEAD CODE: gated on `this.rendered === true` immediately after an `if (this.rendered) { return; }` early-out earlier in the same synchronous callback, chunker.js:431-434, so it can never actually execute. flow()'s retry loop, not that call, is the real internal precedent.) No source patching of Paged.js itself was required to CALL render()/removePages() (they are ordinary, non-underscored Chunker prototype methods) -- the real constraint is that BOTH calls must run against the SAME Chunker instance and the SAME live chunker.source DOM tree that produced the retained breakToken (breaktoken.js's BreakToken.node is a live DOM node reference, not a portable position; Chunker.flow() always builds a brand-new ContentParser -- and therefore an unrelated tree with fresh data-ref UUIDs -- from whatever content it is given, so a breakToken from one flow() run has no meaningful counterpart in a later, independently re-parsed run). This same-instance requirement is reasoned from the source cited above, not independently confirmed by a negative control here -- this spike's two phases always run against the one Previewer/Chunker instance phase 1 created, so a fresh-Chunker-plus-foreign-token failure was never deliberately provoked and observed.",
    resumptionAttempted: true,
    resumptionWorked,
    targetPageIndex,
    sectionNumberAtBreakpoint: phase1.sectionNumberAtBreakpoint,
    editSectionNumber,
    timings: {
      fullOriginalMs: phase1.fullOriginalMs,
      resumeNoEditMs: phase1.resumeNoEditMs,
      resumeWithEditMs: phase2.resumeWithEditMs,
      fullEditedMs: phase2.fullEditedMs,
      speedupRatio
    },
    pageCounts: {
      totalPagesOriginal: phase1.totalPagesOriginal,
      totalPagesAfterResumeNoEdit: phase1.totalPagesAfterResumeNoEdit,
      totalPagesAfterEdit: phase2.totalPagesAfterEdit,
      totalPagesEdited: phase2.totalPagesEdited
    },
    equivalenceChecks: {
      resumeNoEdit: resumeNoEditComparison,
      resumeWithEditVsControl: resumeWithEditComparison,
      retainedPrefixVsControl: prefixComparison
    },
    notes:
      "See docs/superpowers/plans/2026-07-25-phase0-findings.md Gate 7 section for the full writeup. All equivalence checks above compare page.element.textContent only (per the brief: \"per-page text content, not pixels\") -- this is text-exact, not a stronger structural/DOM-shape comparison; the two sides have genuinely different DOM structure going in (the control's marker sits inside real pipeline-generated markup, the resumed side's edit is a bare inserted text node), so a textContent-only check cannot by itself rule out structural divergence (e.g. the list-nesting/table-rowspan risk in rebuildAncestors noted elsewhere in this file). Patch surface required to reach this point: none to Paged.js's own source (render()/removePages() are called as-is); the surface actually required is manual DOM manipulation of chunker.source performed by CALLING CODE (this spike's render-context handler in resources/pagination-render/index.ts) to apply an edit strictly after the retained breakToken while leaving the retained prefix's nodes untouched -- which for THIS spike's edit (a new text node appended to an existing paragraph) needed no extra data-ref bookkeeping, but a general \"splice in freshly-parsed content\" edit would (new elements need data-ref UUIDs assigned exactly the way ContentParser.addRefs does it internally, an unexported/undocumented implementation detail). Timings above exclude removePages(targetPageIndex)'s own cost (destroying 172 page elements, as of Task 10's KeepWithNextHandler -- was 147 before it, since totalPagesOriginal shifted from 297 to 322; see Gate 2's own findings-doc section) on both the resume-no-edit and resume-with-edit sides, and fullEditedMs is measured while phase 1's ~322 attached page elements are still in the DOM (gate7Root isn't removed until after the control run) rather than against a pristine page -- both are documented simplifications, judged (via the Gate 2 cross-check in the findings doc) to roughly offset rather than re-measured here. An edit occurring BEFORE targetPageIndex is NOT just a slower case -- it is actively UNSAFE with this mechanism as tested: resuming from a retained breakToken reuses pages[0..targetPageIndex-1] completely as-is, so if the edit fell upstream of the checkpoint those reused pages would silently show stale, pre-edit content while pages resumed from the checkpoint onward reflect the edit -- an internally inconsistent document, not merely a missed optimization. A real implementation MUST know, for every retained checkpoint, whether a given edit falls before or after it (via the source-offset mapping Task 4/Gate 1 already built) and fall back to a full re-layout (or resume from an earlier still-valid checkpoint) whenever it does not. This was not separately measured here -- it follows directly from how the mechanism replays only from the checkpoint forward, not from an untested assumption -- but any production use of this finding must treat it as a hard correctness requirement, not an optimization detail."
  }

  mkdirSync(join(__dirname, 'results'), { recursive: true })
  writeFileSync(
    join(__dirname, 'results', 'gate7-findings.json'),
    JSON.stringify(findings, null, 2)
  )

  await app.close()
})
