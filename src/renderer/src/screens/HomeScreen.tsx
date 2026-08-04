import { useEffect, useState } from 'react'
import { useAppStore } from '../store/appStore'
import { useDocumentStore } from '../store/documentStore'
import { useThumbnail } from '../hooks/useThumbnail'
import { formatRelativeTime } from '../lib/formatRelativeTime'
import { RESUME_TEMPLATE } from '../templates/resume.md'
import { LETTER_TEMPLATE } from '../templates/letter.md'
import { REPORT_TEMPLATE } from '../templates/report.md'
import type { RecentFileEntry } from '../../../preload/index.d'

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
  { id: 'report', title: 'Report', subtitle: 'Report with a table', content: REPORT_TEMPLATE }
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
  onSelect
}: {
  entry: RecentFileEntry
  onSelect: () => void
}): React.JSX.Element {
  const thumbnail = useThumbnail(entry.filePath, () => window.api.getThumbnail(entry.filePath))
  const filename = entry.filePath.split('/').pop() ?? entry.filePath

  return (
    <button
      onClick={onSelect}
      className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-accent/6"
    >
      <div className="h-[52px] w-[40px] flex-shrink-0 overflow-hidden rounded-sm bg-canvas">
        {thumbnail.dataUrl && (
          <img src={thumbnail.dataUrl} alt="" className="h-full w-full object-cover" />
        )}
      </div>
      <div className="flex flex-1 flex-col">
        <span className="text-13 font-semibold text-text-primary">{filename}</span>
        <span className="text-11-5 text-text-tertiary">{thumbnail.pageCount ?? '—'} pages</span>
      </div>
      <span className="text-11-5 text-text-tertiary">{formatRelativeTime(entry.editedAt)}</span>
    </button>
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

  const [recentFiles, setRecentFiles] = useState<RecentFileEntry[]>([])

  useEffect(() => {
    window.api.getRecentFiles().then(setRecentFiles)
  }, [])

  const handleNewDocument = (content?: string): void => {
    newDocument(content)
    goEditor()
  }

  const handleOpenFile = async (): Promise<void> => {
    const loaded = await openFile()
    if (loaded) goEditor()
  }

  const handleOpenRecent = async (filePath: string): Promise<void> => {
    const loaded = await openPath(filePath)
    if (loaded) goEditor()
  }

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
          onClick={() => setHomeActiveSection('recent')}
          className={`rounded-md px-3 py-2 text-left text-13 ${homeActiveSection === 'recent' ? 'bg-accent/9 font-semibold text-accent' : 'text-text-primary'}`}
        >
          Recent
        </button>
        <button
          onClick={() => setHomeActiveSection('templates')}
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

        <section className="mb-8">
          <h2 className="mb-3 text-11 font-bold uppercase tracking-[.05em] text-text-secondary">
            Start new
          </h2>
          <div className="flex gap-4">
            {TEMPLATES.map((template) => (
              <TemplateCard
                key={template.id}
                template={template}
                onSelect={() => handleNewDocument(template.content)}
              />
            ))}
          </div>
        </section>

        <section>
          <h2 className="mb-3 text-11 font-bold uppercase tracking-[.05em] text-text-secondary">
            Recent
          </h2>
          {recentFiles.length === 0 ? (
            <p className="text-13 text-text-tertiary">No recent documents yet</p>
          ) : (
            <div className="flex flex-col">
              {recentFiles.map((entry) => (
                <RecentRow
                  key={entry.filePath}
                  entry={entry}
                  onSelect={() => handleOpenRecent(entry.filePath)}
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
