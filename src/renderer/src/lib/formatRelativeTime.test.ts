import { describe, it, expect } from 'vitest'
import { formatRelativeTime } from './formatRelativeTime'

const NOW = new Date('2026-08-04T12:00:00.000Z')

function isoMinutesAgo(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString()
}

describe('formatRelativeTime', () => {
  it('returns "just now" for under a minute ago', () => {
    expect(formatRelativeTime(isoMinutesAgo(0.5), NOW)).toBe('just now')
  })

  it('returns minutes ago for under an hour', () => {
    expect(formatRelativeTime(isoMinutesAgo(5), NOW)).toBe('5 minutes ago')
  })

  it('returns hours ago for under a day', () => {
    expect(formatRelativeTime(isoMinutesAgo(3 * 60), NOW)).toBe('3 hours ago')
  })

  it('returns days ago for under a week', () => {
    expect(formatRelativeTime(isoMinutesAgo(2 * 24 * 60), NOW)).toBe('2 days ago')
  })

  it('returns a short date for a week or more ago', () => {
    const result = formatRelativeTime(isoMinutesAgo(10 * 24 * 60), NOW)
    expect(result).not.toMatch(/ago|now/)
  })

  it('uses singular "minute"/"hour"/"day" for a count of 1', () => {
    expect(formatRelativeTime(isoMinutesAgo(1), NOW)).toBe('1 minute ago')
    expect(formatRelativeTime(isoMinutesAgo(60), NOW)).toBe('1 hour ago')
    expect(formatRelativeTime(isoMinutesAgo(24 * 60), NOW)).toBe('1 day ago')
  })
})
