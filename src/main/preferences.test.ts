import { describe, it, expect } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_PREFERENCES, readPreferences, writePreferences } from './preferences'

describe('readPreferences / writePreferences', () => {
  it('round-trips a real preferences object through a real temp directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pagedown-preferences-'))
    try {
      const preferences = {
        spellcheckEnabled: false,
        autosaveIntervalMs: 60_000,
        defaultPageConfig: {
          pageSize: 'A4' as const,
          orientation: 'landscape' as const,
          theme: 'resume' as const,
          fontFamily: 'inter' as const
        },
        colorScheme: 'dark' as const,
        authorName: 'Kai'
      }
      await writePreferences(dir, preferences)
      const result = await readPreferences(dir)
      expect(result).toEqual(preferences)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns DEFAULT_PREFERENCES when no file exists yet', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pagedown-preferences-'))
    try {
      const result = await readPreferences(dir)
      expect(result).toEqual(DEFAULT_PREFERENCES)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('degrades a malformed file to DEFAULT_PREFERENCES rather than throwing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pagedown-preferences-'))
    try {
      await writeFile(join(dir, 'preferences.json'), 'not valid json{{{', 'utf8')
      const result = await readPreferences(dir)
      expect(result).toEqual(DEFAULT_PREFERENCES)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('sanitizes individual bad fields to their own defaults rather than discarding the whole file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pagedown-preferences-'))
    try {
      await writeFile(
        join(dir, 'preferences.json'),
        JSON.stringify({
          spellcheckEnabled: 'yes', // wrong type
          autosaveIntervalMs: 60_000, // valid
          defaultPageConfig: {
            pageSize: 'Poster', // not a real PageSize
            orientation: 'landscape', // valid
            theme: 'resume', // valid
            fontFamily: 'comic-sans' // not a real PageFontFamily
          }
        }),
        'utf8'
      )
      const result = await readPreferences(dir)
      expect(result).toEqual({
        spellcheckEnabled: DEFAULT_PREFERENCES.spellcheckEnabled,
        autosaveIntervalMs: 60_000,
        defaultPageConfig: {
          pageSize: DEFAULT_PREFERENCES.defaultPageConfig.pageSize,
          orientation: 'landscape',
          theme: 'resume',
          fontFamily: DEFAULT_PREFERENCES.defaultPageConfig.fontFamily
        },
        colorScheme: DEFAULT_PREFERENCES.colorScheme,
        authorName: DEFAULT_PREFERENCES.authorName
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects an autosave interval below the 5s floor, falling back to the default', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pagedown-preferences-'))
    try {
      await writeFile(
        join(dir, 'preferences.json'),
        JSON.stringify({ ...DEFAULT_PREFERENCES, autosaveIntervalMs: 100 }),
        'utf8'
      )
      const result = await readPreferences(dir)
      expect(result.autosaveIntervalMs).toBe(DEFAULT_PREFERENCES.autosaveIntervalMs)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('a truncated (crash-mid-write) file degrades to defaults rather than throwing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pagedown-preferences-'))
    try {
      // Half of a real JSON object -- what write-then-rename's own atomicity
      // is meant to make impossible in practice, but readPreferences should
      // still degrade gracefully if it ever happens (e.g. a hand-edited file).
      await writeFile(join(dir, 'preferences.json'), '{"spellcheckEnabled": tr', 'utf8')
      const result = await readPreferences(dir)
      expect(result).toEqual(DEFAULT_PREFERENCES)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('defaults colorScheme to "system" and sanitizes an invalid value back to it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pagedown-preferences-'))
    try {
      expect(DEFAULT_PREFERENCES.colorScheme).toBe('system')
      const noFile = await readPreferences(dir)
      expect(noFile.colorScheme).toBe('system')

      await writeFile(
        join(dir, 'preferences.json'),
        JSON.stringify({ ...DEFAULT_PREFERENCES, colorScheme: 'purple' }),
        'utf8'
      )
      const invalid = await readPreferences(dir)
      expect(invalid.colorScheme).toBe('system')

      await writeFile(
        join(dir, 'preferences.json'),
        JSON.stringify({ ...DEFAULT_PREFERENCES, colorScheme: 'dark' }),
        'utf8'
      )
      const valid = await readPreferences(dir)
      expect(valid.colorScheme).toBe('dark')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('defaults authorName to an empty string and sanitizes a non-string value back to it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pagedown-preferences-'))
    try {
      expect(DEFAULT_PREFERENCES.authorName).toBe('')
      const noFile = await readPreferences(dir)
      expect(noFile.authorName).toBe('')

      await writeFile(
        join(dir, 'preferences.json'),
        JSON.stringify({ ...DEFAULT_PREFERENCES, authorName: 42 }),
        'utf8'
      )
      const invalid = await readPreferences(dir)
      expect(invalid.authorName).toBe('')

      await writeFile(
        join(dir, 'preferences.json'),
        JSON.stringify({ ...DEFAULT_PREFERENCES, authorName: 'Kai' }),
        'utf8'
      )
      const valid = await readPreferences(dir)
      expect(valid.authorName).toBe('Kai')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
