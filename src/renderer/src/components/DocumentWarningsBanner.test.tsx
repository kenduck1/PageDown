import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import DocumentWarningsBanner from './DocumentWarningsBanner'
import { initialDocumentState, useDocumentStore } from '../store/documentStore'
import type { DocumentWarning } from '../../../markdown/document-warnings'

const FRONTMATTER_WARNING: DocumentWarning = {
  id: 'malformed-frontmatter',
  message: "This document's frontmatter isn't valid YAML, so default page settings are being used."
}

const INLINE_WARNING: DocumentWarning = {
  id: 'inline-pagebreak-marker',
  message: "A <!-- pagebreak --> marker is written inline, so it won't create a page break."
}

beforeEach(() => {
  useDocumentStore.setState(initialDocumentState)
})

afterEach(() => {
  cleanup()
})

describe('DocumentWarningsBanner', () => {
  it('renders nothing when there are no warnings', () => {
    render(<DocumentWarningsBanner warnings={[]} />)
    expect(screen.queryByRole('group', { name: 'Document warnings' })).not.toBeInTheDocument()
  })

  it('renders the banner with the warning message', () => {
    render(<DocumentWarningsBanner warnings={[FRONTMATTER_WARNING]} />)
    expect(screen.getByRole('group', { name: 'Document warnings' })).toBeInTheDocument()
    expect(screen.getByText(FRONTMATTER_WARNING.message)).toBeInTheDocument()
  })

  it('joins multiple simultaneous warnings into one row', () => {
    render(<DocumentWarningsBanner warnings={[FRONTMATTER_WARNING, INLINE_WARNING]} />)
    // `getByText`'s default matcher normalizes (trims + collapses)
    // whitespace before comparing -- the component's own literal separator
    // is two spaces on each side of the middot (`  ·  `), which normalizes
    // to single spaces here, not because the rendered text itself changed.
    expect(
      screen.getByText(`${FRONTMATTER_WARNING.message} · ${INLINE_WARNING.message}`)
    ).toBeInTheDocument()
  })

  it('clicking Dismiss hides the banner', async () => {
    const user = userEvent.setup()
    render(<DocumentWarningsBanner warnings={[FRONTMATTER_WARNING]} />)

    await user.click(screen.getByRole('button', { name: 'Dismiss' }))

    expect(screen.queryByRole('group', { name: 'Document warnings' })).not.toBeInTheDocument()
  })

  it('stays dismissed across a re-render with the SAME unresolved warnings', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<DocumentWarningsBanner warnings={[FRONTMATTER_WARNING]} />)
    await user.click(screen.getByRole('button', { name: 'Dismiss' }))

    // Same warning, still present -- e.g. the user kept typing elsewhere in
    // the document without touching the frontmatter block at all.
    rerender(<DocumentWarningsBanner warnings={[FRONTMATTER_WARNING]} />)

    expect(screen.queryByRole('group', { name: 'Document warnings' })).not.toBeInTheDocument()
  })

  // The core re-arm rule: dismissing does NOT permanently mute a warning
  // category. Once the underlying problem is fully resolved (warnings goes
  // to []) and then recurs -- even as the exact same category -- it is
  // treated as fresh news, not a re-trigger of the old dismissal.
  it('re-appears after the warning set clears and then a new occurrence (even the same category) shows up', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<DocumentWarningsBanner warnings={[FRONTMATTER_WARNING]} />)
    await user.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('group', { name: 'Document warnings' })).not.toBeInTheDocument()

    // The user fixed the YAML -- warnings clears entirely.
    rerender(<DocumentWarningsBanner warnings={[]} />)
    expect(screen.queryByRole('group', { name: 'Document warnings' })).not.toBeInTheDocument()

    // ...and then breaks it again. This must NOT stay silently suppressed.
    rerender(<DocumentWarningsBanner warnings={[FRONTMATTER_WARNING]} />)
    expect(screen.getByRole('group', { name: 'Document warnings' })).toBeInTheDocument()
  })

  it('a different warning category appearing while dismissed does not itself re-arm (accepted, documented simplification)', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<DocumentWarningsBanner warnings={[FRONTMATTER_WARNING]} />)
    await user.click(screen.getByRole('button', { name: 'Dismiss' }))

    // A second, unrelated category shows up WITHOUT the warning set ever
    // passing through empty. Dismissal is scoped to "stop nagging about the
    // current batch of problems," not per-warning-id -- see this
    // component's own header comment.
    rerender(<DocumentWarningsBanner warnings={[FRONTMATTER_WARNING, INLINE_WARNING]} />)

    expect(screen.queryByRole('group', { name: 'Document warnings' })).not.toBeInTheDocument()
  })

  it('switching to a different tab shows warnings again, even if the previous tab was dismissed', async () => {
    useDocumentStore.setState({ activeTabId: 'tab-a' })
    const user = userEvent.setup()
    const { rerender } = render(<DocumentWarningsBanner warnings={[FRONTMATTER_WARNING]} />)
    await user.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('group', { name: 'Document warnings' })).not.toBeInTheDocument()

    useDocumentStore.setState({ activeTabId: 'tab-b' })
    rerender(<DocumentWarningsBanner warnings={[FRONTMATTER_WARNING]} />)

    expect(screen.getByRole('group', { name: 'Document warnings' })).toBeInTheDocument()
  })
})
