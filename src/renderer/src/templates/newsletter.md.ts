// This template IS byte-canonical against Milkdown's round-trip
// serialization, and is asserted so alongside every other template in
// templates.test.ts. It previously was not, and carried a comment saying so:
// its tight "- **March N** — ..." bullet list came back LOOSE, because
// Milkdown's schema dropped list `spread` (tight vs. loose) on serialize.
// That gap is closed -- see list-spread-fix.ts -- so the exclusion is gone
// and the template content itself is unchanged, exactly as it was authored.
// See also meeting-notes.md.ts.
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
