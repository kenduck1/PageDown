import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import {
  Editor,
  rootCtx,
  defaultValueCtx,
  remarkStringifyOptionsCtx,
  editorViewCtx
} from '@milkdown/core'
import { listener, listenerCtx } from '@milkdown/plugin-listener'
import { $prose, getMarkdown, callCommand } from '@milkdown/utils'
import { Plugin } from '@milkdown/prose/state'
import type { EditorView } from '@milkdown/prose/view'
import {
  toggleStrongCommand,
  toggleEmphasisCommand,
  wrapInHeadingCommand,
  wrapInBulletListCommand,
  wrapInOrderedListCommand,
  liftListItemCommand,
  toggleLinkCommand
} from '@milkdown/preset-commonmark'
import { insertTableCommand } from '@milkdown/preset-gfm'
import { EDITOR_SCHEMA_PLUGINS } from './plugins'
import {
  EDITOR_COMMAND_PLUGINS,
  undoCommand,
  redoCommand,
  insertPagebreakCommand
} from './commands'
import { PINNED_STRINGIFY_OPTIONS } from './stringify-options'

// True heading level 1-6 (`headingSchema`'s own `level` attr, from
// @milkdown/preset-commonmark's source), narrowed to 1-3 here because
// that's all the mockup's paragraph-style dropdown ("Normal text"/H1/H2/H3)
// exposes -- see EditorToolbar.tsx.
type ToggleableHeadingLevel = 1 | 2 | 3

// Walks up from the current selection's resolved position looking for an
// ancestor node of the given list type. Used to make toggleBulletList/
// toggleOrderedList genuine toggles: @milkdown/preset-commonmark's own
// wrapInBulletListCommand/wrapInOrderedListCommand (confirmed by reading
// their source, node/bullet-list.ts and node/ordered-list.ts) only ever
// WRAP -- they call ProseMirror's `wrapIn`, which has no "already wrapped,
// so lift back out" branch of its own. Without this check, clicking the
// bullet-list toolbar button a second time on an already-bulleted block
// would either no-op (wrapIn's own findWrapping guard rejects an invalid
// wrap) or nest a second list inside the first, neither of which is the
// toggle-off behavior a toolbar button implies.
function isInListType(view: EditorView, typeName: 'bullet_list' | 'ordered_list'): boolean {
  const { $from } = view.state.selection
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type.name === typeName) return true
  }
  return false
}

interface MilkdownEditorProps {
  content: string
  onChange: (markdown: string) => void
  onError: (message: string) => void
}

export interface MilkdownEditorHandle {
  // Synchronously serializes and pushes the editor's CURRENT document
  // through onChange -- IF AND ONLY IF a real edit has landed since mount
  // (tracked independently of @milkdown/plugin-listener's own internal
  // 200ms debounce; see editedSinceMountRef below). A no-op otherwise, so
  // it's always safe to call defensively. Two callers need this: Save
  // (EditorScreen), so a fast edit-then-save isn't silently dropped by the
  // debounce; and this component's own unmount cleanup, so a fast
  // edit-then-navigate-away isn't dropped by plugin-listener's destroy()
  // (which cancels its pending debounced call rather than flushing it --
  // confirmed by reading its source).
  //
  // The "only if a real edit happened" gate matters because Milkdown's own
  // remark-stringify serialization is not always byte-identical to the
  // original `content` prop even with zero edits (verified: it silently
  // rewrites e.g. `*`-bullets/single-asterisk emphasis/`~~~` fences to the
  // canonical form pinned in stringify-options.ts, and always normalizes a
  // missing trailing newline) -- gating on a real edit having occurred is
  // what keeps calling flush() on an untouched document a true no-op
  // instead of silently rewriting the file to Milkdown's canonical
  // markdown form. See this sub-project's task-8-report.md for the
  // verified finding.
  flush: () => void

