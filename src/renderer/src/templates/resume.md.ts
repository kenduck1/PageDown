// De-personalisation pass: this template used to be populated with a
// plausible real person (name, personal email, a San Francisco address, two
// invented employers, and specific achievement metrics), so opening it read
// as editing a stranger's resume rather than starting your own.
//
// Placeholder convention across all seven templates: PLAIN TITLE-CASE text
// ("Your Name", "Company Name"), never bracketed ("[Your Name]"). Bracketed
// placeholders are UNSAFE here and were ruled out on a measurement, not a
// preference: `mdast-util-to-markdown` escapes a leading `[` so it cannot be
// misread as a link reference, so `# [Your Name]` comes back out of a real
// Milkdown round trip as `# \[Your Name]` -- i.e. the user's first edit would
// inject a visible backslash into their own file, and templates.test.ts's
// byte-identity block would fail. CAPS ("YOUR NAME") round-trips too but was
// ruled out separately: in a resume heading it reads as a deliberate styling
// choice rather than as a field to overwrite, which is the opposite of what a
// placeholder is for.
//
// The YAML frontmatter block this template used to carry is DELETED, not
// rewritten. Its four keys (name/email/phone/location) exist nowhere in
// PageConfig, so nothing in the app ever read or rendered them. The contact
// line below replaces it with the same information as real, editable,
// printing document content -- which is the right call regardless, since a
// resume's contact details ARE content and belong on the page.
//
// Note that the ORIGINAL argument recorded here was partly about avoiding a
// visible `Frontmatter (N lines)` box in the canvas. That box no longer
// exists (see milkdown/nodes/frontmatter.ts), so adding page-config
// frontmatter to this template is now purely a question of whether it needs
// non-default page settings -- it does not; Letter/1in is already what it
// renders at.
//
// Email uses an explicit `[text](mailto:...)` link rather than a bare
// autolink literal: the explicit form is already proven to round-trip
// byte-identically by the cover-letter template, whereas a bare
// `you@example.com` depends on remark-gfm's autolink-literal serializer being
// present in Milkdown's own stringify extensions, which is not worth betting
// the byte-identity pin on. example.com (RFC 2606) and the 555-01xx range
// (reserved for fiction) are deliberate and must stay.
export const RESUME_TEMPLATE = `# Your Name

[your.name@example.com](mailto:your.name@example.com) · (555) 012-3456 · City, State

## Experience

### Job Title — Company Name

_Start Year – Present_

Describe what you owned and what it produced. Lead with the outcome — scope, scale, or a number carries further than a list of responsibilities.

### Previous Job Title — Previous Company

_Start Year – End Year_

A second entry, shorter than the first. Older roles earn less space than recent ones.

## Skills

List the tools, methods, and domains you want to be found for, separated by commas.

## Education

**Degree, Field of Study** — School Name, Year
`
