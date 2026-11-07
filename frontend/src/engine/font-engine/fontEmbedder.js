import { deflate } from '../pdf-parser/pdfStreams.js'
import { latin1Bytes, name, PdfDict, PdfRef, PdfString } from '../pdf-parser/pdfSyntax.js'
import { loadStandardFontMetrics, winAnsiEncodeCharacter } from './standardFonts.js'

let fontkitPromise = null
export function loadFontkit() {
  if (!fontkitPromise) {
    // fontkit's complex-script shapers (Devanagari, Arabic…) use generator
    // code compiled for regenerator-runtime, which must exist globally.
    fontkitPromise = import('regenerator-runtime/runtime.js')
      .then((module) => {
        const runtime = module.default ?? module
        if (!globalThis.regeneratorRuntime && runtime?.mark) globalThis.regeneratorRuntime = runtime
      })
      .catch(() => undefined)
      .then(() => import('@pdf-lib/fontkit'))
      .then((module) => module.default ?? module)
  }
  return fontkitPromise
}

function randomSubsetTag() {
  let tag = ''
  for (let index = 0; index < 6; index += 1) tag += String.fromCharCode(65 + Math.floor(Math.random() * 26))
  return tag
}

function utf16Hex(text) {
  let hex = ''
  for (let index = 0; index < text.length; index += 1) hex += text.charCodeAt(index).toString(16).padStart(4, '0')
  return hex.toUpperCase()
}

function buildToUnicodeCMap(entries) {
  const lines = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
  ]
  for (let offset = 0; offset < entries.length; offset += 100) {
    const chunk = entries.slice(offset, offset + 100)
    lines.push(`${chunk.length} beginbfchar`)
    for (const [code, text] of chunk) lines.push(`<${code.toString(16).padStart(4, '0').toUpperCase()}> <${utf16Hex(text)}>`)
    lines.push('endbfchar')
  }
  lines.push('endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end')
  return lines.join('\n')
}

function encodeSubset(subset) {
  return new Promise((resolve, reject) => {
    const parts = []
    subset.encodeStream()
      .on('data', (bytes) => parts.push(bytes))
      .on('end', () => {
        const total = parts.reduce((sum, part) => sum + part.length, 0)
        const output = new Uint8Array(total)
        let offset = 0
        for (const part of parts) { output.set(part, offset); offset += part.length }
        resolve(output)
      })
      .on('error', reject)
  })
}

