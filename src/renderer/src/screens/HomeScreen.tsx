import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store/appStore'
import { useDocumentStore } from '../store/documentStore'
import { usePreferencesStore } from '../store/preferencesStore'
import { useThumbnail } from '../hooks/useThumbnail'
import { formatRelativeTime } from '../lib/formatRelativeTime'
import { RESUME_TEMPLATE } from '../templates/resume.md'
import { LETTER_TEMPLATE } from '../templates/letter.md'
import { REPORT_TEMPLATE } from '../templates/report.md'
import { COVER_LETTER_TEMPLATE } from '../templates/cover-letter.md'
import { MEETING_NOTES_TEMPLATE } from '../templates/meeting-notes.md'
import { INVOICE_TEMPLATE } from '../templates/invoice.md'
import { NEWSLETTER_TEMPLATE } from '../templates/newsletter.md'
import type { RecentFileEntry } from '../../../preload/index.d'
import { applyPageConfig } from '../../../markdown/page-config'
import { replaceRawFrontmatter } from '../../../markdown/frontmatter-splice'

interface Template {
  id: string
  title: string
  subtitle: string
  content?: string
}

const TEMPLATES: Template[] = [
  { id: 'blank', title: 'Blank', subtitle: 'Start from scratch' },
  { id: 'resume', title: 'Résumé', subtitle: 'One-page résumé', content: RESUME_TEMPLATE },
  { id: 'letter', title: 'Letter', subtitle: 'Formal letter', content: LETTER_TEMPLATE },
  { id: 'report', title: 'Report', subtitle: 'Report with a table', content: REPORT_TEMPLATE },
  {
    id: 'cover-letter',
    title: 'Cover Letter',
    subtitle: 'Job application letter',
    content: COVER_LETTER_TEMPLATE
  },
  {
    id: 'meeting-notes',
    title: 'Meeting Notes',
    subtitle: 'Agenda and action items',
    content: MEETING_NOTES_TEMPLATE
  },
  { id: 'invoice', title: 'Invoice', subtitle: 'Itemized invoice', content: INVOICE_TEMPLATE },
  {
    id: 'newsletter',
    title: 'Newsletter',
    subtitle: 'Multi-section newsletter',
    content: NEWSLETTER_TEMPLATE
  }
]

function TemplateCard({
  template,
  onSelect
}: {
  template: Template
  onSelect: () => void
}): React.JSX.Element {
  const thumbnail = useThumbnail(template.id, () =>
    template.content
      ? window.api.getTemplateThumbnail(template.content)
      : Promise.resolve({ dataUrl: '', pageCount: 0 })
  )

  return (
    <button
      onClick={onSelect}
      className="flex w-[168px] flex-col items-start rounded-md border border-border-subtle bg-page p-3 text-left shadow-flat"
    >
      <div className="mb-2 flex h-[140px] w-full items-center justify-center overflow-hidden rounded-sm bg-canvas">
        {thumbnail.dataUrl && (
          <img src={thumbnail.dataUrl} alt="" className="h-full w-full object-cover" />
        )}
      </div>
      <span className="text-12-5 font-semibold text-text-primary">{template.title}</span>
      <span className="text-11 text-text-tertiary">{template.subtitle}</span>
    </button>
  )
}

