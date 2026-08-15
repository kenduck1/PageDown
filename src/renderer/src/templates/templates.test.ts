import { describe, it, expect } from 'vitest'
import { getMarkdown } from '@milkdown/utils'
import { markdownToHtml } from '../../../markdown/pipeline'
import { createTestEditor } from '../milkdown/test-editor'
import { EDITOR_SCHEMA_PLUGINS } from '../milkdown/plugins'
import { RESUME_TEMPLATE } from './resume.md'
import { LETTER_TEMPLATE } from './letter.md'
import { REPORT_TEMPLATE } from './report.md'
import { COVER_LETTER_TEMPLATE } from './cover-letter.md'
import { MEETING_NOTES_TEMPLATE } from './meeting-notes.md'
import { INVOICE_TEMPLATE } from './invoice.md'
import { NEWSLETTER_TEMPLATE } from './newsletter.md'

// Same composition MilkdownEditor.tsx actually mounts -- see plugins.ts's own
// comment and round-trip.test.ts's precedent for why this must stay a
// literal copy of EDITOR_SCHEMA_PLUGINS rather than a hand-filtered subset.
const PLUGINS = EDITOR_SCHEMA_PLUGINS.flat()

// One list, used by every it.each below. There is no separate manifest to
// keep in sync -- HomeScreen.tsx's own TEMPLATES array is the registry -- so
// a template added there and forgotten here is silently untested; keeping a
// single list here at least makes that one edit rather than three.
const ALL_TEMPLATES: [string, string][] = [
  ['resume', RESUME_TEMPLATE],
  ['letter', LETTER_TEMPLATE],
  ['report', REPORT_TEMPLATE],
  ['cover letter', COVER_LETTER_TEMPLATE],
  ['meeting notes', MEETING_NOTES_TEMPLATE],
  ['invoice', INVOICE_TEMPLATE],
  ['newsletter', NEWSLETTER_TEMPLATE]
]

// Every top-level frontmatter key PageDown itself owns and renders, read off
// applyPageConfig's own emitted key list in src/markdown/page-config.ts.
// Anything outside this set parses as YAML and then does nothing at all --
// see the frontmatter test below for why that matters.
const PAGE_CONFIG_KEYS = new Set([
  'page',
  'orientation',
  'margins',
  'header',
  'footer',
  'footerLeft',
  'footerCenter',
  'footerRight',
  'headerLeft',
  'headerCenter',
  'headerRight',
  'customWidth',
  'customHeight',
  'fontFamily',
  'fontSize',
  'pageNumberFormat',
  'theme',
  'direction'
])

// Top-level keys of a template's leading `---` block, or [] if it has none.
// Deliberately a line scan rather than js-yaml: only the top-level key names
// are wanted, and an indented line (margins' nested per-side block) is a
// child of the key above it, not a key in its own right.
function frontmatterKeys(template: string): string[] {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(template)
  if (!match) return []
  return match[1]
    .split('\n')
    .filter((line) => /^[A-Za-z]/.test(line))
    .map((line) => line.slice(0, line.indexOf(':')))
}

async function roundTrip(markdown: string): Promise<string> {
  const editor = await createTestEditor(markdown, PLUGINS)
  const result = editor.action(getMarkdown())
  await editor.destroy()
  return result
}

