function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'} ago`
}

export function formatRelativeTime(isoString: string, now: Date = new Date()): string {
  const then = new Date(isoString)
  const diffMs = now.getTime() - then.getTime()
  const diffMinutes = Math.floor(diffMs / 60_000)

  if (diffMinutes < 1) return 'just now'
  if (diffMinutes < 60) return plural(diffMinutes, 'minute')

  const diffHours = Math.floor(diffMinutes / 60)
  if (diffHours < 24) return plural(diffHours, 'hour')

  const diffDays = Math.floor(diffHours / 24)
  if (diffDays < 7) return plural(diffDays, 'day')

  return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
