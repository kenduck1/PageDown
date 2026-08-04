import { useState, type ReactElement, type RefObject } from 'react'
import { useAppStore } from '../store/appStore'
import { useDocumentStore } from '../store/documentStore'
import type { MilkdownEditorHandle } from '../milkdown/MilkdownEditor'

// The formatting toolbar described in docs/design-handoff/README.md's
// "Editor — shared chrome" section, item 3. This component is deliberately
// NOT mounted into EditorScreen.tsx yet -- see this sub-project's own task
// brief and CLAUDE.md's Milkdown section for why ("Still explicitly NOT
// built: ... formatting toolbar"). A future integration step wires
// `editorRef` to the real mounted MilkdownEditor and renders this above the
// canvas; for now it's built and tested against a fake ref standing in for
// that real editor instance.
export interface EditorToolbarProps {
  editorRef: RefObject<MilkdownEditorHandle | null>
}

// All icon paths below are adapted from docs/design-handoff/PageDown.dc.html's
// own real prototype markup (searched for `<svg` there) rather than drawn
// from scratch, per this task's brief -- kept at the spec's own 24x24
// viewBox / stroke-based / no-fill convention (small deviations noted per
// icon below where the source material itself isn't a pure outline shape).
function Icon({
  children,
  strokeWidth = 1.75
}: {
  children: ReactElement | ReactElement[]
  strokeWidth?: number
}): ReactElement {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

function ChevronDownIcon(): ReactElement {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  )
}

function ToolbarDivider(): ReactElement {
  return <div className="mx-1 h-5 w-px flex-none bg-border-subtle" aria-hidden="true" />
}

interface ToolbarIconButtonProps {
  label: string
  onClick?: () => void
  active?: boolean
  disabled?: boolean
  children: ReactElement
}

// 30x30 hit target / 6px radius, per the mockup's own spec (README's
// "All toolbar icon buttons: 30x30px hit target, 6px radius" line).
function ToolbarIconButton({
  label,
  onClick,
  active = false,
  disabled = false,
  children
}: ToolbarIconButtonProps): ReactElement {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      disabled={disabled}
      className={`flex h-[30px] w-[30px] flex-none items-center justify-center rounded-sm text-text-secondary transition-colors ${
        active ? 'bg-accent/14 text-accent' : 'hover:bg-chrome-light'
      } ${disabled ? 'cursor-not-allowed opacity-40' : ''}`}
    >
      {children}
    </button>
  )
}

type HeadingChoice = 'paragraph' | 1 | 2 | 3

