import { useState } from 'react'
import type {
  Orientation,
  PageConfig,
  PageMargins,
  PageNumberFormat,
  PageRunningContent,
  PageSize,
  PageTheme
} from '../../../markdown/page-config'
import { useModalDialog } from '../hooks/useModalDialog'

// A real, functional Page Setup dialog: every control here edits a local
// in-modal draft of `PageConfig`, and Apply hands the finished draft back
// to the caller unchanged (the caller is responsible for persisting it via
// `applyPageConfig`, src/markdown/page-config.ts). This component itself
// does not read or write frontmatter -- it only edits the in-memory
// `PageConfig` value it's given, per its props contract below.
//
// LIMITATION, stated plainly and deliberately (do not remove this note):
// changing any setting here has NO visible effect on the pagination
// preview or the exported PDF today. The sandboxed pagination render
// context (`resources/pagination-render/index.ts`) calls
// `previewer.preview(container, [], root)` with a hardcoded empty
// stylesheet array -- it does not accept `@page` CSS (page size, margins,
// headers/footers) from ANY document yet, not just ones edited through
// this modal. Wiring these settings into real layout is separate, larger,
// out-of-scope work. What IS real here: the settings genuinely persist to
// the document's YAML frontmatter (via `applyPageConfig`) once a caller
// wires this modal's `onApply` up to that -- this component and its
// values are not a mockup/stub.
//
// Visual placeholders, documented rather than left unexplained:
// - Theme cards use small static CSS "line-drawing" bars (`ThemeGlyph`
//   below) rather than the Home screen's live rendered-thumbnail
//   convention (`TemplateCard` in HomeScreen.tsx) -- that convention goes
//   through a real IPC call into the main-process pagination harness
//   (`getTemplateThumbnail`), which this component intentionally avoids
//   needing so it stays a plain, Electron-free, unit-testable component.
// - The orientation toggle omits the mockup's small icon glyphs (text-only
//   pills) for the same reason: not load-bearing for a first functional
//   pass, and easy to layer in later without changing this component's
//   behavior or props.
// - The footer "center" field's `Page {n} of {total}` token is signalled
//   as dynamic by rendering the *entire* field's text in the accent color
//   while its value still contains `{n}` or `{total}` (an HTML text
//   `<input>` cannot color one substring differently from the rest) --
//   once the user edits it to literal text, the accent color goes away.

export interface PageSetupModalProps {
  open: boolean
  initialConfig: PageConfig
  onApply: (config: PageConfig) => void
  onClose: () => void
}

const PAGE_SIZES: PageSize[] = ['Letter', 'A4', 'Legal', 'Custom']
const ORIENTATIONS: { value: Orientation; label: string }[] = [
  { value: 'portrait', label: 'Portrait' },
  { value: 'landscape', label: 'Landscape' }
]
const PAGE_NUMBER_FORMATS: { value: PageNumberFormat; label: string }[] = [
  { value: 'decimal', label: '1, 2, 3' },
  { value: 'roman', label: 'i, ii, iii' }
]
const THEMES: { value: PageTheme; label: string }[] = [
  { value: 'default', label: 'Default' },
  { value: 'resume', label: 'Résumé' },
  { value: 'letter', label: 'Letter' },
  { value: 'report', label: 'Report' }
]

const MARGIN_FIELDS: { key: keyof PageMargins; label: string }[] = [
  { key: 'top', label: 'Top' },
  { key: 'bottom', label: 'Bottom' },
  { key: 'left', label: 'Left' },
  { key: 'right', label: 'Right' }
]

// Header and footer take the same three sides. The labels are prefixed
// ("Header left", not "Left") because both groups are on screen at once and
// a bare "Left" would be ambiguous to a screen reader and to getByLabelText
// in tests -- the <span> inside each <label> IS the accessible name here.
const HEADER_FIELDS: { key: keyof PageRunningContent; label: string }[] = [
  { key: 'left', label: 'Header left' },
  { key: 'center', label: 'Header center' },
  { key: 'right', label: 'Header right' }
]

const FOOTER_FIELDS: { key: keyof PageRunningContent; label: string }[] = [
  { key: 'left', label: 'Footer left' },
  { key: 'center', label: 'Footer center' },
  { key: 'right', label: 'Footer right' }
]

