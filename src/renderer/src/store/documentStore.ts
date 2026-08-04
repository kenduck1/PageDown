import { create } from 'zustand'

interface DocumentStateValues {
  content: string
  filePath: string | null
  isDirty: boolean
  error: string | null
  revision: number
}

interface DocumentState extends DocumentStateValues {
  newDocument: (initialContent?: string) => void
  loadDocument: (filePath: string, content: string) => void
  openFile: () => Promise<boolean>
  openPath: (filePath: string) => Promise<boolean>
  save: () => Promise<void>
  updateContent: (content: string) => void
  clearError: () => void
}

export const initialDocumentState: DocumentStateValues = {
  content: '',
  filePath: null,
  isDirty: false,
  error: null,
  revision: 0
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export const useDocumentStore = create<DocumentState>()((set, get) => ({
  ...initialDocumentState,
  newDocument: (initialContent = '') =>
    set((state) => ({
      content: initialContent,
      filePath: null,
      isDirty: false,
      error: null,
      revision: state.revision + 1
    })),
  loadDocument: (filePath, content) =>
    set((state) => ({
      content,
      filePath,
      isDirty: false,
      error: null,
      revision: state.revision + 1
    })),
  openFile: async () => {
    try {
      const result = await window.api.openFile()
      if (!result) return false
      get().loadDocument(result.filePath, result.content)
      return true
    } catch (err) {
      set({ error: errorMessage(err) })
      return false
    }
  },
  openPath: async (filePath) => {
    try {
      const result = await window.api.openPath(filePath)
      get().loadDocument(result.filePath, result.content)
      return true
    } catch (err) {
      set({ error: errorMessage(err) })
      return false
    }
  },
  save: async () => {
    const { content, filePath } = get()
    try {
      const result = await window.api.saveFile(filePath, content)
      if (result) set({ filePath: result.filePath, isDirty: false, error: null })
    } catch (err) {
      set({ error: errorMessage(err) })
    }
  },
  updateContent: (content) => set({ content, isDirty: true }),
  clearError: () => set({ error: null })
}))
