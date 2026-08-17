// The COMPOSER TARGET highlight: while the Insert-link or Add-comment
// composer holds DOM focus, this paints the range that composer is about to
// act on.
//
// WHY THIS EXISTS, and why the obvious fix does not work. FloatingCard.tsx
// takes real DOM focus -- it has to, being an input the user types into --
// and Gate 43 measured the consequence directly rather than inferring it: its
// first draft read the selection box AFTER opening the composer and failed in
// 881ms on `expect(selectionBox).not.toBeNull()`, because once an <input>
// holds focus, `window.getSelection()` reports THAT input's own collapsed
// selection. The contenteditable's range is therefore not merely painted in
// Chromium's muted unfocused grey -- it is GONE from the DOM Selection API.
// So a `::selection` rule is dead CSS: there is no selection left for it to
// style. That one-liner was written, committed, and reverted (e56b10e,
// "Revert the ::selection rule: the selection is destroyed, not unfocused");
// do not re-attempt it. A decoration is the only thing that can paint a range
// the browser no longer considers selected, which is exactly why
// FloatingCard's own note names this machinery by file.
//
// Modelled on find-plugin.ts, this codebase's canonical decoration plugin
// (page-guide-plugin.ts is the other), and it keeps that file's hard rules:
//
//  - Nothing here calls `view.focus()`, in either direction. Focus must stay
//    in the composer's field; stealing it back would close the composer's own
//    reason to exist. Asserted directly in this file's tests, since none of
//    the decoration assertions would fail if a stray focus() were added.
//  - Every transaction this plugin causes is META-ONLY and ZERO-STEP
//    (`docChanged: false`, no `storedMarksSet`), so opening or closing a
//    composer can never trip MilkdownEditor's `editedSinceMountRef` and mark a
//    clean document dirty. Also asserted directly.
//  - NOTHING NOTIFIES REACT AT ALL, so there is no `view: () => ({ update })`
//    hook here and the "never notify from `apply`" rule is satisfied
//    vacuously rather than carefully. That is a real simplification over
//    find-plugin, not an omission: the find plugin reports its match count
//    back out because only it can know that number, whereas the composer-open
//    flag ORIGINATES in React (appStore's `linkComposerOpen`/
//    `commentComposerOpen`) and flows strictly one way in. This plugin is a
//    pure sink, so it also has no convergence loop to make converge -- see
//    find-plugin's own two-round argument for what that costs when it exists.
//
// THE HIGHLIGHTED RANGE IS THE LIVE `state.selection`, NOT A SNAPSHOT TAKEN
// WHEN THE COMPOSER OPENED, and that is the load-bearing design decision in
// this file. Both composers dispatch through commands that read
// `view.state.selection` at SUBMIT time (addCommentCommand, insertLink's
// toggle-vs-update branch), so deriving the highlight from the same place
// makes "what is painted" and "what will be acted on" the same question asked
// once -- the identical reasoning editor-commands.ts's insertLink gives for
// branching on `markActive` rather than a hand-rolled `rangeHasMark`. A
// snapshot would need position mapping through every intervening transaction
// to stay correct, and would still be free to disagree with the command after
// all that work. Reading live also degrades honestly: the canvas stays live
// and clickable behind an open composer (FloatingCard is `role="group"`, not
// `dialog`, precisely because it traps nothing), so a user who clicks into
// the text collapses the selection -- and the highlight correctly disappears,
// because at that moment there is genuinely nothing for the composer to
// attach to.
//
// The CSS lives in src/renderer/src/assets/base.css, NEVER in
// src/typography/document-typography.css -- that file is shared verbatim with
// the sandboxed pagination render context, where an editor-only highlight
// would be PRINTED. Same rule and same reason as .pagedown-find-match,
// .pagedown-comment-mark, .pagedown-slash-query and .pagedown-page-guide.

import { Plugin, PluginKey, type EditorState } from '@milkdown/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/prose/view'

