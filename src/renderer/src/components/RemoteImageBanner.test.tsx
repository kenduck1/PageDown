import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import RemoteImageBanner from './RemoteImageBanner'
import { initialDocumentState, useDocumentStore } from '../store/documentStore'

beforeEach(() => {
  useDocumentStore.setState(initialDocumentState)
})

afterEach(() => {
  cleanup()
})

describe('RemoteImageBanner', () => {
  it('renders nothing for a document with no remote images', () => {
    useDocumentStore.setState({ content: '# No images here' })
    render(<RemoteImageBanner />)
    expect(screen.queryByRole('group', { name: 'Remote image consent' })).not.toBeInTheDocument()
  })

  it('renders the banner for a document with a remote image and no decision yet', () => {
    useDocumentStore.setState({ content: '![x](https://example.com/a.png)' })
    render(<RemoteImageBanner />)
    expect(screen.getByRole('group', { name: 'Remote image consent' })).toBeInTheDocument()
    expect(
      screen.getByText('This document wants to load images from the internet.')
    ).toBeInTheDocument()
  })

  it('renders nothing once the active tab already has an explicit decision, even though the document still has remote images', () => {
    useDocumentStore.setState({
      content: '![x](https://example.com/a.png)',
      remoteImagesAllowed: false
    })
    render(<RemoteImageBanner />)
    expect(screen.queryByRole('group', { name: 'Remote image consent' })).not.toBeInTheDocument()
  })

  it('clicking Load sets remoteImagesAllowed to true for the active tab and hides the banner', async () => {
    useDocumentStore.setState({ content: '![x](https://example.com/a.png)' })
    const user = userEvent.setup()
    render(<RemoteImageBanner />)

    await user.click(screen.getByRole('button', { name: 'Load' }))

    expect(useDocumentStore.getState().remoteImagesAllowed).toBe(true)
    const activeId = useDocumentStore.getState().activeTabId
    const tab = useDocumentStore.getState().tabs.find((t) => t.id === activeId)
    expect(tab?.remoteImagesAllowed).toBe(true)
  })

  it('clicking Keep blocked sets remoteImagesAllowed to false for the active tab and hides the banner', async () => {
    useDocumentStore.setState({ content: '![x](https://example.com/a.png)' })
    const user = userEvent.setup()
    render(<RemoteImageBanner />)

    await user.click(screen.getByRole('button', { name: 'Keep blocked' }))

    expect(useDocumentStore.getState().remoteImagesAllowed).toBe(false)
  })
})
