import { useCallback } from 'react'
import { useAppStore } from '../store/appStore'
import { useDocumentStore } from '../store/documentStore'
import { usePreferencesStore } from '../store/preferencesStore'
import { applyPageConfig, DEFAULT_PAGE_CONFIG } from '../../../markdown/page-config'
import { replaceRawFrontmatter } from '../../../markdown/frontmatter-splice'
import type { Preferences } from '../../../preload/index.d'

// Does the user's saved default page config actually differ from what a
// document with NO frontmatter at all already renders as?
//
// This exists to stop a brand-new blank document opening with an opaque
// `Frontmatter (4 lines)` block at the top of it. That block is not editable
// in the canvas by design (Page Setup is how you change it), so for the
// overwhelmingly common case -- a user who has never opened Settings -- it was
// a grey box of YAML that said exactly what the app would have done anyway,
// sitting above an otherwise empty page. It is the first thing a new user
// sees, and it reads like leftover junk.
//
// Compared field-by-field against DEFAULT_PAGE_CONFIG rather than against
// DEFAULT_PREFERENCES: the question that actually matters is "would writing
// this change anything?", and the renderer cannot import from src/main/**
// anyway (it sits outside tsconfig.web.json's include -- the same constraint
// that makes preload re-declare these types instead of importing them).
// `DefaultPageConfig` is a deliberately narrow 4-field subset of PageConfig,
// so this stays exhaustive by construction: adding a fifth field to that
// interface makes this object literal fail to typecheck rather than silently
// ignoring it.
function differsFromBuiltInDefaults(preferences: Preferences): boolean {
  const config = preferences.defaultPageConfig
  const builtIn: typeof config = {
    pageSize: DEFAULT_PAGE_CONFIG.pageSize,
    orientation: DEFAULT_PAGE_CONFIG.orientation,
    theme: DEFAULT_PAGE_CONFIG.theme,
    fontFamily: DEFAULT_PAGE_CONFIG.fontFamily
  }
  return (Object.keys(builtIn) as (keyof typeof builtIn)[]).some(
    (key) => config[key] !== builtIn[key]
  )
}

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
      if (content === undefined && preferences && differsFromBuiltInDefaults(preferences)) {
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