/**
 * The one class this plugin ever emits. Exported so base.css's rule and this
 * file's tests name the same string rather than two hand-copied copies of it
 * -- the same "declare the pair together" reasoning page-guide-plugin's own
 * BLOCK_INDEX_ATTRIBUTE / BLOCK_INDEX_HAST_PROPERTY constants are declared
 * for.
 */
export const COMPOSER_TARGET_CLASS = 'pagedown-composer-target'

export interface ComposerTargetState {
  /** Whether a composer popover is currently open over this editor. */
  active: boolean
  decorations: DecorationSet
}

export const composerTargetPluginKey = new PluginKey<ComposerTargetState>('pagedownComposerTarget')

// One shared inactive value rather than a fresh object per transaction: while
// no composer is open (i.e. essentially always) this plugin's state is
// referentially stable, so nothing downstream of it ever sees a change.
const INACTIVE: ComposerTargetState = { active: false, decorations: DecorationSet.empty }

function buildDecorations(state: EditorState): DecorationSet {
  const { from, to, empty } = state.selection
  // A collapsed caret has nothing to show, and Decoration.inline over a
  // zero-width range would be meaningless anyway. This is also the honest
  // rendering of the state both composers' own commands refuse from: an empty
  // selection is exactly what addCommentCommand returns false for.
  if (empty || from >= to) return DecorationSet.empty
  return DecorationSet.create(state.doc, [
    Decoration.inline(from, to, { class: COMPOSER_TARGET_CLASS })
  ])
}

/**
 * Built per MOUNT (in MilkdownEditor.tsx, alongside findProse/selectionProse)
 * rather than added to the static EDITOR_COMMAND_PLUGINS list -- not because
 * it needs a per-mount callback the way createFindPlugin does (it takes none
 * at all), but because a Plugin instance carries per-view state and must not
 * be shared across two live editors.
 */
export function createComposerTargetPlugin(): Plugin {
  return new Plugin<ComposerTargetState>({
    key: composerTargetPluginKey,
    state: {
      init: () => INACTIVE,
      apply: (tr, prev, _oldState, newState) => {
        const meta = tr.getMeta(composerTargetPluginKey) as boolean | undefined
        // `??`, not `||`: `meta` is legitimately `false` (the close signal),
        // and `false || prev.active` would silently ignore every close.
        const active = meta ?? prev.active
        // Nothing that could move or reveal the highlight: no open/close
        // signal, no document change, and no selection change. `selectionSet`
        // covers an explicitly dispatched selection; a docChanged transaction
        // maps the selection with it, which is why both are checked.
        if (meta === undefined && !tr.docChanged && !tr.selectionSet) return prev
        if (!active) return prev.active ? INACTIVE : prev
        return { active: true, decorations: buildDecorations(newState) }
      }
    },
    props: {
      decorations: (state) =>
        composerTargetPluginKey.getState(state)?.decorations ?? DecorationSet.empty
    }
  })
}

/**
 * The single entry point: tell this editor whether a composer popover is open
 * over it. Idempotent -- dispatching the value the plugin already holds is
 * skipped entirely, the same no-op guard applyPageGuides uses, so a React
 * effect that re-runs for an unrelated reason costs nothing and produces no
 * transaction at all.
 *
 * Deliberately does NOT call `view.focus()`. Focus belongs to the composer's
 * field for as long as it is open; taking it back here would defeat the whole
 * surface. The transaction it does dispatch is meta-only and zero-step, so it
 * has `docChanged: false` and no `storedMarksSet` and therefore cannot trip
 * MilkdownEditor's `editedSinceMountRef`. Both properties are load-bearing
 * and both are asserted in composer-target-plugin.test.ts.
 */
export function setComposerTargetIn(view: EditorView, active: boolean): void {
  if ((composerTargetPluginKey.getState(view.state)?.active ?? false) === active) return
  view.dispatch(view.state.tr.setMeta(composerTargetPluginKey, active))
}
