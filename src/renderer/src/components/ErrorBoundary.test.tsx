import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ErrorBoundary from './ErrorBoundary'
import { useDocumentStore, initialDocumentState, type DocumentTab } from '../store/documentStore'

function tab(overrides: Partial<DocumentTab> & { id: string }): DocumentTab {
  return {
    filePath: null,
    content: '',
    isDirty: false,
    mtimeMs: null,
    remoteImagesAllowed: null,
    currentPage: 1,
    draftId: null,
    ...overrides
  }
}

// A component that throws on demand, so the boundary can be driven the only
// way React lets it be driven: by a real render-time exception.
function Boom({ explode }: { explode: boolean }): React.JSX.Element {
  if (explode) throw new Error('kaboom in render')
  return <div>the real app</div>
}

beforeEach(() => {
  useDocumentStore.setState(initialDocumentState)
  window.api = { ...window.api, saveFile: vi.fn() } as typeof window.api
  // React logs the caught error itself; the boundary logs the component stack.
  // Silenced so a deliberately-crashing test doesn't fill the run with noise.
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ErrorBoundary', () => {
  it('renders its children untouched when nothing throws', () => {
    render(
      <ErrorBoundary>
        <Boom explode={false} />
      </ErrorBoundary>
    )

    expect(screen.getByText('the real app')).toBeInTheDocument()
  })

  it('replaces a crashed tree with a recoverable screen instead of a blank window', () => {
    render(
      <ErrorBoundary>
        <Boom explode={true} />
      </ErrorBoundary>
    )

    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save my work' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reload window' })).toBeInTheDocument()
  })

  it('never swallows the error -- it is logged AND shown', () => {
    render(
      <ErrorBoundary>
        <Boom explode={true} />
      </ErrorBoundary>
    )

    expect(console.error).toHaveBeenCalled()
    expect(screen.getByText(/kaboom in render/)).toBeInTheDocument()
  })

  it('saves EVERY dirty tab, not just the active one', async () => {
    // The whole point of the boundary: the document store survives a render
    // crash untouched (it is plain module state), so the user's work is still
    // reachable even though React's tree is gone.
    useDocumentStore.setState({
      tabs: [
        tab({ id: 'a', filePath: '/tmp/a.md', content: '# A', isDirty: true }),
        tab({ id: 'b', filePath: '/tmp/b.md', content: '# B', isDirty: true }),
        tab({ id: 'c', filePath: '/tmp/c.md', content: '# C' })
      ],
      activeTabId: 'a',
      content: '# A',
      filePath: '/tmp/a.md',
      isDirty: true
    })
    vi.mocked(window.api.saveFile).mockImplementation(async (filePath) => ({
      filePath: filePath ?? '/tmp/chosen.md',
      mtimeMs: 1
    }))
    const user = userEvent.setup()
    render(
      <ErrorBoundary>
        <Boom explode={true} />
      </ErrorBoundary>
    )

    await user.click(screen.getByRole('button', { name: 'Save my work' }))

    await waitFor(() => {
      expect(screen.getByText(/Saved\./)).toBeInTheDocument()
    })
    expect(window.api.saveFile).toHaveBeenCalledTimes(2)
    expect(window.api.saveFile).toHaveBeenCalledWith('/tmp/a.md', '# A', null)
    expect(window.api.saveFile).toHaveBeenCalledWith('/tmp/b.md', '# B', null)
  })

  it('reports a save that did not happen rather than claiming success', async () => {
    useDocumentStore.setState({
      tabs: [tab({ id: 'a', filePath: null, content: '# unsaved', isDirty: true })],
      activeTabId: 'a',
      content: '# unsaved',
      filePath: null,
      isDirty: true
    })
    // Null = the user cancelled the Save dialog, so nothing was written.
    vi.mocked(window.api.saveFile).mockResolvedValue(null)
    const user = userEvent.setup()
    render(
      <ErrorBoundary>
        <Boom explode={true} />
      </ErrorBoundary>
    )

    await user.click(screen.getByRole('button', { name: 'Save my work' }))

    await waitFor(() => {
      expect(screen.getByText(/could not be saved/)).toBeInTheDocument()
    })
  })

  it('"Try again" clears the boundary and re-renders the app', async () => {
    const user = userEvent.setup()
    const { rerender } = render(
      <ErrorBoundary>
        <Boom explode={true} />
      </ErrorBoundary>
    )
    expect(screen.getByRole('alert')).toBeInTheDocument()

    // The retry only helps if whatever caused the throw is no longer true --
    // model that by re-rendering with a child that no longer explodes.
    rerender(
      <ErrorBoundary>
        <Boom explode={false} />
      </ErrorBoundary>
    )
    await user.click(screen.getByRole('button', { name: 'Try again' }))

    expect(screen.getByText('the real app')).toBeInTheDocument()
  })
})
