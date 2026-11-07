import { latin1, parsePdfValue, PdfDict, PdfName, PdfRef, skipWhitespace } from './pdfSyntax.js'
import { decodeStreamData } from './pdfStreams.js'

const OBJECT_HEADER = /^(\d+)\s+(\d+)\s+obj\b/

export class PdfEncryptedError extends Error {
  constructor() {
    super('This PDF is encrypted. Unlock or decrypt it before editing its text.')
    this.code = 'PDF_ENCRYPTED'
  }
}

/**
 * Random-access view over a PDF file: cross-reference sections (classic and
 * stream), compressed object streams, broken-xref reconstruction, page tree and
 * inherited page attributes.
 */
export class PdfDocumentIndex {
  constructor(bytes) {
    this.bytes = bytes
    this.source = latin1(bytes)
    this.entries = new Map()
    this.trailer = new PdfDict()
    this.latestXref = 0
    this.latestXrefIsStream = false
    this.objectCache = new Map()
    this.objectStreams = new Map()
    this.reconstructed = null
    this.headerOffset = Math.max(0, this.source.indexOf('%PDF-'))
    this.repaired = false
  }

  static async open(bytes) {
    const index = new PdfDocumentIndex(bytes)
    await index.load()
    return index
  }

  async load() {
    try {
      await this.loadXrefChain()
    } catch {
      this.repaired = true
      this.entries = new Map()
      this.trailer = new PdfDict()
    }
    if (!this.trailer.get('Root') || this.entries.size === 0) {
      this.repaired = true
      await this.reconstruct()
    }
    if (this.trailer.has('Encrypt')) throw new PdfEncryptedError()
    const objectStreamNumbers = new Set([...this.entries.values()].filter((entry) => entry.type === 2).map((entry) => entry.objectStreamNumber))
    for (const number of objectStreamNumbers) await this.loadObjectStream(number)
    if (!this.getRootDict()) {
      if (!this.repaired) {
        this.repaired = true
        await this.reconstruct()
      }
      if (!this.getRootDict()) throw new Error('The PDF catalog could not be found.')
    }
  }

  get size() {
    const declared = this.trailer.get('Size')
    let max = 0
    for (const number of this.entries.keys()) if (number > max) max = number
    if (this.reconstructed) for (const number of this.reconstructed.keys()) if (number > max) max = number
    return Math.max(typeof declared === 'number' ? declared : 0, max + 1)
  }

  async loadXrefChain() {
    const matches = [...this.source.matchAll(/startxref\s+(\d+)/g)]
    if (!matches.length) throw new Error('startxref not found')
    let offset = Number(matches.at(-1)[1])
    if (offset === 0 && matches.length > 1) offset = Number(matches.at(-2)[1])
    const visited = new Set()
    let first = true
    while (Number.isInteger(offset) && offset >= 0) {
      if (visited.has(offset) || visited.size > 128) break
      visited.add(offset)
      const section = await this.parseXrefSection(offset)
      if (first) {
        this.trailer = section.trailer
        this.latestXref = section.offset
        this.latestXrefIsStream = section.isStream
        first = false
      }
      for (const [number, entry] of section.entries) {
        if (!this.entries.has(number)) this.entries.set(number, entry)
      }
      const previous = section.trailer.get('Prev')
      if (typeof previous !== 'number') break
      offset = previous
    }
  }

  locate(offset, keyword) {
    const candidates = [offset, offset + this.headerOffset]
    for (const candidate of candidates) {
      const position = skipWhitespace(this.source, candidate)
      if (keyword ? this.source.startsWith(keyword, position) : OBJECT_HEADER.test(this.source.slice(position, position + 32))) return position
    }
    // Search a small window around the declared offset (off-by-a-few files are common).
    const windowStart = Math.max(0, offset - 64)
    const windowText = this.source.slice(windowStart, offset + 256)
    const local = keyword ? windowText.indexOf(keyword) : windowText.search(/\d+\s+\d+\s+obj\b/)
    return local >= 0 ? windowStart + local : -1
  }

