// The one place that turns a document's file path into the short label the
// user sees for it. Extracted out of EditorTabBar.tsx when the window-close
// guard needed the identical string for its "save the changes you made to
// <name>?" dialog -- two copies of this would let a tab read "report.md" while
// the dialog asking whether to discard it named something else.
//
// Splits on BOTH path separators (matching HomeScreen's own recent rows) and
// falls back to "Untitled" for a document that has never been saved.
export function tabLabel(filePath: string | null): string {
  if (!filePath) return 'Untitled'
  return filePath.split(/[/\\]/).pop() ?? filePath
}
