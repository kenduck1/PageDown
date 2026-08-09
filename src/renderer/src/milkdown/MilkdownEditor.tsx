import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { Editor, rootCtx, defaultValueCtx, remarkStringifyOptionsCtx } from '@milkdown/core'
import { listener, listenerCtx } from '@milkdown/plugin-listener'
import { $prose, getMarkdown } from '@milkdown/utils'
import { Plugin } from '@milkdown/prose/state'
import { EDITOR_SCHEMA_PLUGINS } from './plugins'
import { EDITOR_COMMAND_PLUGINS } from './commands'
import { PINNED_STRINGIFY_OPTIONS } from './stringify-options'
import { buildEditorCommands, type EditorCommands } from './editor-commands'
import { createFindPlugin } from './find-plugin'
import { createDropImagePlugin } from './drop-image'
import { createSelectionPlugin, type SelectionSnapshot } from './selection-plugin'
import type { PageGeometry } from '../../../typography/page-geometry'
import type { DocumentStyle } from '../../../typography/document-style'

interface MilkdownEditorProps {
  content: string
  // The document's own real page geometry (computePageGeometry,
  // src/typography/page-geometry.ts), passed down rather than recomputed
  // here: EditorScreen already memoizes it per document, and the page card
  // this mount sits inside is sized from the very same object -- deriving it
  // twice would let the card and the text column disagree.
  geometry: PageGeometry
  // The document's own theme/font selection (resolveDocumentStyle,
  // src/typography/document-style.ts), passed down for the same reason
  // `geometry` is. Only `theme` and `fontFamily` are read here: the running
  // header/footer half of DocumentStyle has no meaning on this surface,
  // because the Milkdown canvas is ONE continuous card with no per-page
  // wrapper to hang a running header off. Headers/footers therefore appear
  // in the paginated preview, thumbnails and exported PDF, but not here --
  // a deliberate, documented asymmetry, not an oversight.
  documentStyle: DocumentStyle
  onChange: (markdown: string) => void
  onError: (message: string) => void
  // Fired by the find plugin whenever its match count or active index
  // actually changes -- including changes caused by a DOCUMENT edit rather
  // than by a new query, which is why this is a callback rather than a return
  // value on setFindState. Latest-ref captured below, exactly like
  // onChange/onError.
  onFindMatchesChanged?: (count: number, activeIndex: number) => void
  // Called once per real image file found in a native OS drop, in drop
  // order. Owned by the caller (EditorScreen wires it to
  // documentStore.saveDroppedImage) rather than this component reaching
  // into the store directly -- MilkdownEditor takes no window.api/store
  // dependency anywhere else, and this stays consistent with that. Latest-
  // ref captured below, same as onChange/onError/onFindMatchesChanged.
  onDropImage?: (file: File) => Promise<{ relativePath: string } | { error: string }>
  // Fired whenever the selection or its formatting state actually changes
  // (selection-plugin.ts's own sameSnapshot early-return decides "actually"),
  // and with `null` when this editor is destroyed so a stale bubble can't
  // outlive the instance it belongs to. Backs the selection bubble
  // (components/SelectionBubble.tsx) and EditorToolbar's live active-state.
  // Latest-ref captured below, exactly like every other callback prop here.
  onSelectionChanged?: (snapshot: SelectionSnapshot | null) => void
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
  function MilkdownEditor(
    {
      content,
      geometry,
      documentStyle,
      onChange,
      onError,
      onFindMatchesChanged,
      onDropImage,
      onSelectionChanged
    },
    ref
  ) {
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
    // Same latest-ref treatment, for the find plugin's match-count callback
    // -- constructed once inside the mount effect below (see findProse), so
    // it needs the same "always call the current prop" indirection as
    // onChange/onError rather than being rebuilt on every render.
    const onFindMatchesChangedRef = useRef(onFindMatchesChanged)
    // Same latest-ref treatment, for the drop-image plugin -- constructed
    // once inside the mount effect below (see dropImageProse), same
    // reasoning as onFindMatchesChangedRef above.
    const onDropImageRef = useRef(onDropImage)
    // Same latest-ref treatment, for the selection plugin -- constructed once
    // inside the mount effect below (see selectionProse), same reasoning as
    // onFindMatchesChangedRef above.
    const onSelectionChangedRef = useRef(onSelectionChanged)
    useEffect(() => {
      onChangeRef.current = onChange
      onErrorRef.current = onError
      onFindMatchesChangedRef.current = onFindMatchesChanged
      onDropImageRef.current = onDropImage
      onSelectionChangedRef.current = onSelectionChanged
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
      redo: () => commandsRef.current?.redo(),
      focusEnd: () => commandsRef.current?.focusEnd(),
      setFindState: (next) => commandsRef.current?.setFindState(next),
      replaceActiveMatch: (replacement) => commandsRef.current?.replaceActiveMatch(replacement),
      replaceAllMatches: (replacement) => commandsRef.current?.replaceAllMatches(replacement),
      toggleInlineCode: () => commandsRef.current?.toggleInlineCode(),
      getSelectedText: () => commandsRef.current?.getSelectedText() ?? '',
      getSelectionRect: () => commandsRef.current?.getSelectionRect() ?? null,
      addComment: (author, text) => commandsRef.current?.addComment(author, text) ?? false,
      resolveComment: (id) => commandsRef.current?.resolveComment(id)
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

      // Constructed per-mount (not in the static EDITOR_COMMAND_PLUGINS list)
      // because it closes over this mount's own latest-ref callback -- the
      // same reason editedTrackerProse above is built here.
      const findProse = $prose(() =>
        createFindPlugin((count, activeIndex) => {
          onFindMatchesChangedRef.current?.(count, activeIndex)
        })
      )

      // Same per-mount construction as findProse above, for the same reason.
      // Note this one reports through the ref even for its `null`
      // (destroy-time) call: that call happens during editor.destroy() inside
      // this effect's own cleanup, i.e. after React has already committed the
      // unmount, so reading the latest prop rather than a mount-time capture
      // is what keeps a remount (key={revision}) from clearing the bubble via
      // the OUTGOING instance's stale callback.
      const selectionProse = $prose(() =>
        createSelectionPlugin((snapshot) => {
          onSelectionChangedRef.current?.(snapshot)
        })
      )

      // Same per-mount construction as findProse above, for the same
      // reason -- closes over this mount's own latest-ref callbacks. Needs
      // `ctx` (unlike editedTrackerProse/findProse) to construct a real
      // image node via imageSchema.type(ctx), so this uses $prose's other
      // signature, (ctx) => Plugin, rather than the no-arg one.
      const dropImageProse = $prose((ctx) =>
        createDropImagePlugin(ctx, {
          onDropImage: (file) =>
            onDropImageRef.current
              ? onDropImageRef.current(file)
              : Promise.resolve({ error: 'Image drop is not available here.' }),
          onError: (message) => onErrorRef.current(message)
        })
      )

      Editor.make()
        .config((ctx) => {
          ctx.set(rootCtx, root)
          ctx.set(defaultValueCtx, content)
          ctx.set(remarkStringifyOptionsCtx, PINNED_STRINGIFY_OPTIONS)
          ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
            // Clearing editedSinceMountRef here (not just inside flush(),
            // below) is load-bearing, not cosmetic -- verified via a real
            // reproduced bug, not theorized. Without this, the ref tracks
            // "has there been ANY edit since mount" rather than "is there
            // an edit not yet synced to the store": after a normal edit
            // syncs through this debounced path, the ref stayed true
            // forever after (nothing else cleared it), so a LATER,
            // unrelated unmount (e.g. this same tab's content being
            // externally replaced by Page Setup's replaceContent, which
            // bumps revision and remounts a FRESH instance) would still
            // find the OUTGOING instance's ref true and have its cleanup
            // flush() unconditionally re-serialize and push that outgoing
            // instance's OWN (now-stale) document through onChange --
            // clobbering the fresh, externally-set content the instant
            // after it was set. Reproduced concretely: type into the
            // editor, let the 200ms debounce sync normally, then trigger a
            // revision bump via Page Setup Apply (adds a frontmatter
            // block) -- the frontmatter silently disappeared on the very
            // next remount, because the outgoing instance's belated flush
            // pushed its own pre-Page-Setup (frontmatter-less) snapshot
            // right after Apply had just set the correct one. Clearing the
            // ref here means flush() only ever fires for a genuinely
            // UNSYNCED edit (the original Save-race bug this mechanism
            // exists for -- see flush()'s own doc comment -- where the
            // user clicks Save/switches tabs within the 200ms window
            // before this callback has even run once), not a stale replay
            // of an edit that already made it to the store.
            editedSinceMountRef.current = false
            onChangeRef.current(markdown)
          })
        })
        .use(EDITOR_SCHEMA_PLUGINS.flat())
        .use(EDITOR_COMMAND_PLUGINS)
        .use(listener)
        .use(editedTrackerProse)
        .use(findProse)
        .use(selectionProse)
        .use(dropImageProse)
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

    // An inline max-width of geometry.contentWidthPx + mx-auto, NOT px-8 for
    // horizontal spacing: contentWidthPx is the page's real content-box
    // width after its own margins (computePageGeometry,
    // src/typography/page-geometry.ts) -- the exact same number the
    // pagination render context targets via its per-request @page rule, so
    // the two surfaces lay text out in identical-width boxes. It's an inline
    // style rather than the `max-w-[624px]` class this used to carry because
    // it now follows the document's own page size and margins (Page Geometry
    // Wiring sub-project); for a document with no frontmatter it still
    // resolves to exactly CONTENT_WIDTH_PX (624 = 816 - 96 - 96, Letter with
    // 1in margins), which is what Gate 10
    // (phase0/gate10-editor-layout-parity.spec.ts) measures against its own
    // no-frontmatter fixture. Horizontal ambient padding here would make the
    // actual rendered TEXT narrower than that (padding subtracts from the
    // box max-width constrains), silently reintroducing the width mismatch
    // that whole gate exists to catch -- Paged.js's own page-content box has
    // no equivalent extra inner padding beyond its page margin, which IS the
    // content-width boundary already. py-6 stays: vertical spacing doesn't
    // affect content WIDTH parity.
    //
    // pagedown-document: the shared document-typography.css scope class
    // (src/typography/document-typography.css) -- every selector in that
    // stylesheet is scoped under .pagedown-document specifically so its
    // bare tag rules (h1, p, ul, table, ...) don't leak into the app shell's
    // own chrome via base.css's global @layer base import. Removing this
    // class silently disables all of that file's rules for this mount.
    return (
      <div
        ref={rootRef}
        // pagedown-theme-*/pagedown-font-*: this surface's half of the
        // per-document theme/font rules in document-typography.css. The
        // sandboxed paginator sets the SAME two classes on its own <body>
        // (resources/pagination-render/index.ts's 'render' handler), which
        // is what keeps the two surfaces in typographic parity -- Gate 10
        // measures exactly that. `default`/`source-serif-4` deliberately
        // have no rules at all, so those two classes are inert by design.
        className={`milkdown-mount pagedown-document pagedown-theme-${documentStyle.theme} pagedown-font-${documentStyle.fontFamily} flow-root min-h-full mx-auto py-6`}
        // The native `dir` attribute, not a CSS `direction` override: it
        // also drives the browser's own bidi text-run resolution and list/
        // table mirroring, which a bare `direction:` CSS property does not
        // fully replicate. The sandboxed paginator sets the same attribute
        // on its own <body> (resources/pagination-render/index.ts).
        dir={documentStyle.direction}
        style={{ maxWidth: geometry.contentWidthPx }}
      />
    )
  }
)

export default MilkdownEditor
