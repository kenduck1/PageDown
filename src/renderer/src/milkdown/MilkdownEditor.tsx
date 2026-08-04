import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { Editor, rootCtx, defaultValueCtx, remarkStringifyOptionsCtx } from '@milkdown/core'
import { commonmark } from '@milkdown/preset-commonmark'
import { gfm } from '@milkdown/preset-gfm'
import { listener, listenerCtx } from '@milkdown/plugin-listener'
import { $prose, getMarkdown } from '@milkdown/utils'
import { Plugin } from '@milkdown/prose/state'
import { frontmatterRemark, frontmatterNode } from './nodes/frontmatter'
import { pagebreakRemark, pagebreakRemarkToMarkdown, pagebreakNode } from './nodes/pagebreak'
import { PINNED_STRINGIFY_OPTIONS } from './stringify-options'

interface MilkdownEditorProps {
  content: string
  onChange: (markdown: string) => void
  onError: (message: string) => void
}

export interface MilkdownEditorHandle {
  // Reads the editor's CURRENT document and serializes it right now,
  // bypassing @milkdown/plugin-listener's internal 200ms debounce entirely
  // (see CLAUDE.md's "Quirk" note on markdownUpdated). Callers that need
  // the true up-to-date markdown for a one-off read -- Save, in particular
  // -- must use this instead of trusting onChange to have already landed.
  //
  // Returns null in TWO distinct cases, deliberately collapsed into one
  // signal because every current caller (EditorScreen's Save handler) only
  // ever wants to know "is there anything new to sync into the store right
  // now": (1) the editor hasn't finished mounting yet, or (2) the editor
  // has mounted but no real edit (a transaction with `docChanged` or
  // `storedMarksSet`, tracked by the editedTrackerProse plugin below) has
  // happened since mount. Case (2) matters because Milkdown's own
  // remark-stringify serialization is not always byte-identical to the
  // original `content` prop even with zero edits (verified: it silently
  // rewrites e.g. `*`-bullets/single-asterisk emphasis/`~~~` fences to the
  // canonical form pinned in stringify-options.ts, and always normalizes a
  // missing trailing newline) -- gating on a real edit having occurred is
  // what keeps clicking Save on an untouched document a true no-op instead
  // of silently rewriting the file to Milkdown's canonical markdown form.
  // See this sub-project's task-8-report.md for the verified finding.
  getMarkdown: () => string | null
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
    // This project currently wires no undo/redo (`prosemirror-history` is
    // not used anywhere in src/), so there is no real edit path that could
    // ever set `addToHistory: false` and get silently excluded here; if
    // undo/redo is added later, re-verify this exclusion still can't hide a
    // genuine content change.
    const editedSinceMountRef = useRef(false)
    // Edits fire through whichever onChange was current at mount time
    // otherwise -- captured in a ref so the listener callback (registered
    // once, at construction) always calls the latest prop without needing to
    // tear down and rebuild the whole editor when the parent re-renders with
    // a new function identity. Assigned inside an effect (not inline during
    // render) per eslint-plugin-react-hooks' react-hooks/refs rule -- mutating
    // ref.current during render is flagged even for this "latest ref" pattern.
    const onChangeRef = useRef(onChange)
    useEffect(() => {
      onChangeRef.current = onChange
    })

    useImperativeHandle(ref, () => ({
      getMarkdown: () =>
        editorRef.current && editedSinceMountRef.current
          ? editorRef.current.action(getMarkdown())
          : null
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
        .use(commonmark)
        .use(gfm)
        .use(frontmatterRemark)
        .use(frontmatterNode)
        .use(pagebreakRemark)
        .use(pagebreakRemarkToMarkdown)
        .use(pagebreakNode)
        .use(listener)
        .use(editedTrackerProse)
        .create()
        .then((created) => {
          if (cancelled) {
            void created.destroy()
            return
          }
          editorRef.current = created
        })
        .catch((err: unknown) => {
          if (!cancelled) {
            onError(err instanceof Error ? err.message : String(err))
          }
        })

      return () => {
        cancelled = true
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
