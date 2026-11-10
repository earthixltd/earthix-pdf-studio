import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PDFDocument, degrees, rgb, StandardFonts } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { writePageObjects } from '../../frontend/src/engine/page-objects/objectWriter.js'
import { extractPageObjects } from '../../frontend/src/engine/page-objects/objectReader.js'
import { decodePng, encodePng, readJpegInfo } from '../../frontend/src/engine/page-objects/imageCodec.js'
import { pageViewTransform } from '../../frontend/src/engine/page-objects/pageGeometry.js'
import { createFileFontProvider, extractTextWithPdfJs, findSystemFont } from '../font-engine/helpers/pdfFixtures.js'

async function basePdf({ rotate = 0 } = {}) {
  const document = await PDFDocument.create()
  const page = document.addPage([612, 792])
  const font = await document.embedFont(StandardFonts.Helvetica)
  page.drawText('Original page text', { x: 72, y: 700, size: 14, font, color: rgb(0, 0, 0) })
  if (rotate) page.setRotation(degrees(rotate))
  document.addPage([612, 792])
  return new Uint8Array(await document.save({ useObjectStreams: false }))
}

async function samplePng() {
  const width = 4
  const height = 3
  const rgbData = new Uint8Array(width * height * 3)
  const alpha = new Uint8Array(width * height)
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    rgbData.set([pixel * 20, 100, 255 - pixel * 20], pixel * 3)
    alpha[pixel] = pixel % 2 ? 128 : 255
  }
  return encodePng({ width, height, rgb: rgbData, alpha })
}

async function textItems(bytes, pageNumber = 1) {
  const task = getDocument({ data: bytes.slice(), useSystemFonts: false, isEvalSupported: false, disableFontFace: true, verbosity: 0 })
  const document = await task.promise
  const page = await document.getPage(pageNumber)
  const viewport = page.getViewport({ scale: 1 })
  const content = await page.getTextContent()
  const annotations = await page.getAnnotations()
  const items = content.items.map((item) => {
    const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5])
    return { str: item.str, x, y }
  })
  await task.destroy()
  return { items, annotations }
}

function objectsFixture(png) {
  return [
    { id: 't1', type: 'text', pageIndex: 0, z: 1, x: 100, y: 200, width: 10, height: 10, rotation: 0, opacity: 1, text: 'Added heading\nSecond line', fontFamily: 'Helvetica', fontSource: 'standard', bold: true, italic: false, fontSize: 18, color: '#2454E6', align: 'left', lineHeight: 1.25, autoWidth: true },
    { id: 'i1', type: 'image', pageIndex: 0, z: 2, x: 300, y: 300, width: 80, height: 60, rotation: 0, opacity: 0.8, assetId: 'a1', data: png, format: 'png', pixelWidth: 4, pixelHeight: 3 },
    { id: 's1', type: 'shape', shape: 'rect', pageIndex: 0, z: 3, x: 50, y: 400, width: 120, height: 50, rotation: 15, opacity: 1, strokeColor: '#D92D20', strokeWidth: 2, fillColor: '#FFF4E5' },
    { id: 's2', type: 'shape', shape: 'ellipse', pageIndex: 0, z: 4, x: 200, y: 400, width: 80, height: 40, rotation: 0, opacity: 0.5, strokeColor: '#000000', strokeWidth: 1, fillColor: null, dashed: true },
    { id: 's3', type: 'shape', shape: 'arrow', pageIndex: 0, z: 5, x: 0, y: 0, width: 0, height: 0, rotation: 0, opacity: 1, strokeColor: '#027A48', strokeWidth: 3, points: [{ x: 320, y: 500 }, { x: 420, y: 560 }] },
    { id: 'k1', type: 'ink', pageIndex: 0, z: 6, x: 59, y: 599, width: 52, height: 22, rotation: 0, opacity: 1, color: '#101828', strokeWidth: 2, strokes: [[{ x: 60, y: 600 }, { x: 70, y: 610 }, { x: 90, y: 605 }, { x: 110, y: 620 }]] },
    { id: 'h1', type: 'highlight', kind: 'highlight', pageIndex: 0, z: 7, x: 72, y: 78, width: 120, height: 18, rotation: 0, color: '#FFE066', opacity: 0.45, rects: [{ x: 72, y: 78, width: 120, height: 18 }], text: 'Original page text' },
    { id: 'n1', type: 'note', pageIndex: 1, z: 8, x: 400, y: 100, width: 20, height: 20, rotation: 0, color: '#FFC83D', text: 'Please check this page' },
  ]
}

