import { useMemo } from 'react'
import { extractOutline, type OutlineHeading } from '../lib/extractOutline'

export interface EditorOutlineProps {
  content: string
  onSelectHeading: (sourceOffset: number) => void
  // Optional: the source offset of whatever's currently under the cursor/
  // scroll position in the real editor. No live scroll-tracking is built
  // yet (see CLAUDE.md/this task's brief) -- a future integration step
  // supplies this once it's wired to the real editor. When provided, the
  // heading whose range contains it (the closest PRECEDING heading, i.e.
  // the last heading at or before this offset) is highlighted as "current".
  activeSourceOffset?: number
}

// Headings look up which heading "contains" activeSourceOffset by walking
// forward through document-ordered headings and keeping the last one whose
// own start is still at or before activeSourceOffset -- i.e. the closest
// preceding heading. Returns -1 (nothing highlighted) if activeSourceOffset
// is before every heading, or wasn't supplied at all.
function findActiveIndex(headings: OutlineHeading[], activeSourceOffset?: number): number {
  if (activeSourceOffset == null) return -1
  let activeIndex = -1
  for (let index = 0; index < headings.length; index++) {
    if (headings[index].sourceOffset > activeSourceOffset) break
    activeIndex = index
  }
  return activeIndex
}

function EditorOutline({
  content,
  onSelectHeading,
  activeSourceOffset
}: EditorOutlineProps): React.JSX.Element {
  const headings = useMemo(() => extractOutline(content), [content])
  const activeIndex = useMemo(
    () => findActiveIndex(headings, activeSourceOffset),
    [headings, activeSourceOffset]
  )

  if (headings.length === 0) {
    return (
      <div className="px-3 py-4 text-11 text-text-tertiary">No headings in this document yet.</div>
    )
  }

  return (
    <ul className="flex flex-col gap-px overflow-y-auto px-2 py-2">
      {headings.map((heading, index) => {
        const isTopLevel = heading.depth === 1
        const isActive = index === activeIndex

        return (
          <li key={`${heading.sourceOffset}-${index}`}>
            <button
              type="button"
              onClick={() => onSelectHeading(heading.sourceOffset)}
              className={[
                'block w-full truncate rounded-sm text-left',
                isTopLevel ? 'py-[7px] pl-2 pr-2 text-12-5' : 'py-1.5 pl-5 pr-2 text-11-5',
                isActive
                  ? 'bg-accent/9 font-bold text-accent'
                  : [
                      isTopLevel ? 'text-text-primary' : 'text-text-secondary',
                      'hover:bg-chrome-dark'
                    ].join(' ')
              ].join(' ')}
            >
              {heading.text || 'Untitled heading'}
            </button>
          </li>
        )
      })}
    </ul>
  )
}

export default EditorOutline