// Only rendered when pageSize is 'Custom'. Keyed on the PageConfig field
// name itself so the onChange below can write straight through with no
// key-to-field mapping table.
const CUSTOM_SIZE_FIELDS: { key: 'customWidth' | 'customHeight'; label: string }[] = [
  { key: 'customWidth', label: 'Width (in)' },
  { key: 'customHeight', label: 'Height (in)' }
]

const DYNAMIC_TOKEN_PATTERN = /\{n\}|\{total\}/

const ROMAN_NUMERALS: [number, string][] = [
  [1000, 'm'],
  [900, 'cm'],
  [500, 'd'],
  [400, 'cd'],
  [100, 'c'],
  [90, 'xc'],
  [50, 'l'],
  [40, 'xl'],
  [10, 'x'],
  [9, 'ix'],
  [5, 'v'],
  [4, 'iv'],
  [1, 'i']
]

function toRoman(num: number): string {
  let n = num
  let result = ''
  for (const [value, symbol] of ROMAN_NUMERALS) {
    while (n >= value) {
      result += symbol
      n -= value
    }
  }
  return result
}

function formatPageNumber(n: number, format: PageNumberFormat): string {
  return format === 'roman' ? toRoman(n) : String(n)
}

// Preview-only token resolution: substitutes sample page 1 of 12 so the
// live-preview column shows what the token will actually render as,
// formatted per the currently-selected page-number format.
function resolveFooterPreviewText(text: string, format: PageNumberFormat): string {
  return text
    .replaceAll('{n}', formatPageNumber(1, format))
    .replaceAll('{total}', formatPageNumber(12, format))
}

function PillButton({
  selected,
  onClick,
  children
}: {
  selected: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={`rounded-sm border px-3 py-1.5 text-12-5 font-medium ${
        selected
          ? 'border-accent bg-accent/9 text-accent'
          : 'border-border-subtle text-text-primary'
      }`}
    >
      {children}
    </button>
  )
}

function ToggleSwitch({
  label,
  checked,
  onChange
}: {
  label: string
  checked: boolean
  onChange: (value: boolean) => void
}): React.JSX.Element {
  return (
    <label className="flex items-center justify-between gap-3 py-1">
      <span className="text-12-5 text-text-primary">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative h-5 w-[34px] rounded-full transition-colors ${
          checked ? 'bg-accent' : 'bg-border-subtle'
        }`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-page transition-transform ${
            checked ? 'translate-x-[16px]' : 'translate-x-0.5'
          }`}
        />
      </button>
    </label>
  )
}

// Small static "line-drawing" placeholder per theme -- see the file-level
// comment above for why this is a simplified stand-in rather than a live
// rendered thumbnail.
function ThemeGlyph({ theme }: { theme: PageTheme }): React.JSX.Element {
  const bar = (widthClass: string, key: number): React.JSX.Element => (
    <div key={key} className={`h-[3px] rounded-full bg-border-subtle ${widthClass}`} />
  )
  const heading = <div className="mb-1.5 h-[5px] w-3/5 rounded-full bg-text-faint" />

  switch (theme) {
    case 'resume':
      return (
        <div className="flex h-full w-full flex-col gap-1 p-2">
          <div className="h-[5px] w-2/3 rounded-full bg-text-faint" />
          <div className="mb-1 h-[3px] w-2/5 rounded-full bg-border-subtle" />
          {bar('w-full', 1)}
          {bar('w-5/6', 2)}
          {bar('w-full', 3)}
          {bar('w-2/3', 4)}
        </div>
      )
    case 'letter':
      return (
        <div className="flex h-full w-full flex-col items-end gap-1 p-2">
          {bar('w-2/5', 1)}
          {bar('w-1/3', 2)}
          <div className="mt-2 flex w-full flex-col gap-1">
            {bar('w-full', 3)}
            {bar('w-full', 4)}
            {bar('w-4/5', 5)}
          </div>
        </div>
      )
    case 'report':
      return (
        <div className="flex h-full w-full flex-col gap-1 p-2">
          {heading}
          <div className="mb-1 grid grid-cols-3 gap-[2px]">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-[6px] rounded-[1px] bg-border-subtle" />
            ))}
          </div>
          {bar('w-full', 1)}
          {bar('w-5/6', 2)}
        </div>
      )
    default:
      return (
        <div className="flex h-full w-full flex-col gap-1 p-2">
          {heading}
          {bar('w-full', 1)}
          {bar('w-full', 2)}
          {bar('w-4/5', 3)}
        </div>
      )
  }
}

