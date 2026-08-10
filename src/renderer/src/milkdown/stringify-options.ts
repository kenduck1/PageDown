import type { Options as RemarkGfmOptions } from 'remark-gfm'

// The canonical, production copy of Milkdown's remark-stringify pin.
// Originally established as a spike artifact in phase1/milkdown-fixture.ts
// (Phase 1 feasibility spike) — this file is now the source of truth;
// phase1's copy is historical and should not be imported from production
// code.
export const PINNED_STRINGIFY_OPTIONS = {
  bullet: '-' as const,
  emphasis: '_' as const,
  strong: '*' as const,
  fence: '`' as const,
  rule: '-' as const,
  listItemIndent: 'one' as const,
  resourceLink: true,
  // Pinned to complete the list the master design doc names (design:85).
  // Matches mdast-util-to-markdown's own default today, so this changes no
  // output -- which is exactly the point: an incomplete pin is the drift the
  // pin exists to prevent. `false` means an h1/h2 always serializes as an
  // ATX heading (`# Title`) rather than a Setext underline (`Title\n=====`),
  // which matters here beyond style: a Setext underline made of `---` is the
  // exact shape frontmatter.ts's own YAML node has to be protected from
  // (Phase 1 Gate 1's original frontmatter-destruction finding).
  setext: false
}

// design:85 also names `tableCellPadding` among the pinned options -- but it
// is NOT a remark-stringify option and putting it in the object above would
// be a silent no-op that reads like real coverage. Traced through the
// installed packages rather than assumed: `remark-gfm` takes it as a PLUGIN
// option and forwards it to `gfmTableToMarkdown(settings)`
// (mdast-util-gfm-table), which closes over it directly -- it never reaches
// `state.options`, which is where remark-stringify's own settings land. So
// it is pinned here, at the one place it actually takes effect: the
// `remarkGFMPlugin` options ctx slice that @milkdown/preset-gfm exposes
// (`$remark`'s third member), set alongside PINNED_STRINGIFY_OPTIONS by
// every editor construction site.
//
// `true` matches today's effective behaviour, again deliberately: with the
// option unset, `markdown-table` supplies its own `padding !== false`
// default, so cells are already padded (`| a | b |`). Pinning makes that
// independent of two libraries' defaults continuing to agree.
export const PINNED_GFM_OPTIONS: RemarkGfmOptions = {
  tableCellPadding: true
}