function EditorToolbar({ editorRef }: EditorToolbarProps): ReactElement {
  const viewMode = useAppStore((state) => state.viewMode)
  const setViewMode = useAppStore((state) => state.setViewMode)
  const openPageSetup = useAppStore((state) => state.openPageSetup)
  const content = useDocumentStore((state) => state.content)
  const [isExporting, setIsExporting] = useState(false)
  // Local mirror of "which paragraph style is selected," independent of the
  // editor's own live selection (which nothing here tracks yet -- see the
  // <select>'s own comment below for why "Normal text" can't yet be a real
  // toggle-off).
  const [headingChoice, setHeadingChoice] = useState<HeadingChoice>('paragraph')

  const handleHeadingChange = (value: string): void => {
    if (value === 'paragraph') {
      // There is no live selection-state tracking wired into this toolbar
      // yet (that's a separate, larger "bubble menu / active formatting
      // state" feature this sub-project doesn't build -- see this
      // component's own module comment). MilkdownEditorHandle.toggleHeading
      // only clears a heading back to a paragraph when called with the
      // level that's ALREADY active; without knowing that live, there's no
      // level this toolbar could safely pass here that's guaranteed to be
      // the right one to clear. Left as a real, but currently inert,
      // dropdown option rather than guessing wrong and clearing/creating the
      // wrong heading level.
      setHeadingChoice('paragraph')
      return
    }
    const level = Number(value) as 1 | 2 | 3
    setHeadingChoice(level)
    editorRef.current?.toggleHeading(level)
  }

  const handleInsertLink = (): void => {
    const href = window.prompt('Link URL')
    if (href) editorRef.current?.insertLink(href)
  }

  const handleExportPdf = async (): Promise<void> => {
    if (isExporting) return
    setIsExporting(true)
    try {
      const result = await window.api.exportPdf(content)
      if (result) useDocumentStore.setState({ error: null })
    } catch (err) {
      useDocumentStore.setState({ error: err instanceof Error ? err.message : String(err) })
    } finally {
      setIsExporting(false)
    }
  }

  return (
    <div
      className="flex flex-none flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b border-border-subtle bg-page px-3.5 py-1.5"
      role="toolbar"
      aria-label="Formatting toolbar"
    >
      {/* Undo / redo */}
      <div className="flex items-center gap-0.5">
        <ToolbarIconButton label="Undo" onClick={() => editorRef.current?.undo()}>
          <Icon strokeWidth={1.8}>
            <path d="M7 7 3 11l4 4" />
            <path d="M3 11h11.5A5.5 5.5 0 0 1 20 16.5v0" />
          </Icon>
        </ToolbarIconButton>
        <ToolbarIconButton label="Redo" onClick={() => editorRef.current?.redo()}>
          <Icon strokeWidth={1.8}>
            <path d="M17 7l4 4-4 4" />
            <path d="M21 11H9.5A5.5 5.5 0 0 0 4 16.5v0" />
          </Icon>
        </ToolbarIconButton>
      </div>

      <ToolbarDivider />

      {/* Paragraph style / font family / font size. Font family and font
          size have no backing MilkdownEditorHandle command (this
          sub-project's brief scopes editing commands to bold/italic/
          heading/lists/link/table/pagebreak/undo/redo only) -- both selects
          below are real, interactive, native <select> elements, but
          intentionally unwired, matching the same "present but inert"
          treatment as the Find button. */}
      <div className="flex items-center gap-2">
        <div className="relative flex h-[30px] items-center">
          <select
            aria-label="Paragraph style"
            className="h-full appearance-none rounded-sm bg-transparent pl-2.5 pr-6 text-12-5 text-text-primary hover:bg-chrome-light"
            value={headingChoice === 'paragraph' ? 'paragraph' : String(headingChoice)}
            onChange={(e) => handleHeadingChange(e.target.value)}
          >
            <option value="paragraph">Normal text</option>
            <option value="1">Heading 1</option>
            <option value="2">Heading 2</option>
            <option value="3">Heading 3</option>
          </select>
          <span className="pointer-events-none absolute right-2 text-text-tertiary">
            <ChevronDownIcon />
          </span>
        </div>
        <div className="relative flex h-[30px] items-center">
          <select
            aria-label="Font family"
            className="h-full appearance-none rounded-sm bg-transparent pl-2.5 pr-6 font-serif text-12-5 text-text-primary hover:bg-chrome-light"
            defaultValue="Source Serif 4"
          >
            <option value="Source Serif 4">Source Serif 4</option>
            <option value="Sans">Sans</option>
          </select>
          <span className="pointer-events-none absolute right-2 text-text-tertiary">
            <ChevronDownIcon />
          </span>
        </div>
        <div className="relative flex h-[30px] items-center">
          <select
            aria-label="Font size"
            className="h-full appearance-none rounded-sm bg-transparent pl-2 pr-5 text-12-5 text-text-primary hover:bg-chrome-light"
            defaultValue="11"
          >
            {['9', '10', '11', '12', '14', '16', '18'].map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
          <span className="pointer-events-none absolute right-1.5 text-text-tertiary">
            <ChevronDownIcon />
          </span>
        </div>
      </div>

      <ToolbarDivider />

      {/* Bold / Italic / Underline / text color. Underline and text-color
          have no backing command -- Markdown has no native underline
          syntax, and this sub-project's brief doesn't scope a color-mark
          command -- so both stay real, present, but unwired buttons. */}
      <div className="flex items-center gap-0.5">
        <ToolbarIconButton label="Bold" onClick={() => editorRef.current?.toggleBold()}>
          <span className="text-14 font-bold leading-none">B</span>
        </ToolbarIconButton>
        <ToolbarIconButton label="Italic" onClick={() => editorRef.current?.toggleItalic()}>
          <span className="text-14 italic leading-none">I</span>
        </ToolbarIconButton>
        <ToolbarIconButton label="Underline">
          <span className="text-14 leading-none underline">U</span>
        </ToolbarIconButton>
        <ToolbarIconButton label="Text color">
          <span className="flex flex-col items-center gap-px">
            <span className="text-13 leading-none">A</span>
            <span className="h-[2.5px] w-3.5 rounded-full bg-accent" />
          </span>
        </ToolbarIconButton>
      </div>

      <ToolbarDivider />

      {/* Bullet / numbered / checkbox list -- the mockup renders these as
          three plain icon buttons side by side (verified against
          PageDown.dc.html's own markup: no chevron/dropdown panel actually
          exists for this group, despite the README's prose calling it a
          "dropdown group"), so that's what's built here. Checkbox list has
          no backing command (GFM task-list items aren't in this
          sub-project's command scope) and stays unwired. */}
      <div className="flex items-center gap-0.5">
        <ToolbarIconButton
          label="Bulleted list"
          onClick={() => editorRef.current?.toggleBulletList()}
        >
          <Icon strokeWidth={1.7}>
            <circle cx="4.5" cy="7" r="1.3" fill="currentColor" stroke="none" />
            <path d="M9 7h11" />
            <circle cx="4.5" cy="12" r="1.3" fill="currentColor" stroke="none" />
            <path d="M9 12h11" />
            <circle cx="4.5" cy="17" r="1.3" fill="currentColor" stroke="none" />
            <path d="M9 17h11" />
          </Icon>
        </ToolbarIconButton>
        <ToolbarIconButton
          label="Numbered list"
          onClick={() => editorRef.current?.toggleOrderedList()}
        >
          <Icon strokeWidth={1.7}>
            <text x="2" y="8.5" fontSize="7" stroke="none" fill="currentColor">
              1
            </text>
            <path d="M9 7h11" />
            <text x="2" y="13.5" fontSize="7" stroke="none" fill="currentColor">
              2
            </text>
            <path d="M9 12h11" />
            <text x="2" y="18.5" fontSize="7" stroke="none" fill="currentColor">
              3
            </text>
            <path d="M9 17h11" />
          </Icon>
        </ToolbarIconButton>
        <ToolbarIconButton label="Checklist">
          <svg
            width="15"
            height="15"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="2" y="2" width="10" height="10" rx="2" />
            <path d="M4.3 7.3l1.8 1.8L10 5.8" />
          </svg>
        </ToolbarIconButton>
      </div>

      <ToolbarDivider />

      {/* Link / image / table / split-cell / page-break. Image and
          split-cell have no backing command in this sub-project's scope and
          stay unwired, same treatment as Underline/text-color above. */}
      <div className="flex items-center gap-0.5">
        <ToolbarIconButton label="Insert link" onClick={handleInsertLink}>
          <Icon strokeWidth={1.8}>
            <path d="M9.5 14.5 14.5 9.5" />
            <path d="M11 7.5l1-1a3.5 3.5 0 0 1 5 5l-1 1" />
            <path d="M13 16.5l-1 1a3.5 3.5 0 0 1-5-5l1-1" />
          </Icon>
        </ToolbarIconButton>
        <ToolbarIconButton label="Insert image">
          <Icon strokeWidth={1.7}>
            <rect x="3.5" y="5" width="17" height="14" rx="2" />
            <circle cx="9" cy="10" r="1.4" />
            <path d="M4 16.5 9 12a2 2 0 0 1 2.7 0l5.3 4.7" />
          </Icon>
        </ToolbarIconButton>
        <ToolbarIconButton label="Insert table" onClick={() => editorRef.current?.insertTable()}>
          <Icon strokeWidth={1.7}>
            <rect x="3.5" y="5" width="17" height="14" rx="1.5" />
            <path d="M3.5 10.3h17" />
            <path d="M3.5 15.6h17" />
            <path d="M10 5v14" />
          </Icon>
        </ToolbarIconButton>
        <ToolbarIconButton label="Split cell">
          <Icon strokeWidth={1.7}>
            <rect x="3.5" y="4" width="7" height="5" rx="1" />
            <rect x="13.5" y="15" width="7" height="5" rx="1" />
            <path d="M7 9v3a2 2 0 0 0 2 2h1.5" />
            <path d="M14.5 14h-1a2 2 0 0 1-2-2v0" />
          </Icon>
        </ToolbarIconButton>
        <ToolbarIconButton
          label="Insert page break"
          onClick={() => editorRef.current?.insertPageBreak()}
        >
          <Icon strokeWidth={1.7}>
            <rect x="5" y="3" width="14" height="18" rx="1.5" />
            <path d="M6.5 12h3M14.5 12h3" />
            <path d="M11 10.3v3.4" />
          </Icon>
        </ToolbarIconButton>
      </div>

      {/* Find -- per docs/design-handoff/README.md's own "Not yet designed"
          list: "a search icon exists in the toolbar as a placeholder
          trigger only" (no find/replace panel exists to open). Deliberately
          unwired, matching the design handoff's own explicit call-out. */}
      <ToolbarIconButton label="Find">
        <Icon strokeWidth={1.8}>
          <circle cx="10.5" cy="10.5" r="6" />
          <path d="M19 19l-4.3-4.3" />
        </Icon>
      </ToolbarIconButton>

      {/* Right-aligned cluster: view-mode segmented control, page setup,
          Export PDF. */}
      <div className="ml-auto flex items-center gap-3.5">
        <div className="flex items-center gap-0.5 rounded-md bg-chrome-dark p-0.5">
          {(
            [
              {
                mode: 'format' as const,
                label: 'Format',
                icon: (
                  <Icon strokeWidth={1.6}>
                    <rect x="6" y="3.5" width="12" height="17" rx="1.5" />
                    <path d="M8.7 8h6.6M8.7 11h6.6M8.7 14h4" />
                  </Icon>
                )
              },
              {
                mode: 'split' as const,
                label: 'Split',
                icon: (
                  <Icon strokeWidth={1.6}>
                    <rect x="4" y="4.5" width="16" height="15" rx="1.5" />
                    <path d="M12 4.5v15" />
                  </Icon>
                )
              },
              {
                mode: 'source' as const,
                label: 'Source',
                icon: (
                  <Icon strokeWidth={1.7}>
                    <path d="M9 8.5 5.5 12 9 15.5" />
                    <path d="M15 8.5 18.5 12 15 15.5" />
                  </Icon>
                )
              }
            ] as const
          ).map(({ mode, label, icon }) => (
            <button
              key={mode}
              type="button"
              aria-pressed={viewMode === mode}
              onClick={() => setViewMode(mode)}
              className={`flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-12-5 ${
                viewMode === mode
                  ? 'bg-page text-text-primary shadow-flat'
                  : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              {icon}
              {label}
            </button>
          ))}
        </div>

        <ToolbarIconButton label="Page setup" onClick={openPageSetup}>
          <Icon strokeWidth={1.6}>
            <rect x="5" y="3" width="14" height="18" rx="1.5" />
            <rect x="7.5" y="6" width="9" height="12" rx="0.5" strokeDasharray="1.8 1.8" />
          </Icon>
        </ToolbarIconButton>

        <button
          type="button"
          onClick={() => void handleExportPdf()}
          disabled={isExporting}
          className="flex h-8 items-center gap-1.5 rounded-md bg-accent px-3.5 text-12-5 font-semibold text-on-accent transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Icon strokeWidth={1.9}>
            <path d="M12 3.5v11" />
            <path d="M8 11l4 4 4-4" />
            <path d="M5 18.5h14" />
          </Icon>
          {isExporting ? 'Exporting…' : 'Export PDF'}
        </button>
      </div>
    </div>
  )
}

export default EditorToolbar
