import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PDFDocument } from 'pdf-lib'
import { writePageObjects } from '../../frontend/src/engine/page-objects/objectWriter.js'
import { inspectNativePdfText, replaceNativeTextBlock, restyleNativeTextBlock } from '../../frontend/src/services/nativePdfTextEditor.js'
import { looksVisual, toLogicalIndic } from '../../frontend/src/engine/font-engine/indicText.js'
import { createFileFontProvider, extractTextWithPdfJs, findSystemFont } from '../font-engine/helpers/pdfFixtures.js'

const DEVANAGARI = /[ऀ-ॿ]/
const nirmalaPath = findSystemFont(['Nirmala.ttc', 'Nirmala.ttf'])
const hindiBlock = (inspection) => inspection.blocks.find((block) => DEVANAGARI.test(block.text))

/** A page whose content draws Hindi with an embedded Nirmala UI subset (flattened, no Earthix layer). */
async function hindiPdf(text, provider, color = '#B31A1A') {
  const document = await PDFDocument.create()
  document.addPage([595, 842])
  const base = new Uint8Array(await document.save({ useObjectStreams: false }))
  const family = (await provider.listFonts()).find((entry) => /Nirmala UI/.test(entry.family)).family
  const object = { id: 'h', type: 'text', pageIndex: 0, z: 1, x: 72, y: 120, width: 10, height: 10, rotation: 0, opacity: 1, text, fontFamily: family, fontSource: 'local', fontSize: 20, color, align: 'left', lineHeight: 1.3, autoWidth: true, bold: false, italic: false }
  return (await writePageObjects(base, [object], { fontProvider: provider, flatten: true })).bytes
}

test('visual-order Hindi from PDFs is converted to the order people type', () => {
  assert.equal(toLogicalIndic('दुिनया'), 'दुनिया')
  assert.equal(toLogicalIndic('िहंदी'), 'हिंदी')
  assert.equal(toLogicalIndic('िक्रया'), 'क्रिया')
  assert.equal(toLogicalIndic('कमर् का'), 'कर्म का')
  // Already logical text is left alone.
  for (const text of ['दुनिया', 'हिंदी', 'क्रिया', 'कर्म', 'नमस्ते', 'किनारा']) {
    assert.equal(looksVisual(text), false, text)
    assert.equal(toLogicalIndic(text), text)
  }
})

test('existing Hindi text written by a PDF generator can be edited with the same installed font', async (t) => {
  if (!nirmalaPath) { t.skip('Nirmala UI is not installed'); return }
  const provider = createFileFontProvider([nirmalaPath])
  const source = await hindiPdf('नमस्ते दुनिया', provider)

  const inspection = await inspectNativePdfText(source, { fontProvider: provider })
  const block = hindiBlock(inspection)
  assert.equal(block.text, 'नमस्ते दुनिया')
  assert.equal(block.editable, true)

  const result = await replaceNativeTextBlock(source, block, 'नमस्ते भारत', { fontProvider: provider })
  assert.equal(result.fontPlan.match, 'exact')
  const edited = hindiBlock(result.inspection)
  assert.equal(edited.text, 'नमस्ते भारत')
  assert.equal(edited.fillColor, block.fillColor)
  assert.ok(Math.abs(edited.fontSizeUser - 20) < 0.01)
  const [text] = await extractTextWithPdfJs(result.bytes)
  assert.match(text, /भारत/)

  // Colour changes keep the shaped glyphs.
  const recoloured = await restyleNativeTextBlock(result.bytes, edited, { color: '#2454E6' }, { fontProvider: provider })
  assert.equal(hindiBlock(recoloured.inspection).fillColor, '#2454E6')
  assert.equal(hindiBlock(recoloured.inspection).text, 'नमस्ते भारत')
})

test('Hindi printed from Edge (unlabelled conjuncts) is recovered from the installed font and edited', async (t) => {
  if (!nirmalaPath) { t.skip('Nirmala UI is not installed'); return }
  const source = new Uint8Array(readFileSync(new URL('../fixtures/hindi-invoice-edge.pdf', import.meta.url)))
  const without = hindiBlock(await inspectNativePdfText(source))
  assert.equal(without.editable, false)
  assert.equal(without.reasonCode, 'needs-installed-font')

  const provider = createFileFontProvider([nirmalaPath])
  const inspection = await inspectNativePdfText(source, { fontProvider: provider })
  const block = hindiBlock(inspection)
  assert.equal(block.text, 'नमस्ते दुनिया')
  assert.equal(block.editable, true)

  const result = await replaceNativeTextBlock(source, block, 'नमस्ते भारत, कृपया हस्ताक्षर करें', { fontProvider: provider })
  assert.equal(hindiBlock(result.inspection).text, 'नमस्ते भारत, कृपया हस्ताक्षर करें')
  const [text] = await extractTextWithPdfJs(result.bytes)
  assert.match(text, /नमस्ते भारत, कृपया हस्ताक्षर करें/)
  // The English text on the page is untouched.
  assert.match(text, /Rahul Kumar/)
})

test('without an installed Hindi font the edit is refused with a clear message', async (t) => {
  if (!nirmalaPath) { t.skip('Nirmala UI is not installed'); return }
  const source = await hindiPdf('नमस्ते', createFileFontProvider([nirmalaPath]))
  const block = hindiBlock(await inspectNativePdfText(source))
  await assert.rejects(() => replaceNativeTextBlock(source, block, 'नमस्ते जी', { fontProvider: null }), /needs a Hindi font/)
})
