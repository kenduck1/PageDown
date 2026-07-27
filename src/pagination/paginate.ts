import { markdownToHtml } from '../markdown/pipeline'
import type { PaginationHarness } from '../main/pagination-window'

// Times the two stages of a full re-pagination pass: the Markdown->HTML
// pipeline (in-process, synchronous) and the round trip into the sandboxed
// Paged.js render harness (executeJavaScript dispatch + Paged.js layout +
// the harness's own poll loop back out — see pagination-window.ts's
// sendDocument). Task 7's incremental relayout work and later Phase 0 gates
// reuse this exact `{ stages, pageCount }` shape, so keep it minimal: no
// break-quality handling, no Mermaid integration, no retries — just timing.
// `layoutMs` is an additive, optional field (Paged.js's own internal
// preview() timing, forwarded from `PaginationResult` — see
// pagination-window.ts) added after the fact so committed timing results
// can show how much of `sendAndPaginate` is genuine layout work versus
// harness/poll overhead; it does not change or remove anything in the
// pinned `{ stages, pageCount }` shape Task 7 depends on.
export async function paginateAndTime(
  harness: PaginationHarness,
  markdown: string
): Promise<{ stages: Record<string, number>; pageCount: number; layoutMs: number }> {
  const stages: Record<string, number> = {}

  let t = performance.now()
  const { html } = markdownToHtml(markdown)
  stages.markdownToHtml = performance.now() - t

  t = performance.now()
  const result = await harness.sendDocument(html)
  stages.sendAndPaginate = performance.now() - t

  return { stages, pageCount: result.pageCount, layoutMs: result.layoutMs }
}
