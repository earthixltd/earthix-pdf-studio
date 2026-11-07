import * as standardFontsModule from '@pdf-lib/standard-fonts'

// Vite resolves the ES build (named exports); Node resolves the CommonJS build (default export).
const lib = standardFontsModule.Font ? standardFontsModule : Reflect.get(standardFontsModule, 'default')

export const STANDARD_14_FONTS = [
  'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique',
  'Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique',
  'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic',
  'Symbol', 'ZapfDingbats',
]

const metricsCache = new Map()
export function loadStandardFontMetrics(fontName) {
  if (!STANDARD_14_FONTS.includes(fontName)) return null
  if (!metricsCache.has(fontName)) metricsCache.set(fontName, lib.Font.load(fontName))
  return metricsCache.get(fontName)
}

let winAnsiNameToUnicode = null
/** Glyph name -> Unicode for every WinAnsi glyph (covers Latin-1 and Windows-1252 extras). */
export function getWinAnsiGlyphNameMap() {
  if (!winAnsiNameToUnicode) {
    winAnsiNameToUnicode = new Map()
    for (const [codePoint, [, glyphName]] of Object.entries(lib.Encodings.WinAnsi.unicodeMappings)) {
      if (!winAnsiNameToUnicode.has(glyphName)) winAnsiNameToUnicode.set(glyphName, String.fromCodePoint(Number(codePoint)))
    }
  }
  return winAnsiNameToUnicode
}

/** Encode one Unicode character in WinAnsiEncoding. Returns { code, name } or null. */
export function winAnsiEncodeCharacter(character) {
  const codePoint = character.codePointAt(0)
  if (character === '\u00a0') return { code: 0x20, name: 'space' }
  if (!lib.Encodings.WinAnsi.canEncodeUnicodeCodePoint(codePoint)) return null
  return lib.Encodings.WinAnsi.encodeUnicodeCodePoint(codePoint)
}

const ALIASES = [
  [/^(arial|helvetica|liberationsans|arimo|nimbussans)/, 'Helvetica'],
  [/^(timesnewroman|times|liberationserif|tinos|nimbusroman)/, 'Times'],
  [/^(couriernew|courier|liberationmono|cousine|nimbusmono)/, 'Courier'],
]

export function standardFamilyFor(normalizedFamily, { serif = false, fixedPitch = false } = {}) {
  for (const [pattern, family] of ALIASES) if (pattern.test(normalizedFamily)) return family
  if (/symbol/.test(normalizedFamily)) return 'Symbol'
  if (/dingbat/.test(normalizedFamily)) return 'ZapfDingbats'
  if (fixedPitch || /mono|consol|code/.test(normalizedFamily)) return 'Courier'
  if (serif || /serif|roman|georgia|garamond|cambria|book|minion|palatino/.test(normalizedFamily)) return 'Times'
  return 'Helvetica'
}

export function standardFontName(family, bold, italic) {
  if (family === 'Symbol' || family === 'ZapfDingbats') return family
  if (family === 'Times') {
    if (bold && italic) return 'Times-BoldItalic'
    if (bold) return 'Times-Bold'
    if (italic) return 'Times-Italic'
    return 'Times-Roman'
  }
  const suffix = bold && italic ? '-BoldOblique' : bold ? '-Bold' : italic ? '-Oblique' : ''
  return family + suffix
}

/** Map a non-embedded BaseFont name (Arial, Arial,Bold, TimesNewRoman...) to a standard-14 font. */
export function resolveStandardFontAlias(baseFontName) {
  if (STANDARD_14_FONTS.includes(baseFontName)) return baseFontName
  const normalized = baseFontName.replace(/^[A-Z]{6}\+/, '').toLowerCase().replace(/[^a-z]/g, '')
  const bold = /bold|black|heavy|semibold|demi/.test(normalized)
  const italic = /italic|oblique/.test(normalized)
  for (const [pattern, family] of ALIASES) {
    if (pattern.test(normalized)) return standardFontName(family, bold, italic)
  }
  if (/^symbol/.test(normalized)) return 'Symbol'
  if (/^zapfdingbats/.test(normalized)) return 'ZapfDingbats'
  return null
}
