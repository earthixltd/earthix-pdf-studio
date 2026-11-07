import { latin1, PdfDict, PdfName, PdfRef, PdfString } from '../pdf-parser/pdfSyntax.js'
import { asNumber, nameOf } from '../pdf-parser/pdfDocumentIndex.js'
import { baseEncodingGlyphName, baseEncodingTable, glyphNameToUnicode } from './glyphNames.js'
import { loadStandardFontMetrics, resolveStandardFontAlias, winAnsiEncodeCharacter } from './standardFonts.js'

const FLAG_FIXED_PITCH = 1
const FLAG_SERIF = 2
const FLAG_SYMBOLIC = 4
const FLAG_ITALIC = 64
const FLAG_FORCE_BOLD = 262144

function utf16BeToString(bytes) {
  if (bytes.length === 1) return String.fromCharCode(bytes[0])
  const units = []
  for (let offset = 0; offset + 1 < bytes.length; offset += 2) units.push((bytes[offset] << 8) | bytes[offset + 1])
  return String.fromCharCode(...units)
}

function hexBytes(hex) {
  const clean = hex.replace(/\s+/g, '')
  const padded = clean.length % 2 ? clean + '0' : clean
  const bytes = new Uint8Array(padded.length / 2)
  for (let offset = 0; offset < padded.length; offset += 2) bytes[offset / 2] = Number.parseInt(padded.slice(offset, offset + 2), 16)
  return bytes
}

function bytesToCode(bytes) {
  let code = 0
  for (const byte of bytes) code = code * 256 + byte
  return code
}

/** Token based ToUnicode CMap parser (bfchar + bfrange, single and array destinations). */
export function parseToUnicodeCMap(text) {
  const map = new Map()
  const tokenPattern = /<([0-9A-Fa-f\s]*)>|(\[)|(\])|([A-Za-z_][A-Za-z0-9_.]*)/g
  let mode = null
  let pending = []
  let arrayItems = null
  for (const match of text.matchAll(tokenPattern)) {
    if (match[4]) {
      const word = match[4]
      if (word === 'beginbfchar') { mode = 'bfchar'; pending = [] }
      else if (word === 'beginbfrange') { mode = 'bfrange'; pending = [] }
      else if (word === 'endbfchar' || word === 'endbfrange') { mode = null; pending = [] }
      continue
    }
    if (!mode) continue
    if (match[2]) { arrayItems = []; continue }
    if (match[3]) {
      if (mode === 'bfrange' && arrayItems && pending.length === 2) {
        const low = bytesToCode(pending[0])
        const high = bytesToCode(pending[1])
        arrayItems.forEach((item, offset) => { if (low + offset <= high) map.set(low + offset, utf16BeToString(item)) })
      }
      arrayItems = null
      pending = []
      continue
    }
    const bytes = hexBytes(match[1])
    if (arrayItems) { arrayItems.push(bytes); continue }
    pending.push(bytes)
    if (mode === 'bfchar' && pending.length === 2) {
      map.set(bytesToCode(pending[0]), utf16BeToString(pending[1]))
      pending = []
    } else if (mode === 'bfrange' && pending.length === 3) {
      const low = bytesToCode(pending[0])
      const high = Math.min(bytesToCode(pending[1]), low + 0xffff)
      const destination = pending[2]
      if (destination.length <= 1) {
        for (let code = low; code <= high; code += 1) map.set(code, String.fromCharCode(destination[0] + code - low))
      } else {
        const units = []
        for (let offset = 0; offset + 1 < destination.length; offset += 2) units.push((destination[offset] << 8) | destination[offset + 1])
        for (let code = low; code <= high; code += 1) {
          const shifted = [...units]
          shifted[shifted.length - 1] += code - low
          map.set(code, String.fromCharCode(...shifted))
        }
      }
      pending = []
    }
  }
  return map
}

function stripSubsetTag(fontName) {
  return fontName.replace(/^[A-Z]{6}\+/, '')
}

function splitCamel(value) {
  return value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').trim()
}

