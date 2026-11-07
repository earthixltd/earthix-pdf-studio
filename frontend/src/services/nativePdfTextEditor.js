const latin1 = (bytes) => {
  const chunks = []
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length))))
  }
  return chunks.join('')
}

const latin1Bytes = (value) => Uint8Array.from(value, (character) => character.charCodeAt(0) & 0xff)
const concatBytes = (parts) => {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const output = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }
  return output
}

function findDictionaryEnd(source, start) {
  let depth = 0
  let inLiteral = false
  let literalDepth = 0
  let escaped = false
  let inHex = false

  for (let index = start; index < source.length - 1; index += 1) {
    const char = source[index]
    const next = source[index + 1]

    if (inLiteral) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '(') literalDepth += 1
      else if (char === ')') {
        literalDepth -= 1
        if (literalDepth === 0) inLiteral = false
      }
      continue
    }

    if (inHex) {
      if (char === '>') inHex = false
      continue
    }

    if (char === '(') {
      inLiteral = true
      literalDepth = 1
      continue
    }

    if (char === '<' && next !== '<') {
      inHex = true
      continue
    }

    if (char === '<' && next === '<') {
      depth += 1
      index += 1
      continue
    }

    if (char === '>' && next === '>') {
      depth -= 1
      index += 1
      if (depth === 0) return index + 1
    }
  }

  throw new Error('Malformed PDF dictionary.')
}

function readIndirectObjectAtOffset(source, offset, index = null) {
  const tail = source.slice(offset)
  const header = tail.match(/^(\d+)\s+(\d+)\s+obj\b/)
  if (!header) throw new Error('PDF indirect object header could not be read at byte offset ' + offset + '.')

  const objectNumber = Number(header[1])
  const generation = Number(header[2])
  const bodyStart = header[0].length
  const dictStart = tail.indexOf('<<', bodyStart)
  if (dictStart < 0) {
    const endObject = tail.indexOf('endobj', bodyStart)
    return { objectNumber, generation, body: tail.slice(bodyStart, endObject < 0 ? undefined : endObject).trim(), dictionary: null, stream: null }
  }

  const dictEnd = findDictionaryEnd(tail, dictStart)
  const dictionary = tail.slice(dictStart, dictEnd)
  const endObjectMarker = tail.indexOf('endobj', dictEnd)
  const streamMarker = tail.indexOf('stream', dictEnd)
  if (streamMarker < 0 || endObjectMarker < 0 || streamMarker > endObjectMarker) {
    return { objectNumber, generation, dictionary, body: dictionary, stream: null }
  }

  let streamStart = streamMarker + 6
  if (tail.slice(streamStart, streamStart + 2) === '\r\n') streamStart += 2
  else if (tail[streamStart] === '\n' || tail[streamStart] === '\r') streamStart += 1

  let length = Number(dictionary.match(/\/Length(?!\d)\s+(\d+)(?!\s+\d+\s+R)/)?.[1])
  if (!Number.isFinite(length) && index) {
    const indirectLength = dictionary.match(/\/Length(?!\d)\s+(\d+)\s+\d+\s+R/)
    if (indirectLength) {
      const lengthObject = getPdfObject(index, Number(indirectLength[1]))
      length = Number(lengthObject.body ?? lengthObject.dictionary)
    }
  }
  if (!Number.isFinite(length) || length < 0) {
    throw new Error('PDF object ' + objectNumber + ' has an indirect or invalid stream length that could not be resolved safely.')
  }

  const absoluteStreamStart = offset + streamStart
  const streamEnd = absoluteStreamStart + length
  if (streamEnd > source.length) throw new Error('PDF object ' + objectNumber + ' stream exceeds the document length.')
  return {
    objectNumber,
    generation,
    dictionary,
    body: dictionary,
    stream: latin1Bytes(source.slice(absoluteStreamStart, streamEnd)),
  }
}

function parseClassicXrefSection(source, offset) {
  const marker = source.indexOf('trailer', offset)
  if (marker < 0) throw new Error('Classic PDF xref trailer was not found.')
  const start = source.indexOf('<<', marker)
  if (start < 0) throw new Error('PDF trailer dictionary was not found.')
  const end = findDictionaryEnd(source, start)
  const trailer = source.slice(start, end)
  const section = source.slice(offset + 4, marker)
  const tokens = section.match(/\S+/g) || []
  const entries = new Map()
  let cursor = 0

  while (cursor < tokens.length) {
    const first = Number(tokens[cursor])
    const count = Number(tokens[cursor + 1])
    if (!Number.isInteger(first) || !Number.isInteger(count) || count < 0) break
    cursor += 2

    for (let item = 0; item < count; item += 1) {
      const byteOffset = Number(tokens[cursor])
      const generation = Number(tokens[cursor + 1])
      const flag = tokens[cursor + 2]
      cursor += 3
      if (!Number.isInteger(byteOffset) || !Number.isInteger(generation)) continue
      entries.set(first + item, flag === 'n'
        ? { type: 1, offset: byteOffset, generation }
        : { type: 0, nextFreeObject: byteOffset, generation })
    }
  }

  return { entries, trailer }
}

function parseNumberArray(dictionary, key) {
  const match = dictionary.match(new RegExp('\\/' + key + '\\s*\\[([^\\]]*)\\]'))
  if (!match) return null
  const values = match[1].trim().split(/\s+/).filter(Boolean).map(Number)
  return values.every(Number.isFinite) ? values : null
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

function applyPngPredictor(bytes, parameters = '') {
  const predictor = Number(parameters.match(/\/Predictor\s+(\d+)/)?.[1] ?? 1)
  if (predictor <= 1) return bytes
  if (predictor === 2) throw new Error('TIFF predictor streams are not supported by native text editing yet.')
  if (predictor < 10 || predictor > 15) throw new Error('Unsupported PDF stream predictor: ' + predictor)

  const colors = Number(parameters.match(/\/Colors\s+(\d+)/)?.[1] ?? 1)
  const columns = Number(parameters.match(/\/Columns\s+(\d+)/)?.[1] ?? 1)
  const bitsPerComponent = Number(parameters.match(/\/BitsPerComponent\s+(\d+)/)?.[1] ?? 8)
  const rowBytes = Math.ceil((colors * columns * bitsPerComponent) / 8)
  const bytesPerPixel = Math.max(1, Math.ceil((colors * bitsPerComponent) / 8))
  if (!rowBytes || !bytesPerPixel) throw new Error('Invalid PNG predictor parameters in PDF stream.')

  const hasFilterByte = bytes.length % (rowBytes + 1) === 0
  const fixedFilter = predictor === 15 ? null : predictor - 10
  if (!hasFilterByte && (fixedFilter === null || bytes.length % rowBytes !== 0)) {
    throw new Error('PNG predictor data has an invalid row length.')
  }

  const rows = hasFilterByte ? bytes.length / (rowBytes + 1) : bytes.length / rowBytes
  const output = new Uint8Array(rows * rowBytes)
  let inputOffset = 0
  let outputOffset = 0
  let previous = new Uint8Array(rowBytes)

  for (let rowIndex = 0; rowIndex < rows; rowIndex += 1) {
    const filter = hasFilterByte ? bytes[inputOffset++] : fixedFilter
    if (filter < 0 || filter > 4) throw new Error('Unsupported PNG predictor filter: ' + filter)
    const row = new Uint8Array(rowBytes)

    for (let column = 0; column < rowBytes; column += 1) {
      const raw = bytes[inputOffset++]
      const left = column >= bytesPerPixel ? row[column - bytesPerPixel] : 0
      const above = previous[column] || 0
      const upperLeft = column >= bytesPerPixel ? previous[column - bytesPerPixel] : 0
      let value = raw
      if (filter === 1) value += left
      else if (filter === 2) value += above
      else if (filter === 3) value += Math.floor((left + above) / 2)
      else if (filter === 4) value += paethPredictor(left, above, upperLeft)
      row[column] = value & 0xff
    }

    output.set(row, outputOffset)
    outputOffset += rowBytes
    previous = row
  }

  return output
}

async function decodePdfStream(streamBytes, dictionary) {
  let decoded = streamBytes
  const filter = dictionary.match(/\/Filter\s*(\/[^\s/>]+|\[[^\]]*\])/)?.[1] || ''
  if (!filter) return decoded
  if (/FlateDecode|\/Fl\b/.test(filter)) decoded = await inflate(decoded)
  else throw new Error('PDF stream filter ' + filter + ' is not supported by native text editing yet.')
  const decodeParms = dictionary.match(/\/DecodeParms\s*(<<[\s\S]*?>>|\[[^\]]*\])/)?.[1] || ''
  if (decodeParms.startsWith('<<')) decoded = applyPngPredictor(decoded, decodeParms)
  return decoded
}

