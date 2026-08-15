import { $prose } from '@milkdown/utils'
import { Plugin } from '@milkdown/prose/state'
import { closeHistory } from '@milkdown/prose/history'
import type { Node as ProseNode } from '@milkdown/prose/model'
import type {
  EditorView,
  NodeView,
  NodeViewConstructor,
  ViewMutationRecord
} from '@milkdown/prose/view'

// A GFM task list item (`- [ ] alpha`) rendered as a REAL, CLICKABLE checkbox
// in the Format canvas.
//
// THE DEFECT THIS CLOSES, both halves measured against the real code rather
// than inferred from the symptom (a user reported "why does the check box
// option create a bullet"):
//
//   - CANVAS: @milkdown/preset-gfm's `extendListItemSchemaForTask` toDOM emits
//     `<li data-item-type="task" data-checked="false">` -- and NO <input>
//     anywhere. It publishes the state as data attributes and expects a
//     consuming THEME to draw the control from them. This app imports no
//     Milkdown theme CSS at all (the same absence that once left ordinary
//     lists with no bullets and no indent, closed by document-typography.css's
//     own list rules), so nothing ever drew one. document-typography.css then
//     gave every `ul > li` `list-style-type: disc`, so a task item rendered as
//     an ordinary bullet -- exactly what was reported.
//   - PAGINATED (preview / PDF / print / HTML export): markdownToHtml emits a
//     genuinely DIFFERENT DOM -- `<ul class="contains-task-list">` /
//     `<li class="task-list-item"><input type="checkbox" disabled> alpha</li>`
//     -- a real checkbox, but nothing suppressed the list marker, so that
//     surface showed a bullet AND a checkbox.
//
// So the two surfaces disagreed in two different ways at once. The CSS half of
// the fix (marker suppression + checkbox geometry, shared by both surfaces)
// lives in src/typography/document-typography.css; this file is the canvas
// half -- the control that surface did not have at all.
//
// WHY A NODE VIEW WITH A REAL <input>, RATHER THAN A CSS-DRAWN `::before` BOX
// KEYED OFF `data-checked`. The pseudo-element is genuinely lighter (no schema
// touch, no reconciliation surface, no new plugin) and was the first design,
// but it loses on the two things that matter most here:
//
//   1. INTERACTIVITY. A checkbox that cannot be ticked is worse than a bullet.
//      A `::before` box is not a hit target of its own -- a click on it
//      reports the originating `<li>` as `event.target`, so toggling would
//      mean reconstructing "was this click inside the drawn marker?" from
//      `getBoundingClientRect` arithmetic against a box no API exposes. A real
//      <input> makes the hit target unambiguous (`event.target` IS the
//      control) and gets keyboard operation (focus + Space) for free from the
//      browser.
//   2. TESTABILITY. That geometry reconstruction is exactly what jsdom cannot
//      evaluate -- it has no layout engine, and this repo's own test-setup.ts
//      polyfills the rect APIs to ALL ZEROS (see selection-plugin.ts's jsdom
//      hazard note), so a unit test of a coordinate-based hit test would pass
//      against {0,0,0,0} and prove nothing. With a real <input> the toggle is
//      a plain `dispatchEvent` on a real element, and the assertion is about
//      document state, not pixels -- see task-item.test.ts.
//
// It also makes the two surfaces render the SAME ELEMENT (`input[type=
// checkbox]`), which is what lets one shared declaration block in
// document-typography.css size and position both. Two different mechanisms
// (a pseudo-element here, a real input there) would have to be kept
// numerically in sync by hand -- precisely the "name the element or it
// silently diverges" trap that file already documents at length.
//
// WHY THE CONTENT GOES IN A WRAPPER <div> RATHER THAN STRAIGHT IN THE <li>.
// ProseMirror reconciles the children of `contentDOM` against the node's own
// content and destroys anything it does not recognise, so a non-content
// <input> sitting inside contentDOM would be removed on the next update.
// `contentDOM` therefore has to be a dedicated element, with the input as its
// sibling. The wrapper is layout-neutral: it declares nothing, it has no
// border or padding so the inner <p>'s margins collapse straight through it to
// the <li> exactly as they do on the paginated surface, and `.pagedown-document
// :first-child { margin-top: 0 }` reaches the same conclusion either way
// because every element it could match here is already at margin-top: 0.
//
// WHY PLAIN LIST ITEMS ARE UNTOUCHED, AND HOW. `nodeViews` is keyed by node
// TYPE, so this constructor runs for every `list_item` in the document,
// including ordinary bullets. Returning `undefined` for those is not a
// convention this file invented -- prosemirror-view's own
// `NodeViewDesc.create` reads `let spec = custom && custom(...)` and then
// `else if (!dom) { DOMSerializer.renderSpec(node.type.spec.toDOM(node)) }`
// (read from prosemirror-view@1.42.2's source, not assumed), so declining is a
// real, supported path that falls straight through to the schema's own
// rendering. An ordinary bullet is byte-for-byte what it was before this file
// existed.

/** `checked` is null for an ordinary bullet, false/true for a task item. */
function isTaskItem(node: ProseNode): boolean {
  return node.attrs.checked === true || node.attrs.checked === false
}

class TaskItemView implements NodeView {
  readonly dom: HTMLLIElement
  readonly contentDOM: HTMLDivElement
  private readonly input: HTMLInputElement
  private node: ProseNode

