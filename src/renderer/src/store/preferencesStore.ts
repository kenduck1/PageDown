import { create } from 'zustand'
import type { Preferences } from '../../../preload/index.d'

// A dedicated store, not more fields on appStore -- matching findStore.ts's
// own precedent (see that file's comment for the full reasoning):
// preferences are a persisted, main-process-backed concern with their own
// load/save lifecycle, not UI-only navigation/view-mode state.
//
// `loaded` distinguishes "not fetched yet" from "fetched and these really
// are the user's settings" -- consumers that apply a default (HomeScreen's
// new-blank-document flow, useAutosave's interval) need to know whether
// `preferences` is genuinely the persisted value or just this store's own
// placeholder before the one real `getPreferences()` IPC call (fired once,
// from App.tsx, on app mount) resolves.
interface PreferencesState {
  preferences: Preferences | null
  loaded: boolean
  setPreferences: (preferences: Preferences) => void
}

export const usePreferencesStore = create<PreferencesState>()((set) => ({
  preferences: null,
  loaded: false,
  setPreferences: (preferences) => set({ preferences, loaded: true })
}))
