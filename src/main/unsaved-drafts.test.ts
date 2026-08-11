import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, readdir, readFile, writeFile, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  generateDraftId,
  isValidDraftId,
  writeUnsavedDraft,
  readUnsavedDraft,
  listUnsavedDrafts,
  discardUnsavedDraft,
  pruneExpiredDrafts,
  buildDraftPreview
} from './unsaved-drafts'

// Real temp directories and real files throughout -- deliberately NOT mocked
// fs, matching version-history.test.ts's own integration style. The bugs this
// feature can realistically ship (a discard that silently deletes nothing, a
// traversal escaping the drafts directory, a truncated write) are all
// filesystem-level, and a mocked fs would certify every one of them as
// working.

const DRAFTS_DIR = 'unsaved'

describe('generateDraftId / isValidDraftId', () => {
  it('generates 32 lowercase hex characters', () => {
    expect(generateDraftId()).toMatch(/^[0-9a-f]{32}$/)
  })

  it('generates a different id every time', () => {
    const ids = new Set(Array.from({ length: 50 }, generateDraftId))
    expect(ids.size).toBe(50)
  })

  it('accepts an id it generated itself', () => {
    expect(isValidDraftId(generateDraftId())).toBe(true)
  })

  it.each([
    ['empty', ''],
    ['too short', 'abc'],
    ['too long', `${'a'.repeat(33)}`],
    ['uppercase hex', 'A'.repeat(32)],
    ['non-hex', 'g'.repeat(32)],
    ['path traversal', '../../../../etc/passwd'],
    ['traversal appended to a valid id', `${'a'.repeat(32)}/../../evil`],
    ['valid id with a leading newline', `\n${'a'.repeat(32)}`],
    ['valid id with a trailing newline', `${'a'.repeat(32)}\n`]
  ])('rejects %s', (_label, value) => {
    expect(isValidDraftId(value)).toBe(false)
  })
})

