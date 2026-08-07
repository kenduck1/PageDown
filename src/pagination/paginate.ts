import { markdownToHtml } from '../markdown/pipeline'
import type { PaginationHarness } from '../main/pagination-window'
import { computePageGeometry } from '../typography/page-geometry'
import { DEFAULT_PAGE_CONFIG } from '../markdown/page-config'

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

  // Page Geometry Wiring: this timing spike deliberately measures the
  // DEFAULT Letter/1in geometry, not a per-document one. `paginateAndTime`
  // only ever receives raw `markdown` and has no validated document path to
  // pull real frontmatter from at this layer -- extracting a document's own
  // PageConfig (extractPageConfig, src/markdown/page-config.ts) needs the
  // raw frontmatter block split out first (extractRawFrontmatter, being
  // relocated to src/markdown/frontmatter-splice.ts by a later task in this
  // same sub-project), which is real per-document wiring that belongs to
  // that task's 4 real callers (page-count-generator.ts,
  // thumbnail-generator.ts, pdf-exporter.ts, src/main/index.ts), not to this
  // Phase-0 timing spike. See src/main/pagination-window.ts's own
  // `PaginationHarness.sendDocument` doc comment for the same distinction.
  t = performance.now()
  const result = await harness.sendDocument(html, computePageGeometry(DEFAULT_PAGE_CONFIG))
  stages.sendAndPaginate = performance.now() - t

  return { stages, pageCount: result.pageCount, layoutMs: result.layoutMs }
}
