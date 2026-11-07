// Minimal, lossless PDF object syntax parser and serializer.
// Values: null | boolean | number | PdfName | PdfString | PdfRef | PdfKeyword | Array | PdfDict

export class PdfName {
  constructor(name) { this.name = name }
  toString() { return '/' + this.name }
}

export class PdfRef {
  constructor(num, gen = 0) { this.num = num; this.gen = gen }
  toString() { return `${this.num} ${this.gen} R` }
}

export class PdfString {
  constructor(bytes, hex = false) { this.bytes = bytes; this.hex = hex }
}

export class PdfKeyword {
  constructor(word) { this.word = word }
}

/** Dictionary keyed by name (without the leading slash); preserves key order. */
export class PdfDict extends Map {
  getName(key) {
    const value = this.get(key)
    return value instanceof PdfName ? value.name : null
  }
}

export const isWhite = (code) => code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09 || code === 0x0c || code === 0x00
const DELIMITERS = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%'])
export const isDelimiter = (char) => DELIMITERS.has(char)

export function skipWhitespace(source, position) {
  let index = position
  while (index < source.length) {
    const code = source.charCodeAt(index)
    if (isWhite(code)) { index += 1; continue }
    if (code === 0x25) { // % comment
      while (index < source.length && source[index] !== '\n' && source[index] !== '\r') index += 1
      continue
    }
    break
  }
  return index
}

export function readLiteralStringBytes(source, start) {
  let index = start + 1
  let depth = 1
  const bytes = []
  const simple = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 }
  while (index < source.length) {
    const char = source[index]
    if (char === '\\') {
      index += 1
      if (index >= source.length) break
      const escaped = source[index]
      if (Object.hasOwn(simple, escaped)) bytes.push(simple[escaped])
      else if (escaped >= '0' && escaped <= '7') {
        let octal = escaped
        for (let count = 0; count < 2 && source[index + 1] >= '0' && source[index + 1] <= '7'; count += 1) octal += source[++index]
        bytes.push(Number.parseInt(octal, 8) & 0xff)
      } else if (escaped === '\r' || escaped === '\n') {
        if (escaped === '\r' && source[index + 1] === '\n') index += 1
      } else bytes.push(escaped.charCodeAt(0) & 0xff)
      index += 1
      continue
    }
    if (char === '(') { depth += 1; bytes.push(40); index += 1; continue }
    if (char === ')') {
      depth -= 1
      index += 1
      if (depth === 0) return { bytes: Uint8Array.from(bytes), end: index }
      bytes.push(41)
      continue
    }
    bytes.push(char.charCodeAt(0) & 0xff)
    index += 1
  }
  throw new Error('Malformed PDF literal string.')
}

export function readHexStringBytes(source, start) {
  const end = source.indexOf('>', start + 1)
  if (end < 0) throw new Error('Malformed PDF hexadecimal string.')
  const hex = source.slice(start + 1, end).replace(/[^0-9a-fA-F]/g, '')
  const padded = hex.length % 2 ? `${hex}0` : hex
  const bytes = new Uint8Array(padded.length / 2)
  for (let offset = 0; offset < padded.length; offset += 2) bytes[offset / 2] = Number.parseInt(padded.slice(offset, offset + 2), 16)
  return { bytes, end: end + 1 }
}

function readName(source, start) {
  let index = start + 1
  let name = ''
  while (index < source.length) {
    const char = source[index]
    if (isWhite(char.charCodeAt(0)) || isDelimiter(char)) break
    if (char === '#' && /^[0-9a-fA-F]{2}$/.test(source.slice(index + 1, index + 3))) {
      name += String.fromCharCode(Number.parseInt(source.slice(index + 1, index + 3), 16))
      index += 3
      continue
    }
    name += char
    index += 1
  }
  return { name, end: index }
}

function readBareWord(source, start) {
  let index = start
  while (index < source.length) {
    const char = source[index]
    if (isWhite(char.charCodeAt(0)) || isDelimiter(char)) break
    index += 1
  }
  return { word: source.slice(start, index), end: index }
}

const NUMBER_PATTERN = /^[+-]?(\d+\.?\d*|\.\d+)$/
const INTEGER_PATTERN = /^\d+$/