/** Split a PostScript-like font name into a human family and style hints. */
export function describeFontName(fontName) {
  const postscriptName = stripSubsetTag(fontName || '')
  const [familyPart, ...styleParts] = postscriptName.split(/[-,]/)
  const familyRaw = familyPart.replace(/(PSMT|PS|MT)$/, '')
  const styleText = styleParts.join(' ')
  const all = postscriptName.toLowerCase()
  return {
    postscriptName,
    family: splitCamel(familyRaw) || postscriptName,
    style: styleText.replace(/MT$|PS$/, '').trim(),
    bold: /bold|black|heavy|semibold|demibold|demi\b/.test(all),
    italic: /italic|oblique|-it\b|,it\b/.test(all),
  }
}

export function normalizeFontKey(value) {
  return String(value || '').toLowerCase().replace(/^[a-z]{6}\+/, '').replace(/[^a-z0-9]/g, '').replace(/(psmt|mt|ps)$/, '')
}

function resolveArray(index, value) {
  const array = index.resolve(value)
  return Array.isArray(array) ? array.map((item) => index.resolve(item)) : null
}

function parseCidWidths(index, cidFont) {
  const widths = new Map()
  const defaultWidth = asNumber(index.resolve(cidFont.get('DW')), 1000)
  const array = resolveArray(index, cidFont.get('W')) || []
  let cursor = 0
  while (cursor < array.length) {
    const first = array[cursor++]
    if (typeof first !== 'number') break
    const next = array[cursor]
    if (Array.isArray(next)) {
      next.forEach((width, offset) => widths.set(first + offset, asNumber(index.resolve(width), defaultWidth)))
      cursor += 1
    } else {
      const last = array[cursor++]
      const width = array[cursor++]
      if (typeof last !== 'number' || typeof width !== 'number') break
      for (let code = first; code <= last && code - first < 0x10000; code += 1) widths.set(code, width)
    }
  }
  return { widths, defaultWidth }
}

function isControlOnly(value) {
  for (const character of value) if (character.charCodeAt(0) >= 0x20) return false
  return true
}

export class PdfFontInfo {
  constructor() {
    this.toUnicode = new Map()
    this.encodingUnicode = new Map()
    this.widths = new Map()
    this.defaultWidth = 0
    this.usedCodes = new Set()
    this.limitations = []
    this.embeddedGidToUnicode = null
    this.cidToGid = null
  }

  splitCodes(bytes) {
    if (this.codeBytes === 2) {
      const codes = []
      for (let offset = 0; offset + 1 < bytes.length; offset += 2) codes.push((bytes[offset] << 8) | bytes[offset + 1])
      return codes
    }
    return [...bytes]
  }

  decode(code) {
    const mapped = this.toUnicode.get(code)
    // Some writers map unmappable glyphs (e.g. Indic conjuncts) to U+0000.
    if (mapped !== undefined && mapped !== '' && !isControlOnly(mapped)) return mapped
    // Letters identified from the same font installed on this computer.
    const recovered = this.recoveredGlyphs?.get(code)
    if (recovered) return recovered
    if (mapped !== undefined && isControlOnly(mapped)) return null
    const fromEncoding = this.encodingUnicode.get(code)
    if (fromEncoding) return fromEncoding
    if (this.embeddedGidToUnicode) {
      const gid = this.cidToGid ? this.cidToGid(code) : code
      const value = this.embeddedGidToUnicode.get(gid)
      if (value) return value
    }
    return null
  }

  widthOf(code) {
    const width = this.widths.has(code) ? this.widths.get(code) : this.defaultWidth
    return (width * this.widthScale) / 1000
  }

  /** True when re-using this code is known to render a real glyph of this font. */
  isSafeCode(code) {
    if (this.unsupportedReason) return false
    if (this.decode(code) === null) return false
    if (this.usedCodes.has(code)) return true
    if (!this.isEmbedded) return this.isComposite ? false : (this.widths.size === 0 || (this.widths.get(code) ?? 0) > 0 || Boolean(this.standardMetrics))
    if (this.isSubset) return false
    if (this.isComposite) return this.toUnicode.has(code)
    return (this.widths.get(code) ?? 0) > 0
  }

  getUnicodeToCode() {
    if (this.unicodeToCode) return this.unicodeToCode
    const map = new Map()
    const consider = (code) => {
      const value = this.decode(code)
      if (!value || [...value].length !== 1 || !this.isSafeCode(code)) return
      if (!map.has(value) || (this.usedCodes.has(code) && !this.usedCodes.has(map.get(value)))) map.set(value, code)
    }
    for (const code of this.usedCodes) consider(code)
    for (const code of this.toUnicode.keys()) consider(code)
    for (const code of this.encodingUnicode.keys()) consider(code)
    if (map.has(' ') === false && map.has('\u00a0')) map.set(' ', map.get('\u00a0'))
    this.unicodeToCode = map
    return map
  }