function PreviewColumn({ config }: { config: PageConfig }): React.JSX.Element {
  // Inches -> preview px, clamped so an extreme margin value can never
  // invert the dashed inset guide (i.e. the guide always leaves a visible
  // page interior).
  const toInset = (inches: number): number => Math.max(4, Math.min(inches * 10, 60))

  return (
    <div className="flex w-[230px] flex-shrink-0 flex-col items-center gap-3 bg-chrome-light p-4">
      <span className="text-eyebrow self-start">Preview</span>
      <div className="relative h-[194px] w-[150px] flex-shrink-0 border border-border-subtle bg-page shadow-flat">
        <div
          className="absolute flex flex-col justify-between border border-dashed border-border-chrome"
          style={{
            top: toInset(config.margins.top),
            bottom: toInset(config.margins.bottom),
            left: toInset(config.margins.left),
            right: toInset(config.margins.right)
          }}
        >
          {config.showHeader && (
            // Mirrors the footer row below: real content, resolved through
            // the same {n}/{total} preview substitution, rather than the
            // literal word "Header" it used to show -- now that header
            // content is a real, editable, rendered thing, a placeholder
            // would misrepresent what the page will actually look like.
            <div className="flex justify-between text-[6px] text-text-tertiary">
              <span className="truncate">
                {resolveFooterPreviewText(config.header.left, config.pageNumberFormat)}
              </span>
              <span className="truncate">
                {resolveFooterPreviewText(config.header.center, config.pageNumberFormat)}
              </span>
              <span className="truncate">
                {resolveFooterPreviewText(config.header.right, config.pageNumberFormat)}
              </span>
            </div>
          )}
        </div>
        {config.showFooter && (
          <div className="absolute inset-x-1 bottom-1 flex justify-between text-[6px] text-text-tertiary">
            <span className="truncate">
              {resolveFooterPreviewText(config.footer.left, config.pageNumberFormat)}
            </span>
            <span className="truncate">
              {resolveFooterPreviewText(config.footer.center, config.pageNumberFormat)}
            </span>
            <span className="truncate">
              {resolveFooterPreviewText(config.footer.right, config.pageNumberFormat)}
            </span>
          </div>
        )}
      </div>
      <span className="text-11 text-text-tertiary">
        {config.pageSize} &middot; {config.orientation}
      </span>
    </div>
  )
}