async function parseXrefStreamSection(source, bytes, offset) {
  const object = readIndirectObjectAtOffset(source, offset)
  if (!/\/Type\s*\/XRef\b/.test(object.dictionary || '') || !object.stream) {
    throw new Error('The startxref offset does not point to a valid xref stream.')
  }

  const widths = parseNumberArray(object.dictionary, 'W')
  if (!widths || widths.length !== 3 || widths.some((width) => !Number.isInteger(width) || width < 0)) {
    throw new Error('PDF xref stream has an invalid W array.')
  }
  const recordWidth = widths.reduce((sum, width) => sum + width, 0)
  if (!recordWidth) throw new Error('PDF xref stream has an empty W array.')
  const size = Number(object.dictionary.match(/\/Size\s+(\d+)/)?.[1])
  if (!Number.isInteger(size) || size < 1) throw new Error('PDF xref stream has an invalid Size value.')
  const indexRanges = parseNumberArray(object.dictionary, 'Index') || [0, size]
  if (indexRanges.length % 2 !== 0) throw new Error('PDF xref stream has an invalid Index array.')

  const decoded = await decodePdfStream(object.stream, object.dictionary)
  const entries = new Map()
  let byteOffset = 0
  for (let rangeIndex = 0; rangeIndex < indexRanges.length; rangeIndex += 2) {
    const firstObject = indexRanges[rangeIndex]
    const objectCount = indexRanges[rangeIndex + 1]
    if (!Number.isInteger(firstObject) || !Number.isInteger(objectCount) || firstObject < 0 || objectCount < 0) {
      throw new Error('PDF xref stream contains an invalid object range.')
    }

    for (let item = 0; item < objectCount; item += 1) {
      if (byteOffset + recordWidth > decoded.length) throw new Error('PDF xref stream ended before all entries were read.')
      const fields = []
      for (const width of widths) {
        let value = 0
        for (let byte = 0; byte < width; byte += 1) value = value * 256 + decoded[byteOffset++]
        fields.push(width === 0 ? 0 : value)
      }
      const type = widths[0] === 0 ? 1 : fields[0]
      const objectNumber = firstObject + item
      if (type === 0) {
        entries.set(objectNumber, { type: 0, nextFreeObject: fields[1], generation: fields[2] })
      } else if (type === 1) {
        entries.set(objectNumber, { type: 1, offset: fields[1], generation: fields[2] })
      } else if (type === 2) {
        entries.set(objectNumber, { type: 2, objectStreamNumber: fields[1], objectStreamIndex: fields[2], generation: 0 })
      }
    }
  }

  return { entries, trailer: object.dictionary, xrefObjectNumber: object.objectNumber }
}

async function parseXrefSection(source, bytes, offset) {
  if (source.slice(offset, offset + 4) === 'xref') {
    const classic = parseClassicXrefSection(source, offset)
    const supplementalOffset = Number(classic.trailer.match(/\/XRefStm\s+(\d+)/)?.[1])
    if (Number.isInteger(supplementalOffset)) {
      const supplemental = await parseXrefStreamSection(source, bytes, supplementalOffset)
      for (const [objectNumber, entry] of supplemental.entries) {
        if (!classic.entries.has(objectNumber) || entry.type === 2) classic.entries.set(objectNumber, entry)
      }
    }
    return classic
  }
  return parseXrefStreamSection(source, bytes, offset)
}

function parseObjectStreamHeader(headerSource, count) {
  const tokens = headerSource.trim().split(/\s+/).filter(Boolean).map(Number)
  if (tokens.length < count * 2) throw new Error('PDF object stream header is incomplete.')
  const objects = []
  for (let index = 0; index < count; index += 1) {
    const objectNumber = tokens[index * 2]
    const relativeOffset = tokens[index * 2 + 1]
    if (!Number.isInteger(objectNumber) || !Number.isInteger(relativeOffset) || relativeOffset < 0) {
      throw new Error('PDF object stream contains an invalid object index.')
    }
    objects.push({ objectNumber, relativeOffset })
  }
  return objects
}

async function loadCompressedObjects(index, objectStreamNumber) {
  const cached = index.objectStreamCache.get(objectStreamNumber)
  if (cached) return cached
  const streamObject = getPdfObject(index, objectStreamNumber)
  if (!streamObject.stream || !/\/Type\s*\/ObjStm\b/.test(streamObject.dictionary || '')) {
    throw new Error('PDF compressed object reference points to an invalid object stream.')
  }
  const count = Number(streamObject.dictionary.match(/\/N\s+(\d+)/)?.[1])
  const first = Number(streamObject.dictionary.match(/\/First\s+(\d+)/)?.[1])
  if (!Number.isInteger(count) || count < 1 || !Number.isInteger(first) || first < 0) {
    throw new Error('PDF object stream has invalid N or First values.')
  }
  const decoded = await decodePdfStream(streamObject.stream, streamObject.dictionary)
  const decodedSource = latin1(decoded)
  if (first > decodedSource.length) throw new Error('PDF object stream First offset is outside the decoded stream.')
  const objects = parseObjectStreamHeader(decodedSource.slice(0, first), count)
  const parsed = new Map()
  for (let indexInStream = 0; indexInStream < objects.length; indexInStream += 1) {
    const current = objects[indexInStream]
    const nextOffset = objects[indexInStream + 1]?.relativeOffset ?? (decodedSource.length - first)
    if (nextOffset < current.relativeOffset) throw new Error('PDF object stream offsets are not ordered.')
    const body = decodedSource.slice(first + current.relativeOffset, first + nextOffset).trim()
    let dictionary = null
    if (body.startsWith('<<')) {
      const dictionaryEnd = findDictionaryEnd(body, 0)
      dictionary = body.slice(0, dictionaryEnd)
    }
    parsed.set(current.objectNumber, {
      objectNumber: current.objectNumber,
      generation: 0,
      dictionary,
      body,
      stream: null,
      isCompressed: true,
      objectStreamNumber,
      objectStreamIndex: indexInStream,
    })
  }
  index.objectStreamCache.set(objectStreamNumber, parsed)
  return parsed
}