  invalidateEncodingCache() {
    this.unicodeToCode = null
  }

  encodeCharacter(character) {
    const map = this.getUnicodeToCode()
    if (map.has(character)) return map.get(character)
    if (character === '\u00a0' && map.has(' ')) return map.get(' ')
    return null
  }

  get cssFontStack() {
    const quoted = (value) => `"${value.replace(/"/g, '')}"`
    const families = [this.family, this.postscriptName].filter(Boolean).map(quoted)
    const generic = this.fixedPitch ? 'monospace' : this.serif ? 'serif' : 'sans-serif'
    const extra = this.fixedPitch ? ['"Courier New"'] : this.serif ? ['"Times New Roman"'] : ['Arial', 'Helvetica']
    return [...new Set([...families, ...extra])].join(', ') + ', ' + generic
  }

  metadataFor(resourceName) {
    const supportedCharacters = [...this.getUnicodeToCode().keys()]
    return {
      id: String(this.objectNumber ?? 'inline') + ':' + resourceName,
      resourceName,
      fontObjectNumber: this.objectNumber,
      descendantFontObjectNumber: this.descendantObjectNumber ?? null,
      descriptorObjectNumber: this.descriptorObjectNumber ?? null,
      baseFontName: this.baseFontName,
      descriptorFontName: this.descriptorFontName,
      fontFamily: this.family,
      postscriptName: this.postscriptName,
      cssFontStack: this.cssFontStack,
      subtype: this.subtype,
      encoding: this.encodingName,
      fontFlags: this.flags,
      fontWeight: this.bold ? 700 : 400,
      fontStyle: this.italic ? 'italic' : 'normal',
      isBold: this.bold,
      isItalic: this.italic,
      isSerif: this.serif,
      isFixedPitch: this.fixedPitch,
      isSubset: this.isSubset,
      isEmbedded: this.isEmbedded,
      embeddedFontProgram: this.fontFileKey,
      hasToUnicode: this.toUnicode.size > 0,
      unicodeMapEntries: this.toUnicode.size,
      supportedCharacterCount: supportedCharacters.length,
      supportedCharacters,
      widthMetricCount: this.widths.size,
      defaultWidth: this.defaultWidth,
      ascent: this.ascent,
      descent: this.descent,
      canNativeReplace: !this.unsupportedReason,
      canPreserveEmbeddedFont: this.isEmbedded && !this.unsupportedReason,
      limitations: [...this.limitations, ...(this.unsupportedReason ? [this.unsupportedReason] : [])],
    }
  }
}

async function loadEmbeddedCmap(index, descriptor) {
  const fontFileRef = descriptor.get('FontFile2') || descriptor.get('FontFile3')
  if (!(fontFileRef instanceof PdfRef)) return null
  try {
    const bytes = await index.getStreamBytes(fontFileRef.num)
    if (!bytes) return null
    const fontkitModule = await import('@pdf-lib/fontkit')
    const fontkit = fontkitModule.default ?? fontkitModule
    const font = fontkit.create(bytes)
    const map = new Map()
    for (const codePoint of font.characterSet || []) {
      const glyph = font.glyphForCodePoint(codePoint)
      if (glyph && glyph.id && !map.has(glyph.id)) map.set(glyph.id, String.fromCodePoint(codePoint))
    }
    return map.size ? map : null
  } catch {
    return null
  }
}

