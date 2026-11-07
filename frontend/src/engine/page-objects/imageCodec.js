// Minimal image codecs for embedding pictures in PDFs (no canvas required).
// JPEG files are embedded as-is (DCTDecode). PNG files are decoded to RGB +
// alpha and stored as Flate streams with a soft mask.

import { deflate, inflate } from '../pdf-parser/pdfStreams.js'
import { name, PdfDict, PdfRef } from '../pdf-parser/pdfSyntax.js'

const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

export function detectImageFormat(bytes) {
  if (bytes?.[0] === 0xff && bytes[1] === 0xd8) return 'jpeg'
  if (bytes?.[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png'
  return null
}

function readExifOrientation(bytes, start, length) {
  // "Exif\0\0" + TIFF header
  if (length < 14 || String.fromCharCode(...bytes.subarray(start, start + 4)) !== 'Exif') return 1
  const tiff = start + 6
  const little = bytes[tiff] === 0x49
  const u16 = (offset) => (little ? bytes[offset] | (bytes[offset + 1] << 8) : (bytes[offset] << 8) | bytes[offset + 1])
  const u32 = (offset) => (little
    ? (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)) + bytes[offset + 3] * 0x1000000
    : bytes[offset] * 0x1000000 + ((bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]))
  const ifd = tiff + u32(tiff + 4)
  if (ifd + 2 > start + length) return 1
  const count = u16(ifd)
  for (let entry = 0; entry < count; entry += 1) {
    const offset = ifd + 2 + entry * 12
    if (offset + 12 > start + length) break
    if (u16(offset) === 0x0112) return u16(offset + 8) || 1
  }
  return 1
}

/** Width, height, colour components and EXIF orientation of a JPEG file. */
export function readJpegInfo(bytes) {
  if (detectImageFormat(bytes) !== 'jpeg') throw new Error('Not a JPEG image.')
  let offset = 2
  let orientation = 1
  let adobe = false
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue }
    const marker = bytes[offset + 1]
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) { offset += marker === 0xff ? 1 : 2; continue }
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3]
    if (marker === 0xe1) orientation = readExifOrientation(bytes, offset + 4, length - 2)
    if (marker === 0xee) adobe = true
    if (SOF_MARKERS.has(marker)) {
      return {
        format: 'jpeg',
        height: (bytes[offset + 5] << 8) | bytes[offset + 6],
        width: (bytes[offset + 7] << 8) | bytes[offset + 8],
        components: bytes[offset + 9],
        orientation,
        adobe,
      }
    }
    if (marker === 0xd9 || marker === 0xda) break
    offset += 2 + length
  }
  throw new Error('The JPEG image size could not be read.')
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes, start = 0, end = bytes.length) {
  let crc = 0xffffffff
  for (let index = start; index < end; index += 1) crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

const readU32 = (bytes, offset) => bytes[offset] * 0x1000000 + ((bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3])

export function readPngInfo(bytes) {
  if (detectImageFormat(bytes) !== 'png') throw new Error('Not a PNG image.')
  return { format: 'png', width: readU32(bytes, 16), height: readU32(bytes, 20), bitDepth: bytes[24], colorType: bytes[25], interlace: bytes[28] }
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/** Decode a non-interlaced PNG to 8-bit RGB (+ optional alpha). */
export async function decodePng(bytes) {
  const info = readPngInfo(bytes)
  if (info.interlace) throw new Error('Interlaced PNG images are not supported.')
  let offset = 8
  const idat = []
  let palette = null
  let transparency = null
  while (offset + 8 <= bytes.length) {
    const length = readU32(bytes, offset)
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7])
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    if (type === 'IDAT') idat.push(data)
    else if (type === 'PLTE') palette = data
    else if (type === 'tRNS') transparency = data
    else if (type === 'IEND') break
    offset += 12 + length
  }
  const total = idat.reduce((sum, part) => sum + part.length, 0)
  const compressed = new Uint8Array(total)
  let cursor = 0
  for (const part of idat) { compressed.set(part, cursor); cursor += part.length }
  const raw = await inflate(compressed)

  const { width, height, bitDepth, colorType } = info
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]
  if (!channels) throw new Error('Unsupported PNG colour type.')
  const bitsPerPixel = channels * bitDepth
  const bytesPerPixel = Math.max(1, bitsPerPixel >> 3)
  const stride = Math.ceil((width * bitsPerPixel) / 8)
  const pixels = new Uint8Array(stride * height)
  let previous = new Uint8Array(stride)
  for (let row = 0; row < height; row += 1) {
    const filter = raw[row * (stride + 1)]
    const line = raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1))
    const output = pixels.subarray(row * stride, (row + 1) * stride)
    for (let index = 0; index < stride; index += 1) {
      const left = index >= bytesPerPixel ? output[index - bytesPerPixel] : 0
      const up = previous[index]
      const upLeft = index >= bytesPerPixel ? previous[index - bytesPerPixel] : 0
      const value = line[index] ?? 0
      let result
      switch (filter) {
        case 1: result = value + left; break
        case 2: result = value + up; break
        case 3: result = value + ((left + up) >> 1); break
        case 4: result = value + paeth(left, up, upLeft); break
        default: result = value
      }
      output[index] = result & 0xff
    }
    previous = output
  }

  const sample = (row, column, channel) => {
    if (bitDepth === 8) return pixels[row * stride + column * channels + channel]
    if (bitDepth === 16) return pixels[row * stride + (column * channels + channel) * 2]
    const bitIndex = column * bitDepth
    const byte = pixels[row * stride + (bitIndex >> 3)]
    const shift = 8 - bitDepth - (bitIndex & 7)
    return (byte >> shift) & ((1 << bitDepth) - 1)
  }
  const scaleGray = (value) => (bitDepth >= 8 ? value : Math.round((value * 255) / ((1 << bitDepth) - 1)))

  const rgb = new Uint8Array(width * height * 3)
  const alpha = new Uint8Array(width * height)
  let hasAlpha = false
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const pixel = row * width + column
      let r
      let g
      let b
      let a = 255
      if (colorType === 0) {
        const raw0 = sample(row, column, 0)
        r = g = b = scaleGray(raw0)
        if (transparency && transparency.length >= 2 && raw0 === ((transparency[0] << 8) | transparency[1]) >> (bitDepth === 16 ? 8 : 0)) a = 0
      } else if (colorType === 2) {
        r = sample(row, column, 0); g = sample(row, column, 1); b = sample(row, column, 2)
        if (transparency && transparency.length >= 6 && r === transparency[1] && g === transparency[3] && b === transparency[5]) a = 0
      } else if (colorType === 3) {
        const entry = sample(row, column, 0)
        r = palette?.[entry * 3] ?? 0; g = palette?.[entry * 3 + 1] ?? 0; b = palette?.[entry * 3 + 2] ?? 0
        if (transparency && entry < transparency.length) a = transparency[entry]
      } else if (colorType === 4) {
        r = g = b = sample(row, column, 0); a = sample(row, column, 1)
      } else {
        r = sample(row, column, 0); g = sample(row, column, 1); b = sample(row, column, 2); a = sample(row, column, 3)
      }
      rgb[pixel * 3] = r
      rgb[pixel * 3 + 1] = g
      rgb[pixel * 3 + 2] = b
      alpha[pixel] = a
      if (a !== 255) hasAlpha = true
    }
  }
  return { width, height, rgb, alpha: hasAlpha ? alpha : null }
}

