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
  resourceLink: true
}
