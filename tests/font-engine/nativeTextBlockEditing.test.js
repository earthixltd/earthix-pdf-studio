import test from 'node:test'
import assert from 'node:assert/strict'
import { inspectNativePdfText, replaceNativeTextBlock } from '../../frontend/src/services/nativePdfTextEditor.js'
import {
  createFileFontProvider, createRawPdf, createStandardFontPdf, createSubsetFontPdf, extractTextWithPdfJs, findSystemFont,
} from './helpers/pdfFixtures.js'

const blockWithText = (inspection, text) => inspection.blocks.find((block) => block.text === text)
const runStartX = (inspection, text) => inspection.runs.find((run) => run.originalText === text)?.startPoint.x
const lineStartingWith = (inspection, start) => {
  const first = inspection.blocks.find((block) => block.text.startsWith(start))
  if (!first) return ''
  return inspection.blocks
    .filter((block) => block.pageIndex === first.pageIndex && Math.abs(block.startPoint.y - first.startPoint.y) < 0.5 && block.startPoint.x >= first.startPoint.x)
    .sort((a, b) => a.startPoint.x - b.startPoint.x)
    .map((block) => block.text)
    .join('')
}

test('groups pdf-lib text into editable blocks with geometry, size and colour', async () => {
  const bytes = await createStandardFontPdf([{ y: 700, size: 12, parts: [{ text: 'Invoice', color: [0.2, 0.4, 0.6] }, { text: 'Number', bold: true }] }])
  const inspection = await inspectNativePdfText(bytes)
  const invoice = blockWithText(inspection, 'Invoice')
  assert.ok(invoice, 'Invoice block exists')
  assert.equal(invoice.editable, true)
  assert.equal(invoice.fillColor, '#336699')
  assert.ok(Math.abs(invoice.fontSizeUser - 12) < 0.01)
  assert.ok(Math.abs(invoice.startPoint.x - 72) < 0.01)
  assert.ok(Math.abs(invoice.startPoint.y - 700) < 0.01)
  // A bold word is a separate block (style is preserved per block).
  assert.ok(blockWithText(inspection, 'Number'))
})

test('lengthening text moves the following words on the same line instead of overlapping them', async () => {
  const bytes = await createStandardFontPdf([
    { y: 700, size: 12, parts: [{ text: 'Name:' }, { text: 'Rahul' }, { text: 'Kumar', bold: true }] },
    { y: 680, size: 12, parts: [{ text: 'Untouched second line' }] },
  ])
  const before = await inspectNativePdfText(bytes)
  // "Name:" and "Rahul" share one style and a word gap, so they form one block.
  const nameBlock = blockWithText(before, 'Name: Rahul')
  assert.ok(nameBlock, 'regular-weight words grouped into one editable block')
  const kumarBefore = runStartX(before, 'Kumar')
  const originalGap = kumarBefore - nameBlock.endPoint.x
  const result = await replaceNativeTextBlock(bytes, nameBlock, 'Name: Rahul Sharma')
  const after = result.inspection
  assert.equal(result.fontPlan.kind, 'original')
  const edited = blockWithText(after, 'Name: Rahul Sharma')
  assert.ok(edited)
  const kumarAfter = runStartX(after, 'Kumar')
  assert.ok(kumarAfter > kumarBefore, 'Kumar moved right')
  // Kumar starts after the new text with the same gap as before (no overlap).
  assert.ok(Math.abs((kumarAfter - edited.endPoint.x) - originalGap) < 0.05, `gap kept: ${kumarAfter - edited.endPoint.x} vs ${originalGap}`)
  // Earlier text and other lines do not move.
  assert.ok(Math.abs(runStartX(after, 'Name:') - runStartX(before, 'Name:')) < 0.01)
  assert.ok(Math.abs(runStartX(after, 'Untouched second line') - runStartX(before, 'Untouched second line')) < 0.01)
  const [pageText] = await extractTextWithPdfJs(result.bytes)
  assert.match(pageText, /Rahul Sharma/)
  assert.doesNotMatch(pageText, /Rahul\s+Kumar/)
})

test('shortening text pulls the following words left to close the gap', async () => {
  const bytes = await createStandardFontPdf([{ y: 700, size: 12, parts: [{ text: 'Wonderful' }, { text: 'day' }] }])
  const before = await inspectNativePdfText(bytes)
  const block = blockWithText(before, 'Wonderful day') || blockWithText(before, 'Wonderful')
  const result = await replaceNativeTextBlock(bytes, block, block.text.replace('Wonderful', 'Nice'))
  const after = result.inspection
  assert.ok(after.blocks.some((item) => item.text.startsWith('Nice')))
  if (block.text === 'Wonderful') assert.ok(runStartX(after, 'day') < runStartX(before, 'day'))
})