export async function openFontProgram(bytes, postscriptName) {
  const fontkit = await loadFontkit()
  // fontkit's create(buffer, name) treats the name as a variation for plain
  // fonts, so only collections (.ttc) are searched by PostScript name.
  let font = fontkit.create(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
  if (font && typeof font.layout !== 'function' && Array.isArray(font.fonts)) {
    font = (postscriptName && font.getFont?.(postscriptName)) || font.fonts.find((candidate) => candidate.postscriptName === postscriptName) || font.fonts[0]
  }
  if (!font || typeof font.layout !== 'function') throw new Error('The fallback font file could not be read.')
  return font
}

export function fontCoversText(font, text) {
  for (const character of text) {
    if (/\s/.test(character)) continue
    if (!font.hasGlyphForCodePoint(character.codePointAt(0))) return false
  }
  return true
}

/**
 * Encoder for an embedded Type0/Identity-H font built from a TrueType/OpenType
 * program (a system font). Glyphs used by the edit are subset into the PDF.
 */
export async function createEmbeddedFontEncoder(fontBytes, postscriptName, label) {
  const font = await openFontProgram(fontBytes, postscriptName)
  const subset = font.createSubset()
  const scale = 1000 / font.unitsPerEm
  const toUnicode = new Map()
  const widths = new Map([[0, 0]])

  return {
    kind: 'embedded',
    label: label || font.fullName || font.postscriptName,
    postscriptName: font.postscriptName,
    codeBytes: 2,
    ascent: font.ascent * scale,
    descent: font.descent * scale,
    /** Line metrics in em units (as browsers use them for this font). */
    metrics: { ascent: font.ascent / font.unitsPerEm, descent: Math.abs(font.descent) / font.unitsPerEm },
    canEncode(text) { return fontCoversText(font, text) },
    measure(text, size) {
      if (!text) return 0
      return (font.layout(text).advanceWidth / font.unitsPerEm) * size
    },
    encode(text) {
      const layout = font.layout(text)
      return layout.glyphs.map((glyph, index) => {
        const position = layout.positions[index]
        const code = subset.includeGlyph(glyph)
        const width = glyph.advanceWidth * scale
        widths.set(code, width)
        const unicode = glyph.codePoints?.length ? String.fromCodePoint(...glyph.codePoints) : ''
        if (unicode && !toUnicode.has(code)) toUnicode.set(code, unicode)
        return {
          code,
          width,
          unicode,
          kern: ((position?.xAdvance ?? glyph.advanceWidth) - glyph.advanceWidth) * scale,
          xOffset: (position?.xOffset || 0) * scale,
          yOffset: (position?.yOffset || 0) * scale,
          isSpace: unicode === ' ' || unicode === '\u00a0',
        }
      })
    },
    async buildObjects(allocate, reservedFontNumber) {
      const subsetBytes = await encodeSubset(subset)
      const isCFF = Boolean(subset.cff)
      const baseFontName = `${randomSubsetTag()}+${(font.postscriptName || 'EarthixFallback').replace(/[^A-Za-z0-9_-]/g, '')}`
      const fontFileRef = new PdfRef(allocate(), 0)
      const descriptorRef = new PdfRef(allocate(), 0)
      const cidFontRef = new PdfRef(allocate(), 0)
      const toUnicodeRef = new PdfRef(allocate(), 0)
      const fontRef = new PdfRef(reservedFontNumber ?? allocate(), 0)

      const compressedFont = await deflate(subsetBytes)
      const fontFileDict = new PdfDict([['Length', compressedFont.length], ['Filter', name('FlateDecode')]])
      if (isCFF) fontFileDict.set('Subtype', name('CIDFontType0C'))
      else fontFileDict.set('Length1', subsetBytes.length)

      const bbox = font.bbox
      let flags = 4 // symbolic (glyphs outside the standard Latin set)
      if (font.post?.isFixedPitch) flags |= 1
      if (font['OS/2']?.sFamilyClass && (font['OS/2'].sFamilyClass >> 8) >= 1 && (font['OS/2'].sFamilyClass >> 8) <= 7) flags |= 2
      if (font.italicAngle) flags |= 64
      const descriptor = new PdfDict([
        ['Type', name('FontDescriptor')],
        ['FontName', name(baseFontName)],
        ['Flags', flags],
        ['FontBBox', [bbox.minX * scale, bbox.minY * scale, bbox.maxX * scale, bbox.maxY * scale].map((value) => Math.round(value))],
        ['ItalicAngle', font.italicAngle || 0],
        ['Ascent', Math.round(font.ascent * scale)],
        ['Descent', Math.round(font.descent * scale)],
        ['CapHeight', Math.round((font.capHeight || font.ascent) * scale)],
        ['XHeight', Math.round((font.xHeight || 0) * scale)],
        ['StemV', 80],
        [isCFF ? 'FontFile3' : 'FontFile2', fontFileRef],
      ])

      const maxCode = Math.max(...widths.keys())
      const widthArray = []
      for (let code = 0; code <= maxCode; code += 1) widthArray.push(Math.round(widths.get(code) ?? 0))
      const cidFont = new PdfDict([
        ['Type', name('Font')],
        ['Subtype', name(isCFF ? 'CIDFontType0' : 'CIDFontType2')],
        ['BaseFont', name(baseFontName)],
        ['CIDSystemInfo', new PdfDict([
          ['Registry', new PdfString(latin1Bytes('Adobe'))],
          ['Ordering', new PdfString(latin1Bytes('Identity'))],
          ['Supplement', 0],
        ])],
        ['FontDescriptor', descriptorRef],
        ['DW', 1000],
        ['W', [0, widthArray]],
      ])
      if (!isCFF) cidFont.set('CIDToGIDMap', name('Identity'))

      const cmapBytes = latin1Bytes(buildToUnicodeCMap([...toUnicode.entries()].sort((a, b) => a[0] - b[0])))
      const compressedCmap = await deflate(cmapBytes)
      const type0 = new PdfDict([
        ['Type', name('Font')],
        ['Subtype', name('Type0')],
        ['BaseFont', name(baseFontName)],
        ['Encoding', name('Identity-H')],
        ['DescendantFonts', [cidFontRef]],
        ['ToUnicode', toUnicodeRef],
      ])
      return {
        fontRef,
        objects: [
          { num: fontFileRef.num, gen: 0, value: fontFileDict, stream: compressedFont },
          { num: descriptorRef.num, gen: 0, value: descriptor },
          { num: cidFontRef.num, gen: 0, value: cidFont },
          { num: toUnicodeRef.num, gen: 0, value: new PdfDict([['Length', compressedCmap.length], ['Filter', name('FlateDecode')]]), stream: compressedCmap },
          { num: fontRef.num, gen: 0, value: type0 },
        ],
      }
    },
  }
}

/** Encoder for a non-embedded standard-14 font (WinAnsi text only). */
export function createStandardFontEncoder(fontName) {
  const metrics = loadStandardFontMetrics(fontName)
  if (!metrics) throw new Error(`Unknown standard font ${fontName}.`)
  return {
    kind: 'standard14',
    label: fontName,
    postscriptName: fontName,
    codeBytes: 1,
    ascent: metrics.Ascender || 718,
    descent: metrics.Descender || -207,
    canEncode(text) {
      for (const character of text) if (!winAnsiEncodeCharacter(character)) return false
      return true
    },
    measure(text, size) {
      let total = 0
      for (const character of text) {
        const encoded = winAnsiEncodeCharacter(character)
        total += encoded ? (metrics.getWidthOfGlyph(encoded.name) ?? 500) : 556
      }
      return (total * size) / 1000
    },
    encode(text) {
      return [...text].map((character) => {
        const encoded = winAnsiEncodeCharacter(character)
        if (!encoded) throw new Error(`The standard font ${fontName} cannot draw “${character}”.`)
        return { code: encoded.code, width: metrics.getWidthOfGlyph(encoded.name) ?? 500, unicode: character, kern: 0, xOffset: 0, yOffset: 0, isSpace: encoded.code === 32 }
      })
    },
    async buildObjects(allocate, reservedFontNumber) {
      const fontRef = new PdfRef(reservedFontNumber ?? allocate(), 0)
      const widths = []
      for (let code = 32; code <= 255; code += 1) {
        let width = 0
        for (const candidate of [String.fromCharCode(code), new TextDecoder('windows-1252').decode(Uint8Array.of(code))]) {
          const encoded = winAnsiEncodeCharacter(candidate)
          if (encoded && encoded.code === code) { width = metrics.getWidthOfGlyph(encoded.name) ?? 0; break }
        }
        widths.push(width)
      }
      const dict = new PdfDict([
        ['Type', name('Font')],
        ['Subtype', name('Type1')],
        ['BaseFont', name(fontName)],
        ['Encoding', name('WinAnsiEncoding')],
        ['FirstChar', 32],
        ['LastChar', 255],
        ['Widths', widths],
      ])
      return { fontRef, objects: [{ num: fontRef.num, gen: 0, value: dict }] }
    },
  }
}
