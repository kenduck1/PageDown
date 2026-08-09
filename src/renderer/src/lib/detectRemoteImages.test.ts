import { describe, it, expect } from 'vitest'
import { documentHasRemoteImages } from './detectRemoteImages'

describe('documentHasRemoteImages', () => {
  it('returns false for an empty document', () => {
    expect(documentHasRemoteImages('')).toBe(false)
  })

  it('returns false for a document with no images at all', () => {
    expect(documentHasRemoteImages('Just a paragraph of text.')).toBe(false)
  })

  it('returns false for a document with only local/relative images', () => {
    expect(documentHasRemoteImages('![chart](./figures/chart.png)')).toBe(false)
  })

  it('returns false for a document with only a data: image', () => {
    expect(documentHasRemoteImages('![x](data:image/png;base64,abc)')).toBe(false)
  })

  it('returns true for a direct https:// image', () => {
    expect(documentHasRemoteImages('![x](https://example.com/a.png)')).toBe(true)
  })

  it('returns true for a direct http:// image', () => {
    expect(documentHasRemoteImages('![x](http://example.com/a.png)')).toBe(true)
  })

  it('returns true for a resolved reference-style image, even when the definition appears AFTER the reference', () => {
    const source = '![x][ref]\n\n[ref]: https://example.com/a.png'
    expect(documentHasRemoteImages(source)).toBe(true)
  })

  it('returns false for a reference-style image whose definition is local', () => {
    const source = '![x][ref]\n\n[ref]: ./local.png'
    expect(documentHasRemoteImages(source)).toBe(false)
  })

  it('returns true for a remote image written as raw HTML', () => {
    expect(documentHasRemoteImages('<img src="https://example.com/pixel.gif">')).toBe(true)
  })

  it('returns false for a local image written as raw HTML', () => {
    expect(documentHasRemoteImages('<img src="./local.png">')).toBe(false)
  })

  it('finds a remote image among several local ones, and among several raw-HTML nodes', () => {
    const source = [
      '![a](./one.png)',
      '',
      '<div>Some raw HTML with no image</div>',
      '',
      '<img src="./two.png">',
      '',
      '![b](https://example.com/three.png)'
    ].join('\n')
    expect(documentHasRemoteImages(source)).toBe(true)
  })

  // Kept deliberately in lockstep with pipeline.ts's REMOTE_SRC_PATTERN -- see
  // this module's own comment on why the two disagreeing would be worse than
  // either being wrong alone (the banner would report "no remote images" for a
  // document the pipeline was actively blocking).
  it('detects an http(s) URL with no slashes after the colon', () => {
    expect(documentHasRemoteImages('![x](http:evil.com/tracker.png)')).toBe(true)
    expect(documentHasRemoteImages('<img src="http:evil.com/tracker.png">')).toBe(true)
  })

  it('detects a protocol-relative //host URL', () => {
    expect(documentHasRemoteImages('![x](//evil.com/tracker.png)')).toBe(true)
  })

  it('detects a remote srcset on <source>, which carries no protocol allowlist at all', () => {
    const source =
      '<picture><source srcset="https://evil.com/track.png"><img src="a.png"></picture>'
    expect(documentHasRemoteImages(source)).toBe(true)
  })

  it('still returns false for a local srcset', () => {
    expect(documentHasRemoteImages('<img src="a.png" srcset="a-2x.png 2x">')).toBe(false)
  })
})