function RecentRow({
  entry,
  onSelect,
  onOpenInNewWindow
}: {
  entry: RecentFileEntry
  onSelect: () => void
  onOpenInNewWindow: () => void
}): React.JSX.Element {
  const thumbnail = useThumbnail(entry.filePath, () => window.api.getThumbnail(entry.filePath))
  const filename = entry.filePath.split(/[/\\]/).pop() ?? entry.filePath

  return (
    // A plain div, not a single row-wide <button> -- Multi-window support
    // added a SECOND, real action (Open in New Window) to this row, and
    // nesting one <button> inside another is invalid HTML. The main open
    // action and the new-window action are now two sibling buttons inside
    // this wrapper instead.
    <div className="flex w-full items-center gap-3 rounded-md px-2 py-2 hover:bg-accent/6">
      <button onClick={onSelect} className="flex flex-1 items-center gap-3 text-left">
        <div className="h-[52px] w-[40px] flex-shrink-0 overflow-hidden rounded-sm bg-canvas">
          {thumbnail.dataUrl && (
            <img src={thumbnail.dataUrl} alt="" className="h-full w-full object-cover" />
          )}
        </div>
        <div className="flex flex-1 flex-col">
          <span className="text-13 font-semibold text-text-primary">{filename}</span>
          <span className="text-11-5 text-text-tertiary">{thumbnail.pageCount ?? '—'} pages</span>
        </div>
      </button>
      <span className="text-11-5 text-text-tertiary">{formatRelativeTime(entry.editedAt)}</span>
      {/* Always visible (not opacity-0-until-hover) -- a hover-only reveal
      for the Split-mode divider was already found, this same session, to
      have a real discoverability problem in its resting state; this button
      stays subtle (text-tertiary) rather than invisible instead.

      Deliberately a GENERIC "Open in new window" label, not "Open
      {filename} in a new window" -- a real regression, not a style
      preference: the filename substring in this button's own name made it
      match the exact same bare `new RegExp(filename)` pattern nine
      pre-existing gate specs already use to click a recent-file row's
      MAIN open button (phase0/gate11/14/16/17/18/19/20/22/23), producing a
      genuine Playwright strict-mode ambiguity (two buttons, one name
      match) -- caught by gate14 failing for real, not a flake. A screen
      reader traversing this row already announces the filename via the
      main button immediately before this one, so a generic label here
      reads naturally in context, matching how many real apps label a
      per-row icon action. */}
      <button
        onClick={onOpenInNewWindow}
        title="Open in new window"
        aria-label="Open in new window"
        className="flex-shrink-0 rounded-sm p-1.5 text-text-tertiary hover:bg-accent/9 hover:text-text-primary"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="4" y="4" width="16" height="16" rx="2" />
          <path d="M14 4h6v6" />
          <path d="M20 4l-8 8" />
        </svg>
      </button>
    </div>
  )
}

