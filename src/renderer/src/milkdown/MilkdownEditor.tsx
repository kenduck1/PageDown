import { useEffect, useRef } from 'react'
import { Editor, rootCtx, defaultValueCtx, remarkStringifyOptionsCtx } from '@milkdown/core'
import { commonmark } from '@milkdown/preset-commonmark'
import { gfm } from '@milkdown/preset-gfm'
import { listener, listenerCtx } from '@milkdown/plugin-listener'
import { frontmatterRemark, frontmatterNode } from './nodes/frontmatter'
import { pagebreakRemark, pagebreakRemarkToMarkdown, pagebreakNode } from './nodes/pagebreak'
import { PINNED_STRINGIFY_OPTIONS } from './stringify-options'

interface MilkdownEditorProps {
  content: string
  onChange: (markdown: string) => void
  onError: (message: string) => void
}

function MilkdownEditor({ content, onChange, onError }: MilkdownEditorProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
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

  useEffect(() => {
    const root = rootRef.current
    if (!root) return

    let editor: Editor | undefined
    let cancelled = false

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
      .create()
      .then((created) => {
        if (cancelled) {
          void created.destroy()
          return
        }
        editor = created
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          onError(err instanceof Error ? err.message : String(err))
        }
      })

    return () => {
      cancelled = true
      if (editor) void editor.destroy()
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

export default MilkdownEditor
