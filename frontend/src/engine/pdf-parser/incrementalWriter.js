import { concatBytes, latin1Bytes, PdfDict, PdfName, serializePdfValue } from './pdfSyntax.js'

function groupContiguous(numbers) {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b)
  const groups = []
  for (const number of sorted) {
    const last = groups.at(-1)
    if (last && last.first + last.count === number) last.count += 1
    else groups.push({ first: number, count: 1 })
  }
  return groups
}

function writeUInt(target, offset, value, width) {
  let remaining = value
  for (let index = width - 1; index >= 0; index -= 1) {
    target[offset + index] = remaining % 256
    remaining = Math.floor(remaining / 256)
  }
}

/**
 * Append an incremental update containing new or replaced objects.
 * `objects` is a list of { num, gen, value, stream? } where `stream` holds the
 * already-encoded stream bytes (the dictionary must describe them).
 * The xref section is written in the same style as the file's latest section.
 * Files that needed xref repair receive a complete xref stream instead.
 */
export function writeIncrementalUpdate(index, objects) {
  const base = index.bytes
  const parts = [base]
  let length = base.length
  if (base.length && base[base.length - 1] !== 0x0a && base[base.length - 1] !== 0x0d) {
    parts.push(latin1Bytes('\n'))
    length += 1
  }
  const offsets = new Map()
  for (const object of objects) {
    offsets.set(object.num, { offset: length, gen: object.gen ?? 0 })
    const header = latin1Bytes(`${object.num} ${object.gen ?? 0} obj\n${serializePdfValue(object.value)}\n`)
    parts.push(header)
    length += header.length
    if (object.stream) {
      const open = latin1Bytes('stream\n')
      const close = latin1Bytes('\nendstream\n')
      parts.push(open, object.stream, close)
      length += open.length + object.stream.length + close.length
    }
    const end = latin1Bytes('endobj\n')
    parts.push(end)
    length += end.length
  }

  const maxNumber = Math.max(index.size - 1, ...objects.map((object) => object.num))
  const trailerSource = index.trailer
  const copyTrailerKeys = (target) => {
    for (const key of ['Root', 'Info', 'ID']) if (trailerSource.has(key)) target.set(key, trailerSource.get(key))
  }

  if (index.latestXrefIsStream || index.repaired) {
    const xrefNumber = maxNumber + 1
    const size = xrefNumber + 1
    const entryMap = new Map()
    if (index.repaired) {
      for (const [number, entry] of index.entries) {
        if (entry.type === 1) entryMap.set(number, [1, entry.offset, entry.generation ?? 0])
        else if (entry.type === 2) {
          const objects = index.objectStreams.get(entry.objectStreamNumber)
          const position = entry.objectStreamIndex >= 0 ? entry.objectStreamIndex : [...(objects?.keys() || [])].indexOf(number)
          if (position >= 0) entryMap.set(number, [2, entry.objectStreamNumber, position])
        }
      }
      entryMap.set(0, [0, 0, 65535])
    }
    for (const [number, { offset, gen }] of offsets) entryMap.set(number, [1, offset, gen])
    entryMap.set(xrefNumber, [1, length, 0])
    const numbers = [...entryMap.keys()]
    const groups = groupContiguous(numbers)
    const widths = [1, 4, 2]
    const recordWidth = 7
    const data = new Uint8Array(numbers.length * recordWidth)
    let cursor = 0
    for (const group of groups) {
      for (let number = group.first; number < group.first + group.count; number += 1) {
        const [type, field1, field2] = entryMap.get(number)
        writeUInt(data, cursor, type, 1)
        writeUInt(data, cursor + 1, field1, 4)
        writeUInt(data, cursor + 5, Math.min(field2, 65535), 2)
        cursor += recordWidth
      }
    }
    const dict = new PdfDict()
    dict.set('Type', new PdfName('XRef'))
    dict.set('Size', size)
    copyTrailerKeys(dict)
    if (!index.repaired) dict.set('Prev', index.latestXref)
    dict.set('W', widths)
    dict.set('Index', groups.flatMap((group) => [group.first, group.count]))
    dict.set('Length', data.length)
    const head = latin1Bytes(`${xrefNumber} 0 obj\n${serializePdfValue(dict)}\nstream\n`)
    const tail = latin1Bytes(`\nendstream\nendobj\nstartxref\n${length}\n%%EOF\n`)
    parts.push(head, data, tail)
    return concatBytes(parts)
  }

  const xrefOffset = length
  const groups = groupContiguous([...offsets.keys()])
  let xref = 'xref\n'
  for (const group of groups) {
    xref += `${group.first} ${group.count}\n`
    for (let number = group.first; number < group.first + group.count; number += 1) {
      const { offset, gen } = offsets.get(number)
      xref += `${String(offset).padStart(10, '0')} ${String(gen).padStart(5, '0')} n\r\n`
    }
  }
  const trailer = new PdfDict()
  trailer.set('Size', maxNumber + 1)
  copyTrailerKeys(trailer)
  trailer.set('Prev', index.latestXref)
  xref += `trailer\n${serializePdfValue(trailer)}\nstartxref\n${xrefOffset}\n%%EOF\n`
  parts.push(latin1Bytes(xref))
  return concatBytes(parts)
}