function PageSetupModal({
  open,
  initialConfig,
  onApply,
  onClose
}: PageSetupModalProps): React.JSX.Element | null {
  const [draft, setDraft] = useState<PageConfig>(initialConfig)
  const [prevOpen, setPrevOpen] = useState(open)
  const [prevInitialConfig, setPrevInitialConfig] = useState(initialConfig)
  // Escape-to-close, a real focus trap, focus-in on open, and focus-restore
  // on close -- see useModalDialog.ts's own header comment for what this
  // fixes (aria-modal="true" was previously a false claim: the document
  // behind the scrim stayed fully tabbable and Escape did nothing). Called
  // unconditionally, before the `if (!open)` early return below, per the
  // Rules of Hooks -- the hook itself no-ops internally whenever `open` is
  // false.
  const dialogRef = useModalDialog(open, onClose)

  // Re-seed the draft from `initialConfig` every time the modal opens (or
  // the caller hands it a different config while already open) -- this is
  // an uncontrolled-on-open dialog, same spirit as MilkdownEditor's own
  // "seeds at construction, uncontrolled after" pattern, so an edit made
  // and then cancelled never leaks into the next time the modal opens.
  // Deliberately not a `useEffect`: calling `setState` from inside an
  // effect body for this exact "adjust state in response to a prop
  // change" case forces an extra, avoidable render pass (which is what
  // eslint's own `react-hooks/set-state-in-effect` rule flags). This is
  // React's own documented alternative instead -- compare against the
  // previous render's props directly in the render body and call
  // `setState` synchronously there, which React applies before this
  // render commits rather than after an extra one.
  if (open !== prevOpen || initialConfig !== prevInitialConfig) {
    setPrevOpen(open)
    setPrevInitialConfig(initialConfig)
    if (open) setDraft(initialConfig)
  }

  if (!open) return null

  const updateMargin = (key: keyof PageMargins, value: number): void => {
    setDraft((prev) => ({ ...prev, margins: { ...prev.margins, [key]: value } }))
  }

  const updateFooter = (key: keyof PageRunningContent, value: string): void => {
    setDraft((prev) => ({ ...prev, footer: { ...prev.footer, [key]: value } }))
  }

  const updateHeader = (key: keyof PageRunningContent, value: string): void => {
    setDraft((prev) => ({ ...prev, header: { ...prev.header, [key]: value } }))
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim"
      onClick={onClose}
      data-testid="page-setup-scrim"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Page setup"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[min(660px,88vh)] w-[760px] max-w-[92vw] flex-col overflow-hidden rounded-lg bg-page shadow-modal"
      >
        <div className="flex items-center justify-between border-b border-border-subtle px-5 py-3.5">
          <h2 className="text-15-5 font-bold text-text-primary">Page setup</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="text-15 text-text-secondary"
          >
            &times;
          </button>
        </div>

        {/* The "these settings don't change the page layout yet" notice that
            used to sit here is GONE, and deliberately not replaced with a
            softer version. It was already half-false after the Page Geometry
            Wiring sub-project (page size, orientation and margins became
            real there) and is now false in every particular: as of the Page
            Setup Completeness sub-project, every control in this dialog --
            size, custom dimensions, orientation, margins, header/footer
            content, page-number format, theme, and the toolbar's font
            family -- reaches the paginated preview, Home-screen thumbnails,
            and exported PDF. A stale disclaimer is worse than none: it
            teaches the user to distrust controls that now work. */}
        <div className="flex flex-1 overflow-hidden">
          <div className="flex-1 overflow-y-auto p-5">
            <section className="mb-6">
              <h3 className="text-eyebrow mb-2">Page size</h3>
              <div className="mb-3 flex gap-2">
                {PAGE_SIZES.map((size) => (
                  <PillButton
                    key={size}
                    selected={draft.pageSize === size}
                    onClick={() => setDraft((prev) => ({ ...prev, pageSize: size }))}
                  >
                    {size}
                  </PillButton>
                ))}
              </div>
              {/* Only meaningful for 'Custom', and only rendered then --
                  a width/height box sitting inert next to a selected
                  "Letter" pill would read as broken. computePageGeometry's
                  own 2in-200in clamp is the real guard (it also covers a
                  value hand-typed straight into a .md file, which no input
                  attribute can reach); min/max here is just an affordance. */}
              {draft.pageSize === 'Custom' && (
                <div className="mb-3 grid grid-cols-2 gap-3">
                  {CUSTOM_SIZE_FIELDS.map(({ key, label }) => (
                    <label key={key} className="flex flex-col gap-1">
                      <span className="text-11-5 text-text-secondary">{label}</span>
                      <input
                        type="number"
                        step="0.25"
                        min="2"
                        max="200"
                        value={draft[key]}
                        onChange={(e) =>
                          setDraft((prev) => ({ ...prev, [key]: parseFloat(e.target.value) || 0 }))
                        }
                        className="rounded-sm border border-border-subtle px-2 py-1 text-12-5 text-text-primary"
                      />
                    </label>
                  ))}
                </div>
              )}
              <div className="flex gap-2">
                {ORIENTATIONS.map(({ value, label }) => (
                  <PillButton
                    key={value}
                    selected={draft.orientation === value}
                    onClick={() => setDraft((prev) => ({ ...prev, orientation: value }))}
                  >
                    {label}
                  </PillButton>
                ))}
              </div>
            </section>

            <section className="mb-6">
              <h3 className="text-eyebrow mb-2">Margins</h3>
              <div className="grid grid-cols-2 gap-3">
                {MARGIN_FIELDS.map(({ key, label }) => (
                  <label key={key} className="flex flex-col gap-1">
                    <span className="text-11-5 text-text-secondary">{label} (in)</span>
                    <input
                      type="number"
                      step="0.05"
                      value={draft.margins[key]}
                      onChange={(e) => updateMargin(key, parseFloat(e.target.value) || 0)}
                      className="rounded-sm border border-border-subtle px-2 py-1 text-12-5 text-text-primary"
                    />
                  </label>
                ))}
              </div>
            </section>

            <section className="mb-6">
              <h3 className="text-eyebrow mb-2">Header &amp; footer</h3>
              <ToggleSwitch
                label="Show header"
                checked={draft.showHeader}
                onChange={(value) => setDraft((prev) => ({ ...prev, showHeader: value }))}
              />
              <ToggleSwitch
                label="Show footer"
                checked={draft.showFooter}
                onChange={(value) => setDraft((prev) => ({ ...prev, showFooter: value }))}
              />

              <div className="mt-3 grid grid-cols-3 gap-3">
                {HEADER_FIELDS.map(({ key, label }) => {
                  const value = draft.header[key]
                  const isDynamic = DYNAMIC_TOKEN_PATTERN.test(value)
                  return (
                    <label key={key} className="flex flex-col gap-1">
                      <span className="text-11-5 text-text-secondary">{label}</span>
                      <input
                        type="text"
                        value={value}
                        onChange={(e) => updateHeader(key, e.target.value)}
                        className={`rounded-sm border border-border-subtle px-2 py-1 text-12-5 ${
                          isDynamic ? 'text-accent' : 'text-text-primary'
                        }`}
                      />
                    </label>
                  )
                })}
              </div>

              <div className="mt-3 grid grid-cols-3 gap-3">
                {FOOTER_FIELDS.map(({ key, label }) => {
                  const value = draft.footer[key]
                  const isDynamic = DYNAMIC_TOKEN_PATTERN.test(value)
                  return (
                    <label key={key} className="flex flex-col gap-1">
                      <span className="text-11-5 text-text-secondary">{label}</span>
                      <input
                        type="text"
                        value={value}
                        onChange={(e) => updateFooter(key, e.target.value)}
                        className={`rounded-sm border border-border-subtle px-2 py-1 text-12-5 ${
                          isDynamic ? 'text-accent' : 'text-text-primary'
                        }`}
                      />
                    </label>
                  )
                })}
              </div>

              <div className="mt-3 flex gap-2">
                {PAGE_NUMBER_FORMATS.map(({ value, label }) => (
                  <PillButton
                    key={value}
                    selected={draft.pageNumberFormat === value}
                    onClick={() => setDraft((prev) => ({ ...prev, pageNumberFormat: value }))}
                  >
                    {label}
                  </PillButton>
                ))}
              </div>
            </section>

            <section>
              <h3 className="text-eyebrow mb-2">Theme</h3>
              <div className="flex gap-3">
                {THEMES.map(({ value, label }) => (
                  <button
                    key={value}
                    type="button"
                    // Disambiguated from the page-size pill of the same name
                    // ("Letter" is both a PageSize and a PageTheme) -- the
                    // visible label stays the plain theme name per the
                    // mockup, this is an accessible-name-only distinction.
                    aria-label={`Theme: ${label}`}
                    aria-pressed={draft.theme === value}
                    onClick={() => setDraft((prev) => ({ ...prev, theme: value }))}
                    className={`flex h-[112px] w-[88px] flex-col overflow-hidden rounded-md border bg-page text-left ${
                      draft.theme === value
                        ? 'border-accent shadow-glow-accent'
                        : 'border-border-subtle shadow-flat'
                    }`}
                  >
                    <div className="flex-1 bg-chrome-light">
                      <ThemeGlyph theme={value} />
                    </div>
                    <span className="px-1.5 py-1 text-11 font-medium text-text-primary">
                      {label}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          </div>

          <PreviewColumn config={draft} />
        </div>

        <div className="flex justify-end gap-2 border-t border-border-subtle px-5 py-3.5">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border-subtle px-4 py-2 text-13 font-semibold text-text-primary"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onApply(draft)}
            className="rounded-md bg-accent px-4 py-2 text-13 font-semibold text-on-accent"
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  )
}

export default PageSetupModal
