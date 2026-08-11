import { useEffect, useState } from 'react'
import { useAppStore } from '../store/appStore'
import { usePreferencesStore } from '../store/preferencesStore'
import type { Preferences, DefaultPageConfig } from '../../../preload/index.d'

const PAGE_SIZES: DefaultPageConfig['pageSize'][] = ['Letter', 'A4', 'Legal', 'Custom']
const ORIENTATIONS: { value: DefaultPageConfig['orientation']; label: string }[] = [
  { value: 'portrait', label: 'Portrait' },
  { value: 'landscape', label: 'Landscape' }
]
// Same four themes/two fonts PageSetupModal.tsx/EditorToolbar.tsx already
// offer per-document -- these are the SAME real options, just choosing what
// a brand-new document starts with rather than editing an open one.
const THEMES: { value: DefaultPageConfig['theme']; label: string }[] = [
  { value: 'default', label: 'Default' },
  { value: 'resume', label: 'Résumé' },
  { value: 'letter', label: 'Letter' },
  { value: 'report', label: 'Report' }
]
const FONT_FAMILIES: { value: DefaultPageConfig['fontFamily']; label: string }[] = [
  { value: 'source-serif-4', label: 'Source Serif 4' },
  { value: 'inter', label: 'Inter' }
]
const COLOR_SCHEMES: { value: Preferences['colorScheme']; label: string }[] = [
  { value: 'system', label: 'Match System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' }
]