async function createPdfIndex(bytes) {
  const source = latin1(bytes)
  const startXrefMatches = [...source.matchAll(/startxref\s+(\d+)\s+%%EOF/g)]
  if (!startXrefMatches.length) throw new Error('PDF xref location could not be found.')
  const latestXref = Number(startXrefMatches.at(-1)[1])
  const entries = new Map()
  let currentXref = latestXref
  let latestTrailer = ''
  const visitedXrefs = new Set()
  let first = true

  while (Number.isInteger(currentXref) && currentXref >= 0) {
    if (visitedXrefs.has(currentXref)) throw new Error('PDF xref /Prev chain contains a loop.')
    visitedXrefs.add(currentXref)
    const section = await parseXrefSection(source, bytes, currentXref)
    if (first) {
      latestTrailer = section.trailer
      first = false
    }
    for (const [objectNumber, entry] of section.entries) {
      if (!entries.has(objectNumber)) entries.set(objectNumber, entry)
    }
    const previous = section.trailer.match(/\/Prev\s+(\d+)/)
    if (!previous) break
    currentXref = Number(previous[1])
    if (visitedXrefs.size > 64) throw new Error('PDF contains too many incremental xref revisions.')
  }

  if (/\/Encrypt(?:\s|\d|<|\[)/.test(latestTrailer)) {
    throw new Error('Encrypted PDFs must be unlocked before native text editing.')
  }
  const index = { source, latestXref, entries, trailer: latestTrailer, objectStreamCache: new Map() }
  const objectStreamNumbers = new Set([...entries.values()]
    .filter((entry) => entry.type === 2)
    .map((entry) => entry.objectStreamNumber))
  for (const objectStreamNumber of objectStreamNumbers) await loadCompressedObjects(index, objectStreamNumber)
  return index
}

function getPdfObject(index, objectNumber) {
  const entry = index.entries.get(objectNumber)
  if (!entry || entry.type === 0) throw new Error('PDF object ' + objectNumber + ' is missing or free.')
  if (entry.type === 2) {
    const objectStream = index.objectStreamCache.get(entry.objectStreamNumber)
    const object = objectStream?.get(objectNumber)
    if (!object) throw new Error('Compressed PDF object ' + objectNumber + ' could not be resolved from object stream ' + entry.objectStreamNumber + '.')
    if (object.objectStreamIndex !== entry.objectStreamIndex) throw new Error('Compressed PDF object ' + objectNumber + ' has an inconsistent object-stream index.')
    return object
  }
  if (entry.type !== 1 || !Number.isInteger(entry.offset)) throw new Error('PDF object ' + objectNumber + ' has an unsupported xref entry type.')
  const object = readIndirectObjectAtOffset(index.source, entry.offset, index)
  if (object.objectNumber !== objectNumber) throw new Error('PDF xref entry for object ' + objectNumber + ' points to object ' + object.objectNumber + '.')
  return object
}

function sanitizeTrailerForClassicXref(dictionary, size, previousXref) {
  let trailer = dictionary
    .replace(/\/Type\s*\/XRef\b/g, '')
    .replace(/\/W\s*\[[^\]]*\]/g, '')
    .replace(/\/Index\s*\[[^\]]*\]/g, '')
    .replace(/\/Length(?!\d)\s+\d+/g, '')
    .replace(/\/Filter\s*(?:\/[^\s/>]+|\[[^\]]*\])/g, '')
    .replace(/\/DecodeParms\s*(?:<<[\s\S]*?>>|\[[^\]]*\])/g, '')
    .replace(/\/Prev\s+\d+/g, '')
    .replace(/\/Size\s+\d+/g, '')
  trailer = trailer.replace(/>>\s*$/, '').trim()
  return trailer + ' /Size ' + size + ' /Prev ' + previousXref + ' >>'
}

function extractReferences(source) {
  return [...source.matchAll(/(\d+)\s+(\d+)\s+R/g)].map((match) => ({ objectNumber: Number(match[1]), generation: Number(match[2]) }))
}

function getPageObjects(index) {
  const root = index.trailer.match(/\/Root\s+(\d+)\s+\d+\s+R/)
  if (!root) throw new Error('PDF catalog reference is missing.')
  const catalog = getPdfObject(index, Number(root[1]))
  const pagesRef = catalog.dictionary?.match(/\/Pages\s+(\d+)\s+\d+\s+R/)
  if (!pagesRef) throw new Error('PDF page tree is missing.')

  const pages = []
  const visit = (objectNumber) => {
    const object = getPdfObject(index, objectNumber)
    const dictionary = object.dictionary || ''
    if (/\/Type\s*\/Page(?!s)/.test(dictionary)) {
      pages.push({ objectNumber, dictionary })
      return
    }

    const kidsMatch = dictionary.match(/\/Kids\s*\[([\s\S]*?)\]/)
    if (!kidsMatch) return
    for (const reference of extractReferences(kidsMatch[1])) visit(reference.objectNumber)
  }

  visit(Number(pagesRef[1]))
  return pages
}

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function decodeUtf16BeHex(hex) {
  const values = hex.match(/.{1,4}/g) || []
  const units = values.map((part) => Number.parseInt(part.padEnd(4, '0'), 16))
  let output = ''
  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index]
    if (unit >= 0xd800 && unit <= 0xdbff && units[index + 1] >= 0xdc00 && units[index + 1] <= 0xdfff) {
      const low = units[++index]
      output += String.fromCodePoint(0x10000 + ((unit - 0xd800) << 10) + low - 0xdc00)
    } else {
      output += String.fromCharCode(unit)
    }
  }
  return output
}


function createWinAnsiMapping() {
  const decoder = new TextDecoder('windows-1252')
  const codeToUnicode = new Map()
  const unicodeToCode = new Map()
  for (let code = 32; code <= 255; code += 1) {
    if ([0x7f, 0x81, 0x8d, 0x8f, 0x90, 0x9d].includes(code)) continue
    const character = decoder.decode(Uint8Array.of(code))
    if (!character || /[\u0000-\u001f\u007f-\u009f]/.test(character)) continue
    codeToUnicode.set(code, character)
    if (!unicodeToCode.has(character)) unicodeToCode.set(character, code)
  }
  return { codeToUnicode, unicodeToCode }
}