  async parseXrefSection(declaredOffset) {
    const classicOffset = this.locate(declaredOffset, 'xref')
    if (classicOffset >= 0 && this.source.startsWith('xref', classicOffset)) {
      const classic = this.parseClassicXref(classicOffset)
      const streamOffset = classic.trailer.get('XRefStm')
      if (typeof streamOffset === 'number') {
        try {
          const supplemental = await this.parseXrefStream(streamOffset)
          for (const [number, entry] of supplemental.entries) {
            if (!classic.entries.has(number) || entry.type === 2) classic.entries.set(number, entry)
          }
        } catch {
          // A broken hybrid section does not invalidate the classic table.
        }
      }
      return { ...classic, offset: declaredOffset, isStream: false }
    }
    const stream = await this.parseXrefStream(declaredOffset)
    return { ...stream, offset: declaredOffset, isStream: true }
  }

  parseClassicXref(offset) {
    const trailerPosition = this.source.indexOf('trailer', offset)
    if (trailerPosition < 0) throw new Error('xref trailer missing')
    const tokens = this.source.slice(offset + 4, trailerPosition).match(/\S+/g) || []
    const entries = new Map()
    let cursor = 0
    while (cursor < tokens.length) {
      const first = Number(tokens[cursor])
      const count = Number(tokens[cursor + 1])
      if (!Number.isInteger(first) || !Number.isInteger(count) || count < 0) break
      cursor += 2
      for (let item = 0; item < count && cursor + 2 < tokens.length + 1; item += 1) {
        const byteOffset = Number(tokens[cursor])
        const generation = Number(tokens[cursor + 1])
        const flag = tokens[cursor + 2]
        cursor += 3
        if (!Number.isInteger(byteOffset) || !Number.isInteger(generation)) continue
        // Some writers number the first section from 1 instead of 0; tolerate it.
        entries.set(first + item, flag === 'n' ? { type: 1, offset: byteOffset, generation } : { type: 0, generation })
      }
    }
    const { value: trailer } = parsePdfValue(this.source, trailerPosition + 7)
    if (!(trailer instanceof PdfDict)) throw new Error('xref trailer is not a dictionary')
    return { entries, trailer }
  }

  async parseXrefStream(declaredOffset) {
    const position = this.locate(declaredOffset, null)
    if (position < 0) throw new Error('xref stream not found')
    const object = this.readObjectAt(position)
    const dict = object.value
    if (!(dict instanceof PdfDict) || dict.getName('Type') !== 'XRef' || !object.stream) throw new Error('not an xref stream')
    const widths = dict.get('W')
    if (!Array.isArray(widths) || widths.length !== 3) throw new Error('invalid xref W')
    const recordWidth = widths.reduce((sum, width) => sum + width, 0)
    const size = dict.get('Size')
    const ranges = Array.isArray(dict.get('Index')) ? dict.get('Index') : [0, size]
    const data = await decodeStreamData(object.stream, dict, (value) => this.resolve(value))
    const entries = new Map()
    let cursor = 0
    for (let rangeIndex = 0; rangeIndex + 1 < ranges.length; rangeIndex += 2) {
      const firstObject = ranges[rangeIndex]
      const count = ranges[rangeIndex + 1]
      for (let item = 0; item < count; item += 1) {
        if (cursor + recordWidth > data.length) break
        const fields = widths.map((width) => {
          let value = 0
          for (let byte = 0; byte < width; byte += 1) value = value * 256 + data[cursor++]
          return value
        })
        const type = widths[0] === 0 ? 1 : fields[0]
        const number = firstObject + item
        if (type === 0) entries.set(number, { type: 0, generation: fields[2] })
        else if (type === 1) entries.set(number, { type: 1, offset: fields[1], generation: fields[2] })
        else if (type === 2) entries.set(number, { type: 2, objectStreamNumber: fields[1], objectStreamIndex: fields[2], generation: 0 })
      }
    }
    return { entries, trailer: dict }
  }