test('edits text inside a TJ array with kerning-based word spaces', async () => {
  const content = 'BT /F1 12 Tf 72 700 Td [(Hello) -333 (World)] TJ ET\nBT /F1 12 Tf 200 700 Td (Far column) Tj ET'
  const bytes = createRawPdf(content)
  const before = await inspectNativePdfText(bytes)
  const block = blockWithText(before, 'Hello World')
  assert.ok(block, 'virtual space detected inside TJ')
  const result = await replaceNativeTextBlock(bytes, block, 'Hello Earth')
  assert.ok(result.inspection.blocks.some((item) => item.text === 'Hello Earth'))
  // A distant column is not shifted.
  assert.ok(Math.abs(runStartX(result.inspection, 'Far column') - runStartX(before, 'Far column')) < 0.01)
  const [pageText] = await extractTextWithPdfJs(result.bytes)
  assert.match(pageText, /Hello\s*Earth/)
})

test('keeps size, colour and transform from the original graphics state (q/cm/Q)', async () => {
  const content = 'q 2 0 0 2 0 0 cm 0 0 1 rg BT /F1 10 Tf 36 350 Td (Scaled blue) Tj ET Q BT /F1 12 Tf 72 100 Td (Plain) Tj ET'
  const bytes = createRawPdf(content)
  const before = await inspectNativePdfText(bytes)
  const scaled = blockWithText(before, 'Scaled blue')
  assert.ok(Math.abs(scaled.fontSizeUser - 20) < 0.01, 'cm scale applied to font size')
  assert.equal(scaled.fillColor, '#0000FF')
  assert.ok(Math.abs(scaled.startPoint.x - 72) < 0.01 && Math.abs(scaled.startPoint.y - 700) < 0.01)
  assert.equal(blockWithText(before, 'Plain').fillColor, '#000000', 'Q restores the fill colour')
  const result = await replaceNativeTextBlock(bytes, scaled, 'Scaled green')
  const edited = blockWithText(result.inspection, 'Scaled green')
  assert.ok(edited)
  assert.ok(Math.abs(edited.fontSizeUser - 20) < 0.01)
  assert.equal(edited.fillColor, '#0000FF')
})

test('updates overprinted duplicate (fake bold / shadow) copies together', async () => {
  const content = 'BT /F1 12 Tf 72 700 Td (Total) Tj ET BT /F1 12 Tf 72.4 700 Td (Total) Tj ET'
  const bytes = createRawPdf(content)
  const before = await inspectNativePdfText(bytes)
  const blocks = before.blocks.filter((block) => block.text === 'Total')
  assert.equal(blocks.length, 1, 'duplicates are merged into one editable block')
  assert.equal(blocks[0].twinKeys.length, 1)
  const result = await replaceNativeTextBlock(bytes, blocks[0], 'Grand Total')
  const totals = result.inspection.runs.filter((run) => run.originalText === 'Grand Total')
  assert.equal(totals.length, 2, 'both copies now read the new text')
  assert.ok(!result.inspection.runs.some((run) => run.originalText === 'Total'))
})

test('handles inherited page resources and classic xref incremental output', async () => {
  const bytes = createRawPdf('BT /F1 11 Tf 72 700 Td (Inherited resources) Tj ET', { compress: false })
  const before = await inspectNativePdfText(bytes)
  const result = await replaceNativeTextBlock(bytes, blockWithText(before, 'Inherited resources'), 'Inherited fonts work')
  const tail = Buffer.from(result.bytes.subarray(bytes.length)).toString('latin1')
  assert.match(tail, /\nxref\n/)
  assert.match(tail, /\/Prev \d+/)
  const [pageText] = await extractTextWithPdfJs(result.bytes)
  assert.match(pageText, /Inherited fonts work/)
})

test('uses the standard PDF font family when a non-embedded font lacks the typed character', async () => {
  // WinAnsi cannot encode the rupee sign; without installed fonts the edit must fail clearly.
  const bytes = createRawPdf('BT /F1 12 Tf 72 700 Td (Price 100) Tj ET')
  const before = await inspectNativePdfText(bytes)
  await assert.rejects(() => replaceNativeTextBlock(bytes, blockWithText(before, 'Price 100'), 'Price ₹100'), /No font here can draw/)
})

