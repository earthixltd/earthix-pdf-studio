import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { inspectNativePdfText, replaceNativeTextBlock } from '../../frontend/src/services/nativePdfTextEditor.js'
import { createStaticFontProvider, resolveFallbackFont, styleDistance } from '../../frontend/src/engine/font-engine/fallbackFonts.js'
import { openFontProgram } from '../../frontend/src/engine/font-engine/fontEmbedder.js'
import { describeFontName, weightFromStyle } from '../../frontend/src/engine/font-engine/pdfFontLoader.js'
import { buildCmapTable, buildPreviewFontFile, replaceCmapTable } from '../../frontend/src/engine/font-engine/previewFonts.js'
import { textWeight } from '../../frontend/src/engine/page-objects/textLayout.js'
import { createRawPdf, createSubsetFontPdf, extractTextWithPdfJs, findSystemFont } from './helpers/pdfFixtures.js'

const arialPath = findSystemFont(['arial.ttf', 'Arial.ttf'])
const noArial = !arialPath && 'Arial is not installed'

test('a big first line can be edited when a small number sits just before it', async () => {
  const bytes = createRawPdf('BT /F1 8 Tf 67 662 Td (1 ) Tj ET BT /F1 48 Tf 75 662 Td (Big Title) Tj ET')
  const before = await inspectNativePdfText(bytes)
  const result = await replaceNativeTextBlock(bytes, before.blocks.find((block) => block.text.startsWith('Big')), 'Bigger Title')
  assert.ok(result.inspection.blocks.some((block) => block.text.startsWith('Bigger Title')))
  assert.ok(result.inspection.blocks.some((block) => block.text.trim() === '1'), 'the small number is untouched')
})

test('a missing letter borrows a font without changing the rest of the line', { skip: noArial }, async () => {
  const bytes = await createSubsetFontPdf(arialPath, 'Hello')
  const before = await inspectNativePdfText(bytes)
  const block = before.blocks.find((item) => item.text === 'Hello')
  const result = await replaceNativeTextBlock(bytes, block, 'Hello,')
  assert.deepEqual(result.fontPlan.letters, [','])
  const kept = result.inspection.blocks.find((item) => item.text === 'Hello')
  assert.ok(kept, 'the original word is still there')
  assert.equal(kept.fontKey, block.fontKey, 'and still in its own font')
  const comma = result.inspection.blocks.find((item) => item.text === ',')
  assert.ok(Math.abs(comma.startPoint.x - kept.endPoint.x) < 0.01, 'the borrowed letter sits right after the word')
  const [pageText] = await extractTextWithPdfJs(result.bytes)
  assert.match(pageText, /Hello\s*,/)
})

test('weights are read from every common way of naming a font', () => {
  const cases = [
    ['Roboto-Thin', 100], ['Inter-ExtraLight', 200], ['SegoeUI-Light', 300], ['CalibriLight', 300], ['Lato-Regular', 400],
    ['Roboto-Medium', 500], ['SegoeUI-Semibold', 600], ['OpenSans-DemiBold', 600], ['Arial-BoldMT', 700], ['Arial,Bold', 700],
    ['TimesNewRomanPS-BoldItalicMT', 700], ['Roboto-ExtraBold', 800], ['Lato-Heavy', 800], ['Roboto-Black', 900], ['ArialBlack', 900], ['ABCDEF+Poppins-Light', 300], ['ARIALBOLD', 700],
  ]
  for (const [name, weight] of cases) assert.equal(describeFontName(name).weight, weight, name)
  assert.equal(describeFontName('Blackadder').weight, null, 'a family name is not a weight')
  assert.equal(describeFontName('Blackadder').bold, false)
  assert.equal(describeFontName('OldEnglishTextMT').weight, null)
  assert.equal(describeFontName('Arial-BoldItalicMT').bold, true)
  assert.equal(weightFromStyle('Semibold Italic'), 600)
  assert.equal(weightFromStyle('Italic'), null)
})

test('text items keep older bold-only values working', () => {
  assert.equal(textWeight({ bold: true }), 700)
  assert.equal(textWeight({}), 400)
  assert.equal(textWeight({ bold: false, weight: 300 }), 300)
})

test('an installed font is chosen by the closest weight', { skip: noArial }, async () => {
  const bytes = new Uint8Array(readFileSync(arialPath))
  const entry = (style) => ({ postscriptName: `Demo-${style}`, fullName: `Demo ${style}`, family: 'Demo', style, load: async () => bytes })
  const provider = createStaticFontProvider(['Thin', 'Light', 'Regular', 'Medium', 'Semibold', 'Bold', 'Black'].map(entry))
  const pick = async (weight, italic = false) => (await resolveFallbackFont({ postscriptName: '', family: 'Demo', weight, bold: weight >= 600, italic }, 'a', provider)).label
  assert.equal(await pick(100), 'Demo Thin')
  assert.equal(await pick(300), 'Demo Light')
  assert.equal(await pick(500), 'Demo Medium')
  assert.equal(await pick(600), 'Demo Semibold')
  assert.equal(await pick(900), 'Demo Black')
  assert.equal(styleDistance('Bold', { bold: true }), 0)
  assert.equal(styleDistance('Bold Italic', { weight: 700, italic: true }), 0)
  assert.ok(styleDistance('Regular', { weight: 700 }) > styleDistance('Semibold', { weight: 700 }))
})

test('the preview font sends real letters to the glyphs PDF.js stored privately', { skip: noArial }, async () => {
  const source = new Uint8Array(readFileSync(arialPath))
  const original = await openFontProgram(source)
  const glyphA = original.glyphForCodePoint(65).id
  const glyphB = original.glyphForCodePoint(66).id
  // The shape PDF.js produces: PDF codes reach glyphs through private-use characters.
  const privateFont = replaceCmapTable(source, buildCmapTable([[0xe000, glyphA], [0xe001, glyphB]]))
  const built = await buildPreviewFontFile(privateFont, new Map([[10, 0xe000], [11, 0xe001]]), [['A', 10], ['B', 11]])
  assert.equal(built.covered, 2)
  const result = await openFontProgram(built.bytes)
  assert.equal(result.glyphForCodePoint(65).id, glyphA)
  assert.equal(result.glyphForCodePoint(66).id, glyphB)
  assert.equal(result.glyphForCodePoint(67).id, 0, 'letters outside the PDF font are left to the fallback stack')
  assert.equal(result.numGlyphs, original.numGlyphs, 'every other table is intact')
})

test('character maps handle letters beyond the basic plane and very large fonts', () => {
  const emoji = buildCmapTable([[65, 3], [0x1f600, 9]])
  const view = new DataView(emoji.buffer)
  assert.equal(view.getUint16(2), 1, 'large code points use format 12')
  assert.equal(view.getUint16(4), 3)
  assert.equal(view.getUint16(6), 10)
  const scattered = buildCmapTable(Array.from({ length: 20000 }, (_, index) => [0x1000 + index * 2, index + 1]))
  assert.equal(new DataView(scattered.buffer).getUint16(6), 10, 'too many ranges for format 4')
})