function chunk(type, data) {
  const output = new Uint8Array(12 + data.length)
  const view = new DataView(output.buffer)
  view.setUint32(0, data.length)
  for (let index = 0; index < 4; index += 1) output[4 + index] = type.charCodeAt(index)
  output.set(data, 8)
  view.setUint32(8 + data.length, crc32(output, 4, 8 + data.length))
  return output
}

/** Encode 8-bit RGB (+ optional alpha) as a PNG file. */
export async function encodePng({ width, height, rgb, alpha = null }) {
  const channels = alpha ? 4 : 3
  const stride = width * channels
  const raw = new Uint8Array((stride + 1) * height)
  for (let row = 0; row < height; row += 1) {
    const base = row * (stride + 1)
    raw[base] = 0
    for (let column = 0; column < width; column += 1) {
      const pixel = row * width + column
      const target = base + 1 + column * channels
      raw[target] = rgb[pixel * 3]
      raw[target + 1] = rgb[pixel * 3 + 1]
      raw[target + 2] = rgb[pixel * 3 + 2]
      if (alpha) raw[target + 3] = alpha[pixel]
    }
  }
  const header = new Uint8Array(13)
  const view = new DataView(header.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  header[8] = 8
  header[9] = alpha ? 6 : 2
  const compressed = await deflate(raw)
  const parts = [Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), chunk('IHDR', header), chunk('IDAT', compressed), chunk('IEND', new Uint8Array())]
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let cursor = 0
  for (const part of parts) { output.set(part, cursor); cursor += part.length }
  return output
}