function parseSimpleFontWidths(index, fontDictionary) {
  const firstChar = Number(fontDictionary.match(/\/FirstChar\s+(\d+)/)?.[1] ?? 0)
  const lastChar = Number(fontDictionary.match(/\/LastChar\s+(\d+)/)?.[1] ?? 255)
  const widths = new Map()
  const widthsMatch = fontDictionary.match(/\/Widths\s*\[([^\]]*)\]/)
  if (widthsMatch) {
    const values = widthsMatch[1].match(/-?\d+(?:\.\d+)?/g) || []
    values.forEach((value, offset) => {
      const code = firstChar + offset
      if (code <= lastChar) widths.set(code, Number(value))
    })
  }
  const descriptorReference = fontDictionary.match(/\/FontDescriptor\s+(\d+)\s+\d+\s+R/)
  const descriptor = descriptorReference ? getPdfObject(index, Number(descriptorReference[1])) : null
  const defaultWidth = Number(descriptor?.dictionary?.match(/\/MissingWidth\s+(-?\d+(?:\.\d+)?)/)?.[1] ?? 500)
  const supportedCodes = new Set([...widths].filter(([, width]) => width > 0).map(([code]) => code))
  return { widths, defaultWidth, firstChar, lastChar, supportedCodes, hasExplicitWidths: Boolean(widthsMatch) }
}

function parseToUnicodeCMap(source) {
  const codeToUnicode = new Map()
  const lines = source.split(/\r?\n/)
  let section = ''

  for (const line of lines) {
    const countMatch = line.match(/^\s*\d+\s+begin(bfchar|bfrange)\s*$/)
    if (countMatch) {
      section = countMatch[1]
      continue
    }
    if (/endbfchar|endbfrange/.test(line)) {
      section = ''
      continue
    }
    if (!section) continue

    if (section === 'bfchar') {
      const pair = line.match(/<([\da-fA-F]+)>\s*<([\da-fA-F]+)>/)
      if (pair) codeToUnicode.set(Number.parseInt(pair[1], 16), decodeUtf16BeHex(pair[2]))
      continue
    }

    const range = line.match(/<([\da-fA-F]+)>\s*<([\da-fA-F]+)>\s*(<([\da-fA-F]+)>|\[([^\]]*)\])/)
    if (!range) continue
    const start = Number.parseInt(range[1], 16)
    const end = Number.parseInt(range[2], 16)
    if (range[4]) {
      const startUnicode = Number.parseInt(range[4], 16)
      for (let code = start; code <= end; code += 1) {
        codeToUnicode.set(code, String.fromCodePoint(startUnicode + code - start))
      }
    } else if (range[5]) {
      const destinations = [...range[5].matchAll(/<([\da-fA-F]+)>/g)]
      for (let offset = 0; offset < destinations.length && start + offset <= end; offset += 1) {
        codeToUnicode.set(start + offset, decodeUtf16BeHex(destinations[offset][1]))
      }
    }
  }

  const unicodeToCode = new Map()
  for (const [code, text] of codeToUnicode) {
    if (text && !unicodeToCode.has(text)) unicodeToCode.set(text, code)
  }
  return { codeToUnicode, unicodeToCode }
}

