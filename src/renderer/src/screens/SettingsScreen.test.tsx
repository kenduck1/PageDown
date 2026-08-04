import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SettingsScreen from './SettingsScreen'
import { useAppStore, initialAppState } from '../store/appStore'

beforeEach(() => {
  useAppStore.setState({ ...initialAppState, screen: 'settings' })
})

afterEach(() => {
  cleanup()
})

describe('SettingsScreen', () => {
  it('renders a coming-soon message', () => {
    render(<SettingsScreen />)
    expect(screen.getByText('Coming soon.')).toBeInTheDocument()
  })

  it('navigates back to Home on "← Home" click', async () => {
    const user = userEvent.setup()
    render(<SettingsScreen />)
    await user.click(screen.getByRole('button', { name: '← Home' }))
    expect(useAppStore.getState().screen).toBe('home')
  })
})