describe('unsaved draft storage', () => {
  let userDataDir: string

  beforeEach(async () => {
    userDataDir = await mkdtemp(join(tmpdir(), 'pagedown-drafts-test-'))
  })

  afterEach(async () => {
    await rm(userDataDir, { recursive: true, force: true })
  })

  it('lists nothing before any draft has been written', async () => {
    expect(await listUnsavedDrafts(userDataDir)).toEqual([])
  })

  it('mints an id on the first write and reads the content back', async () => {
    const draftId = await writeUnsavedDraft(userDataDir, null, '# Untitled work')
    expect(draftId).not.toBeNull()
    expect(isValidDraftId(draftId as string)).toBe(true)
    expect(await readUnsavedDraft(userDataDir, draftId as string)).toBe('# Untitled work')
  })

  it('overwrites the SAME draft when given back its own id, rather than accumulating files', async () => {
    const draftId = (await writeUnsavedDraft(userDataDir, null, 'first')) as string
    await writeUnsavedDraft(userDataDir, draftId, 'second')
    await writeUnsavedDraft(userDataDir, draftId, 'third')

    expect(await readUnsavedDraft(userDataDir, draftId)).toBe('third')
    // The real files on disk, not just the listing -- one draft means one
    // file, which is the whole point of echoing the id back.
    const files = await readdir(join(userDataDir, DRAFTS_DIR))
    expect(files).toEqual([`${draftId}.md`])
  })

  it('writes nothing at all for byte-empty content', async () => {
    expect(await writeUnsavedDraft(userDataDir, null, '')).toBeNull()
    // Not even the directory -- a blank tab must leave no trace.
    await expect(readdir(join(userDataDir, DRAFTS_DIR))).rejects.toThrow()
  })

  it('DOES write whitespace-only and frontmatter-only content', async () => {
    // Deliberately byte-exact emptiness only: whitespace or a template's
    // frontmatter is content somebody produced on purpose (the same
    // reasoning documentStore.isPristineBlankTab records).
    const whitespace = await writeUnsavedDraft(userDataDir, null, '   \n\n')
    const frontmatter = await writeUnsavedDraft(userDataDir, null, '---\npageSize: A4\n---\n')
    expect(whitespace).not.toBeNull()
    expect(frontmatter).not.toBeNull()
  })

  it('throws for an invalid non-null draft id rather than silently minting a new one', async () => {
    await expect(writeUnsavedDraft(userDataDir, '../escape', 'x')).rejects.toThrow(
      /Invalid unsaved-draft id/
    )
    // And it wrote nothing anywhere.
    await expect(readdir(join(userDataDir, DRAFTS_DIR))).rejects.toThrow()
  })

  it('returns null for an unknown or malformed id rather than throwing', async () => {
    expect(await readUnsavedDraft(userDataDir, generateDraftId())).toBeNull()
    expect(await readUnsavedDraft(userDataDir, '../../../../etc/passwd')).toBeNull()
  })

  it('never reads outside the drafts directory even for a traversal id that names a real file', async () => {
    // A real, readable file one level up from the drafts directory. If id
    // validation were dropped, join(userDataDir, 'unsaved', '../secret.md')
    // resolves to exactly this file -- so a passing assertion here is
    // genuinely load-bearing, not a tautology about a file that does not
    // exist.
    await mkdir(join(userDataDir, DRAFTS_DIR), { recursive: true })
    await writeFile(join(userDataDir, 'secret.md'), 'TOP SECRET')
    expect(await readUnsavedDraft(userDataDir, '../secret.md')).toBeNull()
    expect(await readUnsavedDraft(userDataDir, '../secret')).toBeNull()
  })

  it('lists a written draft with real metadata and a readable preview', async () => {
    const draftId = (await writeUnsavedDraft(
      userDataDir,
      null,
      '---\npageSize: Letter\n---\n\n# Quarterly report\n\nBody text.'
    )) as string

    const drafts = await listUnsavedDrafts(userDataDir)
    expect(drafts).toHaveLength(1)
    expect(drafts[0].draftId).toBe(draftId)
    expect(drafts[0].preview).toBe('Quarterly report')
    expect(drafts[0].sizeBytes).toBeGreaterThan(0)
    expect(Number.isNaN(new Date(drafts[0].updatedAt).getTime())).toBe(false)
  })

  it('lists most-recently-updated first', async () => {
    const older = (await writeUnsavedDraft(userDataDir, null, 'older')) as string
    const newer = (await writeUnsavedDraft(userDataDir, null, 'newer')) as string
    // Both writes land within the same millisecond on a fast machine, which
    // would make the sort untestable -- push the older one unambiguously
    // into the past rather than relying on wall-clock delay between awaits
    // (the same technique gate14 uses for its own mtime setup).
    const past = new Date(Date.now() - 60_000)
    await utimes(join(userDataDir, DRAFTS_DIR, `${older}.md`), past, past)

    const drafts = await listUnsavedDrafts(userDataDir)
    expect(drafts.map((draft) => draft.draftId)).toEqual([newer, older])
  })

  it('ignores files in the drafts directory that are not drafts', async () => {
    const draftId = (await writeUnsavedDraft(userDataDir, null, 'real work')) as string
    // A leftover .tmp from an interrupted write, and unrelated junk. Neither
    // is somebody's lost work, and offering either would be worse than
    // dropping it.
    await writeFile(join(userDataDir, DRAFTS_DIR, `${draftId}.md.tmp`), 'partial')
    await writeFile(join(userDataDir, DRAFTS_DIR, 'notes.md'), 'unrelated')
    await writeFile(join(userDataDir, DRAFTS_DIR, 'ZZZZ.md'), 'wrong shape')

    const drafts = await listUnsavedDrafts(userDataDir)
    expect(drafts.map((draft) => draft.draftId)).toEqual([draftId])
  })

  it('drops one unreadable draft without hiding the others', async () => {
    const good = (await writeUnsavedDraft(userDataDir, null, 'good content')) as string
    const truncatedId = generateDraftId()
    // A zero-byte file is what a truncated write would leave behind;
    // writeUnsavedDraft itself can never produce one.
    await writeFile(join(userDataDir, DRAFTS_DIR, `${truncatedId}.md`), '')

    const drafts = await listUnsavedDrafts(userDataDir)
    expect(drafts.map((draft) => draft.draftId)).toEqual([good])
  })

  it('discards a draft so its file is genuinely gone from disk', async () => {
    const draftId = (await writeUnsavedDraft(userDataDir, null, 'discard me')) as string
    const filePath = join(userDataDir, DRAFTS_DIR, `${draftId}.md`)
    await expect(stat(filePath)).resolves.toBeDefined()

    await discardUnsavedDraft(userDataDir, draftId)

    // The real assertion this feature turns on: the version-history bug this
    // mirrors (a renderer-supplied cutoff that made the deletion a silent
    // no-op) would have passed any test that only checked the call resolved.
    await expect(stat(filePath)).rejects.toThrow()
    expect(await readUnsavedDraft(userDataDir, draftId)).toBeNull()
    expect(await listUnsavedDrafts(userDataDir)).toEqual([])
  })

  it('a discarded draft cannot come back on a later listing', async () => {
    const draftId = (await writeUnsavedDraft(userDataDir, null, 'gone')) as string
    await discardUnsavedDraft(userDataDir, draftId)
    expect(await listUnsavedDrafts(userDataDir)).toEqual([])
    expect(await listUnsavedDrafts(userDataDir)).toEqual([])
  })

  it('discarding an absent or malformed draft is a silent no-op', async () => {
    await expect(discardUnsavedDraft(userDataDir, generateDraftId())).resolves.toBeUndefined()
    await expect(discardUnsavedDraft(userDataDir, '../../evil')).resolves.toBeUndefined()
  })

  it('never deletes outside the drafts directory for a traversal id', async () => {
    await mkdir(join(userDataDir, DRAFTS_DIR), { recursive: true })
    await writeFile(join(userDataDir, 'secret.md'), 'TOP SECRET')
    // BOTH spellings, and the second one is the load-bearing one -- found by
    // mutation-testing this file. draftPath appends '.md', so a '../secret.md'
    // id resolves to a harmless '../secret.md.md' that never existed; it would
    // pass this assertion even with every id check deleted. '../secret'
    // resolves to the REAL file, so only that spelling can distinguish a
    // working guard from an absent one.
    await discardUnsavedDraft(userDataDir, '../secret.md')
    await discardUnsavedDraft(userDataDir, '../secret')
    expect(await readFile(join(userDataDir, 'secret.md'), 'utf8')).toBe('TOP SECRET')
  })

  it('serializes a discard against an in-flight write for the same draft', async () => {
    // The ordering hazard the per-draft queue exists for: without it, a
    // discard can land BETWEEN a write's own mkdir and its rename, deleting
    // nothing and letting the write recreate the file a moment later --
    // resurrecting work the user explicitly discarded. Dispatched without
    // awaiting the write first, so the two genuinely overlap.
    const draftId = (await writeUnsavedDraft(userDataDir, null, 'v1')) as string
    const write = writeUnsavedDraft(userDataDir, draftId, 'v2')
    const discard = discardUnsavedDraft(userDataDir, draftId)
    await Promise.all([write, discard])

    // Discard was enqueued second, so it must win.
    expect(await readUnsavedDraft(userDataDir, draftId)).toBeNull()
  })
})

