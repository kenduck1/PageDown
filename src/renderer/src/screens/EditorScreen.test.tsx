import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import EditorScreen from './EditorScreen'
import { useDocumentStore, initialDocumentState } from '../store/documentStore'

beforeEach(() => {
  useDocumentStore.setState(initialDocumentState)
})

afterEach(() => {
  cleanup()
})

describe('EditorScreen', () => {
  it('shows "Untitled" for a new, unsaved document', () => {
    render(<EditorScreen />)
    expect(screen.getByText('Untitled')).toBeInTheDocument()
  })

  it('shows the real file path and content for a loaded document', () => {
    useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report\n\nBody text' })
    render(<EditorScreen />)
    expect(screen.getByText('/tmp/report.md')).toBeInTheDocument()
    expect(screen.getByTestId('document-content')).toHaveTextContent('# Report')
  })

  it('shows the error message instead of content when the store has an error', () => {
    useDocumentStore.setState({ error: 'File not found' })
    render(<EditorScreen />)
    expect(screen.getByText('File not found')).toBeInTheDocument()
    expect(screen.queryByTestId('document-content')).not.toBeInTheDocument()
  })
})
