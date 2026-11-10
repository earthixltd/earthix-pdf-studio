import test from 'node:test'
import assert from 'node:assert/strict'
import { inflateSync } from 'node:zlib'
import { PDFDocument } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { writePageObjects } from '../../frontend/src/engine/page-objects/objectWriter.js'
import { noteMessage } from '../../frontend/src/engine/page-objects/textLayout.js'

async function blankPdf() {
  const doc = await PDFDocument.create()
  doc.addPage([612, 792])
  return new Uint8Array(await doc.save())
}

const note = (text, color = '#53B1FD') => ({ id: 'n1', type: 'note', pageIndex: 0, z: 1, x: 100, y: 100, width: 20, height: 20, color, text })

async function annotationsOf(bytes) {
  const task = getDocument({ data: bytes.slice(), useSystemFonts: false })
  const document = await task.promise
  const annotations = await (await document.getPage(1)).getAnnotations()
  await task.destroy()
  return annotations
}

test('a comment is exported as an icon in its colour, holding only the words typed', async () => {
  const { bytes } = await writePageObjects(await blankPdf(), [note('Please check this')])
  const annotations = await annotationsOf(bytes)
  const annotation = annotations.find((item) => item.subtype === 'Text')
  assert.equal(annotation.contentsObj.str, 'Please check this')
  assert.equal(annotation.titleObj.str, '', 'no default name')
  assert.ok(!Buffer.from(bytes).toString('latin1').includes('Earthix PDF Studio'))
  assert.deepEqual([...annotation.color], [0x53, 0xb1, 0xfd], 'the chosen colour')

  const doc = await PDFDocument.load(bytes)
  const annot = doc.getPage(0).node.Annots().lookup(0)
  const stream = annot.lookup(annot.context.obj('AP')).lookup(annot.context.obj('N'))
  const content = inflateSync(stream.getContents()).toString('latin1')
  assert.match(content, /0\.3\d* 0\.69\d* 0\.99\d* rg/, 'the icon is painted in that colour')
})

test('the message box grows with the words and wraps long comments', () => {
  const short = noteMessage(note('Hi'))
  const longer = noteMessage(note('A somewhat longer comment'))
  const veryLong = noteMessage(note('word '.repeat(80)))
  assert.ok(short.width < longer.width)
  assert.equal(veryLong.width, 220, 'long comments wrap at a fixed width')
  assert.ok(veryLong.height > short.height * 3)
})

test('dark colours get white words', () => {
  assert.equal(noteMessage(note('x', '#1B2333')).color, '#FFFFFF')
  assert.equal(noteMessage(note('x', '#FDB022')).color, '#1B2333')
})

test('an empty comment adds nothing to the PDF', async () => {
  const { bytes } = await writePageObjects(await blankPdf(), [note('   ')])
  assert.equal((await annotationsOf(bytes)).length, 0)
  assert.equal(noteMessage(note('')), null)
})

test('a flattened comment keeps its icon and message', async () => {
  const { bytes } = await writePageObjects(await blankPdf(), [note('Still readable')], { flatten: true })
  const annotation = (await annotationsOf(bytes)).find((item) => item.subtype === 'Text')
  assert.equal(annotation.contentsObj.str, 'Still readable')
})