function parseCidWidths(index, type0FontDictionary) {
  const descendantReference = type0FontDictionary.match(/\/DescendantFonts\s*\[\s*(\d+)\s+\d+\s+R/)
  if (!descendantReference) return { widths: new Map(), defaultWidth: 1000 }
  const descendant = getPdfObject(index, Number(descendantReference[1]))
  const dictionary = descendant.dictionary || ''
  const defaultWidth = Number(dictionary.match(/\/DW\s+(-?\d+(?:\.\d+)?)/)?.[1] ?? 1000)
  const widths = new Map()
  const marker = dictionary.indexOf('/W')
  if (marker < 0) return { widths, defaultWidth }
  const start = dictionary.indexOf('[', marker)
  if (start < 0) return { widths, defaultWidth }
  let depth = 0
  let end = -1
  for (let index = start; index < dictionary.length; index += 1) {
    if (dictionary[index] === '[') depth += 1
    else if (dictionary[index] === ']') {
      depth -= 1
      if (depth === 0) { end = index; break }
    }
  }
  if (end < 0) return { widths, defaultWidth }
  const tokens = dictionary.slice(start + 1, end).match(/\[|\]|-?\d+(?:\.\d+)?/g) || []
  let cursor = 0
  while (cursor < tokens.length) {
    const firstCid = Number(tokens[cursor++])
    if (!Number.isInteger(firstCid)) break
    if (tokens[cursor] === '[') {
      cursor += 1
      let code = firstCid
      while (cursor < tokens.length && tokens[cursor] !== ']') {
        const width = Number(tokens[cursor++])
        if (Number.isFinite(width)) widths.set(code++, width)
      }
      cursor += 1
    } else {
      const lastCid = Number(tokens[cursor++])
      const width = Number(tokens[cursor++])
      if (!Number.isInteger(lastCid) || !Number.isFinite(width)) break
      for (let code = firstCid; code <= lastCid; code += 1) widths.set(code, width)
    }
  }
  return { widths, defaultWidth }
}

function identityHCodeUnits(bytes) {
  if (bytes.length % 2 !== 0) throw new Error('An Identity-H text string has an invalid byte length.')
  const codes = []
  for (let offset = 0; offset < bytes.length; offset += 2) codes.push((bytes[offset] << 8) | bytes[offset + 1])
  return codes
}

function fontCodeUnits(bytes, font) {
  if (font.isComposite) return identityHCodeUnits(bytes)
  return [...bytes]
}

function pdfNumber(value) {
  return Number(value.toFixed(4)).toString()
}

function getFontDescriptor(index, fontObject) {
  const descendantReference = fontObject.dictionary?.match(/\/DescendantFonts\s*\[\s*(\d+)\s+\d+\s+R/)
  const descendant = descendantReference ? getPdfObject(index, Number(descendantReference[1])) : null
  const descriptorReference = (descendant?.dictionary || fontObject.dictionary || '').match(/\/FontDescriptor\s+(\d+)\s+\d+\s+R/)
  const descriptor = descriptorReference ? getPdfObject(index, Number(descriptorReference[1])) : null
  return { descendant, descriptor, dictionary: descriptor?.dictionary || '' }
}

function readFontMetadata(index, resourceName, fontObject, mapping, metrics, isComposite) {
  const dictionary = fontObject.dictionary || ''
  const { descendant, descriptor, dictionary: descriptorDictionary } = getFontDescriptor(index, fontObject)
  const baseFontName = dictionary.match(/\/BaseFont\s*\/([^\s/<>()]+)/)?.[1] || ''
  const descriptorFontName = descriptorDictionary.match(/\/FontName\s*\/([^\s/<>()]+)/)?.[1] || ''
  const subtype = dictionary.match(/\/Subtype\s*\/([^\s/<>()]+)/)?.[1] || 'Unknown'
  const encoding = dictionary.match(/\/Encoding\s*\/([^\s/<>()]+)/)?.[1] || 'Custom/Unknown'
  const flags = Number(descriptorDictionary.match(/\/Flags\s+(\d+)/)?.[1] || 0)
  const weightValue = Number(descriptorDictionary.match(/\/FontWeight\s+(\d+)/)?.[1] || 0)
  const fontFileMatch = descriptorDictionary.match(/\/(FontFile3|FontFile2|FontFile)\s+(\d+)\s+\d+\s+R/)
  const embedded = Boolean(fontFileMatch)
  const isSubset = /^[A-Z]{6}\+/.test(baseFontName)
  const fontFamily = (descriptorFontName || baseFontName).replace(/^[A-Z]{6}\+/, '')
  const italic = Boolean(flags & 64) || /italic|oblique/i.test(fontFamily)
  const bold = Boolean(flags & 262144) || weightValue >= 600 || /bold|black|heavy|semibold/i.test(fontFamily)
  const unicodeMapEntries = mapping.codeToUnicode.size
  const hasToUnicode = unicodeMapEntries > 0
  const identityH = encoding === 'Identity-H'
  const winAnsi = encoding === 'WinAnsiEncoding'
  const supportedCharacters = [...mapping.unicodeToCode.entries()]
    .filter(([, code]) => !embedded || identityH || !metrics.supportedCodes || metrics.supportedCodes.has(code))
    .map(([character]) => character)
  const canNativeReplace = (identityH && hasToUnicode && mapping.unicodeToCode.size > 0)
    || (winAnsi && mapping.unicodeToCode.size > 0 && supportedCharacters.length > 0)
  const limitations = []
  if (!identityH && !winAnsi) limitations.push('Encoding ' + encoding + ' is not supported by the current native replacement path.')
  if (!hasToUnicode && !winAnsi) limitations.push('The font does not expose a readable ToUnicode character map.')
  if (!embedded) limitations.push('The font program is not embedded; the viewer font substitute may affect visual matching.')
  if (isSubset) limitations.push('This is a subset font; only characters present in the embedded subset can be reused.')

  return {
    id: String(fontObject.objectNumber) + ':' + resourceName,
    resourceName,
    fontObjectNumber: fontObject.objectNumber,
    descendantFontObjectNumber: descendant?.objectNumber ?? null,
    descriptorObjectNumber: descriptor?.objectNumber ?? null,
    baseFontName,
    descriptorFontName,
    fontFamily,
    subtype,
    encoding,
    fontFlags: flags,
    fontWeight: weightValue || (bold ? 700 : 400),
    fontStyle: italic ? 'italic' : 'normal',
    isBold: bold,
    isItalic: italic,
    isSubset,
    isEmbedded: embedded,
    embeddedFontProgram: fontFileMatch?.[1] || null,
    hasToUnicode,
    unicodeMapEntries,
    supportedCharacterCount: supportedCharacters.length,
    supportedCharacters,
    widthMetricCount: metrics.widths.size,
    defaultWidth: metrics.defaultWidth,
    canNativeReplace,
    canPreserveEmbeddedFont: embedded && canNativeReplace,
    limitations,
  }
}

async function parseFontMaps(index, resourcesDictionary) {
  const fontDictionaryStart = resourcesDictionary.indexOf('/Font')
  if (fontDictionaryStart < 0) return new Map()
  const open = resourcesDictionary.indexOf('<<', fontDictionaryStart)
  if (open < 0) return new Map()
  const end = findDictionaryEnd(resourcesDictionary, open)
  const fontDictionary = resourcesDictionary.slice(open, end)
  const fonts = new Map()

  for (const match of fontDictionary.matchAll(/\/([A-Za-z0-9_.+-]+)\s+(\d+)\s+\d+\s+R/g)) {
    const resourceName = match[1]
    const fontObject = getPdfObject(index, Number(match[2]))
    const fontObjectDictionary = fontObject.dictionary || ''
    const toUnicodeRef = fontObjectDictionary.match(/\/ToUnicode\s+(\d+)\s+\d+\s+R/)
    const encoding = fontObjectDictionary.match(/\/Encoding\s*\/([^\s/<>()]+)/)?.[1] || 'Custom/Unknown'
    const identityH = encoding === 'Identity-H'
    const winAnsi = encoding === 'WinAnsiEncoding'
    let mapping = { codeToUnicode: new Map(), unicodeToCode: new Map() }
    if (toUnicodeRef) {
      const cmapObject = getPdfObject(index, Number(toUnicodeRef[1]))
      if (cmapObject.stream) {
        const cmapBytes = await decodePdfStream(cmapObject.stream, cmapObject.dictionary || '')
        mapping = parseToUnicodeCMap(latin1(cmapBytes))
      }
    }
    if (winAnsi && mapping.unicodeToCode.size === 0) mapping = createWinAnsiMapping()
    const metrics = identityH
      ? parseCidWidths(index, fontObjectDictionary)
      : winAnsi
        ? parseSimpleFontWidths(index, fontObjectDictionary)
        : { widths: new Map(), defaultWidth: 1000, supportedCodes: null }
    const metadata = readFontMetadata(index, resourceName, fontObject, mapping, metrics, identityH)
    fonts.set(resourceName, {
      ...mapping,
      ...metrics,
      fontObjectNumber: fontObject.objectNumber,
      encoding,
      isComposite: identityH,
      codeBytes: identityH ? 2 : 1,
      metadata,
    })
  }
  return fonts
}

function readLiteralString(source, start) {
  let index = start + 1
  let depth = 1
  const bytes = []
  while (index < source.length && depth > 0) {
    const char = source[index]
    if (char === '\\') {
      index += 1
      if (index >= source.length) break
      const escaped = source[index]
      const simple = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 }
      if (Object.hasOwn(simple, escaped)) bytes.push(simple[escaped])
      else if (/[0-7]/.test(escaped)) {
        let octal = escaped
        for (let count = 0; count < 2 && /[0-7]/.test(source[index + 1] || ''); count += 1) octal += source[++index]
        bytes.push(Number.parseInt(octal, 8) & 0xff)
      } else if (escaped === '\r' || escaped === '\n') {
        if (escaped === '\r' && source[index + 1] === '\n') index += 1
      } else bytes.push(escaped.charCodeAt(0) & 0xff)
      index += 1
      continue
    }
    if (char === '(') {
      depth += 1
      bytes.push(40)
      index += 1
      continue
    }
    if (char === ')') {
      depth -= 1
      index += 1
      if (depth > 0) bytes.push(41)
      continue
    }
    bytes.push(char.charCodeAt(0) & 0xff)
    index += 1
  }
  if (depth !== 0) throw new Error('Malformed PDF text string.')
  return { type: 'string', start, end: index, bytes: Uint8Array.from(bytes) }
}

function tokenizeContent(bytes) {
  const source = latin1(bytes)
  const tokens = []
  let index = 0
  const delimiters = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%'])

  while (index < source.length) {
    const char = source[index]
    if (/\s/.test(char)) { index += 1; continue }
    if (char === '%') {
      while (index < source.length && source[index] !== '\n' && source[index] !== '\r') index += 1
      continue
    }
    if (char === '(') {
      const token = readLiteralString(source, index)
      tokens.push(token)
      index = token.end
      continue
    }
    if (char === '<' && source[index + 1] !== '<') {
      const end = source.indexOf('>', index + 1)
      if (end < 0) throw new Error('Malformed PDF hexadecimal string.')
      const hex = source.slice(index + 1, end).replace(/\s+/g, '')
      const padded = hex.length % 2 ? `${hex}0` : hex
      const data = new Uint8Array(padded.length / 2)
      for (let offset = 0; offset < padded.length; offset += 2) data[offset / 2] = Number.parseInt(padded.slice(offset, offset + 2), 16)
      tokens.push({ type: 'hex', start: index, end: end + 1, bytes: data })
      index = end + 1
      continue
    }
    if (char === '[') { tokens.push({ type: 'arrayStart', start: index, end: index + 1 }); index += 1; continue }
    if (char === ']') { tokens.push({ type: 'arrayEnd', start: index, end: index + 1 }); index += 1; continue }
    if (char === '<' && source[index + 1] === '<') {
      const end = findDictionaryEnd(source, index)
      tokens.push({ type: 'composite', start: index, end })
      index = end
      continue
    }
    if (char === '/' ) {
      const start = index++
      while (index < source.length && !/\s/.test(source[index]) && !delimiters.has(source[index])) index += 1
      tokens.push({ type: 'name', value: source.slice(start + 1, index), start, end: index })
      continue
    }

    const start = index
    while (index < source.length && !/\s/.test(source[index]) && !delimiters.has(source[index])) index += 1
    if (index === start) { index += 1; continue }
    const value = source.slice(start, index)
    tokens.push({ type: /^[-+]?\d*\.?\d+$/.test(value) ? 'number' : 'word', value, start, end: index })
  }
  return tokens
}

function decodeFontText(bytes, font) {
  if (font.isComposite && bytes.length % 2 !== 0) return ''
  let output = ''
  for (const code of fontCodeUnits(bytes, font)) output += font.codeToUnicode.get(code) ?? '\uFFFD'
  return output
}

function extractFontResourceDictionary(pageDictionary, index) {
  const direct = pageDictionary.match(/\/Resources\s*(<<)/)
  if (direct) {
    const start = pageDictionary.indexOf('<<', direct.index)
    const end = findDictionaryEnd(pageDictionary, start)
    return pageDictionary.slice(start, end)
  }
  const resourceRef = pageDictionary.match(/\/Resources\s+(\d+)\s+\d+\s+R/)
  if (resourceRef) return getPdfObject(index, Number(resourceRef[1])).dictionary || ''
  return ''
}

function pageContentRefs(pageDictionary) {
  const contents = pageDictionary.match(/\/Contents\s+(\d+)\s+\d+\s+R/)
  if (contents) return [Number(contents[1])]
  const array = pageDictionary.match(/\/Contents\s*\[([\s\S]*?)\]/)
  if (array) return extractReferences(array[1]).map((reference) => reference.objectNumber)
  return []
}

function previousNumericOperands(tokens, operatorIndex, count) {
  const values = []
  for (let cursor = operatorIndex - 1; cursor >= 0 && values.length < count; cursor -= 1) {
    if (tokens[cursor].type !== 'number') break
    values.unshift(Number(tokens[cursor].value))
  }
  return values.length === count ? values : null
}

function colorChannel(value) {
  return Math.max(0, Math.min(255, Math.round(Number(value) * 255)))
}

function toHexColor(red, green, blue) {
  return '#' + [red, green, blue].map((value) => colorChannel(value).toString(16).padStart(2, '0')).join('').toUpperCase()
}

function readPdfColor(tokens, operatorIndex, operator) {
  if (operator === 'g' || operator === 'G') {
    const [gray] = previousNumericOperands(tokens, operatorIndex, 1) || []
    return Number.isFinite(gray) ? toHexColor(gray, gray, gray) : null
  }
  if (operator === 'rg' || operator === 'RG') {
    const components = previousNumericOperands(tokens, operatorIndex, 3)
    return components ? toHexColor(...components) : null
  }
  if (operator === 'k' || operator === 'K') {
    const components = previousNumericOperands(tokens, operatorIndex, 4)
    if (!components) return null
    const [cyan, magenta, yellow, black] = components
    return toHexColor(1 - Math.min(1, cyan + black), 1 - Math.min(1, magenta + black), 1 - Math.min(1, yellow + black))
  }
  return null
}

function advanceTextMatrix(matrix, advancePoints) {
  const next = [...matrix]
  next[4] += advancePoints * matrix[0]
  next[5] += advancePoints * matrix[1]
  return next
}

function updateTextPosition(tokens, tokenIndex, state) {
  const operator = tokens[tokenIndex]?.value
  if (operator === 'BT') {
    state.textMatrix = [1, 0, 0, 1, 0, 0]
    state.textLineMatrix = [...state.textMatrix]
    return
  }
  if (operator === 'Tm') {
    const values = previousNumericOperands(tokens, tokenIndex, 6)
    if (values) {
      state.textMatrix = values
      state.textLineMatrix = [...values]
    }
    return
  }
  if (operator === 'Td' || operator === 'TD') {
    const values = previousNumericOperands(tokens, tokenIndex, 2)
    if (!values) return
    const [tx, ty] = values
    if (operator === 'TD') state.leading = -ty
    const [a, b, c, d, x, y] = state.textLineMatrix
    state.textLineMatrix = [a, b, c, d, x + tx * a + ty * c, y + tx * b + ty * d]
    state.textMatrix = [...state.textLineMatrix]
    return
  }
  if (operator === 'T*') {
    const [a, b, c, d, x, y] = state.textLineMatrix
    state.textLineMatrix = [a, b, c, d, x - state.leading * c, y - state.leading * d]
    state.textMatrix = [...state.textLineMatrix]
  }
}

function summarizeFontMetadata(fonts) {
  return [...fonts.values()].map((font) => font.metadata)
}

export async function inspectNativePdfText(bytes) {
  const index = await createPdfIndex(bytes)
  const pages = getPageObjects(index)
  const runs = []
  const fontRecords = new Map()

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const page = pages[pageIndex]
    const resources = extractFontResourceDictionary(page.dictionary, index)
    const fonts = await parseFontMaps(index, resources)
    for (const metadata of summarizeFontMetadata(fonts)) {
      const fontKey = metadata.id
      const existingFont = fontRecords.get(fontKey)
      if (existingFont) {
        if (!existingFont.pageIndices.includes(pageIndex)) existingFont.pageIndices.push(pageIndex)
        if (!existingFont.pageNumbers.includes(pageIndex + 1)) existingFont.pageNumbers.push(pageIndex + 1)
      } else {
        fontRecords.set(fontKey, { ...metadata, pageIndices: [pageIndex], pageNumbers: [pageIndex + 1] })
      }
    }
    const contentRefs = pageContentRefs(page.dictionary)

    for (const streamObjectNumber of contentRefs) {
      const streamObject = getPdfObject(index, streamObjectNumber)
      if (!streamObject.stream) continue
      const decoded = /\/FlateDecode/.test(streamObject.dictionary || '') ? await inflate(streamObject.stream) : streamObject.stream
      const tokens = tokenizeContent(decoded)
      const state = {
        activeFont: '', fontSize: 0, characterSpacing: 0, wordSpacing: 0,
        horizontalScaling: 100, leading: 0, textRise: 0, textRenderingMode: 0,
        fillColor: '#000000', strokeColor: '#000000',
        textMatrix: [1, 0, 0, 1, 0, 0], textLineMatrix: [1, 0, 0, 1, 0, 0],
      }

      for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
        const token = tokens[tokenIndex]
        if (token.type !== 'word') continue
        const operator = token.value
        if (operator === 'BT' || operator === 'Tm' || operator === 'Td' || operator === 'TD' || operator === 'T*') {
          updateTextPosition(tokens, tokenIndex, state)
          continue
        }
        if (operator === 'Tf') {
          const possibleName = tokens[tokenIndex - 2]
          if (possibleName?.type === 'name') state.activeFont = possibleName.value
          state.fontSize = Number(tokens[tokenIndex - 1]?.value) || state.fontSize
          continue
        }
        if (['Tc', 'Tw', 'Tz', 'TL', 'Ts', 'Tr'].includes(operator)) {
          const value = Number(tokens[tokenIndex - 1]?.value)
          if (Number.isFinite(value)) {
            if (operator === 'Tc') state.characterSpacing = value
            if (operator === 'Tw') state.wordSpacing = value
            if (operator === 'Tz') state.horizontalScaling = value
            if (operator === 'TL') state.leading = value
            if (operator === 'Ts') state.textRise = value
            if (operator === 'Tr') state.textRenderingMode = value
          }
          continue
        }
        if (['rg', 'g', 'k'].includes(operator)) {
          state.fillColor = readPdfColor(tokens, tokenIndex, operator) || state.fillColor
          continue
        }
        if (['RG', 'G', 'K'].includes(operator)) {
          state.strokeColor = readPdfColor(tokens, tokenIndex, operator) || state.strokeColor
          continue
        }

        const font = fonts.get(state.activeFont)
        if (!font?.metadata?.canNativeReplace) continue
        const common = {
          pageIndex, pageNumber: pageIndex + 1, streamObjectNumber,
          fontResource: state.activeFont, fontObjectNumber: font.fontObjectNumber,
          fontInfoId: String(pageIndex) + ':' + font.metadata.id,
          fontMetadata: font.metadata,
          fontSize: state.fontSize, characterSpacing: state.characterSpacing,
          wordSpacing: state.wordSpacing, horizontalScaling: state.horizontalScaling,
          textRise: state.textRise, textRenderingMode: state.textRenderingMode,
          fillColor: state.fillColor, strokeColor: state.strokeColor,
          textMatrix: [...state.textMatrix],
          position: { x: state.textMatrix[4], y: state.textMatrix[5] + state.textRise },
          fontEncoding: font.encoding, supportedCharacters: [...font.unicodeToCode.keys()],
        }

        if (operator === 'Tj') {
          const stringToken = tokens[tokenIndex - 1]
          if (stringToken?.type !== 'string' && stringToken?.type !== 'hex') continue
          const text = decodeFontText(stringToken.bytes, font)
          if (!text || text.includes('\uFFFD')) continue
          const originalCodes = fontCodeUnits(stringToken.bytes, font)
          const glyphWidth1000 = originalCodes.reduce((sum, code) => sum + (font.widths.get(code) ?? font.defaultWidth), 0)
          const spaceCount = [...text].filter((character) => character === ' ').length
          const spacingAdvance1000 = state.fontSize > 0 ? ((state.characterSpacing * originalCodes.length + state.wordSpacing * spaceCount) * 1000) / state.fontSize : 0
          const run = {
            ...common,
            key: String(pageIndex) + ':' + streamObjectNumber + ':' + stringToken.start + ':' + stringToken.end,
            originalText: text, tokenType: 'Tj', start: stringToken.start, end: token.end,
            glyphWidth1000, originalAdvance1000: glyphWidth1000 + spacingAdvance1000,
          }
          runs.push(run)
          const advancePoints = ((run.originalAdvance1000 * state.fontSize) / 1000) * (state.horizontalScaling / 100)
          state.textMatrix = advanceTextMatrix(state.textMatrix, advancePoints)
          continue
        }

        if (operator === 'TJ') {
          const arrayEnd = tokens[tokenIndex - 1]
          if (arrayEnd?.type !== 'arrayEnd') continue
          let depth = 0
          let arrayStartIndex = -1
          for (let cursor = tokenIndex - 1; cursor >= 0; cursor -= 1) {
            if (tokens[cursor].type === 'arrayEnd') depth += 1
            else if (tokens[cursor].type === 'arrayStart') {
              depth -= 1
              if (depth === 0) { arrayStartIndex = cursor; break }
            }
          }
          if (arrayStartIndex < 0) continue
          const inner = tokens.slice(arrayStartIndex + 1, tokenIndex - 1)
          const stringTokens = inner.filter((item) => item.type === 'string' || item.type === 'hex')
          const text = stringTokens.map((item) => decodeFontText(item.bytes, font)).join('')
          if (!text || text.includes('\uFFFD')) continue
          const originalGlyphWidth1000 = stringTokens.flatMap((item) => fontCodeUnits(item.bytes, font)).reduce((sum, code) => sum + (font.widths.get(code) ?? font.defaultWidth), 0)
          const kerningAdjustment1000 = inner.filter((item) => item.type === 'number').reduce((sum, item) => sum + Number(item.value), 0)
          const glyphCount = stringTokens.reduce((sum, item) => sum + fontCodeUnits(item.bytes, font).length, 0)
          const spaceCount = [...text].filter((character) => character === ' ').length
          const spacingAdvance1000 = state.fontSize > 0 ? ((state.characterSpacing * glyphCount + state.wordSpacing * spaceCount) * 1000) / state.fontSize : 0
          const run = {
            ...common,
            key: String(pageIndex) + ':' + streamObjectNumber + ':' + tokens[arrayStartIndex].start + ':' + arrayEnd.end,
            originalText: text, tokenType: 'TJ', start: tokens[arrayStartIndex].start, end: arrayEnd.end,
            stringCount: stringTokens.length,
            hasKerningAdjustments: inner.some((item) => item.type === 'number'),
            originalGlyphWidth1000, kerningAdjustment1000, spacingAdvance1000,
            originalAdvance1000: originalGlyphWidth1000 - kerningAdjustment1000 + spacingAdvance1000,
          }
          runs.push(run)
          const advancePoints = ((run.originalAdvance1000 * state.fontSize) / 1000) * (state.horizontalScaling / 100)
          state.textMatrix = advanceTextMatrix(state.textMatrix, advancePoints)
        }
      }
    }
  }

  return { runs, fonts: [...fontRecords.values()], pageCount: pages.length, sourceBytes: bytes.slice() }
}
function encodeTextForFont(text, font) {
  const codes = []
  const allowed = font.metadata?.supportedCharacters ? new Set(font.metadata.supportedCharacters.map((character) => font.unicodeToCode.get(character))) : null
  for (const character of text) {
    const code = font.unicodeToCode.get(character)
    if (code === undefined || (allowed && !allowed.has(code))) {
      const label = character === ' ' ? 'space' : character
      throw new Error('The selected font subset does not contain the character “' + label + '”. No replacement was applied; no overlay text was created.')
    }
    if (font.isComposite) {
      if (code > 0xffff) throw new Error('This PDF font uses a code outside the supported 2-byte Identity-H range.')
    } else if (code < 0 || code > 0xff) {
      throw new Error('The selected simple PDF font cannot encode character “' + character + '” in its one-byte encoding.')
    }
    if (!font.isComposite && font.metadata?.isEmbedded && font.supportedCodes && !font.supportedCodes.has(code)) {
      throw new Error('The embedded font subset does not contain the glyph for “' + character + '”. No replacement was applied.')
    }
    codes.push(code)
  }
  if (!codes.length) throw new Error('Replacement text cannot be empty.')
  const hex = codes.map((code) => code.toString(16).padStart(font.isComposite ? 4 : 2, '0')).join('').toUpperCase()
  return '<' + hex + '>'
}

