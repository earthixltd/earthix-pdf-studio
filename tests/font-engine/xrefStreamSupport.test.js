import test from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { inspectNativePdfText, replaceNativePdfText } from '../../frontend/src/services/nativePdfTextEditor.js'

const ascii = (value) => Buffer.from(value, 'latin1')
const join = (parts) => Buffer.concat(parts.map((part) => Buffer.from(part)))

function encodeXrefEntry(type, fieldOne, fieldTwo, widths = [1, 4, 2]) {
  const fields = [type, fieldOne, fieldTwo]
  const result = Buffer.alloc(widths.reduce((sum, width) => sum + width, 0))
  let offset = 0

  fields.forEach((input, fieldIndex) => {
    let value = BigInt(input)
    const width = widths[fieldIndex]
    for (let index = width - 1; index >= 0; index -= 1) {
      result[offset + index] = Number(value & 0xffn)
      value >>= 8n
    }
    offset += width
  })

  return result
}

function createXrefStreamObjectStreamPdf({ widths = [1, 4, 2], leadingZeroStartXref = false } = {}) {
  const header = ascii('%PDF-1.5\n%\xE2\xE3\xCF\xD3\n')
  const firstSectionMarker = leadingZeroStartXref
    ? ascii('% Linearized first-section marker\nstartxref\n0\n%%EOF\n')
    : Buffer.alloc(0)
  const parts = [join([header, firstSectionMarker])]
  const offsets = new Map()
  const appendObject = (objectNumber, body) => {
    offsets.set(objectNumber, parts.reduce((sum, part) => sum + part.length, 0))
    parts.push(ascii(`${objectNumber} 0 obj\n${body}\nendobj\n`))
  }

  const catalog = '<< /Type /Catalog /Pages 2 0 R >>'
  const pageTree = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'
  const objectOffsets = [0, ascii(catalog).length + 1]
  const objectStreamHeader = `1 ${objectOffsets[0]} 2 ${objectOffsets[1]} `
  const objectStreamFirst = ascii(objectStreamHeader).length
  const objectStreamData = ascii(objectStreamHeader + catalog + '\n' + pageTree)
  const compressedObjectStream = deflateSync(objectStreamData)

  appendObject(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 6 0 R >> >> /Contents 4 0 R >>')
  const content = 'BT\n/F1 12 Tf\n1 0 0 1 72 720 Tm\n(Network) Tj\nET\n'
  appendObject(4, `<< /Length ${ascii(content).length} >>\nstream\n${content}endstream`)
  const simpleWidths = Array(95).fill(500).join(' ')
  appendObject(6, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /FirstChar 32 /LastChar 126 /Widths [${simpleWidths}] >>`)
  appendObject(7, `<< /Type /ObjStm /N 2 /First ${objectStreamFirst} /Length ${compressedObjectStream.length} /Filter /FlateDecode >>\nstream\n${compressedObjectStream.toString('latin1')}\nendstream`)

  const xrefOffset = parts.reduce((sum, part) => sum + part.length, 0)
  const freeGeneration = widths[2] === 1 ? 255 : 65535
  const entries = [
    encodeXrefEntry(0, 0, freeGeneration, widths),
    encodeXrefEntry(2, 7, 0, widths),
    encodeXrefEntry(2, 7, 1, widths),
    encodeXrefEntry(1, offsets.get(3), 0, widths),
    encodeXrefEntry(1, offsets.get(4), 0, widths),
    encodeXrefEntry(0, 0, 0, widths),
    encodeXrefEntry(1, offsets.get(6), 0, widths),
    encodeXrefEntry(1, offsets.get(7), 0, widths),
    encodeXrefEntry(1, xrefOffset, 0, widths),
  ]
  const recordWidth = widths.reduce((sum, width) => sum + width, 0)
  const predictedRows = entries.map((entry) => join([Buffer.from([0]), entry]))
  const compressedXref = deflateSync(join(predictedRows))
  appendObject(8, `<< /Type /XRef /Size 9 /Root 1 0 R /W [${widths.join(' ')}] /Index [0 9] /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns ${recordWidth} >> /Length ${compressedXref.length} >>\nstream\n${compressedXref.toString('latin1')}\nendstream`)
  parts.push(ascii(`startxref\n${xrefOffset}\n%%EOF\n`))
  return new Uint8Array(join(parts))
}

test('reads xref streams, PNG predictors and compressed object streams', async () => {
  const bytes = createXrefStreamObjectStreamPdf()
  const inspection = await inspectNativePdfText(bytes)

  assert.equal(inspection.pageCount, 1)
  assert.equal(inspection.runs.length, 1)
  assert.equal(inspection.runs[0].originalText, 'Network')
  assert.equal(inspection.runs[0].fontMetadata.encoding, 'WinAnsiEncoding')
  assert.equal(inspection.runs[0].fontMetadata.canNativeReplace, true)
})

test('replaces WinAnsi text natively in an xref-stream PDF and reopens incremental output', async () => {
  const bytes = createXrefStreamObjectStreamPdf()
  const inspection = await inspectNativePdfText(bytes)
  const selectedRun = inspection.runs[0]
  const result = await replaceNativePdfText(bytes, selectedRun, 'Earthix')
  const reopened = await inspectNativePdfText(result.bytes)

  assert.equal(reopened.pageCount, 1)
  assert.ok(reopened.runs.some((run) => run.originalText === 'Earthix'))
  assert.ok(!reopened.runs.some((run) => run.originalText === 'Network'))
})

test('supports PDF xref streams using five-byte W [1 3 1] records', async () => {
  const bytes = createXrefStreamObjectStreamPdf({ widths: [1, 3, 1] })
  const inspection = await inspectNativePdfText(bytes)

  assert.equal(inspection.pageCount, 1)
  assert.equal(inspection.runs[0].originalText, 'Network')
  assert.equal(inspection.runs[0].fontMetadata.encoding, 'WinAnsiEncoding')
})

test('ignores the zero startxref marker in a linearized first section and uses the final xref stream', async () => {
  const bytes = createXrefStreamObjectStreamPdf({ widths: [1, 3, 1], leadingZeroStartXref: true })
  const inspection = await inspectNativePdfText(bytes)

  assert.equal(inspection.pageCount, 1)
  assert.equal(inspection.runs[0].originalText, 'Network')
})

test('replaces text in a five-byte xref-stream PDF with a leading first-section marker', async () => {
  const bytes = createXrefStreamObjectStreamPdf({ widths: [1, 3, 1], leadingZeroStartXref: true })
  const inspection = await inspectNativePdfText(bytes)
  const result = await replaceNativePdfText(bytes, inspection.runs[0], 'Earthix')
  const reopened = await inspectNativePdfText(result.bytes)

  assert.equal(reopened.pageCount, 1)
  assert.ok(reopened.runs.some((run) => run.originalText === 'Earthix'))
  assert.ok(!reopened.runs.some((run) => run.originalText === 'Network'))
})