export async function loadPdfFont(index, fontValue) {
  const font = new PdfFontInfo()
  const dict = index.resolve(fontValue)
  if (!(dict instanceof PdfDict)) {
    font.unsupportedReason = 'The font resource could not be read.'
    font.baseFontName = 'Unknown'
    font.family = 'Unknown'
    font.subtype = 'Unknown'
    font.encodingName = 'Unknown'
    font.codeBytes = 1
    font.widthScale = 1
    return font
  }
  font.objectNumber = fontValue instanceof PdfRef ? fontValue.num : null
  font.subtype = dict.getName('Subtype') || 'Unknown'
  font.baseFontName = nameOf(dict.get('BaseFont')) || (font.subtype === 'Type3' ? 'Type3' : 'Unknown')
  font.isComposite = font.subtype === 'Type0'
  font.widthScale = 1

  let descriptorHolder = dict
  let cidFont = null
  if (font.isComposite) {
    const descendants = resolveArray(index, dict.get('DescendantFonts')) || []
    cidFont = descendants[0] instanceof PdfDict ? descendants[0] : null
    const descendantRef = index.resolve(dict.get('DescendantFonts'))?.[0]
    font.descendantObjectNumber = descendantRef instanceof PdfRef ? descendantRef.num : null
    if (cidFont) descriptorHolder = cidFont
  }
  const descriptorRef = descriptorHolder.get('FontDescriptor')
  const descriptor = index.resolve(descriptorRef)
  font.descriptorObjectNumber = descriptorRef instanceof PdfRef ? descriptorRef.num : null
  const descriptorDict = descriptor instanceof PdfDict ? descriptor : new PdfDict()
  font.descriptorFontName = nameOf(descriptorDict.get('FontName')) || ''
  font.flags = asNumber(index.resolve(descriptorDict.get('Flags')), 0)
  font.fontFileKey = ['FontFile', 'FontFile2', 'FontFile3'].find((key) => descriptorDict.has(key)) || null
  font.isEmbedded = Boolean(font.fontFileKey) || font.subtype === 'Type3'
  font.isSubset = /^[A-Z]{6}\+/.test(font.baseFontName)
  const naming = describeFontName(font.descriptorFontName || font.baseFontName)
  font.postscriptName = naming.postscriptName
  font.family = naming.family
  const italicAngle = asNumber(index.resolve(descriptorDict.get('ItalicAngle')), 0)
  const weight = asNumber(index.resolve(descriptorDict.get('FontWeight')), 0)
  font.italic = Boolean(font.flags & FLAG_ITALIC) || naming.italic || Math.abs(italicAngle) > 2
  font.bold = Boolean(font.flags & FLAG_FORCE_BOLD) || weight >= 600 || naming.bold
  font.fixedPitch = Boolean(font.flags & FLAG_FIXED_PITCH) || /courier|mono|consol/i.test(font.family)
  font.serif = Boolean(font.flags & FLAG_SERIF) || /times|serif|roman|georgia|garamond|cambria|book antiqua|palatino/i.test(font.family) && !/sans/i.test(font.family)
  font.symbolic = Boolean(font.flags & FLAG_SYMBOLIC) && !(font.flags & 32)
  font.ascent = asNumber(index.resolve(descriptorDict.get('Ascent')), 0) || 800
  font.descent = asNumber(index.resolve(descriptorDict.get('Descent')), 0) || -200
  if (font.ascent < 300 || font.ascent > 1500) font.ascent = 800
  if (font.descent > 0 || font.descent < -800) font.descent = -200

  // ToUnicode (highest priority for decoding).
  const toUnicodeRef = dict.get('ToUnicode')
  if (toUnicodeRef instanceof PdfRef) {
    try {
      const cmapBytes = await index.getStreamBytes(toUnicodeRef.num)
      if (cmapBytes) font.toUnicode = parseToUnicodeCMap(latin1(cmapBytes))
    } catch {
      font.limitations.push('The ToUnicode map could not be decoded.')
    }
  }

  if (font.isComposite) {
    const encoding = dict.get('Encoding')
    font.encodingName = nameOf(encoding) || 'Embedded CMap'
    if (font.encodingName === 'Identity-H') font.codeBytes = 2
    else if (font.encodingName === 'Identity-V') {
      font.codeBytes = 2
      font.unsupportedReason = 'Vertical (Identity-V) text editing is not supported yet.'
    } else {
      font.codeBytes = 2
      font.unsupportedReason = `The composite font encoding ${font.encodingName} is not supported for editing yet.`
    }
    if (cidFont) {
      const { widths, defaultWidth } = parseCidWidths(index, cidFont)
      font.widths = widths
      font.defaultWidth = defaultWidth
      const cidToGid = index.resolve(cidFont.get('CIDToGIDMap'))
      const mapRef = cidFont.get('CIDToGIDMap')
      if (mapRef instanceof PdfRef) {
        try {
          const mapBytes = await index.getStreamBytes(mapRef.num)
          if (mapBytes) font.cidToGid = (cid) => (cid * 2 + 1 < mapBytes.length ? (mapBytes[cid * 2] << 8) | mapBytes[cid * 2 + 1] : 0)
        } catch {
          // keep identity
        }
      } else if (!(cidToGid instanceof PdfName)) font.cidToGid = null
    } else font.defaultWidth = 1000
    if (!font.toUnicode.size && !font.unsupportedReason) {
      font.embeddedGidToUnicode = await loadEmbeddedCmap(index, descriptorDict)
      if (!font.embeddedGidToUnicode) font.unsupportedReason = 'This font has no readable Unicode map, so its text cannot be decoded for editing.'
    }
    return font
  }

  // Simple fonts (Type1, TrueType, Type3, MMType1).
  font.codeBytes = 1
  const encodingValue = index.resolve(dict.get('Encoding'))
  let baseEncodingName = null
  let differences = null
  if (encodingValue instanceof PdfName) baseEncodingName = encodingValue.name
  else if (encodingValue instanceof PdfDict) {
    baseEncodingName = encodingValue.getName('BaseEncoding')
    differences = resolveArray(index, encodingValue.get('Differences'))
  }
  font.encodingName = baseEncodingName || (differences ? 'Custom (Differences)' : font.subtype === 'TrueType' ? 'Built-in (TrueType)' : 'Built-in')
  const standardAlias = !font.fontFileKey ? resolveStandardFontAlias(font.baseFontName) : null
  if (!baseEncodingName) {
    if (standardAlias === 'Symbol' || standardAlias === 'ZapfDingbats') baseEncodingName = null
    else if (!font.symbolic || font.subtype === 'Type1' || !font.isEmbedded) baseEncodingName = 'StandardEncoding'
    if (font.subtype === 'TrueType' && !font.symbolic) baseEncodingName = 'WinAnsiEncoding'
  }
  const baseTable = baseEncodingName ? baseEncodingTable(baseEncodingName) : null
  const codeGlyphNames = new Map()
  if (baseTable) for (const [code, value] of baseTable) font.encodingUnicode.set(code, value)
  if (differences) {
    let code = 0
    for (const item of differences) {
      if (typeof item === 'number') { code = item; continue }
      if (item instanceof PdfName) {
        codeGlyphNames.set(code, item.name)
        const value = glyphNameToUnicode(item.name)
        if (value) font.encodingUnicode.set(code, value)
        else font.encodingUnicode.delete(code)
        code += 1
      }
    }
  }
  font.baseEncodingName = baseEncodingName

  // Widths.
  if (font.subtype === 'Type3') {
    const matrix = resolveArray(index, dict.get('FontMatrix'))
    font.widthScale = matrix && typeof matrix[0] === 'number' ? matrix[0] * 1000 : 1
  }
  const firstChar = asNumber(index.resolve(dict.get('FirstChar')), 0)
  const widthArray = resolveArray(index, dict.get('Widths'))
  if (widthArray) widthArray.forEach((width, offset) => font.widths.set(firstChar + offset, asNumber(width, 0)))
  font.defaultWidth = asNumber(index.resolve(descriptorDict.get('MissingWidth')), 0)
  if (!widthArray && standardAlias) {
    const metrics = loadStandardFontMetrics(standardAlias)
    font.standardMetrics = metrics
    if (metrics) {
      for (let code = 0; code <= 255; code += 1) {
        let glyphName = codeGlyphNames.get(code) || (baseEncodingName === 'StandardEncoding' ? baseEncodingGlyphName('StandardEncoding', code) : null)
        if (!glyphName) {
          const value = font.encodingUnicode.get(code)
          glyphName = value ? winAnsiEncodeCharacter(value)?.name : null
        }
        const width = glyphName ? metrics.getWidthOfGlyph(glyphName) : undefined
        if (typeof width === 'number') font.widths.set(code, width)
      }
    }
    font.defaultWidth = font.defaultWidth || 500
  } else if (!widthArray && !font.defaultWidth) font.defaultWidth = 500

  if (!font.isEmbedded) font.limitations.push('The font program is not embedded; viewers substitute a similar font.')
  if (font.isSubset) font.limitations.push('Subset font: new characters that are not in the subset use a matching fallback font.')
  return font
}

export function decodeStringBytes(font, bytes) {
  return font.splitCodes(bytes).map((code) => ({ code, unicode: font.decode(code) }))
}

export { PdfString }
