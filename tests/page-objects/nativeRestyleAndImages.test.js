import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PDFDocument } from 'pdf-lib'
import { editPageImage, inspectNativePdfText, restyleNativeTextBlock } from '../../frontend/src/services/nativePdfTextEditor.js'
import { encodePng } from '../../frontend/src/engine/page-objects/imageCodec.js'
import { createRawPdf, extractTextWithPdfJs } from '../font-engine/helpers/pdfFixtures.js'

const TWO_FONTS = '<< /F1 5 0 R /F2 6 0 R >>'
const near = (actual, expected, tolerance = 0.3) => Math.abs(actual - expected) <= tolerance

function blockStarting(inspection, prefix) {
  return inspection.blocks.find((block) => block.text.startsWith(prefix))
}

async function pngBytes(width, height, color) {
  const rgb = new Uint8Array(width * height * 3)
  for (let pixel = 0; pixel < width * height; pixel += 1) rgb.set(color, pixel * 3)
  return encodePng({ width, height, rgb })
}

test('changing the colour of a text block restores the previous colour for the text after it', async () => {
  const source = createRawPdf('0 0 1 rg BT /F1 12 Tf 72 700 Td (Blue words) Tj ET BT /F1 12 Tf 72 680 Td (Next line) Tj ET')
  const inspection = await inspectNativePdfText(source)
  const target = blockStarting(inspection, 'Blue words')
  const result = await restyleNativeTextBlock(source, target, { color: '#D92D20' })
  const after = result.inspection
  assert.equal(blockStarting(after, 'Blue words').fillColor, '#D92D20')
  assert.equal(blockStarting(after, 'Next line').fillColor, '#0000FF')
  const [text] = await extractTextWithPdfJs(result.bytes)
  assert.match(text, /Blue words/)
})

test('a larger font size moves the following words on the same line', async () => {
  const source = createRawPdf('BT /F1 12 Tf 72 700 Td (Size me) Tj /F2 12 Tf ( after) Tj ET', { fonts: TWO_FONTS })
  const inspection = await inspectNativePdfText(source)
  const target = blockStarting(inspection, 'Size me')
  const before = blockStarting(inspection, 'after') || inspection.blocks.find((block) => block.text.includes('after'))
  const result = await restyleNativeTextBlock(source, target, { fontSize: 18 })
  const resized = blockStarting(result.inspection, 'Size me')
  assert.ok(near(resized.fontSizeUser, 18, 0.01))
  const moved = result.inspection.blocks.find((block) => block.text.includes('after'))
  const growth = (resized.endPoint.x - resized.startPoint.x) - (target.endPoint.x - target.startPoint.x)
  assert.ok(growth > 10)
  assert.ok(near(moved.startPoint.x - before.startPoint.x, growth, 0.6), `moved ${moved.startPoint.x - before.startPoint.x} vs ${growth}`)
})

test('bold and a different family switch to a matching standard font', async () => {
  const source = createRawPdf('BT /F1 14 Tf 72 700 Td (Make me bold) Tj ET')
  const inspection = await inspectNativePdfText(source)
  const target = blockStarting(inspection, 'Make me bold')
  const bold = await restyleNativeTextBlock(source, target, { bold: true })
  const boldBlock = blockStarting(bold.inspection, 'Make me bold')
  assert.equal(boldBlock.fontWeight, 700)
  const times = await restyleNativeTextBlock(bold.bytes, boldBlock, { fontFamily: 'Times', fontSource: 'standard', bold: false })
  const timesBlock = blockStarting(times.inspection, 'Make me bold')
  assert.match(timesBlock.fontMetadata.baseFontName, /Times-Roman/)
  const [text] = await extractTextWithPdfJs(times.bytes)
  assert.match(text, /Make me bold/)
})

test('page images can be moved, resized, replaced, faded and deleted', async () => {
  const document = await PDFDocument.create()
  const page = document.addPage([612, 792])
  const image = await document.embedPng(await pngBytes(8, 6, [200, 30, 30]))
  page.drawImage(image, { x: 100, y: 500, width: 50, height: 40 })
  const source = new Uint8Array(await document.save({ useObjectStreams: false }))

  const inspection = await inspectNativePdfText(source)
  assert.equal(inspection.images.length, 1)
  const [original] = inspection.images
  assert.ok(near(original.viewRect.x, 100) && near(original.viewRect.y, 252) && near(original.viewRect.width, 50) && near(original.viewRect.height, 40))
  assert.equal(original.editable, true)

  const moved = await editPageImage(source, original, { type: 'transform', from: original.viewRect, to: { x: 200, y: 300, width: 100, height: 80 } })
  const [placed] = moved.inspection.images
  assert.ok(near(placed.viewRect.x, 200) && near(placed.viewRect.y, 300) && near(placed.viewRect.width, 100) && near(placed.viewRect.height, 80), JSON.stringify(placed.viewRect))

  const rotated = await editPageImage(moved.bytes, placed, { type: 'transform', from: placed.viewRect, to: placed.viewRect, rotation: 90 })
  const [turned] = rotated.inspection.images
  assert.ok(near(turned.viewRect.width, 80) && near(turned.viewRect.height, 100), JSON.stringify(turned.viewRect))

  const replaced = await editPageImage(rotated.bytes, turned, { type: 'replace', data: await pngBytes(4, 4, [10, 120, 220]) })
  assert.equal(replaced.inspection.images.length, 1)
  const faded = await editPageImage(replaced.bytes, replaced.inspection.images[0], { type: 'opacity', value: 0.5 })
  assert.equal(faded.inspection.images.length, 1)
  const deleted = await editPageImage(faded.bytes, faded.inspection.images[0], { type: 'delete' })
  assert.equal(deleted.inspection.images.length, 0)
  const reloaded = await PDFDocument.load(deleted.bytes)
  assert.equal(reloaded.getPageCount(), 1)
})