  // --- Formatting-toolbar command surface ---------------------------------
  //
  // Everything below dispatches directly into the live Milkdown `Editor`
  // via `editor.action(callCommand(commandKey, payload))` -- verified
  // empirically (see commands.ts and this file's own imports) to be the
  // correct mechanism for calling a command from outside the editor's own
  // keymap/input-rule machinery, the same way MilkdownEditor.test.tsx's own
  // "API pattern verification" block already verifies @milkdown/plugin-
  // listener's behavior directly against a real Editor instance rather than
  // assuming its shape from memory. Each command key referenced here is a
  // REAL exported constant from @milkdown/preset-commonmark/@milkdown/
  // preset-gfm (or this project's own commands.ts for the three this
  // project had to define itself: undo/redo/insertPageBreak), confirmed by
  // reading each package's own .d.ts/.ts source under node_modules -- none
  // of these names were assumed from memory.
  //
  // All of these are no-ops (never throw) if called before the editor has
  // finished constructing or after it has been destroyed, matching flush()'s
  // own defensive-call contract above.

  // toggleStrongCommand -- a genuine ProseMirror `toggleMark`, so this is a
  // real toggle: bold text becomes un-bold, and vice versa.
  toggleBold: () => void
  // toggleEmphasisCommand -- same toggleMark-backed behavior as bold.
  toggleItalic: () => void
  // wrapInHeadingCommand is NOT a toggle by itself (confirmed by reading its
  // source: it always calls `setBlockType` to the given level, with no
  // "already this level, so revert to paragraph" branch) -- this method adds
  // that check itself: if the current block is already an `h{level}`,
  // it turns it back into a plain paragraph (wrapInHeadingCommand's own
  // documented level-0 behavior, per its source), otherwise it sets the
  // block to that heading level. Only levels 1-3 are exposed, matching the
  // mockup's paragraph-style dropdown (Normal text/H1/H2/H3).
  toggleHeading: (level: ToggleableHeadingLevel) => void
  // wrapInBulletListCommand also isn't a toggle by itself (it's a plain
  // ProseMirror `wrapIn`) -- this method adds the lift-back-out-if-already-
  // wrapped check via isInListType()/liftListItemCommand above.
  toggleBulletList: () => void
  // Same toggle treatment as toggleBulletList, for wrapInOrderedListCommand.
  toggleOrderedList: () => void
  // toggleLinkCommand -- a toggleMark over the link mark's {href, title}
  // attrs. Like bold/italic, applying this with an empty (collapsed)
  // selection sets a *stored* mark that only takes visible effect on the
  // next character typed, rather than rewriting any existing text -- the
  // same toggleMark characteristic bold/italic have, not a special case.
  insertLink: (href: string) => void
  // insertTableCommand, given `{ row: 2, col: 2 }` -- a minimal 2x2 table
  // (one header row + one body row, two columns; `row` counts the header
  // row, confirmed by reading @milkdown/preset-gfm's own createTable source).
  insertTable: () => void
  // insertPagebreakCommand (commands.ts) -- inserts this editor's own
  // existing pagebreak atom node (nodes/pagebreak.ts) at the current
  // selection, reusing the schema this editor already mounts rather than
  // introducing a second way to represent a page break.
  insertPageBreak: () => void
  // undoCommand/redoCommand (commands.ts) -- prosemirror-history's own
  // `undo`/`redo`, exposed as real Milkdown commands. Wiring in
  // prosemirror-history (via commands.ts's historyProse plugin) for the
  // first time in this project required re-verifying editedTrackerProse's
  // `addToHistory !== false` exclusion below still can't hide a genuine
  // content change -- see commands.ts's own comment for the verified
  // result (it can't: prosemirror-history's undo/redo transactions don't
  // set `addToHistory: false` on themselves).
  undo: () => void
  redo: () => void
}

