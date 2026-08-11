// A minimal, read-only ZIP entry reader, for VERIFYING a generated .docx.
//
// A .docx is a ZIP archive of XML parts, so "did the export work" cannot be
// answered by checking that bytes were written -- the interesting claims
// (a real page break is present, the page size is A4, the frontmatter did not
// leak into the body) are all claims about `word/document.xml` INSIDE that
// archive. This module is what lets the unit tests and the phase0 gate open
// the produced file and assert on its actual contents.
//
// Deliberately NOT `jszip` -- which IS present in the tree as a transitive
// dependency of `docx` itself, and is exactly the wrong thing to reach for
// here. Verifying the writer with the writer's own zip implementation means a
// bug in that implementation is invisible to every assertion: the reader would
// make the same mistake in reverse and the test would still pass. Parsing the
// central directory independently is ~50 lines and makes the check genuinely
// adversarial to the code it is checking.
//
// Read-only and intentionally incomplete: it handles the two compression
// methods a .docx actually uses (stored and raw DEFLATE), reads sizes from the
// CENTRAL DIRECTORY rather than the local file headers (which are permitted to
// carry zeroes when a data descriptor follows), and ignores ZIP64, encryption
// and multi-disk archives. It is not, and must not become, a general-purpose
// unzip.
import { inflateRawSync } from 'node:zlib'

const END_OF_CENTRAL_DIRECTORY = 0x06054b50
const CENTRAL_FILE_HEADER = 0x02014b50
const LOCAL_FILE_HEADER = 0x04034b50

const METHOD_STORED = 0
const METHOD_DEFLATE = 8

function findEndOfCentralDirectory(zip: Buffer): number | null {
  // The record is 22 bytes plus a comment of up to 65535, and it is the LAST
  // thing in the file -- so scan backwards from the earliest position it could
  // start at. Scanning forwards would risk matching the same four bytes
  // appearing inside compressed data.
  const earliest = Math.max(0, zip.length - 22 - 0xffff)
  for (let offset = zip.length - 22; offset >= earliest; offset -= 1) {
    if (zip.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) return offset
  }
  return null
}

/**
 * Every entry name in the archive, in central-directory order. Used to assert
 * an export produced the parts it should (`word/document.xml`,
 * `word/footer1.xml`, an image part, …) rather than only that it produced
 * something openable.
 */
export function listDocxEntries(zip: Buffer): string[] {
  const eocd = findEndOfCentralDirectory(zip)
  if (eocd === null) return []
  const count = zip.readUInt16LE(eocd + 10)
  let offset = zip.readUInt32LE(eocd + 16)
  const names: string[] = []
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > zip.length || zip.readUInt32LE(offset) !== CENTRAL_FILE_HEADER) break
    const nameLength = zip.readUInt16LE(offset + 28)
    const extraLength = zip.readUInt16LE(offset + 30)
    const commentLength = zip.readUInt16LE(offset + 32)
    names.push(zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'))
    offset += 46 + nameLength + extraLength + commentLength
  }
  return names
}

/**
 * The decompressed bytes of one entry, or null if the archive has no such
 * entry (or uses a compression method this reader does not implement).
 */
export function readDocxEntry(zip: Buffer, entryName: string): Buffer | null {
  const eocd = findEndOfCentralDirectory(zip)
  if (eocd === null) return null
  const count = zip.readUInt16LE(eocd + 10)
  let offset = zip.readUInt32LE(eocd + 16)

  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > zip.length || zip.readUInt32LE(offset) !== CENTRAL_FILE_HEADER) return null
    const method = zip.readUInt16LE(offset + 10)
    const compressedSize = zip.readUInt32LE(offset + 20)
    const nameLength = zip.readUInt16LE(offset + 28)
    const extraLength = zip.readUInt16LE(offset + 30)
    const commentLength = zip.readUInt16LE(offset + 32)
    const localOffset = zip.readUInt32LE(offset + 42)
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')

    if (name === entryName) {
      if (zip.readUInt32LE(localOffset) !== LOCAL_FILE_HEADER) return null
      // The local header's OWN name/extra lengths, not the central
      // directory's: the two are allowed to differ (extra fields in
      // particular routinely do), and using the wrong one lands mid-data.
      const localNameLength = zip.readUInt16LE(localOffset + 26)
      const localExtraLength = zip.readUInt16LE(localOffset + 28)
      const start = localOffset + 30 + localNameLength + localExtraLength
      const raw = zip.subarray(start, start + compressedSize)
      if (method === METHOD_STORED) return Buffer.from(raw)
      if (method === METHOD_DEFLATE) return inflateRawSync(raw)
      return null
    }

    offset += 46 + nameLength + extraLength + commentLength
  }
  return null
}

/** Convenience for the common case: `word/document.xml` as a string. */
export function readDocxDocumentXml(zip: Buffer): string {
  const entry = readDocxEntry(zip, 'word/document.xml')
  if (!entry) throw new Error('generated .docx has no word/document.xml part')
  return entry.toString('utf8')
}
