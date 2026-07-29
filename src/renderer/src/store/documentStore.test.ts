import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDocumentStore, initialDocumentState } from './documentStore'

beforeEach(() => {
  useDocumentStore.setState(initialDocumentState)
  window.api = {
    openFile: vi.fn(),
    openPath: vi.fn(),
    saveFile: vi.fn(),
    getRecentFiles: vi.fn()
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useDocumentStore', () => {
  it('newDocument resets to a blank untitled document', () => {
    useDocumentStore.setState({ content: 'old', filePath: '/old.md', isDirty: true, error: 'x' })
    useDocumentStore.getState().newDocument()
    expect(useDocumentStore.getState()).toMatchObject({
      content: '',
      filePath: null,
      isDirty: false,
      error: null
    })
  })

  it('newDocument seeds the given starter content', () => {
    useDocumentStore.getState().newDocument('# Résumé template')
    expect(useDocumentStore.getState().content).toBe('# Résumé template')
    expect(useDocumentStore.getState().filePath).toBeNull()
  })

  it('loadDocument sets filePath and content and clears dirty/error', () => {
    useDocumentStore.setState({ isDirty: true, error: 'x' })
    useDocumentStore.getState().loadDocument('/a.md', '# A')
    expect(useDocumentStore.getState()).toMatchObject({
      filePath: '/a.md',
      content: '# A',
      isDirty: false,
      error: null
    })
  })

  it('openFile loads the result and returns true on success', async () => {
    vi.mocked(window.api.openFile).mockResolvedValue({ filePath: '/a.md', content: '# A' })
    const loaded = await useDocumentStore.getState().openFile()
    expect(loaded).toBe(true)
    expect(useDocumentStore.getState().filePath).toBe('/a.md')
  })

  it('openFile returns false and makes no changes when cancelled', async () => {
    vi.mocked(window.api.openFile).mockResolvedValue(null)
    const loaded = await useDocumentStore.getState().openFile()
    expect(loaded).toBe(false)
    expect(useDocumentStore.getState().filePath).toBeNull()
    expect(useDocumentStore.getState().error).toBeNull()
  })

  it('openFile returns false and sets error on failure', async () => {
    vi.mocked(window.api.openFile).mockRejectedValue(new Error('Permission denied'))
    const loaded = await useDocumentStore.getState().openFile()
    expect(loaded).toBe(false)
    expect(useDocumentStore.getState().error).toBe('Permission denied')
  })

  it('openPath loads the result and returns true on success', async () => {
    vi.mocked(window.api.openPath).mockResolvedValue({ filePath: '/b.md', content: '# B' })
    const loaded = await useDocumentStore.getState().openPath('/b.md')
    expect(loaded).toBe(true)
    expect(useDocumentStore.getState().content).toBe('# B')
  })

  it('save updates filePath and clears isDirty on success', async () => {
    useDocumentStore.setState({ content: '# A', filePath: null, isDirty: true })
    vi.mocked(window.api.saveFile).mockResolvedValue({ filePath: '/saved.md' })
    await useDocumentStore.getState().save()
    expect(useDocumentStore.getState()).toMatchObject({ filePath: '/saved.md', isDirty: false })
  })

  it('save sets error on failure without touching filePath', async () => {
    useDocumentStore.setState({ filePath: '/a.md' })
    vi.mocked(window.api.saveFile).mockRejectedValue(new Error('Disk full'))
    await useDocumentStore.getState().save()
    expect(useDocumentStore.getState()).toMatchObject({ filePath: '/a.md', error: 'Disk full' })
  })

  it('clearError resets error to null', () => {
    useDocumentStore.setState({ error: 'x' })
    useDocumentStore.getState().clearError()
    expect(useDocumentStore.getState().error).toBeNull()
  })
})
