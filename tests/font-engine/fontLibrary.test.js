import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { inspectNativePdfText, replaceNativeTextBlock } from '../../frontend/src/services/nativePdfTextEditor.js'
import { resolveFallbackFont } from '../../frontend/src/engine/font-engine/fallbackFonts.js'
import { openFontProgram } from '../../frontend/src/engine/font-engine/fontEmbedder.js'
import {
  SAMPLE_LETTERS, candidateScore, createCombinedFontProvider, createFontLibrary, fontFileUrl, glyphShape, pickSubset, rankByWidth, widthScore,
} from '../../frontend/src/engine/font-engine/fontLibrary.js'
import { createSubsetFontPdf, findSystemFont } from './helpers/pdfFixtures.js'

const arialPath = findSystemFont(['arial.ttf', 'Arial.ttf'])
const noArial = !arialPath && 'Arial is not installed'
const noLocal = { supported: false, denied: false, status: 'unsupported', prepare: async () => [], listFonts: async () => [] }
const noUploads = { list: async () => [] }
const row = (family, extra = {}) => ({ f: family, i: family.toLowerCase().replace(/\s+/g, '-'), w: [400, 700], s: ['latin', 'devanagari'], c: 's', ...extra })

test('the language file is chosen from the letters typed', () => {
  assert.equal(pickSubset('Hello', ['latin']), 'latin')
  assert.equal(pickSubset('नमस्ते', ['latin', 'devanagari']), 'devanagari')
  assert.equal(pickSubset('₹', ['latin', 'latin-ext']), 'latin-ext')
  assert.equal(pickSubset('नमस्ते', ['latin']), null)
  assert.equal(pickSubset('你好', ['latin', 'japanese']), null, 'no file is known for these letters')
})

test('font file addresses follow the library layout', () => {
  assert.equal(fontFileUrl('open-sans', 'latin', 700, 'italic'), 'https://cdn.jsdelivr.net/fontsource/fonts/open-sans@latest/latin-700-italic.ttf')
})

test('every weight and slant is listed with the names PDFs use', async () => {
  const library = createFontLibrary({ catalog: async () => [row('Poppins', { w: [400, 600, 700], t: 1 })], download: async () => new Uint8Array() })
  const names = (await library.entries()).map((entry) => entry.postscriptName)
  assert.deepEqual(names, ['Poppins-Regular', 'Poppins-Italic', 'Poppins-SemiBold', 'Poppins-SemiBoldItalic', 'Poppins-Bold', 'Poppins-BoldItalic'])
  assert.deepEqual(library.weightsFor('Poppins'), [400, 600, 700])
})

test('letter shapes tell letters apart and see holes', { skip: noArial }, async () => {
  const program = await openFontProgram(new Uint8Array(readFileSync(arialPath)))
  const shape = glyphShape(program.glyphForCodePoint('O'.codePointAt(0)), program.unitsPerEm)
  assert.equal(shape.mask[12 * 24 + 12], 0, 'the middle of O is empty')
  assert.equal(shape.mask[12 * 24 + 1], 1, 'its side is filled')
  assert.ok(shape.stem > 40 && shape.stem < 200)
  assert.equal(glyphShape(program.glyphForCodePoint(' '.codePointAt(0)), program.unitsPerEm), null, 'a space has no shape')
})

test('the same font scores best against its own letters', { skip: noArial }, async () => {
  const regular = await openFontProgram(new Uint8Array(readFileSync(arialPath)))
  const boldPath = findSystemFont(['arialbd.ttf'])
  const bold = await openFontProgram(new Uint8Array(readFileSync(boldPath || arialPath)))
  const letters = [...'HOEA']
  const glyph = (letter) => regular.glyphForCodePoint(letter.codePointAt(0))
  const request = { sample: letters.map((letter) => [letter, (glyph(letter).advanceWidth / regular.unitsPerEm) * 1000]) }
  const shapes = new Map(letters.map((letter) => [letter, glyphShape(glyph(letter), regular.unitsPerEm)]))
  assert.ok(candidateScore(regular, request, shapes) < 0.001)
  if (boldPath) assert.ok(candidateScore(bold, request, shapes) > 10)
})

test('widths are compared by pattern, so a bolder cut of a font still ranks well', () => {
  const widths = (scale) => [...SAMPLE_LETTERS].map((letter, index) => Math.round(((100 + (index % 7) * 20) * scale) / 5))
  const sample = [...'ABCDEFG'].map((letter, index) => [letter, (100 + (index % 7) * 20) * 1.1])
  const similar = row('Similar', { m: widths(1) })
  const different = row('Different', { m: [...SAMPLE_LETTERS].map((letter, index) => 20 + ((index * 5) % 11) * 8) })
  assert.ok(widthScore(similar, sample) < widthScore(different, sample))
  assert.deepEqual(rankByWidth([different, similar], { sample }, 'x').map((item) => item.f), ['Similar', 'Different'])
  assert.equal(widthScore(row('Unmeasured'), sample), Infinity)
})

