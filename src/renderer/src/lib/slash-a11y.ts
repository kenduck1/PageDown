// Shared DOM-id contract between the slash-menu palette (components/
// SlashMenu.tsx) and its ProseMirror plugin (milkdown/slash-plugin.ts) --
// kept in its own tiny, dependency-free file (matching lib/floating-
// position.ts's / lib/slash-query.ts's own "small, pure, no Milkdown/React
// import" shape) rather than defined inside either consumer, because BOTH
// need the IDENTICAL formula and NEITHER may import it from the other:
// slash-plugin.ts deliberately takes no dependency on anything React- or
// catalogue-shaped (see that file's own header comment), and SlashMenu.tsx
// is pure presentation with no ProseMirror plugin/Ctx access at all. A
// hand-copied second formula in either file is exactly the kind of drift
// this project's own "one formula, not two copies" convention
// (enabledSlashItems, findAncestorListType, chooseSlashItem, page-nav.ts's
// clampPageIndex, ...) exists to rule out -- here the stakes are
// accessibility correctness rather than data loss, but the failure mode
// (two independently-written copies silently disagreeing) is the same one.
//
// Follow-up 2 fix (CLAUDE.md's "Slash command menu" section, "the palette is
// effectively invisible to assistive technology"): `aria-activedescendant`
// is keyed on the FLAT RENDERED INDEX, not an item's own catalogue id --
// deliberately, not arbitrarily. slash-plugin.ts's own SlashSession.
// activeIndex is ALREADY defined as "an index into the CURRENTLY FILTERED
// [and isEnabled-filtered] item list" (see that file's own doc comment on
// SlashSession), which is the exact array SlashMenu.tsx renders -- so the
// plugin can compute a correct, always-in-sync aria-activedescendant value
// from its OWN session state alone, with zero knowledge of the item
// catalogue (preserving the "this file knows nothing about SLASH_ITEMS"
// invariant slash-plugin.ts's own header states at length). Keying on
// item.id instead would force the plugin to re-derive the enabled item list
// itself (a live Ctx it deliberately never holds) just to look up a DOM id --
// solving an accessibility gap by reintroducing the exact catalogue coupling
// this file's architecture was built to avoid.

/** The palette's own root listbox element -- referenced by view.dom's aria-controls. */
export const SLASH_LISTBOX_ID = 'pagedown-slash-listbox'

/** DOM id for the option at flat rendered `index` -- referenced by view.dom's aria-activedescendant. */
export function slashOptionDomId(index: number): string {
  return `pagedown-slash-item-${index}`
}
