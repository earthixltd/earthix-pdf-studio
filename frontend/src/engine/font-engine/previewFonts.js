// Shows the PDF's own embedded font while typing.
//
// PDF.js converts every embedded font type (TrueType, CFF, Type 1, CID) into a
// browser-ready file, but that file is addressed by private character codes.
// Here its character map is rebuilt so real letters reach the right glyphs.
// Letters the font doesn't have fall through the CSS font stack, which matches
// how they are drawn in the PDF after saving.

import { openFontProgram } from './fontEmbedder.js'
import { normalizeFontKey } from './pdfFontLoader.js'

const writer = (length) => {
  const view = new DataView(new ArrayBuffer(length))
  let offset = 0
  return {
    u16(value) { view.setUint16(offset, value & 0xffff); offset += 2 },
    u32(value) { view.setUint32(offset, value >>> 0); offset += 4 },
    bytes: () => new Uint8Array(view.buffer),
  }
}

/** Contiguous [start, end, firstGlyph] ranges of sorted [codePoint, glyphId] pairs. */
function toRanges(pairs) {
  const ranges = []
  for (const [codePoint, glyphId] of pairs) {
    const last = ranges.at(-1)
    if (last && codePoint === last[1] + 1 && glyphId === last[2] + codePoint - last[0]) last[1] = codePoint
    else ranges.push([codePoint, codePoint, glyphId])
  }
  return ranges
}

function format4(ranges) {
  const segments = [...ranges, [0xffff, 0xffff, 1]]
  const count = segments.length
  const table = writer(16 + count * 8)
  const log = Math.floor(Math.log2(count))
  table.u16(4)
  table.u16(16 + count * 8)
  table.u16(0)
  table.u16(count * 2)
  table.u16(2 ** (log + 1))
  table.u16(log)
  table.u16(count * 2 - 2 ** (log + 1))
  segments.forEach((segment) => table.u16(segment[1]))
  table.u16(0)
  segments.forEach((segment) => table.u16(segment[0]))
  segments.forEach((segment) => table.u16(segment[2] - segment[0]))
  segments.forEach(() => table.u16(0))
  return table.bytes()
}

function format12(ranges) {
  const table = writer(16 + ranges.length * 12)
  table.u16(12)
  table.u16(0)
  table.u32(16 + ranges.length * 12)
  table.u32(0)
  table.u32(ranges.length)
  for (const [start, end, glyphId] of ranges) {
    table.u32(start)
    table.u32(end)
    table.u32(glyphId)
  }
  return table.bytes()
}

/** A cmap table for [codePoint, glyphId] pairs. */
export function buildCmapTable(pairs) {
  const sorted = [...pairs].sort((a, b) => a[0] - b[0])
  const ranges = toRanges(sorted)
  const basic = ranges.filter((range) => range[1] < 0xffff)
  const hasSupplementary = sorted.some(([codePoint]) => codePoint > 0xffff)
  // Format 4 tops out near 8,000 separate ranges; format 12 has no such limit.
  const subtables = []
  if (basic.length < 8000 && basic.length === ranges.length) subtables.push([3, 1, format4(basic)])
  if (hasSupplementary || !subtables.length) subtables.push([3, 10, format12(ranges)])
  const headerLength = 4 + subtables.length * 8
  const total = headerLength + subtables.reduce((sum, [, , bytes]) => sum + bytes.length, 0)
  const output = new Uint8Array(total)
  const header = writer(headerLength)
  header.u16(0)
  header.u16(subtables.length)
  let offset = headerLength
  for (const [platform, encoding, bytes] of subtables) {
    header.u16(platform)
    header.u16(encoding)
    header.u32(offset)
    output.set(bytes, offset)
    offset += bytes.length
  }
  output.set(header.bytes(), 0)
  return output
}

function checksum(bytes) {
  const padded = new Uint8Array((bytes.length + 3) & ~3)
  padded.set(bytes)
  const view = new DataView(padded.buffer)
  let sum = 0
  for (let offset = 0; offset < padded.length; offset += 4) sum = (sum + view.getUint32(offset)) >>> 0
  return sum
}