  async reconstruct() {
    const table = new Map()
    const pattern = /(?:^|[\r\n\s])(\d+)\s+(\d+)\s+obj\b/g
    for (const match of this.source.matchAll(pattern)) {
      const offset = match.index + match[0].indexOf(match[1])
      table.set(Number(match[1]), { type: 1, offset, generation: Number(match[2]) })
    }
    this.reconstructed = table
    for (const [number, entry] of table) {
      if (!this.entries.has(number) || this.entries.get(number).type === 0) this.entries.set(number, entry)
    }
    // Compressed objects that are not also stored directly.
    for (const [number, entry] of table) {
      if (!this.source.slice(entry.offset, entry.offset + 400).includes('/ObjStm')) continue
      try {
        const objects = await this.loadObjectStream(number)
        for (const objectNumber of objects.keys()) {
          if (!table.has(objectNumber)) this.entries.set(objectNumber, { type: 2, objectStreamNumber: number, objectStreamIndex: -1, generation: 0 })
        }
      } catch {
        // Ignore unreadable object streams during repair.
      }
    }
    if (!this.trailer.get('Root')) {
      let trailer = null
      for (const match of this.source.matchAll(/trailer\s*<</g)) {
        try {
          const { value } = parsePdfValue(this.source, match.index + 7)
          if (value instanceof PdfDict && value.get('Root')) trailer = value
        } catch {
          // keep searching
        }
      }
      if (!trailer) {
        for (const [number] of table) {
          const object = this.getObject(number)
          const dict = object?.value
          if (dict instanceof PdfDict && dict.getName('Type') === 'XRef' && dict.get('Root')) trailer = dict
          if (!trailer && dict instanceof PdfDict && dict.getName('Type') === 'Catalog') {
            trailer = new PdfDict([['Root', new PdfRef(number, object.gen)]])
          }
        }
      }
      if (trailer) this.trailer = trailer
    }
    this.objectCache.clear()
  }

  async loadObjectStream(number) {
    if (this.objectStreams.has(number)) return this.objectStreams.get(number)
    const objects = new Map()
    this.objectStreams.set(number, objects)
    try {
      const streamObject = this.getObject(number)
      const dict = streamObject?.value
      if (!(dict instanceof PdfDict) || !streamObject.stream) return objects
      const count = this.resolve(dict.get('N'))
      const first = this.resolve(dict.get('First'))
      const decoded = latin1(await decodeStreamData(streamObject.stream, dict, (value) => this.resolve(value)))
      const header = decoded.slice(0, first).trim().split(/\s+/).map(Number)
      for (let item = 0; item < count; item += 1) {
        const objectNumber = header[item * 2]
        const relative = header[item * 2 + 1]
        if (!Number.isInteger(objectNumber) || !Number.isInteger(relative)) continue
        try {
          const { value } = parsePdfValue(decoded, first + relative)
          objects.set(objectNumber, { num: objectNumber, gen: 0, value, stream: null, compressed: true })
        } catch {
          // skip unreadable compressed object
        }
      }
    } catch {
      // unreadable object stream
    }
    return objects
  }

  readObjectAt(position) {
    const header = this.source.slice(position, position + 40).match(OBJECT_HEADER)
    if (!header) throw new Error('object header not found')
    const num = Number(header[1])
    const gen = Number(header[2])
    const { value, end } = parsePdfValue(this.source, position + header[0].length)
    let stream = null
    let streamStart
    let streamEnd
    const after = skipWhitespace(this.source, end)
    if (value instanceof PdfDict && this.source.startsWith('stream', after)) {
      streamStart = after + 6
      if (this.source[streamStart] === '\r' && this.source[streamStart + 1] === '\n') streamStart += 2
      else if (this.source[streamStart] === '\n' || this.source[streamStart] === '\r') streamStart += 1
      let length = value.get('Length')
      if (length instanceof PdfRef) {
        try { length = this.getObject(length.num)?.value } catch { length = null }
      }
      const endMarkerOk = (candidate) => {
        const tail = this.source.slice(candidate, candidate + 24)
        return /^\s*endstream/.test(tail)
      }
      if (typeof length === 'number' && length >= 0 && streamStart + length <= this.source.length && endMarkerOk(streamStart + length)) {
        streamEnd = streamStart + length
      } else {
        const marker = this.source.indexOf('endstream', streamStart)
        if (marker < 0) throw new Error(`stream of object ${num} is not terminated`)
        streamEnd = marker
        if (this.source[streamEnd - 1] === '\n') streamEnd -= 1
        if (this.source[streamEnd - 1] === '\r') streamEnd -= 1
      }
      stream = this.bytes.slice(streamStart, streamEnd)
    }
    return { num, gen, value, stream, offset: position }
  }