const MilkdownEditor = forwardRef<MilkdownEditorHandle, MilkdownEditorProps>(
  function MilkdownEditor({ content, onChange, onError }, ref) {
    const rootRef = useRef<HTMLDivElement>(null)
    const editorRef = useRef<Editor | null>(null)
    // Set synchronously (inside a ProseMirror plugin's `apply`, not through
    // @milkdown/plugin-listener's debounced path) the first time a real
    // edit lands since this editor instance mounted. The predicate is the
    // exact same one plugin-listener's own `apply` checks before scheduling
    // its 200ms-debounced handler (confirmed by reading
    // node_modules/.pnpm/@milkdown+plugin-listener@7.21.3/.../lib/index.js):
    // `(tr.docChanged || tr.storedMarksSet) && tr.getMeta('addToHistory')
    // !== false`. The `addToHistory !== false` half is NOT optional --
    // verified empirically (see task-8-report.md) that without it, this
    // flag false-positives on every single mount: @milkdown/preset-commonmark
    // ships its own internal heading-ID-assignment plugin
    // (`MILKDOWN_HEADING_ID$`) that dispatches a synthetic post-mount
    // transaction with `docChanged: true` but `addToHistory: false` --
    // Milkdown's own convention (also relied on elsewhere in its source) for
    // "not a real user edit." Matching plugin-listener's full filter, not
    // just half of it, means this flag is true if and only if
    // plugin-listener would eventually fire markdownUpdated for the same
    // transaction -- a much stronger invariant than an ad-hoc predicate.
    // This project now wires real undo/redo (commands.ts's historyProse
    // plugin, backing MilkdownEditorHandle.undo()/redo() below) -- this
    // exclusion was re-verified against that, per this comment's own
    // earlier note that adding undo/redo later required re-checking it:
    // prosemirror-history's own undo/redo transactions (confirmed by
    // reading node_modules/.pnpm/prosemirror-history's source) never set
    // `addToHistory: false` on themselves, so a document-changing undo/redo
    // still has `docChanged: true` and `getMeta('addToHistory') !== false`
    // (it's `undefined`, not `false`) -- still correctly flips this flag,
    // exactly as a real edit should.
    const editedSinceMountRef = useRef(false)
    // Edits fire through whichever onChange was current at mount time
    // otherwise -- captured in a ref so the listener callback (registered
    // once, at construction) always calls the latest prop without needing to
    // tear down and rebuild the whole editor when the parent re-renders with
    // a new function identity. Assigned inside an effect (not inline during
    // render) per eslint-plugin-react-hooks' react-hooks/refs rule -- mutating
    // ref.current during render is flagged even for this "latest ref" pattern.
    const onChangeRef = useRef(onChange)
    // Same latest-ref treatment as onChangeRef above, applied to onError for
    // consistency -- harmless today only because every current caller
    // passes a referentially-stable onError, but there's no reason for the
    // two callback props to be handled inconsistently.
    const onErrorRef = useRef(onError)
    useEffect(() => {
      onChangeRef.current = onChange
      onErrorRef.current = onError
    })

    // Set once the editor has finished constructing (inside the mount
    // effect's `.then`, alongside `editorRef.current`); cleared on unmount.
    // Holds the actual flush logic so both the imperative handle and this
    // component's own unmount cleanup can share one implementation.
    const flushRef = useRef<(() => void) | null>(null)

    // Same "set once construction finishes, null otherwise" treatment as
    // flushRef, for the formatting-toolbar command surface -- a single
    // object of bound dispatch functions built once, right after
    // flushRef.current, inside the mount effect's `.then` below.
    const commandsRef = useRef<Omit<MilkdownEditorHandle, 'flush'> | null>(null)

    useImperativeHandle(ref, () => ({
      flush: () => flushRef.current?.(),
      toggleBold: () => commandsRef.current?.toggleBold(),
      toggleItalic: () => commandsRef.current?.toggleItalic(),
      toggleHeading: (level) => commandsRef.current?.toggleHeading(level),
      toggleBulletList: () => commandsRef.current?.toggleBulletList(),
      toggleOrderedList: () => commandsRef.current?.toggleOrderedList(),
      insertLink: (href) => commandsRef.current?.insertLink(href),
      insertTable: () => commandsRef.current?.insertTable(),
      insertPageBreak: () => commandsRef.current?.insertPageBreak(),
      undo: () => commandsRef.current?.undo(),
      redo: () => commandsRef.current?.redo()
    }))

    useEffect(() => {
      const root = rootRef.current
      if (!root) return

      let cancelled = false

      // A tiny custom ProseMirror plugin (via @milkdown/utils' `$prose`,
      // the same composable idiom nodes/frontmatter.ts and nodes/pagebreak.ts
      // already use for $nodeSchema/$remark) whose only job is flipping
      // editedSinceMountRef synchronously -- well before plugin-listener's
      // 200ms debounce could matter -- the first time a real edit occurs.
      // Constructed fresh per effect run so it closes over this mount's own
      // editedSinceMountRef (a brand-new ref every time the component
      // remounts via `key`, so no explicit reset is needed between
      // documents).
      const editedTrackerProse = $prose(
        () =>
          new Plugin({
            state: {
              init: () => null,
              apply: (tr) => {
                if ((tr.docChanged || tr.storedMarksSet) && tr.getMeta('addToHistory') !== false) {
                  editedSinceMountRef.current = true
                }
                return null
              }
            }
          })
      )

      Editor.make()
        .config((ctx) => {
          ctx.set(rootCtx, root)
          ctx.set(defaultValueCtx, content)
          ctx.set(remarkStringifyOptionsCtx, PINNED_STRINGIFY_OPTIONS)
          ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
            onChangeRef.current(markdown)
          })
        })
        .use(EDITOR_SCHEMA_PLUGINS.flat())
        .use(EDITOR_COMMAND_PLUGINS)
        .use(listener)
        .use(editedTrackerProse)
        .create()
        .then((created) => {
          if (cancelled) {
            void created.destroy()
            return
          }
          editorRef.current = created
          flushRef.current = () => {
            if (editedSinceMountRef.current) {
              const markdown = created.action(getMarkdown())
              editedSinceMountRef.current = false
              onChangeRef.current(markdown)
            }
          }
          commandsRef.current = {
            toggleBold: () => {
              created.action(callCommand(toggleStrongCommand.key))
            },
            toggleItalic: () => {
              created.action(callCommand(toggleEmphasisCommand.key))
            },
            toggleHeading: (level) => {
              created.action((ctx) => {
                const view = ctx.get(editorViewCtx)
                const currentBlock = view.state.selection.$from.parent
                const isSameLevel =
                  currentBlock.type.name === 'heading' && currentBlock.attrs.level === level
                // wrapInHeadingCommand's own documented behavior: a level
                // below 1 turns the block into a plain paragraph (see its
                // source in @milkdown/preset-commonmark) -- reused here as
                // the "toggle off" branch instead of a separate command.
                return callCommand(wrapInHeadingCommand.key, isSameLevel ? 0 : level)(ctx)
              })
            },
            toggleBulletList: () => {
              created.action((ctx) => {
                const view = ctx.get(editorViewCtx)
                if (isInListType(view, 'bullet_list')) {
                  return callCommand(liftListItemCommand.key)(ctx)
                }
                return callCommand(wrapInBulletListCommand.key)(ctx)
              })
            },
            toggleOrderedList: () => {
              created.action((ctx) => {
                const view = ctx.get(editorViewCtx)
                if (isInListType(view, 'ordered_list')) {
                  return callCommand(liftListItemCommand.key)(ctx)
                }
                return callCommand(wrapInOrderedListCommand.key)(ctx)
              })
            },
            insertLink: (href) => {
              created.action(callCommand(toggleLinkCommand.key, { href }))
            },
            insertTable: () => {
              // A minimal 2x2 table -- `row` includes the header row (see
              // insertTableCommand's own createTable helper source), so
              // `{ row: 2, col: 2 }` is one header row + one body row.
              created.action(callCommand(insertTableCommand.key, { row: 2, col: 2 }))
            },
            insertPageBreak: () => {
              created.action(callCommand(insertPagebreakCommand.key))
            },
            undo: () => {
              created.action(callCommand(undoCommand.key))
            },
            redo: () => {
              created.action(callCommand(redoCommand.key))
            }
          }
        })
        .catch((err: unknown) => {
          if (!cancelled) {
            onErrorRef.current(err instanceof Error ? err.message : String(err))
          }
        })

      return () => {
        cancelled = true
        flushRef.current?.()
        flushRef.current = null
        commandsRef.current = null
        if (editorRef.current) {
          void editorRef.current.destroy()
          editorRef.current = null
        }
      }
      // content/onError are intentionally excluded: this effect constructs
      // the editor exactly once per mount. The parent forces a fresh mount
      // (and thus a fresh read of `content`) by changing this component's
      // `key` on every externally-triggered document load -- see
      // documentStore's `revision` counter and EditorScreen's usage of it.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    return <div ref={rootRef} className="milkdown-mount flow-root min-h-full px-8 py-6" />
  }
)

export default MilkdownEditor
