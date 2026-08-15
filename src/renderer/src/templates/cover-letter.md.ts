// De-personalisation pass -- see resume.md.ts for the placeholder convention
// (plain title case, never bracketed) and the measurement that ruled brackets
// out.
//
// The sender/recipient blocks are one paragraph each held together by soft
// line breaks; that structure is unchanged, only the text inside it. The two
// body paragraphs are now written AS INSTRUCTIONS to the person filling the
// template in, rather than as a stranger's plausible-sounding accomplishments
// -- a middle paragraph about a specific dashboard project cannot be
// de-personalised by swapping the proper nouns out of it, because the whole
// paragraph is the personal part.
//
// The phone number moved from (555) 234-9876 to the 555-01xx block: only
// 555-0100 through 555-0199 are actually reserved for fictional use, so the
// old number was a real, assignable one.
export const COVER_LETTER_TEMPLATE = `Your Name
[your.name@example.com](mailto:your.name@example.com)
(555) 012-3456

Month Day, Year

Hiring Manager
Company Name
Street Address
City, State ZIP

Dear Hiring Manager,

I'm writing to apply for the Job Title position posted on your careers page. Replace this opening with one or two sentences on why this role and this company in particular — the more specific it is, the less it reads like a form letter.

Use this paragraph for a single concrete example: the problem you were handed, what you did about it, and how it turned out. One story with a number in it lands better than a list of responsibilities.

Thank you for your time and consideration. My résumé is attached, and I would be glad to talk further at your convenience.

Sincerely,

Your Name
`