describe('template starter content', () => {
  it.each(ALL_TEMPLATES)(
    '%s template parses without throwing and produces non-empty HTML',
    (_name, template) => {
      expect(() => markdownToHtml(template)).not.toThrow()
      const { html } = markdownToHtml(template)
      expect(html.length).toBeGreaterThan(0)
    }
  )

  // The resume template used to ship a four-key frontmatter block
  // (name/email/phone/location). NONE of those keys exist in PageConfig, so
  // nothing in the app ever read or rendered them -- inert keys in the user's
  // own file, duplicating a heading and contact line that already said the
  // same thing. It is deleted, and this pins that directly rather than only
  // via the generic check below, which a re-added block of inert keys would
  // fail anyway but less legibly.
  //
  // (The original reasoning also cited a visible `Frontmatter (4 lines)` box
  // in the canvas. That box no longer exists -- see
  // milkdown/nodes/frontmatter.ts -- so this test now pins only the "no inert
  // keys" half, which stands on its own.)
  //
  // Note templates are deliberately exempt from the rule that a new blank
  // document only gets frontmatter when the user's saved default page config
  // genuinely differs from the built-in one -- a template is allowed to carry
  // its own considered page config. So this is NOT a ban on template
  // frontmatter; it is a ban on frontmatter the renderer cannot act on.
  it('resume template ships no frontmatter at all', () => {
    expect(RESUME_TEMPLATE.trimStart()).not.toMatch(/^---\n/)
  })

  it.each(ALL_TEMPLATES)(
    '%s template ships no frontmatter key the app cannot render',
    (_name, template) => {
      for (const key of frontmatterKeys(template)) {
        expect(PAGE_CONFIG_KEYS.has(key), `unrenderable frontmatter key: ${key}`).toBe(true)
      }
    }
  )

  // Placeholders are plain title case ("Your Name"), never bracketed
  // ("[Your Name]"), and that is a correctness constraint rather than a style
  // one: `mdast-util-to-markdown` escapes a leading `[` so it cannot be
  // misread as a link reference, so a bracketed placeholder comes back out of
  // a real Milkdown round trip as `\[Your Name]` -- the user's first edit
  // would inject a visible backslash into their own file. The byte-identity
  // block at the bottom of this file would also catch that, but only as an
  // inscrutable diff; this names the actual rule.
  //
  // The `(?!\()` lookahead exempts real links (`[text](url)`), and the {2,}
  // length floor exempts GFM task markers (`[ ]`, `[x]`), which are exactly
  // one character wide and which meeting-notes genuinely needs.
  it.each(ALL_TEMPLATES)('%s template uses no bracketed placeholder', (_name, template) => {
    expect(template).not.toMatch(/\[[^\]\n]{2,}\](?!\()/)
  })

  it('report template contains a GFM table', () => {
    expect(REPORT_TEMPLATE).toMatch(/\|.*\|.*\|/)
    expect(REPORT_TEMPLATE).toMatch(/\|\s*-+\s*\|/)
  })

  it('invoice template contains a GFM table of line items', () => {
    expect(INVOICE_TEMPLATE).toMatch(/\|.*\|.*\|/)
    expect(INVOICE_TEMPLATE).toMatch(/\|\s*-+\s*\|/)
  })

  it('meeting notes template contains real GFM task list items, checked and unchecked', () => {
    const { html } = markdownToHtml(MEETING_NOTES_TEMPLATE)
    expect(html).toContain('<input type="checkbox" disabled>')
    expect(html).toContain('<input type="checkbox" checked disabled>')
  })

  it('cover letter template is distinct starter content from the existing letter template', () => {
    expect(COVER_LETTER_TEMPLATE).not.toBe(LETTER_TEMPLATE)
  })
})

// A design recon measured that most of these templates weren't in
// PageDown's own canonical Markdown form -- a user creates a document from
// one, types one character, and Milkdown's serializer silently reformats
// the whole file on the next flush. These templates' shipped bytes are now
// deliberately authored to already match what createTestEditor +
// EDITOR_SCHEMA_PLUGINS.flat() + getMarkdown() produces, so this asserts
// that stays true rather than only hoping it does. ALL SEVEN are covered
// now: meeting-notes and newsletter used to be excluded because their tight
// lists came back loose (Milkdown dropped mdast `spread` on serialize), and
// that exclusion is gone with the gap -- see list-spread-fix.ts. Neither
// template's content was changed to make this pass; the serializer was
// fixed. meeting-notes additionally exercises GFM task-list `checked` state,
// which the same fix nearly destroyed and which is pinned here as a result.
//
// This is also the safety net for the de-personalisation pass: every
// placeholder in every template was chosen from what round-trips
// byte-identically, which is why they are plain text rather than the
// conventional `[Your Name]` form.
describe('template starter content round-trips byte-identically through Milkdown', () => {
  it.each(ALL_TEMPLATES)(
    '%s template is already in canonical Milkdown-serialized form',
    async (_name, template) => {
      const output = await roundTrip(template)
      expect(output).toBe(template)
    }
  )
})