// ---------------------------------------------------------------------------
// PDF image XObjects
// ---------------------------------------------------------------------------

/**
 * Build PDF image XObject(s) for a JPEG or PNG file.
 * Returns { ref, objects, width, height }.
 */
export async function buildImageXObject(data, allocate) {
  const format = detectImageFormat(data)
  const ref = new PdfRef(allocate(), 0)
  if (format === 'jpeg') {
    const info = readJpegInfo(data)
    const colorSpace = info.components === 1 ? 'DeviceGray' : info.components === 4 ? 'DeviceCMYK' : 'DeviceRGB'
    const dict = new PdfDict([
      ['Type', name('XObject')],
      ['Subtype', name('Image')],
      ['Width', info.width],
      ['Height', info.height],
      ['ColorSpace', name(colorSpace)],
      ['BitsPerComponent', 8],
      ['Filter', name('DCTDecode')],
      ['Length', data.length],
    ])
    if (info.components === 4 && info.adobe) dict.set('Decode', [1, 0, 1, 0, 1, 0, 1, 0])
    return { ref, width: info.width, height: info.height, objects: [{ num: ref.num, gen: 0, value: dict, stream: data }] }
  }
  if (format === 'png') {
    const image = await decodePng(data)
    const objects = []
    const compressed = await deflate(image.rgb)
    const dict = new PdfDict([
      ['Type', name('XObject')],
      ['Subtype', name('Image')],
      ['Width', image.width],
      ['Height', image.height],
      ['ColorSpace', name('DeviceRGB')],
      ['BitsPerComponent', 8],
      ['Filter', name('FlateDecode')],
      ['Length', compressed.length],
    ])
    if (image.alpha) {
      const maskRef = new PdfRef(allocate(), 0)
      const maskData = await deflate(image.alpha)
      objects.push({
        num: maskRef.num,
        gen: 0,
        value: new PdfDict([
          ['Type', name('XObject')],
          ['Subtype', name('Image')],
          ['Width', image.width],
          ['Height', image.height],
          ['ColorSpace', name('DeviceGray')],
          ['BitsPerComponent', 8],
          ['Filter', name('FlateDecode')],
          ['Length', maskData.length],
        ]),
        stream: maskData,
      })
      dict.set('SMask', maskRef)
    }
    objects.unshift({ num: ref.num, gen: 0, value: dict, stream: compressed })
    return { ref, width: image.width, height: image.height, objects }
  }
  throw new Error('Only JPEG and PNG images can be embedded.')
}

/**
 * Read back an image XObject written by Earthix as a JPEG or PNG file.
 * Returns { data, format, width, height } or null.
 */
export async function readImageXObject(index, num) {
  const object = index.getObject(num)
  const dict = object?.value
  if (!(dict instanceof PdfDict) || !object.stream) return null
  const filters = [index.resolve(dict.get('Filter'))].flat().map((item) => item?.name)
  const width = index.resolve(dict.get('Width'))
  const height = index.resolve(dict.get('Height'))
  if (filters.length === 1 && filters[0] === 'DCTDecode') return { data: object.stream.slice(), format: 'jpeg', width, height }
  if (index.resolve(dict.get('BitsPerComponent')) !== 8 || dict.getName('ColorSpace') !== 'DeviceRGB') return null
  const rgb = await index.getStreamBytes(num)
  if (!rgb || rgb.length < width * height * 3) return null
  let alpha = null
  const mask = dict.get('SMask')
  if (mask instanceof PdfRef) {
    const maskBytes = await index.getStreamBytes(mask.num)
    if (maskBytes && maskBytes.length >= width * height) alpha = maskBytes.subarray(0, width * height)
  }
  return { data: await encodePng({ width, height, rgb, alpha }), format: 'png', width, height }
}
