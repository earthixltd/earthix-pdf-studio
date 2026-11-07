import { PdfDict, PdfName } from './pdfSyntax.js'

async function collectStream(readable) {
  const reader = readable.getReader()
  const chunks = []
  let total = 0
  let failure = null
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      total += value.length
    }
  } catch (error) {
    failure = error
  }
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length }
  return { output, failure }
}

async function runDecompression(format, bytes) {
  const stream = new DecompressionStream(format)
  const writer = stream.writable.getWriter()
  const writing = writer.write(bytes).then(() => writer.close()).catch(() => undefined)
  const result = await collectStream(stream.readable)
  await writing
  return result
}

/**
 * Tolerant zlib inflate. Many real-world PDFs contain streams with trailing
 * garbage or a missing checksum; like PDF viewers we keep the decoded data.
 */
export async function inflate(bytes) {
  if (!bytes.length) return new Uint8Array(0)
  const zlib = await runDecompression('deflate', bytes)
  if (!zlib.failure || zlib.output.length) return zlib.output
  // Retry as a raw deflate stream (skip a possibly corrupt 2-byte zlib header).
  const raw = await runDecompression('deflate-raw', bytes.subarray(2))
  if (raw.output.length) return raw.output
  throw new Error('A compressed PDF stream could not be decoded.')
}

export async function deflate(bytes) {
  const stream = new CompressionStream('deflate')
  const writer = stream.writable.getWriter()
  const writing = writer.write(bytes).then(() => writer.close())
  const { output, failure } = await collectStream(stream.readable)
  await writing
  if (failure) throw failure
  return output
}

function paethPredictor(left, above, upperLeft) {
  const prediction = left + above - upperLeft
  const leftDistance = Math.abs(prediction - left)
  const aboveDistance = Math.abs(prediction - above)
  const upperLeftDistance = Math.abs(prediction - upperLeft)
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left
  if (aboveDistance <= upperLeftDistance) return above
  return upperLeft
}

function numberParam(parms, key, fallback) {
  const value = parms?.get?.(key)
  return typeof value === 'number' ? value : fallback
}

export function applyPredictor(bytes, parms) {
  const predictor = numberParam(parms, 'Predictor', 1)
  if (predictor <= 1) return bytes
  const colors = numberParam(parms, 'Colors', 1)
  const columns = numberParam(parms, 'Columns', 1)
  const bitsPerComponent = numberParam(parms, 'BitsPerComponent', 8)
  const rowBytes = Math.ceil((colors * columns * bitsPerComponent) / 8)
  const bytesPerPixel = Math.max(1, Math.ceil((colors * bitsPerComponent) / 8))
  if (!rowBytes) throw new Error('Invalid PDF predictor parameters.')

  if (predictor === 2) {
    if (bitsPerComponent !== 8) throw new Error('TIFF predictor with non-8-bit components is not supported.')
    const output = Uint8Array.from(bytes)
    for (let row = 0; row + rowBytes <= output.length; row += rowBytes) {
      for (let column = bytesPerPixel; column < rowBytes; column += 1) {
        output[row + column] = (output[row + column] + output[row + column - bytesPerPixel]) & 0xff
      }
    }
    return output
  }

  const rows = Math.floor(bytes.length / (rowBytes + 1))
  const output = new Uint8Array(rows * rowBytes)
  let inputOffset = 0
  let previous = new Uint8Array(rowBytes)
  for (let rowIndex = 0; rowIndex < rows; rowIndex += 1) {
    const filter = bytes[inputOffset++]
    const row = new Uint8Array(rowBytes)
    for (let column = 0; column < rowBytes; column += 1) {
      const raw = bytes[inputOffset++]
      const left = column >= bytesPerPixel ? row[column - bytesPerPixel] : 0
      const above = previous[column]
      const upperLeft = column >= bytesPerPixel ? previous[column - bytesPerPixel] : 0
      let value = raw
      if (filter === 1) value += left
      else if (filter === 2) value += above
      else if (filter === 3) value += Math.floor((left + above) / 2)
      else if (filter === 4) value += paethPredictor(left, above, upperLeft)
      row[column] = value & 0xff
    }
    output.set(row, rowIndex * rowBytes)
    previous = row
  }
  return output
}

function asciiHexDecode(bytes) {
  const output = []
  let high = -1
  for (const byte of bytes) {
    if (byte === 0x3e) break // '>'
    let value = -1
    if (byte >= 0x30 && byte <= 0x39) value = byte - 0x30
    else if (byte >= 0x41 && byte <= 0x46) value = byte - 0x37
    else if (byte >= 0x61 && byte <= 0x66) value = byte - 0x57
    if (value < 0) continue
    if (high < 0) high = value
    else { output.push((high << 4) | value); high = -1 }
  }
  if (high >= 0) output.push(high << 4)
  return Uint8Array.from(output)
}