async function appendIncrementalStreamRevision(bytes, index, objectNumber, newDictionary, newStream) {
  const originalSize = Number(index.trailer.match(/\/Size\s+(\d+)/)?.[1])
  if (!Number.isInteger(originalSize)) throw new Error('PDF trailer Size value is missing.')
  const entry = index.entries.get(objectNumber)
  if (!entry) throw new Error('Original page content stream could not be located.')

  const prefix = bytes.length && bytes[bytes.length - 1] !== 10 ? '\n' : ''
  const prefixBytes = latin1Bytes(prefix)
  const objectHeader = latin1Bytes(`${objectNumber} ${entry.generation} obj\n${newDictionary}\nstream\n`)
  const objectEnd = latin1Bytes('\nendstream\nendobj\n')
  const objectOffset = bytes.length + prefixBytes.length
  const xrefOffset = objectOffset + objectHeader.length + newStream.length + objectEnd.length
  const xrefEntry = `${String(objectOffset).padStart(10, '0')} ${String(entry.generation).padStart(5, '0')} n \n`
  const xref = latin1Bytes(`xref\n${objectNumber} 1\n${xrefEntry}`)

  const trailer = sanitizeTrailerForClassicXref(index.trailer, originalSize, index.latestXref)
  const trailerBytes = latin1Bytes(`trailer\n${trailer}\nstartxref\n${xrefOffset}\n%%EOF\n`)
  return concatBytes([bytes, prefixBytes, objectHeader, newStream, objectEnd, xref, trailerBytes])
}