describe('pruneExpiredDrafts', () => {
  let userDataDir: string

  beforeEach(async () => {
    userDataDir = await mkdtemp(join(tmpdir(), 'pagedown-drafts-prune-'))
  })

  afterEach(async () => {
    await rm(userDataDir, { recursive: true, force: true })
  })

  it('keeps a recent draft', async () => {
    const draftId = (await writeUnsavedDraft(userDataDir, null, 'fresh')) as string
    expect(await pruneExpiredDrafts(userDataDir, new Date())).toEqual([])
    expect(await readUnsavedDraft(userDataDir, draftId)).toBe('fresh')
  })

  it('removes a draft older than the 30-day retention window', async () => {
    const draftId = (await writeUnsavedDraft(userDataDir, null, 'ancient')) as string
    const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
    await utimes(join(userDataDir, 'unsaved', `${draftId}.md`), longAgo, longAgo)

    expect(await pruneExpiredDrafts(userDataDir, new Date())).toEqual([draftId])
    expect(await readUnsavedDraft(userDataDir, draftId)).toBeNull()
  })

  it('measures age from the last WRITE, so a still-edited old draft survives', async () => {
    const draftId = (await writeUnsavedDraft(userDataDir, null, 'ancient')) as string
    const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
    await utimes(join(userDataDir, 'unsaved', `${draftId}.md`), longAgo, longAgo)
    // One more edit refreshes the mtime, which is what "still being worked
    // on" means for a document that has no other timestamp.
    await writeUnsavedDraft(userDataDir, draftId, 'ancient, but edited just now')

    expect(await pruneExpiredDrafts(userDataDir, new Date())).toEqual([])
    expect(await readUnsavedDraft(userDataDir, draftId)).toBe('ancient, but edited just now')
  })

  it('prunes only the expired drafts, leaving the rest listed', async () => {
    const stale = (await writeUnsavedDraft(userDataDir, null, 'stale')) as string
    const live = (await writeUnsavedDraft(userDataDir, null, 'live')) as string
    const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
    await utimes(join(userDataDir, 'unsaved', `${stale}.md`), longAgo, longAgo)

    expect(await pruneExpiredDrafts(userDataDir, new Date())).toEqual([stale])
    const remaining = await listUnsavedDrafts(userDataDir)
    expect(remaining.map((draft) => draft.draftId)).toEqual([live])
  })
})