test('PNG encode/decode round trip keeps pixels and alpha', async () => {
  const png = await samplePng()
  const decoded = await decodePng(png)
  assert.equal(decoded.width, 4)
  assert.equal(decoded.height, 3)
  assert.equal(decoded.rgb[3], 20)
  assert.equal(decoded.alpha[1], 128)
})

test('JPEG header parser reads size and orientation', () => {
  // SOI, APP1 Exif with orientation 6, SOF0 300x200x3
  const exif = [0x45, 0x78, 0x69, 0x66, 0, 0, 0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0]
  const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0, exif.length + 2, ...exif, 0xff, 0xc0, 0, 17, 8, 0, 200, 1, 44, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9])
  const info = readJpegInfo(bytes)
  assert.deepEqual([info.width, info.height, info.components, info.orientation], [300, 200, 3, 6])
})

test('added objects are written as page content and comments, then read back as editable objects', async () => {
  const png = await samplePng()
  const source = await basePdf()
  const objects = objectsFixture(png)
  const { bytes, warnings } = await writePageObjects(source, objects)
  assert.deepEqual(warnings, [])

  const reloaded = await PDFDocument.load(bytes)
  assert.equal(reloaded.getPageCount(), 2)
  const [pageText] = await extractTextWithPdfJs(bytes)
  assert.match(pageText, /Added heading/)
  assert.match(pageText, /Second line/)
  assert.match(pageText, /Original page text/)

  const { items, annotations } = await textItems(bytes)
  const heading = items.find((item) => item.str.includes('Added heading'))
  // Baseline: y + padding + baselineOffset (Helvetica metrics, 18pt, line height 1.25).
  const expectedBaseline = 200 + 2 + (18 * 1.25 - (0.905 + 0.212) * 18) / 2 + 0.905 * 18
  assert.ok(Math.abs(heading.x - 102) < 0.5, `heading x ${heading.x}`)
  assert.ok(Math.abs(heading.y - expectedBaseline) < 0.5, `heading baseline ${heading.y} vs ${expectedBaseline}`)
  assert.equal(annotations.filter((annotation) => annotation.subtype === 'Highlight').length, 1)
  const second = await textItems(bytes, 2)
  assert.equal(second.annotations.filter((annotation) => annotation.subtype === 'Text').length, 1)
  assert.equal(second.annotations[0].titleObj.str, '', 'no default author name')
  assert.equal(second.annotations[0].contentsObj.str, 'Please check this page')

  const extracted = await extractPageObjects(bytes)
  assert.equal(extracted.found, true)
  assert.equal(extracted.objects.length, objects.length)
  const image = extracted.objects.find((object) => object.id === 'i1')
  assert.equal(image.format, 'png')
  const decoded = await decodePng(image.data)
  assert.equal(decoded.alpha[1], 128)
  const text = extracted.objects.find((object) => object.id === 't1')
  assert.equal(text.text, 'Added heading\nSecond line')
  assert.equal(text.color, '#2454E6')

  // The returned base PDF no longer draws the objects or the comments.
  const [baseText] = await extractTextWithPdfJs(extracted.bytes)
  assert.doesNotMatch(baseText, /Added heading/)
  assert.match(baseText, /Original page text/)
  const base = await textItems(extracted.bytes)
  assert.equal(base.annotations.length, 0)
  const again = await extractPageObjects(extracted.bytes)
  assert.equal(again.found, false)

  // Writing the extracted objects again gives the same result.
  const rewritten = await writePageObjects(extracted.bytes, extracted.objects)
  const [rewrittenText] = await extractTextWithPdfJs(rewritten.bytes)
  assert.match(rewrittenText, /Added heading/)
})