/** Parse one PDF value starting at `position`. Returns { value, end }. */
export function parsePdfValue(source, position) {
  let index = skipWhitespace(source, position)
  if (index >= source.length) throw new Error('Unexpected end of PDF data.')
  const char = source[index]

  if (char === '<' && source[index + 1] === '<') {
    const dict = new PdfDict()
    index += 2
    for (;;) {
      index = skipWhitespace(source, index)
      if (index >= source.length) throw new Error('Unterminated PDF dictionary.')
      if (source[index] === '>' && source[index + 1] === '>') { index += 2; break }
      if (source[index] !== '/') {
        // Tolerate junk tokens inside a dictionary by skipping them.
        const skipped = parsePdfValue(source, index)
        index = skipped.end
        continue
      }
      const key = readName(source, index)
      const parsed = parsePdfValue(source, key.end)
      dict.set(key.name, parsed.value)
      index = parsed.end
    }
    return { value: dict, end: index }
  }
  if (char === '<') {
    const { bytes, end } = readHexStringBytes(source, index)
    return { value: new PdfString(bytes, true), end }
  }
  if (char === '(') {
    const { bytes, end } = readLiteralStringBytes(source, index)
    return { value: new PdfString(bytes, false), end }
  }
  if (char === '[') {
    const array = []
    index += 1
    for (;;) {
      index = skipWhitespace(source, index)
      if (index >= source.length) throw new Error('Unterminated PDF array.')
      if (source[index] === ']') { index += 1; break }
      const parsed = parsePdfValue(source, index)
      array.push(parsed.value)
      index = parsed.end
    }
    return { value: array, end: index }
  }
  if (char === '/') {
    const { name, end } = readName(source, index)
    return { value: new PdfName(name), end }
  }
  if (char === ')' || char === '>' || char === ']' || char === '{' || char === '}') {
    return { value: new PdfKeyword(char), end: index + 1 }
  }

  const { word, end } = readBareWord(source, index)
  if (NUMBER_PATTERN.test(word)) {
    if (INTEGER_PATTERN.test(word)) {
      // Look ahead for "gen R".
      const afterFirst = skipWhitespace(source, end)
      const second = readBareWord(source, afterFirst)
      if (INTEGER_PATTERN.test(second.word)) {
        const afterSecond = skipWhitespace(source, second.end)
        if (source[afterSecond] === 'R') {
          const nextChar = source[afterSecond + 1]
          if (nextChar === undefined || isWhite(nextChar.charCodeAt(0)) || isDelimiter(nextChar)) {
            return { value: new PdfRef(Number(word), Number(second.word)), end: afterSecond + 1 }
          }
        }
      }
    }
    return { value: Number(word), end }
  }
  if (word === 'true') return { value: true, end }
  if (word === 'false') return { value: false, end }
  if (word === 'null') return { value: null, end }
  return { value: new PdfKeyword(word), end }
}

export function formatPdfNumber(value) {
  if (!Number.isFinite(value)) return '0'
  if (Number.isInteger(value)) return String(value)
  let text = value.toFixed(6)
  text = text.replace(/0+$/, '').replace(/\.$/, '')
  return text === '-0' ? '0' : text
}

function escapeName(name) {
  let output = ''
  for (const char of name) {
    const code = char.charCodeAt(0)
    if (code < 0x21 || code > 0x7e || char === '#' || isDelimiter(char)) output += '#' + code.toString(16).padStart(2, '0')
    else output += char
  }
  return output
}

export function bytesToHex(bytes) {
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex.toUpperCase()
}

export function serializePdfValue(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return formatPdfNumber(value)
  if (value instanceof PdfName) return '/' + escapeName(value.name)
  if (value instanceof PdfRef) return `${value.num} ${value.gen} R`
  if (value instanceof PdfString) return '<' + bytesToHex(value.bytes) + '>'
  if (value instanceof PdfKeyword) return value.word
  if (Array.isArray(value)) return '[' + value.map(serializePdfValue).join(' ') + ']'
  if (value instanceof PdfDict || value instanceof Map) {
    const parts = []
    for (const [key, item] of value) {
      if (item === undefined) continue
      parts.push('/' + escapeName(key) + ' ' + serializePdfValue(item))
    }
    return '<<' + parts.join(' ') + '>>'
  }
  throw new Error('Unsupported PDF value for serialization.')
}

export function pdfDict(entries) {
  const dict = new PdfDict()
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined) dict.set(key, value)
  }
  return dict
}

export const name = (value) => new PdfName(value)

export function latin1(bytes) {
  const chunks = []
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(String.fromCharCode.apply(null, bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length))))
  }
  return chunks.join('')
}

export const latin1Bytes = (value) => {
  const output = new Uint8Array(value.length)
  for (let index = 0; index < value.length; index += 1) output[index] = value.charCodeAt(index) & 0xff
  return output
}

export function concatBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const output = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }
  return output
}
