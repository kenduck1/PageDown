// De-personalisation pass -- see resume.md.ts for the placeholder convention
// (plain title case, never bracketed) and the measurement that ruled brackets
// out.
//
// The body was ALSO rewritten from a job-application letter to a
// purpose-neutral formal letter, which is a content change beyond
// de-personalisation and is deliberate: this template is advertised on the
// Home screen as "Formal letter", and its old body was a second cover letter
// -- near-duplicate starter content to the cover-letter template sitting one
// card away from it, to the point that templates.test.ts has a test whose
// only job is asserting the two strings differ at all. Structure (date block,
// sender block, salutation, two body paragraphs, sign-off) is untouched.
export const LETTER_TEMPLATE = `Month Day, Year

Your Name
Street Address
City, State ZIP

Dear Recipient Name,

Open with the reason you are writing, in one sentence. A formal letter is read quickly, so the request or the news belongs at the top rather than saved for the end.

Use the body for the detail behind it — background, dates, amounts, or whatever the reader needs in order to act on it. Close by saying what you would like to happen next, and by when.

Thank you for your time.

Sincerely,

Your Name
`
