import { getWinAnsiGlyphNameMap } from './standardFonts.js'

const EXTRA_GLYPHS = {
  fi: 'fi', fl: 'fl', ff: 'ff', ffi: 'ffi', ffl: 'ffl', dotlessi: 'ı', Lslash: 'Ł', lslash: 'ł',
  minus: '−', fraction: '⁄', ring: '˚', caron: 'ˇ', breve: '˘', dotaccent: '˙', hungarumlaut: '˝',
  ogonek: '˛', nbspace: '\u00a0', nonbreakingspace: '\u00a0', sfthyphen: '\u00ad', softhyphen: '\u00ad',
  quotesingle: "'", grave: '`', rupee: '₹', rupeeindian: '₹', Delta: 'Δ', Omega: 'Ω', mu: 'µ', pi: 'π',
  approxequal: '≈', notequal: '≠', lessequal: '≤', greaterequal: '≥', infinity: '∞', checkmark: '✓',
  arrowright: '→', arrowleft: '←', arrowup: '↑', arrowdown: '↓', bullet: '•', middot: '·', hyphenminus: '-',
  Gbreve: 'Ğ', gbreve: 'ğ', Idotaccent: 'İ', Scedilla: 'Ş', scedilla: 'ş', Cacute: 'Ć', cacute: 'ć',
  Nacute: 'Ń', nacute: 'ń', Sacute: 'Ś', sacute: 'ś', Zacute: 'Ź', zacute: 'ź', Zdotaccent: 'Ż', zdotaccent: 'ż',
  Aogonek: 'Ą', aogonek: 'ą', Eogonek: 'Ę', eogonek: 'ę', Ccaron: 'Č', ccaron: 'č', Rcaron: 'Ř', rcaron: 'ř',
  Ecaron: 'Ě', ecaron: 'ě', Uring: 'Ů', uring: 'ů', Dcaron: 'Ď', dcaron: 'ď', Tcaron: 'Ť', tcaron: 'ť',
  Ncaron: 'Ň', ncaron: 'ň', Amacron: 'Ā', amacron: 'ā', Emacron: 'Ē', emacron: 'ē', Imacron: 'Ī', imacron: 'ī',
  Omacron: 'Ō', omacron: 'ō', Umacron: 'Ū', umacron: 'ū', florin: 'ƒ', Euro: '€', euro: '€',
}

let nameMap = null
function getNameMap() {
  if (!nameMap) {
    nameMap = new Map(getWinAnsiGlyphNameMap())
    for (const [glyphName, value] of Object.entries(EXTRA_GLYPHS)) if (!nameMap.has(glyphName)) nameMap.set(glyphName, value)
  }
  return nameMap
}

/** Adobe Glyph List style name -> Unicode string (null when unknown). */
export function glyphNameToUnicode(glyphName) {
  if (!glyphName) return null
  const known = getNameMap().get(glyphName)
  if (known) return known
  const base = glyphName.split('.')[0]
  if (base !== glyphName) {
    const stripped = getNameMap().get(base)
    if (stripped) return stripped
  }
  if (base.includes('_')) {
    const parts = base.split('_').map((part) => glyphNameToUnicode(part))
    if (parts.every(Boolean)) return parts.join('')
  }
  let match = base.match(/^uni((?:[0-9A-Fa-f]{4})+)$/)
  if (match) {
    const units = match[1].match(/.{4}/g).map((unit) => Number.parseInt(unit, 16))
    return String.fromCharCode(...units)
  }
  match = base.match(/^u([0-9A-Fa-f]{4,6})$/)
  if (match) {
    const codePoint = Number.parseInt(match[1], 16)
    return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : null
  }
  if (/^[A-Za-z]$/.test(base)) return base
  return null
}

