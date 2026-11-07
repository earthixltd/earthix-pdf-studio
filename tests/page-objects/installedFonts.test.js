import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inspectNativePdfText, restyleNativeTextBlock } from '../../frontend/src/services/nativePdfTextEditor.js'
import { writePageObjects } from '../../frontend/src/engine/page-objects/objectWriter.js'
import { extractPageObjects } from '../../frontend/src/engine/page-objects/objectReader.js'
import { createFileFontProvider, createRawPdf, extractTextWithPdfJs, findSystemFont } from '../font-engine/helpers/pdfFixtures.js'

const textObject = (overrides) => ({
  id: 't', type: 'text', pageIndex: 0, z: 1, x: 72, y: 120, width: 10, height: 10, rotation: 0, opacity: 1,
  fontSize: 16, color: '#1B2333', align: 'left', lineHeight: 1.3, autoWidth: true, bold: false, italic: false, ...overrides,
})

test('existing text can be restyled into an installed font family (Calibri Bold)', async (t) => {
  const regular = findSystemFont(['calibri.ttf'])
  const bold = findSystemFont(['calibrib.ttf'])
  if (!regular || !bold) { t.skip('Calibri is not installed'); return }
  const provider = createFileFontProvider([regular, bold])
  const source = createRawPdf('BT /F1 14 Tf 72 700 Td (Invoice total) Tj ET')
  const inspection = await inspectNativePdfText(source)
  const block = inspection.blocks.find((item) => item.text.startsWith('Invoice total'))
  const result = await restyleNativeTextBlock(source, block, { fontFamily: 'Calibri', fontSource: 'local', bold: true }, { fontProvider: provider })
  assert.equal(result.fontPlan.match, 'exact')
  assert.match(result.fontPlan.label, /Calibri Bold/)
  const updated = result.inspection.blocks.find((item) => item.text.startsWith('Invoice total'))
  assert.match(updated.fontMetadata.baseFontName, /Calibri-Bold/)
  const [text] = await extractTextWithPdfJs(result.bytes)
  assert.match(text, /Invoice total/)
})

test('a Hindi text box in an installed Devanagari font is embedded, searchable and editable again', async (t) => {
  const nirmala = findSystemFont(['Nirmala.ttc', 'Nirmala.ttf'])
  if (!nirmala) { t.skip('Nirmala UI is not installed'); return }
  const provider = createFileFontProvider([nirmala])
  const family = (await provider.listFonts()).find((entry) => /Nirmala UI/.test(entry.family))?.family
  const object = textObject({ text: 'नमस्ते दुनिया\nभारत', fontFamily: family, fontSource: 'local' })
  const { bytes, warnings } = await writePageObjects(createRawPdf('BT /F1 12 Tf 72 700 Td (Page) Tj ET'), [object], { fontProvider: provider })
  assert.deepEqual(warnings, [])
  const [text] = await extractTextWithPdfJs(bytes)
  assert.match(text, /भारत/)
  assert.match(text.replace(/\s+/g, ''), /नम/)
  const extracted = await extractPageObjects(bytes)
  assert.equal(extracted.objects[0].text, 'नमस्ते दुनिया\nभारत')
})

test('a typed signature font (Segoe Script) is embedded for text boxes', async (t) => {
  const script = findSystemFont(['segoesc.ttf'])
  if (!script) { t.skip('Segoe Script is not installed'); return }
  const provider = createFileFontProvider([script])
  const { bytes, warnings } = await writePageObjects(createRawPdf('BT /F1 12 Tf 72 700 Td (Page) Tj ET'), [textObject({ text: 'Rahul Kumar', fontFamily: 'Segoe Script', fontSource: 'local' })], { fontProvider: provider })
  assert.deepEqual(warnings, [])
  const [text] = await extractTextWithPdfJs(bytes)
  assert.match(text, /Rahul Kumar/)
})

test('missing installed fonts fall back with a clear warning instead of failing', async () => {
  const { bytes, warnings } = await writePageObjects(createRawPdf('BT /F1 12 Tf 72 700 Td (Page) Tj ET'), [textObject({ text: 'Fallback text', fontFamily: 'Font That Does Not Exist', fontSource: 'local' })], { fontProvider: null })
  assert.ok(warnings.some((warning) => /not available/.test(warning)))
  const [text] = await extractTextWithPdfJs(bytes)
  assert.match(text, /Fallback text/)
})
