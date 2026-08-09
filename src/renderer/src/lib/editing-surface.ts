import type { SplitLeftMode, ViewMode } from '../store/appStore'

// "Which editing surface is live" is asked in two places that must not drift:
// EditorScreen's handleSetViewMode (which flushes/remounts Milkdown across a
// transition) and useFindController (which decides what Find searches).
// Split mode's left pane IS Format or Source editing, just in a different
// layout, which is why neither question can be answered from viewMode alone.
export function isFormatEditing(viewMode: ViewMode, splitLeftMode: SplitLeftMode): boolean {
  return viewMode === 'format' || (viewMode === 'split' && splitLeftMode === 'format')
}

export function isSourceEditing(viewMode: ViewMode, splitLeftMode: SplitLeftMode): boolean {
  return viewMode === 'source' || (viewMode === 'split' && splitLeftMode === 'source')
}