function HomeScreen(): React.JSX.Element {
  const goEditor = useAppStore((state) => state.goEditor)
  const goSettings = useAppStore((state) => state.goSettings)
  const homeActiveSection = useAppStore((state) => state.homeActiveSection)
  const setHomeActiveSection = useAppStore((state) => state.setHomeActiveSection)
  const newDocument = useDocumentStore((state) => state.newDocument)
  const openFile = useDocumentStore((state) => state.openFile)
  const openPath = useDocumentStore((state) => state.openPath)
  const error = useDocumentStore((state) => state.error)
  const clearError = useDocumentStore((state) => state.clearError)
  const preferences = usePreferencesStore((state) => state.preferences)

  const [recentFiles, setRecentFiles] = useState<RecentFileEntry[]>([])
  const [recentFilter, setRecentFilter] = useState('')
  const templatesSectionRef = useRef<HTMLElement>(null)
  const recentSectionRef = useRef<HTMLElement>(null)

  useEffect(() => {
    window.api.getRecentFiles().then(setRecentFiles)
  }, [])

  // Only the PLAIN blank "New Document" case (content === undefined) gets
  // the user's own default page config applied -- a template already carries
  // its own deliberate frontmatter (or deliberately none), and layering a
  // global default on top would fight the template author's own choices
  // rather than respect them. `preferences` can genuinely still be null
  // here (App.tsx's own getPreferences() call hasn't resolved yet) --
  // falling through to plain empty content in that case is correct, not a
  // bug to guard against: it's exactly what "New Document" already did
  // before this feature existed, so a slow/failed preferences fetch degrades
  // to the pre-existing behavior rather than blocking document creation.
  const handleNewDocument = (content?: string): void => {
    if (content === undefined && preferences) {
      const rawYaml = applyPageConfig('', preferences.defaultPageConfig)
      newDocument(replaceRawFrontmatter('', rawYaml))
    } else {
      newDocument(content)
    }
    goEditor()
  }

  const handleNavClick = (section: 'recent' | 'templates'): void => {
    setHomeActiveSection(section)
    const target = section === 'recent' ? recentSectionRef.current : templatesSectionRef.current
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const handleOpenFile = async (): Promise<void> => {
    const loaded = await openFile()
    if (loaded) goEditor()
  }

  const handleOpenRecent = async (filePath: string): Promise<void> => {
    const loaded = await openPath(filePath)
    if (loaded) goEditor()
  }

  // Fire-and-forget, same rationale as every other one-shot IPC action in
  // this app that has no meaningful loading/error state of its own to
  // show (e.g. this component's own thumbnail requests) -- the new
  // window's own creation/load failures have nothing THIS window could
  // usefully surface anyway. Deliberately does NOT touch this window's own
  // state at all: it stays exactly where it was (Home), which is the
  // whole point of opening a second document in its OWN window rather than
  // navigating away from this one.
  const handleOpenInNewWindow = (filePath: string): void => {
    void window.api.openInNewWindow(filePath)
  }

  // Matches against the same basename RecentRow itself displays (not the
  // full path) -- filtering on a directory segment the user never sees
  // would be confusing when it silently included or excluded a row.
  const trimmedFilter = recentFilter.trim().toLowerCase()
  const filteredRecentFiles = trimmedFilter
    ? recentFiles.filter((entry) => {
        const filename = entry.filePath.split(/[/\\]/).pop() ?? entry.filePath
        return filename.toLowerCase().includes(trimmedFilter)
      })
    : recentFiles

  return (
    <div className="flex h-full bg-chrome-light font-sans text-text-primary">
      <nav className="flex w-[220px] flex-shrink-0 flex-col gap-1 border-r border-border-subtle p-4">
        <span className="mb-4 text-15 font-bold">PageDown</span>
        <button
          onClick={() => handleNewDocument()}
          className="mb-2 rounded-md bg-accent px-4 py-2 text-13 font-semibold text-on-accent"
        >
          New document
        </button>
        <button
          onClick={handleOpenFile}
          className="mb-4 rounded-md border border-border-subtle px-4 py-2 text-13 font-semibold text-text-primary"
        >
          Open file…
        </button>
        <button
          onClick={() => handleNavClick('recent')}
          className={`rounded-md px-3 py-2 text-left text-13 ${homeActiveSection === 'recent' ? 'bg-accent/9 font-semibold text-accent' : 'text-text-primary'}`}
        >
          Recent
        </button>
        <button
          onClick={() => handleNavClick('templates')}
          className={`rounded-md px-3 py-2 text-left text-13 ${homeActiveSection === 'templates' ? 'bg-accent/9 font-semibold text-accent' : 'text-text-primary'}`}
        >
          Templates
        </button>
        <button
          onClick={goSettings}
          className="rounded-md px-3 py-2 text-left text-13 text-text-primary"
        >
          Settings
        </button>
      </nav>

      <main className="flex-1 overflow-auto p-6">
        {error && (
          <div className="mb-4 flex items-center gap-3 text-13 text-red-600">
            <span>{error}</span>
            <button onClick={clearError} className="font-semibold">
              Dismiss
            </button>
          </div>
        )}

        <section ref={templatesSectionRef} className="mb-8">
          <h2 className="mb-3 text-11 font-bold uppercase tracking-[.05em] text-text-secondary">
            Start new
          </h2>
          <div className="flex flex-wrap gap-4">
            {TEMPLATES.map((template) => (
              <TemplateCard
                key={template.id}
                template={template}
                onSelect={() => handleNewDocument(template.content)}
              />
            ))}
          </div>
        </section>

        <section ref={recentSectionRef}>
          <div className="mb-3 flex items-center justify-between gap-4">
            <h2 className="text-11 font-bold uppercase tracking-[.05em] text-text-secondary">
              Recent
            </h2>
            {recentFiles.length > 0 && (
              <input
                type="text"
                value={recentFilter}
                onChange={(e) => setRecentFilter(e.target.value)}
                placeholder="Filter by filename…"
                aria-label="Filter recent documents"
                className="w-48 rounded-sm border border-border-subtle bg-page px-2 py-1 text-11-5 text-text-primary placeholder:text-text-tertiary"
              />
            )}
          </div>
          {recentFiles.length === 0 ? (
            <p className="text-13 text-text-tertiary">No recent documents yet</p>
          ) : filteredRecentFiles.length === 0 ? (
            <p className="text-13 text-text-tertiary">
              No recent documents match &ldquo;{recentFilter.trim()}&rdquo;
            </p>
          ) : (
            <div className="flex flex-col">
              {filteredRecentFiles.map((entry) => (
                <RecentRow
                  key={entry.filePath}
                  entry={entry}
                  onSelect={() => handleOpenRecent(entry.filePath)}
                  onOpenInNewWindow={() => handleOpenInNewWindow(entry.filePath)}
                />
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  )
}

export default HomeScreen