const arialPath = findSystemFont(['arial.ttf', 'Arial.ttf'])

test('subset font: the same installed font redraws the line, a different font only fills the gaps', { skip: !arialPath && 'Arial is not installed' }, async () => {
  const bytes = await createSubsetFontPdf(arialPath, 'Hello')
  const before = await inspectNativePdfText(bytes)
  const block = blockWithText(before, 'Hello')
  assert.ok(block, 'subset text block found')
  assert.equal(block.fontMetadata.isEmbedded, true)
  // "Hexagon" needs x, a, g, n which are not in the subset.
  // Without installed fonts the closest standard PDF font is used.
  const standardResult = await replaceNativeTextBlock(bytes, block, 'Hexagon')
  assert.equal(standardResult.fontPlan.match, 'standard')
  assert.equal(standardResult.fontPlan.label, 'Helvetica')
  assert.deepEqual(standardResult.fontPlan.letters, ['x', 'g', 'n'], 'a and o are in the subset')
  assert.match(lineStartingWith(standardResult.inspection, 'He'), /^Hexagon/)
  const provider = createFileFontProvider([arialPath])
  const tailBefore = runStartX(before, 'Tail')
  const result = await replaceNativeTextBlock(bytes, block, 'Hexagon', { fontProvider: provider })
  assert.equal(result.fontPlan.kind, 'fallback')
  assert.equal(result.fontPlan.match, 'exact')
  const edited = blockWithText(result.inspection, 'Hexagon')
  assert.ok(edited, 'edited text is decodable from the new font ToUnicode map')
  assert.equal(edited.fillColor, '#CC1A1A', 'colour kept')
  assert.ok(Math.abs(edited.fontSizeUser - 14) < 0.01, 'size kept')
  assert.ok(runStartX(result.inspection, 'Tail') > tailBefore, 'following word moved right')
  const [pageText] = await extractTextWithPdfJs(result.bytes)
  assert.match(pageText, /Hexagon/)
  assert.doesNotMatch(pageText, /Hello/)
})

test('subset font: characters already in the subset reuse the original font', { skip: !arialPath && 'Arial is not installed' }, async () => {
  const bytes = await createSubsetFontPdf(arialPath, 'Hello there')
  const before = await inspectNativePdfText(bytes)
  const block = blockWithText(before, 'Hello there')
  const result = await replaceNativeTextBlock(bytes, block, 'Hello three')
  assert.equal(result.fontPlan.kind, 'original')
  assert.ok(blockWithText(result.inspection, 'Hello three'))
})

test('repeated edits keep working on the edited output (undoable byte snapshots)', async () => {
  const bytes = await createStandardFontPdf([{ y: 700, size: 12, parts: [{ text: 'Alpha' }, { text: 'Beta' }] }])
  let current = bytes
  let inspection = await inspectNativePdfText(current)
  for (const next of ['Alpha One', 'Alpha One Two', 'A']) {
    const block = inspection.blocks.find((item) => item.text.startsWith('A'))
    const result = await replaceNativeTextBlock(current, block, next + block.text.slice(block.text.indexOf(' Beta') >= 0 ? block.text.indexOf(' Beta') : block.text.length))
    current = result.bytes
    inspection = result.inspection
  }
  const [pageText] = await extractTextWithPdfJs(current)
  assert.match(pageText, /A\s*Beta/)
})

test('table cells: text in the next cell does not move when a cell grows', async () => {
  // Two bordered cells; "1" sits just 6pt after "Website design", across a border.
  const content = [
    '0.5 w 70 690 90 20 re S 160 690 40 20 re S',
    'BT /F1 12 Tf 75 695 Td (Website design) Tj ET',
    'BT /F1 12 Tf 163 695 Td (1) Tj ET',
  ].join('\n')
  const bytes = createRawPdf(content)
  const before = await inspectNativePdfText(bytes)
  assert.ok(blockWithText(before, 'Website design'), 'border splits the cells into separate blocks')
  assert.ok(blockWithText(before, '1'))
  const result = await replaceNativeTextBlock(bytes, blockWithText(before, 'Website design'), 'Website designing')
  assert.ok(Math.abs(runStartX(result.inspection, '1') - runStartX(before, '1')) < 0.01, 'next cell unchanged')
  assert.ok(result.warnings.some((warning) => /table border|next column/.test(warning)), 'overflow is reported')
})
