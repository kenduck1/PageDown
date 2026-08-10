// This template is deliberately NOT byte-canonical against Milkdown's
// round-trip serialization. The sole remaining difference (verified via
// createTestEditor + EDITOR_SCHEMA_PLUGINS.flat() + getMarkdown()) is that
// its tight "- **March N** — ..." bullet list comes back LOOSE (a blank
// line inserted between each item) -- Milkdown's schema doesn't preserve
// list `spread` (tight vs. loose) on round trip. That's a known Milkdown
// schema fidelity gap, not a defect in this template, and the list is left
// exactly as authored rather than pre-loosened to mask the gap. Revisit
// once `spread` preservation lands; see also meeting-notes.md.ts.
export const NEWSLETTER_TEMPLATE = `# The Weekly Brief

_Issue 14 — March 3, 2026_

## What's New

Our new dashboard redesign shipped to all users this week, cutting the average time to find a report from four clicks down to one. Early feedback has been overwhelmingly positive, with several teams already asking for the same treatment on the analytics workspace.

## Community Spotlight

This month we're highlighting Maya Chen's team, who used our API to build a custom Slack integration that posts daily summary digests. If you've built something worth sharing, reply to this email — we'd love to feature you next.

## Upcoming Events

- **March 12** — Product roadmap webinar, 10am PT
- **March 19** — Office hours with the design team
- **March 26** — Community meetup, San Francisco

## From the Team

Thanks for reading, and as always, let us know what you'd like to see covered next.

— The Product Team
`
