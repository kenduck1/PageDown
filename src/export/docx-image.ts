// Intrinsic pixel dimensions of a raster image, read straight out of its own
// header bytes.
//
// This exists because `docx`'s ImageRun takes a REQUIRED
// `transformation: { width, height }` in pixels and does no measuring of its
// own (confirmed against the installed package's own IMediaTransformation
// type -- both fields are non-optional). Every other rendering surface in this
// app hands its images to a browser, which measures them; the .docx writer is
// the first consumer that has to know an image's real size in plain Node with
// no layout engine anywhere.
//
// Deliberately NOT a dependency (`image-size`, `probe-image-size`, `sharp`):
// this is four header reads over already-in-memory bytes that have ALREADY
// been magic-byte-sniffed by resolveAssetPath's own vetted read path, so a
// new package would add supply-chain surface and (for `sharp`) a native
// binary to an app that ships prebuilt Electron binaries, in exchange for
// code that fits on one screen. The four formats handled here are exactly the
// four `docx`'s RegularImageOptions accepts (`"jpg" | "png" | "gif" | "bmp"`),
// so supporting more would have nothing to hand them to.
//
// Every parse is bounds-checked and returns null rather than throwing: these
// bytes come from a file an untrusted document pointed at, so a truncated or
// deliberately malformed header must degrade to "this image is skipped", never
// to an exception that aborts the whole export over one bad picture -- the
// same posture resolveLocalImageDataUri already takes for every other denial.

/** The image container formats `docx`'s ImageRun can embed directly. */
export type DocxImageType = 'png' | 'jpg' | 'gif' | 'bmp'

export interface DocxImageDimensions {
  type: DocxImageType
  widthPx: number
  heightPx: number
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false
  return signature.every((byte, index) => bytes[index] === byte)
}

function readU32BE(bytes: Uint8Array, offset: number): number | null {
  if (offset + 4 > bytes.length) return null
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  )
}

function readU16BE(bytes: Uint8Array, offset: number): number | null {
  if (offset + 2 > bytes.length) return null
  return (bytes[offset] << 8) | bytes[offset + 1]
}

function readU16LE(bytes: Uint8Array, offset: number): number | null {
  if (offset + 2 > bytes.length) return null
  return bytes[offset] | (bytes[offset + 1] << 8)
}

function readI32LE(bytes: Uint8Array, offset: number): number | null {
  if (offset + 4 > bytes.length) return null
  // `| 0` at the end forces the signed interpretation BMP actually uses: a
  // negative biHeight is legal and means "top-down row order", not a
  // negative-sized image, so the caller takes its absolute value.
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24) |
    0
  )
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const GIF_SIGNATURE = [0x47, 0x49, 0x46, 0x38] // "GIF8" -- covers both 87a and 89a
const BMP_SIGNATURE = [0x42, 0x4d] // "BM"

// JPEG start-of-frame markers. C0-CF is the SOF range, but three values
// inside it are NOT frame headers and must be skipped or the width/height
// would be read out of a Huffman table: C4 (define Huffman table), C8 (JPEG
// extensions) and CC (define arithmetic coding conditioning).
function isJpegStartOfFrame(marker: number): boolean {
  if (marker < 0xc0 || marker > 0xcf) return false
  return marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
}

// Walks JPEG's segment chain rather than reading a fixed offset, because
// unlike PNG/GIF/BMP a JPEG's frame header is not at a fixed position -- an
// arbitrary number of variable-length APPn/COM/DQT segments (EXIF thumbnails,
// colour profiles) precede it, and a camera-produced photo essentially always
// has several.
function readJpegDimensions(bytes: Uint8Array): DocxImageDimensions | null {
  let offset = 2 // past the SOI marker (FF D8) the caller already matched
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null // desynchronised: not a segment boundary
    const marker = bytes[offset + 1]
    // Standalone markers carry no length field at all; skipping their two
    // bytes and continuing is the only correct way past them.
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2
      continue
    }
    // Fill bytes: a run of FFs between segments is legal padding.
    if (marker === 0xff) {
      offset += 1
      continue
    }
    const length = readU16BE(bytes, offset + 2)
    if (length === null || length < 2) return null
    if (isJpegStartOfFrame(marker)) {
      // SOF payload: 1 byte precision, then height then width, both u16 BE.
      const heightPx = readU16BE(bytes, offset + 5)
      const widthPx = readU16BE(bytes, offset + 7)
      if (heightPx === null || widthPx === null) return null
      return { type: 'jpg', widthPx, heightPx }
    }
    offset += 2 + length
  }
  return null
}

/**
 * Reads an image's container type and intrinsic pixel size from its header,
 * or null if the bytes are not one of the four formats `docx` can embed, or
 * are too short/malformed to read a size from.
 *
 * Zero-sized results are rejected here rather than at the call site: a 0x0
 * image would make the caller's fit-to-content-width scaling divide by zero,
 * and no legitimate raster image is 0 wide.
 */
export function readImageDimensions(bytes: Uint8Array): DocxImageDimensions | null {
  const result = readImageDimensionsRaw(bytes)
  if (!result) return null
  if (result.widthPx <= 0 || result.heightPx <= 0) return null
  return result
}

function readImageDimensionsRaw(bytes: Uint8Array): DocxImageDimensions | null {
  if (startsWith(bytes, PNG_SIGNATURE)) {
    // IHDR is required by the spec to be the FIRST chunk, so its payload is
    // always at a fixed offset: 8 signature + 4 length + 4 type = 16.
    const widthPx = readU32BE(bytes, 16)
    const heightPx = readU32BE(bytes, 20)
    if (widthPx === null || heightPx === null) return null
    return { type: 'png', widthPx, heightPx }
  }
  if (startsWith(bytes, GIF_SIGNATURE)) {
    // Logical screen descriptor, immediately after the 6-byte header.
    const widthPx = readU16LE(bytes, 6)
    const heightPx = readU16LE(bytes, 8)
    if (widthPx === null || heightPx === null) return null
    return { type: 'gif', widthPx, heightPx }
  }
  if (startsWith(bytes, BMP_SIGNATURE)) {
    const widthPx = readI32LE(bytes, 18)
    const heightPx = readI32LE(bytes, 22)
    if (widthPx === null || heightPx === null) return null
    // A negative height means top-down row order (see readI32LE); the image
    // is still that many rows tall.
    return { type: 'bmp', widthPx: Math.abs(widthPx), heightPx: Math.abs(heightPx) }
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return readJpegDimensions(bytes)
  }
  // Deliberately unhandled, and this is the honest place to say so: WebP,
  // AVIF and SVG all reach this app's other surfaces fine (Chromium renders
  // them), but `docx`'s ImageRun accepts none of the three as a regular
  // image -- SVG only via a separate SvgMediaOptions shape that REQUIRES a
  // raster fallback we have no rasteriser to produce. Returning null here
  // means such an image is skipped with its alt text kept, rather than
  // written as bytes Word would refuse to open.
  return null
}
