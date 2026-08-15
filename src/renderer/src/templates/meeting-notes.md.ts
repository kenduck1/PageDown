// This template IS byte-canonical against Milkdown's round-trip
// serialization, and is asserted so alongside every other template in
// templates.test.ts. It previously was not, and carried a comment saying so:
// its tight "- [ ] ..." task list came back LOOSE, because Milkdown's schema
// dropped list `spread` (tight vs. loose) on serialize. That gap is closed --
// see list-spread-fix.ts. The tight list, and the mix of checked and
// unchecked items, are therefore load-bearing shapes rather than incidental
// ones: templates.test.ts pins both. See also newsletter.md.ts.
//
// De-personalisation pass -- see resume.md.ts for the placeholder convention
// (plain title case, never bracketed) and the measurement that ruled brackets
// out. The attendee list used to be four plausible real people, and every
// action item was assigned to one of them by first name. Attendees are now
// ROLES rather than "Attendee One/Two" style blanks: a role both reads as a
// field to overwrite and keeps the action items legible as sentences, which
// numbered blanks would not.
//
// Action-item due dates are deliberately RELATIVE ("due Friday") rather than
// calendar dates: the meeting's own Date field above is a placeholder, so
// concrete March dates in the items below would contradict it. The reverse
// fix -- placeholdering the due dates too -- was ruled out because four items
// all reading "due Month Day" stops demonstrating that an action item wants a
// deadline at all.
export const MEETING_NOTES_TEMPLATE = `# Weekly Sync — Team Name

**Date:** Month Day, Year

**Attendees:** Product Lead, Engineering Lead, Design Lead, QA Lead

## Agenda

1. Roadmap check-in
2. Bug backlog triage
3. Upcoming release timeline

## Discussion

Record what was decided rather than everything that was said. The roadmap is tracking behind on one item, so the team agreed to re-scope it and ship the smaller version first. Triage identified three P1 issues, all now assigned. The next release is targeted for the end of the sprint, pending QA sign-off.

## Action Items

- [ ] Product Lead to re-scope the reporting feature and update the roadmap doc — due Friday
- [ ] Engineering Lead to assign the three P1 bugs and confirm owners — due Thursday
- [x] QA Lead to schedule the sign-off review — done
- [ ] Design Lead to send the updated release timeline to stakeholders — due Monday

## Next Meeting

Month Day, Year, same time.
`
