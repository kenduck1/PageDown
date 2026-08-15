import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup } from '@testing-library/react'
import { getMarkdown } from '@milkdown/utils'
import { editorViewCtx } from '@milkdown/core'
import type { EditorView } from '@milkdown/prose/view'
import { createTestEditor } from '../test-editor'
import { EDITOR_SCHEMA_PLUGINS } from '../plugins'
import { EDITOR_COMMAND_PLUGINS } from '../commands'
import { markdownToHtml } from '../../../../markdown/pipeline'

afterEach(() => {
  cleanup()
})

const SCHEMA_ONLY = EDITOR_SCHEMA_PLUGINS.flat()
const FULL = [...SCHEMA_ONLY, ...EDITOR_COMMAND_PLUGINS]

async function open(source: string, plugins = FULL): Promise<EditorView> {
  const editor = await createTestEditor(source, plugins)
  return editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView
}

async function roundTrip(source: string): Promise<string> {
  const editor = await createTestEditor(source, SCHEMA_ONLY)
  const result = editor.action(getMarkdown())
  await editor.destroy()
  return result
}

const TIGHT = '- [ ] alpha\n- [x] beta\n- plain bullet\n'
const LOOSE = '- [ ] alpha\n\n- [x] beta\n'

describe('task list items render a real checkbox in the canvas', () => {
  it('draws an <input type="checkbox"> per task item -- the control the canvas had none of', async () => {
    const view = await open(TIGHT)
    const boxes = view.dom.querySelectorAll<HTMLInputElement>(
      'li[data-item-type="task"] > input[type="checkbox"]'
    )
    expect(boxes).toHaveLength(2)
    expect(boxes[0].checked).toBe(false)
    expect(boxes[1].checked).toBe(true)
  })

  it('leaves an ordinary bullet completely alone -- no checkbox, no task marker', async () => {
    const view = await open(TIGHT)
    const items = Array.from(view.dom.querySelectorAll('li'))
    const plain = items.find((li) => !li.hasAttribute('data-item-type'))
    expect(plain).toBeDefined()
    expect(plain!.querySelector('input')).toBeNull()
    // The node view declines for a non-task item (returns undefined), which
    // prosemirror-view resolves by falling through to the schema's own toDOM.
    // Asserted as "no wrapper div was introduced" because that is the one
    // observable difference between the two rendering paths.
    expect(plain!.firstElementChild?.tagName).toBe('P')
  })

  it('keeps the data attributes the schema parseDOM reads back, so a copied item stays a task', async () => {
    const view = await open(TIGHT)
    const first = view.dom.querySelector('li[data-item-type="task"]')!
    expect(first.getAttribute('data-checked')).toBe('false')
    expect(first.getAttribute('data-list-type')).toBe('bullet')
    expect(first.getAttribute('data-label')).toBe('•')
  })
})

describe('the canvas checkbox is genuinely interactive', () => {
  // The whole reason nodes/task-item.ts uses a real <input> rather than a CSS
  // `::before` box: this assertion is possible at all. A drawn marker would
  // need "was the click inside the marker's rect", and this repo's test-setup
  // polyfills every rect API to all-zeros, so such a test would pass against
  // {0,0,0,0} and prove nothing.
  it('ticking an unchecked box rewrites the document to `- [x]`', async () => {
    const editor = await createTestEditor('- [ ] alpha\n', FULL)
    const view = editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView
    const box = view.dom.querySelector<HTMLInputElement>('input[type="checkbox"]')!

    box.checked = true
    box.dispatchEvent(new Event('change', { bubbles: true }))

    expect(editor.action(getMarkdown())).toBe('- [x] alpha\n')
    await editor.destroy()
  })

  it('un-ticking a checked box rewrites the document back to `- [ ]`', async () => {
    const editor = await createTestEditor('- [x] alpha\n', FULL)
    const view = editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView
    const box = view.dom.querySelector<HTMLInputElement>('input[type="checkbox"]')!

    box.checked = false
    box.dispatchEvent(new Event('change', { bubbles: true }))

    expect(editor.action(getMarkdown())).toBe('- [ ] alpha\n')
    await editor.destroy()
  })

  it('toggling only the second item leaves the first untouched', async () => {
    const editor = await createTestEditor('- [ ] alpha\n- [ ] beta\n', FULL)
    const view = editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView
    const boxes = view.dom.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')

    boxes[1].checked = true
    boxes[1].dispatchEvent(new Event('change', { bubbles: true }))

    expect(editor.action(getMarkdown())).toBe('- [ ] alpha\n- [x] beta\n')
    await editor.destroy()
  })

  it('re-renders the control from the document after a toggle, not from the click', async () => {
    // update() is what keeps the painted state and the document state from
    // drifting apart -- the DOM flips first (the browser does that), the
    // document follows, and update() then re-asserts the document's answer.
    const editor = await createTestEditor('- [ ] alpha\n', FULL)
    const view = editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView
    const box = view.dom.querySelector<HTMLInputElement>('input[type="checkbox"]')!

    box.checked = true
    box.dispatchEvent(new Event('change', { bubbles: true }))

    const after = view.dom.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    expect(after.checked).toBe(true)
    expect(view.dom.querySelector('li[data-item-type="task"]')!.getAttribute('data-checked')).toBe(
      'true'
    )
    await editor.destroy()
  })

  it('does not disturb round-trip fidelity for a document nobody touched', async () => {
    expect(await roundTrip(TIGHT)).toBe('- [ ] alpha\n- [x] beta\n- plain bullet\n')
  })
})