  constructor(
    node: ProseNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined
  ) {
    this.node = node

    this.dom = document.createElement('li')
    // The same attribute set extendListItemSchemaForTask's own toDOM emits.
    // Restated rather than skipped because its PARSE side reads them back:
    // `parseDOM` matches `li[data-item-type="task"]` and recovers label /
    // listType / spread / checked from the dataset, which is the path a
    // copy-paste inside the editor (and any DOM-sourced content) takes. A node
    // view that dropped them would round-trip a copied task item as a plain
    // bullet -- silent data loss of exactly the kind list-spread-fix.ts
    // records for the sibling `checked`-destroying bug.
    this.dom.setAttribute('data-item-type', 'task')
    this.dom.setAttribute('data-label', String(node.attrs.label ?? '•'))
    this.dom.setAttribute('data-list-type', String(node.attrs.listType ?? 'bullet'))
    this.dom.setAttribute('data-spread', String(node.attrs.spread ?? 'false'))
    this.dom.setAttribute('data-checked', String(node.attrs.checked === true))

    this.input = document.createElement('input')
    this.input.type = 'checkbox'
    this.input.checked = node.attrs.checked === true
    // An editable island inside a contenteditable host: without this the
    // browser treats the control as editable content and a caret can land
    // inside it.
    this.input.contentEditable = 'false'
    // Named for assistive tech: the visible label is the item's own text,
    // which lives in a sibling element the control has no relationship to.
    this.input.setAttribute('aria-label', 'Toggle task')

    this.contentDOM = document.createElement('div')

    // Input FIRST so the DOM reading order (and therefore the accessibility
    // tree and tab order) is "checkbox, then its text", matching both the
    // paginated surface's own `<input> alpha` ordering and what the reader
    // sees. Visual order does not depend on this -- the control is positioned
    // out of flow in the list's marker gutter by document-typography.css.
    this.dom.appendChild(this.input)
    this.dom.appendChild(this.contentDOM)

    // `change`, not `click`: it is the one event that covers BOTH a pointer
    // click and the keyboard operation a focused checkbox gets natively
    // (Space), so keyboard users are not silently excluded. By the time it
    // fires the browser has already flipped `input.checked`, which is why the
    // failure path below has to put it back.
    this.input.addEventListener('change', this.onChange)
  }

  private readonly onChange = (): void => {
    const pos = this.getPos()
    if (pos == null) {
      // No position means this view is detached mid-update; the DOM already
      // flipped, so restore it rather than leaving the control showing a state
      // the document does not have.
      this.input.checked = this.node.attrs.checked === true
      return
    }
    const checked = this.input.checked
    // closeHistory so a tick is its own undo step rather than being merged
    // into whatever typing preceded it -- the same reasoning image-resize and
    // the slash menu already apply to their own discrete actions. A plain
    // (non-`addToHistory: false`) transaction is deliberate on the other axis
    // too: ticking a box genuinely rewrites `- [ ]` to `- [x]` in the file, so
    // it MUST mark the document dirty, which a real docChanged step does.
    const tr = closeHistory(this.view.state.tr)
    tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, checked })
    this.view.dispatch(tr)
  }

  update(node: ProseNode): boolean {
    // A node that stopped being a task item (or changed type) needs the
    // schema's own rendering back, which only a fresh NodeViewDesc can give;
    // returning false is how a node view asks to be replaced.
    if (node.type !== this.node.type || !isTaskItem(node)) return false
    this.node = node
    this.input.checked = node.attrs.checked === true
    this.dom.setAttribute('data-checked', String(node.attrs.checked === true))
    this.dom.setAttribute('data-label', String(node.attrs.label ?? '•'))
    this.dom.setAttribute('data-list-type', String(node.attrs.listType ?? 'bullet'))
    this.dom.setAttribute('data-spread', String(node.attrs.spread ?? 'false'))
    return true
  }

  // Everything that happens inside the checkbox is the browser's business, not
  // ProseMirror's: without this, PM's own mousedown handling moves the
  // selection and can swallow the click before `change` ever fires.
  stopEvent(event: Event): boolean {
    return event.target === this.input
  }

  // The checkbox is not part of the node's content, so its own attribute
  // mutations (`checked`, which we set from `update`) must never be read back
  // as a document edit.
  //
  // ViewMutationRecord, not MutationRecord: prosemirror-view widens it with a
  // synthetic `{ type: 'selection', target }` shape, which has none of a real
  // MutationRecord's fields -- `target` is the only member common to both, and
  // it is the only one read here.
  ignoreMutation(mutation: ViewMutationRecord): boolean {
    return !this.contentDOM.contains(mutation.target)
  }

  destroy(): void {
    this.input.removeEventListener('change', this.onChange)
  }
}

// DECLINING FOR A PLAIN BULLET IS A RUNTIME-SUPPORTED PATH THAT THE PUBLISHED
// TYPE DOES NOT DESCRIBE, hence the one cast in this file. `NodeViewConstructor`
// is declared as returning `NodeView` (not `NodeView | undefined`), but
// prosemirror-view@1.42.2's own `NodeViewDesc.create` reads
// `let spec = custom && custom(...)`, then `let dom = spec && spec.dom`, then
// `else if (!dom) { DOMSerializer.renderSpec(node.type.spec.toDOM(node)) }` --
// read from that package's source, not assumed. So an undefined return falls
// straight through to the schema's own rendering.
//
// The alternative (always return a view, building the plain-bullet case by
// hand from `node.type.spec.toDOM`) was rejected: it would put every ordinary
// list item in the document -- the overwhelming majority -- on a second,
// hand-written rendering path for no benefit, and a minimal object node view
// with no `update` would additionally force a full DOM rebuild on attribute
// changes the default path handles in place. Declining keeps plain bullets
// byte-for-byte on the path they were already on.
const taskItemNodeView = ((node, view, getPos) =>
  isTaskItem(node)
    ? new TaskItemView(node, view, getPos)
    : undefined) as unknown as NodeViewConstructor

export const taskItemViewProse = $prose(
  () => new Plugin({ props: { nodeViews: { list_item: taskItemNodeView } } })
)