test('a font in the library is used by name, in one piece', { skip: noArial }, async () => {
  const bytes = await createSubsetFontPdf(arialPath, 'Hello')
  const before = await inspectNativePdfText(bytes)
  const block = before.blocks.find((item) => item.text === 'Hello')
  const urls = []
  const library = createFontLibrary({
    catalog: async () => [row('Arial', { w: [400] })],
    download: async (url) => { urls.push(url); return new Uint8Array(readFileSync(arialPath)) },
  })
  const result = await replaceNativeTextBlock(bytes, block, 'Hexagon', { fontProvider: createCombinedFontProvider(noLocal, library, noUploads) })
  assert.equal(result.fontPlan.match, 'exact')
  assert.equal(result.fontPlan.letters, null)
  assert.ok(result.inspection.blocks.some((item) => item.text === 'Hexagon'))
  assert.match(urls[0], /arial@latest\/latin-400-normal\.ttf$/)
})

test('without internet the edit still works with a standard font', { skip: noArial }, async () => {
  const bytes = await createSubsetFontPdf(arialPath, 'Hello')
  const before = await inspectNativePdfText(bytes)
  const block = before.blocks.find((item) => item.text === 'Hello')
  const library = createFontLibrary({
    catalog: async () => { throw new Error('offline') },
    download: async () => { throw new Error('offline') },
  })
  const result = await replaceNativeTextBlock(bytes, block, 'Hexagon', { fontProvider: createCombinedFontProvider(noLocal, library, noUploads) })
  assert.equal(result.fontPlan.match, 'standard')
})

test('an uploaded font beats the library, and exactOnly never settles for less', { skip: noArial }, async () => {
  const fontBytes = new Uint8Array(readFileSync(arialPath))
  const uploaded = { source: 'uploaded', family: 'Demo', style: 'Regular', fullName: 'Demo Mine', postscriptName: 'Demo-Regular', load: async () => fontBytes }
  const library = createFontLibrary({ catalog: async () => [row('Demo')], download: async () => fontBytes })
  const provider = createCombinedFontProvider(noLocal, library, { list: async () => [uploaded] })
  const exact = await resolveFallbackFont({ postscriptName: 'Demo-Regular', family: 'Demo', weight: 400 }, 'abc', provider, { exactOnly: true })
  assert.equal(exact.label, 'Demo Mine')
  assert.equal(await resolveFallbackFont({ postscriptName: 'Nope', family: 'Nope', weight: 400 }, 'abc', provider, { exactOnly: true }), null)
})

test('a distinctive font gets the closest library font, not a standard one', { skip: noArial }, async () => {
  const fontBytes = new Uint8Array(readFileSync(arialPath))
  const program = await openFontProgram(fontBytes)
  const widths = [...SAMPLE_LETTERS].map((letter) => Math.round(((program.glyphForCodePoint(letter.codePointAt(0)).advanceWidth / program.unitsPerEm) * 1000) / 5))
  const library = createFontLibrary({ catalog: async () => [row('Lookalike', { w: [400], m: widths })], download: async () => fontBytes })
  const provider = createCombinedFontProvider(noLocal, library, noUploads)
  const sample = [...'HOEA'].map((letter) => [letter, (program.glyphForCodePoint(letter.codePointAt(0)).advanceWidth / program.unitsPerEm) * 1000])
  const result = await resolveFallbackFont({ postscriptName: 'Mystery-Regular', family: 'Mystery', weight: 400, sample }, 'xyz', provider)
  assert.equal(result.match, 'similar')
  assert.equal(result.label, 'Lookalike Regular')
})

test('an unanswered font permission popup does not hold up editing twice', { skip: noArial }, async () => {
  const fontBytes = new Uint8Array(readFileSync(arialPath))
  const stuck = { supported: true, denied: false, status: 'unknown', prepare: () => new Promise(() => {}), listFonts: () => new Promise(() => {}) }
  const library = createFontLibrary({ catalog: async () => [row('Demo')], download: async () => fontBytes })
  const provider = createCombinedFontProvider(stuck, library, noUploads)
  const first = Date.now()
  assert.ok((await provider.listFonts()).length > 0)
  assert.ok(Date.now() - first < 2500, 'the first look gives up quickly')
  const second = Date.now()
  await provider.listFonts()
  assert.ok(Date.now() - second < 300, 'later looks do not wait at all')
})

test('library fonts are named from the catalog, not from the file', { skip: noArial }, async () => {
  const fontBytes = new Uint8Array(readFileSync(arialPath))
  const library = createFontLibrary({ catalog: async () => [row('Demo', { w: [700] })], download: async () => fontBytes })
  const provider = createCombinedFontProvider(noLocal, library, noUploads)
  const result = await resolveFallbackFont({ postscriptName: 'Demo-Bold', family: 'Demo', weight: 700 }, 'abc', provider)
  assert.equal(result.encoder.postscriptName, 'Demo-Bold')
})

test('asking for italic prefers fonts that have one', () => {
  const widths = [...SAMPLE_LETTERS].map(() => 100)
  const sample = [['A', 500]]
  const upright = row('Upright', { m: widths })
  const slanted = row('Slanted', { m: widths.map((value) => value + 8), t: 1 })
  assert.deepEqual(rankByWidth([upright, slanted], { sample, italic: true }, 'x').map((item) => item.f), ['Slanted'])
  assert.equal(rankByWidth([upright, slanted], { sample }, 'x')[0].f, 'Upright')
})