describe('task lists: the two surfaces agree', () => {
  // The Gate 10 question asked directly, exactly as nodes/image-size.test.ts
  // does it. Gate 10 pins the editor and the paginator at 0.000px, but its
  // REPORT_TEMPLATE fixture contains no lists at all, so it structurally
  // cannot catch a task-list divergence. jsdom has no layout engine either, so
  // what CAN be asserted here is the thing that actually decides the layout:
  // both surfaces render the SAME control element, and one shared CSS rule
  // (asserted below against the real stylesheet text) governs both.
  const CSS = readFileSync(
    join(__dirname, '../../../../typography/document-typography.css'),
    'utf8'
  )

  it('both surfaces render a real input[type=checkbox] for a task item', async () => {
    const paginated = markdownToHtml(TIGHT).html
    expect(paginated).toContain('<input type="checkbox" disabled>')
    expect(paginated).toContain('<input type="checkbox" checked disabled>')

    const view = await open(TIGHT)
    expect(view.dom.querySelectorAll('input[type="checkbox"]')).toHaveLength(2)
  })

  it('and a LOOSE task list too -- the paginated surface wraps those in <p>, the canvas always does', async () => {
    // The two surfaces differ structurally here (paginated: `<li><p><input>`;
    // canvas: `<li><input><div><p>`), which is exactly why the shared CSS uses
    // a descendant combinator on the paginated side. Pinned so a future
    // "simplification" to `>` on both cannot silently stop matching.
    const paginated = markdownToHtml(LOOSE).html
    expect(paginated).toMatch(/<li class="task-list-item">\s*<p><input type="checkbox"/)

    const view = await open(LOOSE)
    expect(view.dom.querySelectorAll('input[type="checkbox"]')).toHaveLength(2)
  })

  it('one stylesheet rule suppresses the list marker on BOTH surfaces', () => {
    // The user-visible half of the defect: a bullet was drawn next to (or
    // instead of) the checkbox. Both selectors must appear in the same rule --
    // matched together so a change to one that forgets the other fails here.
    expect(CSS).toMatch(
      /\.pagedown-document li\[data-item-type='task'\],\s*\.pagedown-document \.task-list-item \{[^}]*list-style-type: none/
    )
  })

  it('one stylesheet rule positions the control identically on BOTH surfaces', () => {
    expect(CSS).toMatch(
      /\.pagedown-document li\[data-item-type='task'\] > input\[type='checkbox'\],\s*\.pagedown-document \.task-list-item input\[type='checkbox'\] \{[^}]*position: absolute/
    )
  })

  it('takes the control out of the inline flow on both surfaces, which is what makes the text align', () => {
    // If either surface kept its checkbox in flow, that surface's item text
    // would start ~1em further along than the other's. There is exactly one
    // `position` declaration for the control and it is shared, so this cannot
    // be true of one surface only.
    const rule = /input\[type='checkbox'\] \{([^}]*)\}/.exec(CSS)?.[1] ?? ''
    expect(rule).toContain('position: absolute')
    expect(rule).toContain('inset-inline-start')
  })

  it('references no CSS custom property, so the sandbox :root block needs no new entry', () => {
    const block = CSS.slice(CSS.indexOf('GFM TASK LISTS'))
    expect(block).not.toContain('var(')
  })
})