const STANDARD_ENCODING_HIGH = {
  0xa1: 'exclamdown', 0xa2: 'cent', 0xa3: 'sterling', 0xa4: 'fraction', 0xa5: 'yen', 0xa6: 'florin', 0xa7: 'section',
  0xa8: 'currency', 0xa9: 'quotesingle', 0xaa: 'quotedblleft', 0xab: 'guillemotleft', 0xac: 'guilsinglleft',
  0xad: 'guilsinglright', 0xae: 'fi', 0xaf: 'fl', 0xb1: 'endash', 0xb2: 'dagger', 0xb3: 'daggerdbl',
  0xb4: 'periodcentered', 0xb6: 'paragraph', 0xb7: 'bullet', 0xb8: 'quotesinglbase', 0xb9: 'quotedblbase',
  0xba: 'quotedblright', 0xbb: 'guillemotright', 0xbc: 'ellipsis', 0xbd: 'perthousand', 0xbf: 'questiondown',
  0xc1: 'grave', 0xc2: 'acute', 0xc3: 'circumflex', 0xc4: 'tilde', 0xc5: 'macron', 0xc6: 'breve', 0xc7: 'dotaccent',
  0xc8: 'dieresis', 0xca: 'ring', 0xcb: 'cedilla', 0xcd: 'hungarumlaut', 0xce: 'ogonek', 0xcf: 'caron', 0xd0: 'emdash',
  0xe1: 'AE', 0xe3: 'ordfeminine', 0xe8: 'Lslash', 0xe9: 'Oslash', 0xea: 'OE', 0xeb: 'ordmasculine', 0xf1: 'ae',
  0xf5: 'dotlessi', 0xf8: 'lslash', 0xf9: 'oslash', 0xfa: 'oe', 0xfb: 'germandbls',
}

const ASCII_GLYPH_NAMES = [
  'space', 'exclam', 'quotedbl', 'numbersign', 'dollar', 'percent', 'ampersand', 'quotesingle', 'parenleft', 'parenright',
  'asterisk', 'plus', 'comma', 'hyphen', 'period', 'slash', 'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven',
  'eight', 'nine', 'colon', 'semicolon', 'less', 'equal', 'greater', 'question', 'at',
]

function asciiGlyphName(code) {
  if (code >= 0x20 && code <= 0x40) return ASCII_GLYPH_NAMES[code - 0x20]
  if (code >= 0x41 && code <= 0x5a) return String.fromCharCode(code)
  if (code >= 0x61 && code <= 0x7a) return String.fromCharCode(code)
  return { 0x5b: 'bracketleft', 0x5c: 'backslash', 0x5d: 'bracketright', 0x5e: 'asciicircum', 0x5f: 'underscore', 0x60: 'grave', 0x7b: 'braceleft', 0x7c: 'bar', 0x7d: 'braceright', 0x7e: 'asciitilde' }[code] || null
}

const encodingCache = new Map()

const isControlCharacter = (character) => {
  const code = character.charCodeAt(0)
  return code < 0x20 || (code >= 0x7f && code <= 0x9f)
}

function decoderTable(label) {
  const table = new Map()
  try {
    const decoder = new TextDecoder(label)
    for (let code = 0x20; code <= 0xff; code += 1) {
      const character = decoder.decode(Uint8Array.of(code))
      if (character && character !== '\ufffd' && !isControlCharacter(character)) table.set(code, character)
    }
  } catch {
    // Encoding unavailable in this runtime.
  }
  return table
}

/** Base encoding code -> Unicode table. Returns a Map. */
export function baseEncodingTable(encodingName) {
  if (encodingCache.has(encodingName)) return encodingCache.get(encodingName)
  let table
  if (encodingName === 'WinAnsiEncoding') table = decoderTable('windows-1252')
  else if (encodingName === 'MacRomanEncoding') table = decoderTable('macintosh')
  else if (encodingName === 'PDFDocEncoding') table = decoderTable('windows-1252')
  else if (encodingName === 'StandardEncoding') {
    table = new Map()
    for (let code = 0x20; code <= 0x7e; code += 1) table.set(code, String.fromCharCode(code))
    table.set(0x27, '’')
    table.set(0x60, '‘')
    for (const [code, glyphName] of Object.entries(STANDARD_ENCODING_HIGH)) {
      const value = glyphNameToUnicode(glyphName)
      if (value) table.set(Number(code), value)
    }
  } else table = null
  encodingCache.set(encodingName, table)
  return table
}

/** Glyph name for a code in a named base encoding (needed for standard-14 width lookups). */
export function baseEncodingGlyphName(encodingName, code) {
  if (encodingName === 'StandardEncoding') {
    if (code === 0x27) return 'quoteright'
    if (code === 0x60) return 'quoteleft'
    return STANDARD_ENCODING_HIGH[code] || asciiGlyphName(code)
  }
  return null
}
