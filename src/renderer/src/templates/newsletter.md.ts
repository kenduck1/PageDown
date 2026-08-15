// This template IS byte-canonical against Milkdown's round-trip
// serialization, and is asserted so alongside every other template in
// templates.test.ts. It previously was not, and carried a comment saying so:
// its tight "- **March N** — ..." bullet list came back LOOSE, because
// Milkdown's schema dropped list `spread` (tight vs. loose) on serialize.
// That gap is closed -- see list-spread-fix.ts -- so the tight event list
// below is a load-bearing shape rather than an incidental one. See also
// meeting-notes.md.ts.
//
// De-personalisation pass -- see resume.md.ts for the placeholder convention
// (plain title case, never bracketed) and the measurement that ruled brackets
// out. This template named an invented publication ("The Weekly Brief"), a
// plausible real customer by full name, and a real city; all three are now
// placeholders. The bold date leading each event bullet is "Month Day" rather
// than a concrete date for the same reason the meeting-notes due dates are
// relative: the masthead's own issue date is a placeholder, so concrete dates
// underneath it would contradict it -- while keeping the bold-date-first
// SHAPE, which is what the list is demonstrating.
export const NEWSLETTER_TEMPLATE = `# Newsletter Title

_Issue 1 — Month Day, Year_

## What's New

Lead with the one thing a reader would be sorry to miss. Our dashboard redesign shipped to all users this week, cutting the average time to find a report from four clicks down to one, and early feedback has been positive enough that other teams are already asking for the same treatment.

## Community Spotlight

This month we're highlighting Customer Name's team, who used our API to build an integration that posts daily summary digests. If you've built something worth sharing, reply to this email — we'd love to feature you next.

## Upcoming Events

- **Month Day** — Product roadmap webinar, 10am PT
- **Month Day** — Office hours with the design team
- **Month Day** — Community meetup, City

## From the Team

Thanks for reading, and as always, let us know what you'd like to see covered next.

— Your Team
`