test('flattened export keeps no editable layer', async () => {
  const png = await samplePng()
  const { bytes } = await writePageObjects(await basePdf(), objectsFixture(png), { flatten: true })
  const extracted = await extractPageObjects(bytes)
  assert.equal(extracted.found, false)
  const { annotations } = await textItems(bytes)
  assert.equal(annotations.filter((annotation) => annotation.subtype === 'Highlight').length, 0)
  const [pageText] = await extractTextWithPdfJs(bytes)
  assert.match(pageText, /Added heading/)
})

test('objects land at the same visual position on rotated pages', async () => {
  const source = await basePdf({ rotate: 90 })
  const object = { id: 't2', type: 'text', pageIndex: 0, z: 1, x: 150, y: 120, width: 10, height: 10, rotation: 0, opacity: 1, text: 'Rotated page note', fontFamily: 'Times', fontSource: 'standard', bold: false, italic: false, fontSize: 12, color: '#000000', align: 'left', lineHeight: 1.2, autoWidth: true }
  const { bytes } = await writePageObjects(source, [object])
  const { items } = await textItems(bytes)
  const item = items.find((entry) => entry.str.includes('Rotated page note'))
  const expectedBaseline = 120 + 2 + (12 * 1.2 - (0.891 + 0.216) * 12) / 2 + 0.891 * 12
  assert.ok(Math.abs(item.x - 152) < 0.5, `x ${item.x}`)
  assert.ok(Math.abs(item.y - expectedBaseline) < 0.5, `baseline ${item.y}`)

  // pageViewTransform matches PDF.js for every rotation.
  const task = getDocument({ data: source.slice(), verbosity: 0 })
  const document = await task.promise
  const page = await document.getPage(1)
  const viewport = page.getViewport({ scale: 1 })
  const ours = pageViewTransform([0, 0, 612, 792], 90)
  assert.deepEqual(ours.map((value) => Math.round(value * 1000) / 1000), viewport.transform.map((value) => Math.round(value * 1000) / 1000))
  await task.destroy()
})

test('objects written before a page rotation are remapped when read back', async () => {
  const object = { id: 'r1', type: 'shape', shape: 'rect', pageIndex: 0, z: 1, x: 100, y: 100, width: 50, height: 20, rotation: 0, opacity: 1, strokeColor: '#000000', strokeWidth: 1, fillColor: null }
  const { bytes } = await writePageObjects(await basePdf(), [object])
  const document = await PDFDocument.load(bytes)
  document.getPage(0).setRotation(degrees(90))
  const rotated = new Uint8Array(await document.save({ useObjectStreams: false }))
  const extracted = await extractPageObjects(rotated)
  const [moved] = extracted.objects
  // Centre (125, 110) in the old view becomes (792 - 110, 125) after a 90 degree turn.
  assert.ok(Math.abs(moved.x + moved.width / 2 - (792 - 110)) < 0.01)
  assert.ok(Math.abs(moved.y + moved.height / 2 - 125) < 0.01)
  assert.equal(moved.rotation, 90)
})

test('text boxes in an installed font are embedded and searchable', async (t) => {
  const arial = findSystemFont(['arial.ttf', 'Arial.ttf', 'LiberationSans-Regular.ttf'])
  if (!arial) { t.skip('No Arial-compatible font installed'); return }
  const provider = createFileFontProvider([arial])
  const [entry] = await provider.listFonts()
  const object = { id: 'l1', type: 'text', pageIndex: 0, z: 1, x: 80, y: 300, width: 160, height: 10, rotation: 0, opacity: 1, text: 'Prix: 25 € — naïve façade with wrapping text inside a fixed box', fontFamily: entry.family, fontSource: 'local', bold: false, italic: false, fontSize: 12, color: '#000000', align: 'center', lineHeight: 1.3, autoWidth: false }
  const { bytes, warnings } = await writePageObjects(await basePdf(), [object], { fontProvider: provider })
  assert.deepEqual(warnings, [])
  const [pageText] = await extractTextWithPdfJs(bytes)
  assert.match(pageText, /Prix: 25 €/)
  assert.match(pageText, /façade/)
})