export async function replaceNativePdfText(bytes, run, replacementText) {
  if (!run || !Number.isInteger(run.streamObjectNumber)) throw new Error('Select an existing PDF text line before replacing it.')
  if (!['Tj', 'TJ'].includes(run.tokenType)) throw new Error('This PDF text operator is not supported for native replacement.')

  const inspection = await inspectNativePdfText(bytes)
  const target = inspection.runs.find((item) => item.key === run.key)
  if (!target) throw new Error('The selected text run changed. Select it again before replacing.')

  const index = await createPdfIndex(bytes)
  const pages = getPageObjects(index)
  const page = pages[target.pageIndex]
  const fontResources = extractFontResourceDictionary(page.dictionary, index)
  const fonts = await parseFontMaps(index, fontResources)
  const font = fonts.get(target.fontResource)
  if (!font) throw new Error('The selected PDF font encoding could not be read.')
  if (replacementText === target.originalText) throw new Error('The replacement text is identical to the original text. Make a change before replacing it.')
  const replacementToken = encodeTextForFont(replacementText, font)
  const replacementCodes = [...replacementText].map((character) => font.unicodeToCode.get(character))
  if (replacementCodes.some((code) => code === undefined)) throw new Error('Replacement text contains characters that this PDF font cannot encode.')
  const replacementGlyphWidth1000 = replacementCodes.reduce((sum, code) => sum + (font.widths.get(code) ?? font.defaultWidth), 0)
  const spaceCount = [...replacementText].filter((character) => character === ' ').length
  const spacingAdvance1000 = target.fontSize > 0 ? ((target.characterSpacing * replacementCodes.length + target.wordSpacing * spaceCount) * 1000) / target.fontSize : 0
  const adjustment = replacementGlyphWidth1000 + spacingAdvance1000 - target.originalAdvance1000
  const adjustmentToken = Math.abs(adjustment) > 0.0001 ? ` ${pdfNumber(adjustment)}` : ''
  // A Tj string is promoted to a TJ array so a final numeric adjustment can
  // preserve the original text advance without changing its font or text state.
  const nativeOperand = target.tokenType === 'TJ'
    ? `[${replacementToken}${adjustmentToken}]`
    : `[${replacementToken}${adjustmentToken}] TJ`

  const contentObject = getPdfObject(index, target.streamObjectNumber)
  if (!contentObject.stream) throw new Error('Selected text stream could not be read.')
  const decoded = /\/FlateDecode/.test(contentObject.dictionary || '') ? await inflate(contentObject.stream) : contentObject.stream
  const source = latin1(decoded)
  const updatedContent = latin1Bytes(`${source.slice(0, target.start)}${nativeOperand}${source.slice(target.end)}`)
  const compressed = /\/FlateDecode/.test(contentObject.dictionary || '') ? await deflate(updatedContent) : updatedContent
  const lengthUpdatedDictionary = contentObject.dictionary.replace(/\/Length(?!\d)\s+\d+/, `/Length ${compressed.length}`)
  if (lengthUpdatedDictionary === contentObject.dictionary && !/\/Length(?!\d)\s+\d+/.test(contentObject.dictionary)) {
    throw new Error('The PDF stream length could not be updated safely.')
  }

  const nextBytes = await appendIncrementalStreamRevision(bytes, index, target.streamObjectNumber, lengthUpdatedDictionary, compressed)
  const verify = await inspectNativePdfText(nextBytes)
  const matchingRun = verify.runs.find((item) => item.pageIndex === target.pageIndex && item.streamObjectNumber === target.streamObjectNumber && item.start === target.start)
  if (!matchingRun || matchingRun.originalText !== replacementText) {
    throw new Error('The native PDF replacement could not be verified at the selected text position. The original document has not been changed in the editor.')
  }
  return { bytes: nextBytes, run: matchingRun, originalText: target.originalText, replacementText }
}

