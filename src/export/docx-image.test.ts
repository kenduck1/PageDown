import { describe, it, expect } from 'vitest'
import { readImageDimensions } from './docx-image'

// Hand-built minimal headers rather than real image fixtures: the whole point
// of these functions is that they read a HEADER, so a synthetic header
// exercises exactly the bytes under test and lets a truncated/hostile case be
// constructed at all (a real .png cannot be "one byte short of its IHDR"
// without being a different file). The real-file case is covered end to end by
// markdown-to-docx.test.ts, which embeds a genuine PNG and reads its size back
// out of the packed .docx.

function pngHeader(width: number, height: number, trailing = 0): Uint8Array {
  const bytes = new Uint8Array(24 + trailing)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  const view = new DataView(bytes.buffer)
  view.setUint32(8, 13) // IHDR length
  bytes.set([0x49, 0x48, 0x44, 0x52], 12) // "IHDR"
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

describe('readImageDimensions', () => {
  it('reads a PNG IHDR', () => {
    expect(readImageDimensions(pngHeader(640, 480))).toEqual({
      type: 'png',
      widthPx: 640,
      heightPx: 480
    })
  })

  it('reads PNG dimensions above 32767 without sign overflow', () => {
    // A u32 read via bitwise ops goes NEGATIVE past 2^31 unless it is
    // explicitly coerced back to unsigned, and a negative width would sail
    // through a naive `> 0` check on the wrong side.
    expect(readImageDimensions(pngHeader(40000, 30000))).toEqual({
      type: 'png',
      widthPx: 40000,
      heightPx: 30000
    })
  })

  it('reads a GIF logical screen descriptor (little-endian)', () => {
    const bytes = new Uint8Array(10)
    bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0) // "GIF89a"
    bytes[6] = 0x20
    bytes[7] = 0x01 // 288
    bytes[8] = 0x10
    bytes[9] = 0x00 // 16
    expect(readImageDimensions(bytes)).toEqual({ type: 'gif', widthPx: 288, heightPx: 16 })
  })

  it('reads a BMP header and treats a negative height as top-down row order', () => {
    const bytes = new Uint8Array(30)
    bytes.set([0x42, 0x4d], 0)
    const view = new DataView(bytes.buffer)
    view.setInt32(18, 120, true)
    view.setInt32(22, -60, true)
    expect(readImageDimensions(bytes)).toEqual({ type: 'bmp', widthPx: 120, heightPx: 60 })
  })

  it('walks past JPEG APPn segments to find the real SOF0 frame header', () => {
    // The whole reason JPEG needs a segment walk rather than a fixed offset:
    // a real photo puts an EXIF APP1 block (here, 20 bytes) before the frame.
    const bytes = new Uint8Array([
      0xff,
      0xd8, // SOI
      0xff,
      0xe1,
      0x00,
      0x14,
      ...new Array(18).fill(0x00), // APP1, length 20
      0xff,
      0xdb,
      0x00,
      0x04,
      0x00,
      0x00, // DQT, length 4
      0xff,
      0xc0,
      0x00,
      0x11,
      0x08,
      0x02,
      0x58,
      0x03,
      0x20 // SOF0: height 600, width 800
    ])
    expect(readImageDimensions(bytes)).toEqual({ type: 'jpg', widthPx: 800, heightPx: 600 })
  })

  it('does not mistake a Huffman table (0xC4) for a start-of-frame marker', () => {
    // 0xC4 sits inside the 0xC0-0xCF range but is DHT, not SOF -- reading its
    // payload as a frame header yields a plausible-looking but wrong size.
    const bytes = new Uint8Array([
      0xff, 0xd8, 0xff, 0xc4, 0x00, 0x06, 0x11, 0x22, 0x33, 0x44, 0xff, 0xc0, 0x00, 0x11, 0x08,
      0x00, 0x64, 0x00, 0xc8
    ])
    expect(readImageDimensions(bytes)).toEqual({ type: 'jpg', widthPx: 200, heightPx: 100 })
  })

  it('returns null for a truncated PNG rather than throwing', () => {
    expect(readImageDimensions(pngHeader(10, 10).subarray(0, 18))).toBeNull()
  })

  it('returns null for a zero-sized image', () => {
    // Would otherwise divide by zero in the caller's fit-to-width scaling.
    expect(readImageDimensions(pngHeader(0, 10))).toBeNull()
  })

  it('returns null for formats docx cannot embed (WebP, SVG) and for garbage', () => {
    const webp = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50
    ])
    expect(readImageDimensions(webp)).toBeNull()
    expect(readImageDimensions(new TextEncoder().encode('<svg width="10"></svg>'))).toBeNull()
    expect(readImageDimensions(new Uint8Array([1, 2, 3]))).toBeNull()
    expect(readImageDimensions(new Uint8Array(0))).toBeNull()
  })
})
