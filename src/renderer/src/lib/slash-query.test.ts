import { describe, expect, it } from 'vitest'
import { findSlashTrigger } from './slash-query'

describe('findSlashTrigger', () => {
  it('opens a session for a bare "/" at the start of the block', () => {
    expect(findSlashTrigger('/')).toEqual({ slashOffset: 0, query: '' })
  })

  it('opens a session for a "/" preceded by whitespace', () => {
    expect(findSlashTrigger('text /')).toEqual({ slashOffset: 5, query: '' })
  })

  it('extends the query as more characters are typed after the "/"', () => {
    expect(findSlashTrigger('text /he')).toEqual({ slashOffset: 5, query: 'he' })
  })

  // The false-positive guard: a "/" that is neither at the start of the
  // block nor preceded by whitespace must never open a session, however
  // common the surrounding word is.
  it('rejects "and/or" -- the "/" is preceded by a letter, not whitespace', () => {
    expect(findSlashTrigger('and/or')).toBeNull()
  })

  it('rejects "foo/bar" for the same reason', () => {
    expect(findSlashTrigger('foo/bar')).toBeNull()
  })

  // Both slashes in "https://foo" fail the trigger-position rule: the first
  // is preceded by ":", the second by the first "/" -- neither is
  // whitespace or the start of the block.
  it('rejects a URL-shaped "https://foo"', () => {
    expect(findSlashTrigger('https://foo')).toBeNull()
  })

  it('returns the query typed so far for "/head"', () => {
    expect(findSlashTrigger('/head')).toEqual({ slashOffset: 0, query: 'head' })
  })

  // "/ note" is a real, disclosed false-positive risk: the user is writing
  // prose starting with a literal slash character, not invoking the menu.
  // The space right after "/" means the query is " note", which fails the
  // no-whitespace rule -- this is also, incidentally, the case that
  // distinguishes "the query must be whitespace-free" from "the / must be
  // preceded by whitespace": the LEADING space here belongs to the query,
  // not to what precedes the /.
  it('rejects "/ note" -- the query would contain whitespace', () => {
    expect(findSlashTrigger('/ note')).toBeNull()
  })

  // Nothing in the spec excludes "/" from a query -- only whitespace
  // invalidates it. The FIRST "/" opens the session (start of block); the
  // three that follow are just literal query characters, the same as if
  // the user had typed "/abc". This is what distinguishes this function's
  // "scan for the trailing whitespace-free run" approach from a naive
  // `text.lastIndexOf('/')`, which would inspect only the fourth "/" (see
  // it's preceded by another "/", not whitespace) and wrongly reject the
  // whole string.
  it('treats "////" as a single session whose query is "///"', () => {
    expect(findSlashTrigger('////')).toEqual({ slashOffset: 0, query: '///' })
  })

  it('accepts a query at exactly the 24-character cap', () => {
    const query = 'a'.repeat(24)
    expect(findSlashTrigger(`/${query}`)).toEqual({ slashOffset: 0, query })
  })

  it('rejects a query one character past the cap, at 25 characters', () => {
    expect(findSlashTrigger(`/${'a'.repeat(25)}`)).toBeNull()
  })

  it('accepts a non-ASCII query', () => {
    expect(findSlashTrigger('/héllo')).toEqual({ slashOffset: 0, query: 'héllo' })
    expect(findSlashTrigger('/日本語')).toEqual({ slashOffset: 0, query: '日本語' })
  })

  it('returns null for an empty string -- nothing has been typed yet', () => {
    expect(findSlashTrigger('')).toBeNull()
  })

  it('returns null once the query is terminated by trailing whitespace', () => {
    // Typing a space after the query closes the session -- the cursor's
    // current "word" is now empty, which can't start with "/".
    expect(findSlashTrigger('/head ')).toBeNull()
  })

  // A block can contain an earlier, now-closed slash session followed by
  // ordinary prose; only the word the cursor currently sits in matters.
  it('ignores an earlier "/" once the cursor has moved past it into prose', () => {
    expect(findSlashTrigger('/head is a command, ok')).toBeNull()
  })

  // ...but a SECOND "/" later in the same block, with nothing after it,
  // correctly opens a new session anchored to that second "/", not the
  // first.
  it('anchors to the most recent "/" when the block contains an earlier one', () => {
    expect(findSlashTrigger('/first note, then /second')).toEqual({
      slashOffset: 18,
      query: 'second'
    })
  })

  it('rejects a query containing internal whitespace even with a valid trigger position', () => {
    expect(findSlashTrigger('/two words')).toBeNull()
  })
})