/** Copy an sfnt font file with its cmap table replaced. */
export function replaceCmapTable(fontData, cmap) {
  const source = new DataView(fontData.buffer, fontData.byteOffset, fontData.byteLength)
  const count = source.getUint16(4)
  const tables = []
  for (let index = 0; index < count; index += 1) {
    const entry = 12 + index * 16
    const tag = String.fromCharCode(fontData[entry], fontData[entry + 1], fontData[entry + 2], fontData[entry + 3])
    const offset = source.getUint32(entry + 8)
    const length = source.getUint32(entry + 12)
    tables.push({ tag, bytes: tag === 'cmap' ? cmap : fontData.subarray(offset, offset + length) })
  }
  if (!tables.some((table) => table.tag === 'cmap')) throw new Error('This font has no character map.')
  const headerLength = 12 + count * 16
  const total = tables.reduce((sum, table) => sum + ((table.bytes.length + 3) & ~3), headerLength)
  const output = new Uint8Array(total)
  output.set(fontData.subarray(0, 12))
  const directory = new DataView(output.buffer)
  let offset = headerLength
  tables.forEach((table, index) => {
    const entry = 12 + index * 16
    for (let position = 0; position < 4; position += 1) output[entry + position] = table.tag.charCodeAt(position)
    directory.setUint32(entry + 4, checksum(table.bytes))
    directory.setUint32(entry + 8, offset)
    directory.setUint32(entry + 12, table.bytes.length)
    output.set(table.bytes, offset)
    offset += (table.bytes.length + 3) & ~3
  })
  return output
}

const fontCharOf = (toFontChar, code) => {
  if (toFontChar instanceof Map) return toFontChar.get(code) || code
  return toFontChar?.[code] || code
}

/**
 * Rebuild a PDF.js font so letters address their glyphs directly.
 * codeMap is [[letter, pdfCode]…]. Returns { bytes, covered, total } or null.
 */
export async function buildPreviewFontFile(fontData, toFontChar, codeMap) {
  const program = await openFontProgram(fontData)
  const pairs = new Map()
  for (const [letter, code] of codeMap) {
    const codePoint = letter.codePointAt(0)
    const glyph = program.glyphForCodePoint(fontCharOf(toFontChar, code))
    if (glyph?.id) pairs.set(codePoint, glyph.id)
  }
  if (!pairs.size) return null
  return { bytes: replaceCmapTable(fontData, buildCmapTable([...pairs])), covered: pairs.size, total: codeMap.length }
}

function hashBytes(bytes) {
  let hash = 0x811c9dc5
  for (let index = 0; index < bytes.length; index += 1) hash = Math.imul(hash ^ bytes[index], 0x01000193)
  return (hash >>> 0).toString(36)
}

const pageFontCache = new WeakMap()
const registeredFaces = new Map()
const knownFamilies = new WeakMap()

function pageFonts(session, pageIndex) {
  if (!pageFontCache.has(session)) pageFontCache.set(session, new Map())
  const pages = pageFontCache.get(session)
  if (!pages.has(pageIndex)) {
    pages.set(pageIndex, Promise.resolve(session.getPageFonts(pageIndex)).catch(() => {
      pages.delete(pageIndex)
      return []
    }))
  }
  return pages.get(pageIndex)
}

function registerFace(bytes) {
  const hash = hashBytes(bytes)
  if (!registeredFaces.has(hash)) {
    const family = `EarthixPdfFont-${hash}`
    registeredFaces.set(hash, new FontFace(family, bytes).load().then((face) => {
      document.fonts.add(face)
      return family
    }).catch(() => null))
  }
  return registeredFaces.get(hash)
}

function matchingFonts(fonts, metadata) {
  const exact = [metadata.baseFontName, metadata.descriptorFontName].filter(Boolean)
  const byName = fonts.filter((font) => exact.includes(font.name))
  if (byName.length) return byName
  const wanted = exact.map(normalizeFontKey)
  return fonts.filter((font) => wanted.includes(normalizeFontKey(font.name)) && Boolean(font.composite) === metadata.isComposite)
}

/** The already prepared preview font of a block, without waiting. */
export function peekPreviewFont(block) {
  const metadata = block?.fontMetadata
  return (metadata && knownFamilies.get(metadata)) || null
}

/** CSS family holding the block's own embedded font, or null to keep the normal stack. */
export async function previewFontFamily(session, block) {
  const metadata = block?.fontMetadata
  if (!metadata?.isEmbedded || !metadata.codeMap?.length || block.complexScript) return null
  if (typeof FontFace === 'undefined' || !session?.getPageFonts) return null
  if (knownFamilies.has(metadata)) return knownFamilies.get(metadata)
  let best = null
  for (const font of matchingFonts(await pageFonts(session, block.pageIndex), metadata)) {
    try {
      const built = await buildPreviewFontFile(font.data, font.toFontChar, metadata.codeMap)
      if (built && (!best || built.covered > best.covered)) best = built
    } catch {
      // Try the next font with this name.
    }
  }
  // A font that reaches few of its letters was matched wrongly; don't show it.
  const family = best && best.covered * 2 >= best.total ? await registerFace(best.bytes) : null
  knownFamilies.set(metadata, family)
  return family
}

/** Get a page's fonts ready ahead of the first click. */
export async function warmPreviewFonts(session, blocks) {
  const seen = new Set()
  for (const block of blocks) {
    if (!block.fontMetadata || seen.has(block.fontMetadata)) continue
    seen.add(block.fontMetadata)
    await previewFontFamily(session, block).catch(() => null)
  }
}
