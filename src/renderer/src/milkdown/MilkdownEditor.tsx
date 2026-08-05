import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { Editor, rootCtx, defaultValueCtx, remarkStringifyOptionsCtx } from '@milkdown/core'
import { listener, listenerCtx } from '@milkdown/plugin-listener'
import { $prose, getMarkdown } from '@milkdown/utils'
import { Plugin } from '@milkdown/prose/state'
import { EDITOR_SCHEMA_PLUGINS } from './plugins'
import { EDITOR_COMMAND_PLUGINS } from './commands'
import { PINNED_STRINGIFY_OPTIONS } from './stringify-options'
import { buildEditorCommands, type EditorCommands } from './editor-commands'

interface MilkdownEditorProps {
  content: string
  onChange: (markdown: string) => void
  onError: (message: string) => void
}

// Extends EditorCommands (editor-commands.ts) with flush() -- the one
// method that stays defined here rather than there, since it depends on
// editedSinceMountRef, a piece of THIS component's own mount lifecycle, not
// just a live Editor instance the way every EditorCommands method is.
export interface MilkdownEditorHandle extends EditorCommands {
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
  //
  // The rest of this handle's methods (toggleBold, toggleHeading,
  // setParagraph, toggleBulletList/toggleOrderedList, insertLink,
  // insertTable, insertPageBreak, undo, redo) are documented on
  // EditorCommands (editor-commands.ts), which this interface extends --
  // see that file for the formatting-toolbar command surface's own
  // documentation, all of it unchanged by the fix-round move to a separate
  // file (done for eslint-plugin-react-refresh's `only-export-components`
  // rule, not for any behavioral reason).
  flush: () => void
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
    const commandsRef = useRef<EditorCommands | null>(null)

    useImperativeHandle(ref, () => ({
      flush: () => flushRef.current?.(),
      toggleBold: () => commandsRef.current?.toggleBold(),
      toggleItalic: () => commandsRef.current?.toggleItalic(),
      toggleHeading: (level) => commandsRef.current?.toggleHeading(level),
      setParagraph: () => commandsRef.current?.setParagraph(),
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
          // buildEditorCommands is the exact same function
          // MilkdownEditor.test.tsx calls directly against a raw test
          // Editor -- see its own module-level doc comment for why this
          // extraction exists (closing a real, verified mutation-testing
          // gap).
          commandsRef.current = buildEditorCommands(created)
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