// Immediate-apply, not a modal draft-then-Apply/Cancel the way PageSetupModal
// works -- deliberate, not an oversight: this is a full navigated SCREEN (a
// destination, not an overlay atop editing work already in progress), so it
// follows the more common "system preferences" convention instead (macOS
// System Settings, VS Code Settings) where each control takes effect the
// moment it changes. Every change is written through window.api.setPreferences
// immediately, which persists it AND (for spellcheckEnabled specifically)
// applies it live to the real session -- see src/main/index.ts's own
// preferences:set handler for that second half.
function SettingsScreen(): React.JSX.Element {
  const goHome = useAppStore((state) => state.goHome)
  const preferences = usePreferencesStore((state) => state.preferences)
  const setPreferences = usePreferencesStore((state) => state.setPreferences)

  // Locally-buffered raw string for the autosave-interval input, kept
  // separate from the committed preferences.autosaveIntervalMs value.
  // Without this, rejecting an in-progress invalid value (e.g. the empty
  // string while the user is clearing the field) by skipping applyChange
  // left the controlled input snapping back to its last-committed value on
  // every keystroke -- so clearing "45" and typing "90" produced "4590"
  // (each new digit appending to the reverted "45") instead of "90". The
  // buffer always mirrors what the user actually typed; only a value that
  // validates gets pushed through applyChange to the store/IPC.
  // Synced via the "adjust state during render" pattern (React's own
  // recommended alternative to an effect for this exact case) rather than
  // useEffect -- comparing against the last-synced ms value and updating
  // both pieces of state inline, during render, whenever the committed
  // preference has moved out from under the buffer (e.g. loaded for the
  // first time, or changed by a different tab/instance).
  const [autosaveSecondsInput, setAutosaveSecondsInput] = useState('')
  const [lastSyncedAutosaveMs, setLastSyncedAutosaveMs] = useState<number | null>(null)
  if (preferences && preferences.autosaveIntervalMs !== lastSyncedAutosaveMs) {
    setLastSyncedAutosaveMs(preferences.autosaveIntervalMs)
    setAutosaveSecondsInput(String(Math.round(preferences.autosaveIntervalMs / 1000)))
  }

  // A genuine one-shot async fetch (main process's app.getVersion(), which
  // the renderer has no direct way to read), not a value mirrored from any
  // store -- a plain effect is the right tool here, unlike the
  // render-time-sync pattern the autosave buffer above needs.
  const [appVersion, setAppVersion] = useState<string | null>(null)
  useEffect(() => {
    window.api.getAppVersion().then(setAppVersion)
  }, [])

  // Genuinely possible (not just defensive): App.tsx's own getPreferences()
  // call may not have resolved yet if a user navigates here fast enough
  // after launch. Rendering the real values only once they exist avoids a
  // flash of stale/default-looking controls silently reverting a moment
  // later.
  if (!preferences) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-chrome-light font-sans text-text-primary">
        <span className="text-21 font-bold">Settings</span>
        <button onClick={goHome} className="text-12 text-text-secondary">
          ← Home
        </button>
      </div>
    )
  }

  const applyChange = (updates: Partial<Preferences>): void => {
    const next: Preferences = {
      ...preferences,
      ...updates,
      defaultPageConfig: { ...preferences.defaultPageConfig, ...updates.defaultPageConfig }
    }
    setPreferences(next)
    void window.api.setPreferences(next)
  }

  const updateDefaultPageConfig = (updates: Partial<DefaultPageConfig>): void => {
    applyChange({ defaultPageConfig: { ...preferences.defaultPageConfig, ...updates } })
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-chrome-light font-sans text-text-primary">
      {/* `sticky top-0`, so the only way back out of Settings does not scroll
      away with the content. The reported complaint was exactly that -- having
      to scroll back to the top to leave -- and it is a STICKINESS complaint,
      not an argument against this screen's model: Settings stays a full
      navigated destination that applies each change immediately (see this
      file's own header comment for why), rather than becoming a modal, which
      would drag draft-then-Apply/Cancel semantics back in with it.

      Sticky works here without any structural change because the scroll
      container is this element's own PARENT (`overflow-y-auto` on the root
      div) and this is a direct child of it -- a `sticky` element positions
      against its nearest scrolling ancestor, so had the scrollbar lived on
      an inner wrapper instead this would have silently done nothing.
      `bg-page` was already here and is what keeps the scrolled content from
      showing through; `z-10` keeps it above the native `<select>` controls
      below, which otherwise paint over it mid-scroll. */}
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border-subtle bg-page px-5 py-3.5">
        <h1 className="text-15-5 font-bold">Settings</h1>
        <button onClick={goHome} className="text-12-5 text-text-secondary hover:text-text-primary">
          ← Home
        </button>
      </div>

      <div className="mx-auto flex w-full max-w-[520px] flex-col gap-6 px-5 py-6">
        <section className="flex flex-col gap-2.5">
          <h2 className="text-11-5 font-semibold uppercase tracking-wide text-text-secondary">
            Appearance
          </h2>
          <p className="text-11-5 text-text-tertiary">
            Applies to the app&apos;s own chrome only -- the document page itself always renders
            light, matching what gets printed or exported.
          </p>

          <label className="flex items-center justify-between rounded-md border border-border-subtle bg-page px-3.5 py-2.5">
            {/* "Color scheme", not "Theme" -- "New document defaults" below
            already has a real, distinct "Theme" combobox for
            defaultPageConfig.theme (a DOCUMENT typography theme --
            default/resume/letter/report). Same-string accessible names
            would make screen.getByRole('combobox', { name: 'Theme' })
            ambiguous the moment both sections are on screen at once, which
            they always are here (both sit in the one Settings screen) --
            the exact collision EditorToolbar.tsx's own Split-left-pane
            toggle already documents hitting for the identical reason. */}
            <span className="text-12-5 text-text-primary">Color scheme</span>
            <select
              value={preferences.colorScheme}
              onChange={(e) =>
                applyChange({ colorScheme: e.target.value as Preferences['colorScheme'] })
              }
              className="rounded-sm border border-border-chrome bg-page px-2 py-1 text-12-5"
            >
              {COLOR_SCHEMES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
        </section>

        <section className="flex flex-col gap-2.5">
          <h2 className="text-11-5 font-semibold uppercase tracking-wide text-text-secondary">
            Editing
          </h2>
          <label className="flex items-center justify-between rounded-md border border-border-subtle bg-page px-3.5 py-2.5">
            <span className="text-12-5 text-text-primary">Spell check</span>
            <input
              type="checkbox"
              checked={preferences.spellcheckEnabled}
              onChange={(e) => applyChange({ spellcheckEnabled: e.target.checked })}
            />
          </label>

          <label className="flex items-center justify-between rounded-md border border-border-subtle bg-page px-3.5 py-2.5">
            <span className="text-12-5 text-text-primary">Autosave interval (seconds)</span>
            <input
              type="number"
              min={5}
              step={5}
              // Stored/sent in ms (matching useAutosave.ts's own unit), shown
              // in seconds -- nobody thinks in milliseconds when setting a
              // "how often" preference. Bound to the local buffer (not
              // preferences.autosaveIntervalMs directly) so every keystroke
              // shows exactly what was typed, even mid-edit/invalid.
              value={autosaveSecondsInput}
              onChange={(e) => {
                setAutosaveSecondsInput(e.target.value)
                const seconds = Number(e.target.value)
                if (Number.isFinite(seconds) && seconds >= 5) {
                  applyChange({ autosaveIntervalMs: Math.round(seconds * 1000) })
                }
              }}
              className="w-20 rounded-sm border border-border-chrome bg-page px-2 py-1 text-right text-12-5"
            />
          </label>
        </section>

        <section className="flex flex-col gap-2.5">
          <h2 className="text-11-5 font-semibold uppercase tracking-wide text-text-secondary">
            Comments
          </h2>
          <p className="text-11-5 text-text-tertiary">
            Attached to every comment you add. This app has no accounts -- a blank name shows as
            &quot;You&quot; on your own comments.
          </p>
          <label className="flex items-center justify-between rounded-md border border-border-subtle bg-page px-3.5 py-2.5">
            <span className="text-12-5 text-text-primary">Your name</span>
            <input
              type="text"
              placeholder="You"
              value={preferences.authorName}
              onChange={(e) => applyChange({ authorName: e.target.value })}
              className="w-40 rounded-sm border border-border-chrome bg-page px-2 py-1 text-right text-12-5"
            />
          </label>
        </section>

        <section className="flex flex-col gap-2.5">
          <h2 className="text-11-5 font-semibold uppercase tracking-wide text-text-secondary">
            New document defaults
          </h2>
          <p className="text-11-5 text-text-tertiary">
            Applied to every brand-new blank document. A template already sets its own page setup
            and is unaffected.
          </p>

          <label className="flex items-center justify-between rounded-md border border-border-subtle bg-page px-3.5 py-2.5">
            <span className="text-12-5 text-text-primary">Page size</span>
            <select
              value={preferences.defaultPageConfig.pageSize}
              onChange={(e) =>
                updateDefaultPageConfig({
                  pageSize: e.target.value as DefaultPageConfig['pageSize']
                })
              }
              className="rounded-sm border border-border-chrome bg-page px-2 py-1 text-12-5"
            >
              {PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>

          <label className="flex items-center justify-between rounded-md border border-border-subtle bg-page px-3.5 py-2.5">
            <span className="text-12-5 text-text-primary">Orientation</span>
            <select
              value={preferences.defaultPageConfig.orientation}
              onChange={(e) =>
                updateDefaultPageConfig({
                  orientation: e.target.value as DefaultPageConfig['orientation']
                })
              }
              className="rounded-sm border border-border-chrome bg-page px-2 py-1 text-12-5"
            >
              {ORIENTATIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex items-center justify-between rounded-md border border-border-subtle bg-page px-3.5 py-2.5">
            <span className="text-12-5 text-text-primary">Theme</span>
            <select
              value={preferences.defaultPageConfig.theme}
              onChange={(e) =>
                updateDefaultPageConfig({ theme: e.target.value as DefaultPageConfig['theme'] })
              }
              className="rounded-sm border border-border-chrome bg-page px-2 py-1 text-12-5"
            >
              {THEMES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex items-center justify-between rounded-md border border-border-subtle bg-page px-3.5 py-2.5">
            <span className="text-12-5 text-text-primary">Font</span>
            <select
              value={preferences.defaultPageConfig.fontFamily}
              onChange={(e) =>
                updateDefaultPageConfig({
                  fontFamily: e.target.value as DefaultPageConfig['fontFamily']
                })
              }
              className="rounded-sm border border-border-chrome bg-page px-2 py-1 text-12-5"
            >
              {FONT_FAMILIES.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
        </section>

        <footer className="pt-2 text-center text-11-5 text-text-tertiary">
          PageDown{appVersion ? ` ${appVersion}` : ''}
        </footer>
      </div>
    </div>
  )
}

export default SettingsScreen