describe('buildDraftPreview', () => {
  it('uses the first non-blank line', () => {
    expect(buildDraftPreview('\n\nHello there\nsecond line')).toBe('Hello there')
  })

  it('strips a heading marker', () => {
    expect(buildDraftPreview('### Meeting notes')).toBe('Meeting notes')
  })

  it('strips bullet, ordered-list and blockquote markers', () => {
    expect(buildDraftPreview('- buy milk')).toBe('buy milk')
    expect(buildDraftPreview('1. first item')).toBe('first item')
    expect(buildDraftPreview('> quoted')).toBe('quoted')
  })

  it('skips a leading frontmatter block', () => {
    // The single most common draft in existence: useCreateDocument applies
    // the user's default page config as frontmatter to every new blank
    // document, so without this skip every draft would be labelled
    // "pageSize: Letter" and be indistinguishable from every other draft.
    expect(buildDraftPreview('---\npageSize: Letter\ntheme: resume\n---\n\nReal title')).toBe(
      'Real title'
    )
  })

  it('does NOT swallow the body when a leading --- has no closing fence', () => {
    // A thematic break on line 1, not frontmatter. Scanning to a closing
    // `---` that never arrives would consume the whole document.
    expect(buildDraftPreview('---\n\nActual content')).toBe('Actual content')
  })

  it('truncates with an ellipsis', () => {
    const preview = buildDraftPreview('x'.repeat(200))
    expect(preview).toHaveLength(80)
    expect(preview.endsWith('…')).toBe(true)
  })

  it('returns an empty string for content with nothing renderable', () => {
    expect(buildDraftPreview('')).toBe('')
    expect(buildDraftPreview('\n  \n\t\n')).toBe('')
  })
})
