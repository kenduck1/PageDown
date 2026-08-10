// This template is deliberately NOT byte-canonical against Milkdown's
// round-trip serialization. The sole remaining difference (verified via
// createTestEditor + EDITOR_SCHEMA_PLUGINS.flat() + getMarkdown()) is that
// its tight "- [ ] ..." task list comes back LOOSE (a blank line inserted
// between each item) -- Milkdown's schema doesn't preserve list `spread`
// (tight vs. loose) on round trip. That's a known Milkdown schema fidelity
// gap, not a defect in this template, and the list is left exactly as
// authored rather than pre-loosened to mask the gap. Revisit once `spread`
// preservation lands; see also newsletter.md.ts.
export const MEETING_NOTES_TEMPLATE = `# Weekly Sync — Product & Engineering

**Date:** March 3, 2026

**Attendees:** Priya Shah, Marcus Lee, Dana Kim, Theo Alvarez

## Agenda

1. Q1 roadmap check-in
2. Bug backlog triage
3. Upcoming release timeline

## Discussion

The Q1 roadmap is tracking slightly behind schedule due to the delayed API migration; the team agreed to re-scope the reporting feature to ship without CSV export in the first pass. Bug backlog triage identified three P1 issues, all now assigned. The next release is targeted for March 17, pending final QA sign-off.

## Action Items

- [ ] Dana to re-scope the reporting feature and update the roadmap doc — due March 5
- [ ] Marcus to assign the three P1 bugs and confirm owners — due March 4
- [x] Theo to schedule the QA sign-off review — done
- [ ] Priya to send the updated release timeline to stakeholders — due March 6

## Next Meeting

March 10, 2026, same time.
`
