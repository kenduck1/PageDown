import { useCallback } from 'react'
import { useAppStore } from '../store/appStore'
import { useDocumentStore } from '../store/documentStore'
import { usePreferencesStore } from '../store/preferencesStore'
import { applyPageConfig } from '../../../markdown/page-config'
import { replaceRawFrontmatter } from '../../../markdown/frontmatter-splice'

// "Create a document and show it" -- the single implementation behind BOTH
// the Home screen's New document / template cards and File > New in the
// application menu.
//
// Extracted from HomeScreen.tsx rather than reimplemented for the menu:
// applying `preferences.defaultPageConfig` to a BLANK document (and
// deliberately not to a template, which carries its own frontmatter) is a
// real behaviour with two conditions that are easy to get subtly different in
// a second copy -- and a File > New that quietly ignored the user's default
// page size would be exactly the kind of divergence nobody notices for
// months.
export function useCreateDocument(): (content?: string) => void {
  const newDocument = useDocumentStore((state) => state.newDocument)
  const goEditor = useAppStore((state) => state.goEditor)
  const preferences = usePreferencesStore((state) => state.preferences)

  return useCallback(
    (content?: string): void => {
      // Only the PLAIN blank case (content === undefined) gets the user's own
      // default page config applied -- a template already carries its own
      // deliberate frontmatter (or deliberately none), and layering a global
      // default on top would fight the template author's own choices.
      // `preferences` can genuinely still be null here (App.tsx's own
      // getPreferences() call may not have resolved yet); falling through to
      // plain empty content in that case is correct, not a bug to guard
      // against -- it is exactly what New Document did before default page
      // config existed, so a slow or failed preferences fetch degrades to the
      // pre-existing behaviour rather than blocking document creation.
      if (content === undefined && preferences) {
        const rawYaml = applyPageConfig('', preferences.defaultPageConfig)
        newDocument(replaceRawFrontmatter('', rawYaml))
      } else {
        newDocument(content)
      }
      // A no-op when the editor is already on screen (the File > New case),
      // and the whole point from the Home screen.
      goEditor()
    },
    [newDocument, goEditor, preferences]
  )
}