  getObject(number) {
    if (this.objectCache.has(number)) return this.objectCache.get(number)
    const entry = this.entries.get(number)
    let object = null
    if (entry?.type === 1) {
      try {
        const position = this.locate(entry.offset, null)
        const candidate = position >= 0 ? this.readObjectAt(position) : null
        if (candidate && candidate.num === number) object = candidate
      } catch {
        object = null
      }
      if (!object) object = this.readFromReconstructed(number)
    } else if (entry?.type === 2) {
      object = this.objectStreams.get(entry.objectStreamNumber)?.get(number) || null
    } else if (!entry) {
      object = this.readFromReconstructed(number)
    }
    this.objectCache.set(number, object)
    return object
  }

  readFromReconstructed(number) {
    if (!this.reconstructed) {
      const table = new Map()
      for (const match of this.source.matchAll(/(?:^|[\r\n\s])(\d+)\s+(\d+)\s+obj\b/g)) {
        table.set(Number(match[1]), { type: 1, offset: match.index + match[0].indexOf(match[1]), generation: Number(match[2]) })
      }
      this.reconstructed = table
    }
    const entry = this.reconstructed.get(number)
    if (!entry) return null
    try {
      const object = this.readObjectAt(entry.offset)
      return object.num === number ? object : null
    } catch {
      return null
    }
  }

  /** Dereference a value (follows chains of references). */
  resolve(value, depth = 0) {
    if (!(value instanceof PdfRef)) return value
    if (depth > 16) return null
    const object = this.getObject(value.num)
    return object ? this.resolve(object.value, depth + 1) : null
  }

  getRootDict() {
    const root = this.resolve(this.trailer.get('Root'))
    return root instanceof PdfDict ? root : null
  }

  async getStreamBytes(objectNumber) {
    const object = this.getObject(objectNumber)
    if (!object?.stream || !(object.value instanceof PdfDict)) return null
    return decodeStreamData(object.stream, object.value, (value) => this.resolve(value))
  }

  getPages() {
    if (this.pagesCache) return this.pagesCache
    const root = this.getRootDict()
    const pages = []
    const visited = new Set()
    const inheritable = ['Resources', 'MediaBox', 'CropBox', 'Rotate']
    const visit = (reference, inherited) => {
      if (!(reference instanceof PdfRef) || visited.has(reference.num)) return
      visited.add(reference.num)
      const node = this.resolve(reference)
      if (!(node instanceof PdfDict)) return
      const nextInherited = { ...inherited }
      for (const key of inheritable) if (node.has(key)) nextInherited[key] = { value: node.get(key), owner: reference.num }
      const kids = this.resolve(node.get('Kids'))
      const type = node.getName('Type')
      if (type === 'Pages' || (Array.isArray(kids) && type !== 'Page')) {
        for (const kid of kids || []) visit(kid, nextInherited)
        return
      }
      pages.push({ num: reference.num, gen: reference.gen, dict: node, inherited: nextInherited })
    }
    visit(root?.get('Pages'), {})
    this.pagesCache = pages
    return pages
  }
}

export function asNumber(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function nameOf(value) {
  return value instanceof PdfName ? value.name : null
}