function ascii85Decode(bytes) {
  const output = []
  const group = []
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index]
    if (byte === 0x7e) break // '~>'
    if (byte <= 0x20) continue
    if (byte === 0x7a && group.length === 0) { output.push(0, 0, 0, 0); continue } // 'z'
    if (byte < 0x21 || byte > 0x75) continue
    group.push(byte - 33)
    if (group.length === 5) {
      let value = 0
      for (const digit of group) value = value * 85 + digit
      output.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff)
      group.length = 0
    }
  }
  if (group.length > 1) {
    const count = group.length
    while (group.length < 5) group.push(84)
    let value = 0
    for (const digit of group) value = value * 85 + digit
    const tail = [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
    output.push(...tail.slice(0, count - 1))
  }
  return Uint8Array.from(output)
}

function lzwDecode(bytes, earlyChange = 1) {
  const output = []
  let dictionary = []
  const reset = () => {
    dictionary = []
    for (let code = 0; code < 256; code += 1) dictionary.push([code])
    dictionary.push(null, null)
  }
  reset()
  let codeLength = 9
  let bitBuffer = 0
  let bitCount = 0
  let previous = null
  for (const byte of bytes) {
    bitBuffer = (bitBuffer << 8) | byte
    bitCount += 8
    while (bitCount >= codeLength) {
      const code = (bitBuffer >>> (bitCount - codeLength)) & ((1 << codeLength) - 1)
      bitCount -= codeLength
      bitBuffer &= (1 << bitCount) - 1
      if (code === 256) { reset(); codeLength = 9; previous = null; continue }
      if (code === 257) return Uint8Array.from(output)
      let entry
      if (code < dictionary.length && dictionary[code]) entry = dictionary[code]
      else if (previous) entry = [...previous, previous[0]]
      else return Uint8Array.from(output)
      output.push(...entry)
      if (previous) dictionary.push([...previous, entry[0]])
      previous = entry
      const next = dictionary.length + earlyChange
      if (next >= 4096) codeLength = 12
      else if (next >= 2048) codeLength = 12
      else if (next >= 1024) codeLength = Math.max(codeLength, 11)
      else if (next >= 512) codeLength = Math.max(codeLength, 10)
    }
  }
  return Uint8Array.from(output)
}

function runLengthDecode(bytes) {
  const output = []
  let index = 0
  while (index < bytes.length) {
    const length = bytes[index++]
    if (length === 128) break
    if (length < 128) {
      for (let count = 0; count <= length && index < bytes.length; count += 1) output.push(bytes[index++])
    } else {
      const value = bytes[index++]
      for (let count = 0; count < 257 - length; count += 1) output.push(value)
    }
  }
  return Uint8Array.from(output)
}

export function streamFilters(dict) {
  const filter = dict?.get?.('Filter')
  const parms = dict?.get?.('DecodeParms') ?? dict?.get?.('DP')
  const filters = filter instanceof PdfName ? [filter.name] : Array.isArray(filter) ? filter.filter((item) => item instanceof PdfName).map((item) => item.name) : []
  const parmsList = Array.isArray(parms) ? parms : [parms]
  return filters.map((name, index) => ({ name, parms: parmsList[index] instanceof PdfDict ? parmsList[index] : null }))
}

const IMAGE_FILTERS = new Set(['DCTDecode', 'DCT', 'JPXDecode', 'CCITTFaxDecode', 'CCF', 'JBIG2Decode'])

/** Decode a stream through its filter chain. `resolve` dereferences indirect DecodeParms. */
export async function decodeStreamData(bytes, dict, resolve = (value) => value) {
  let data = bytes
  for (const { name, parms: rawParms } of streamFilters(dict)) {
    const parms = rawParms ? resolve(rawParms) : null
    if (name === 'FlateDecode' || name === 'Fl') data = applyPredictor(await inflate(data), parms)
    else if (name === 'LZWDecode' || name === 'LZW') data = applyPredictor(lzwDecode(data, numberParam(parms, 'EarlyChange', 1)), parms)
    else if (name === 'ASCIIHexDecode' || name === 'AHx') data = asciiHexDecode(data)
    else if (name === 'ASCII85Decode' || name === 'A85') data = ascii85Decode(data)
    else if (name === 'RunLengthDecode' || name === 'RL') data = runLengthDecode(data)
    else if (name === 'Crypt') continue
    else if (IMAGE_FILTERS.has(name)) throw new Error(`PDF image filter ${name} is not a text stream.`)
    else throw new Error(`PDF stream filter ${name} is not supported yet.`)
  }
  return data
}
