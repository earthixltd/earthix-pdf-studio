// Many PDF writers (Chrome, Edge, some Office exports) embed Indic text
// without a Unicode mapping for conjunct and half-form glyphs, so text like
// "नमस्ते" reads back as "नम?े". When the same font is installed, those
// glyphs can be identified again: the PDF stores the font's own glyph numbers,
// so shaping candidate letter sequences with the installed font shows which
// letters each unmapped glyph stands for.

import { openFontProgram } from './fontEmbedder.js'
import { normalizeFontKey } from './pdfFontLoader.js'

const cache = new Map()

function scriptLetters(base) {
  const consonants = []
  const ranges = {
    0x0900: [[0x15, 0x39]],
    0x0980: [[0x15, 0x39], [0x5c, 0x5f]],
    0x0a00: [[0x15, 0x39]],
    0x0a80: [[0x15, 0x39]],
    0x0b00: [[0x15, 0x39]],
    0x0b80: [[0x15, 0x39]],
    0x0c00: [[0x15, 0x39]],
    0x0c80: [[0x15, 0x39]],
    0x0d00: [[0x15, 0x3a]],
  }[base] || [[0x15, 0x39]]
  for (const [low, high] of ranges) for (let offset = low; offset <= high; offset += 1) consonants.push(String.fromCodePoint(base + offset))
  const matras = []
  for (let offset = 0x3e; offset <= 0x4c; offset += 1) matras.push(String.fromCodePoint(base + offset))
  return {
    consonants,
    matras,
    halant: String.fromCodePoint(base + 0x4d),
    nukta: String.fromCodePoint(base + 0x3c),
    ra: String.fromCodePoint(base + 0x30),
  }
}

function* candidateGroups(letters) {
  const { consonants: C, matras, halant: H, nukta: N, ra: R } = letters
  const pairs = []
  for (const first of C) for (const second of C) pairs.push(first + H + second)
  yield pairs
  yield C.map((first) => first + H)
  yield C.map((first) => R + H + first)
  const halfPairs = []
  for (const first of C) for (const second of C) halfPairs.push(first + H + second + H)
  yield halfPairs
  const withMatra = []
  for (const first of C) for (const matra of matras) withMatra.push(first + matra)
  yield withMatra
  yield C.map((first) => first + N)
  const triples = []
  for (const first of C) for (const second of C) triples.push(first + H + second + H + R)
  yield triples
}

async function findInstalledFont(font, fontProvider) {
  const entries = (await fontProvider.listFonts().catch(() => [])).filter((entry) => entry.source !== 'library')
  const wanted = normalizeFontKey(font.postscriptName)
  const family = normalizeFontKey(font.family)
  return entries.find((entry) => normalizeFontKey(entry.postscriptName) === wanted) ||
    entries.find((entry) => normalizeFontKey(entry.family) === family && !/bold|italic|light|semi/i.test(entry.style || '')) ||
    null
}

/**
 * Identify unmapped glyph codes of `font`. `samples` maps codes that do have
 * a single-letter Unicode value to that letter (used to confirm the PDF uses
 * the installed font's glyph numbers). Returns Map(code -> text) or null.
 */
export async function recoverUnmappedGlyphs(font, unmappedCodes, samples, fontProvider) {
  if (!fontProvider || !unmappedCodes.size || samples.size < 3) return null
  const entry = await findInstalledFont(font, fontProvider)
  if (!entry) return null
  const cacheKey = `${entry.postscriptName}|${[...unmappedCodes].sort((a, b) => a - b).join(',')}`
  if (cache.has(cacheKey)) return cache.get(cacheKey)

  let program
  try {
    program = await openFontProgram(await entry.load(), entry.postscriptName)
  } catch {
    return null
  }
  const gidOf = (code) => (font.cidToGid ? font.cidToGid(code) : code)
  let matches = 0
  for (const [code, letter] of samples) {
    if (program.glyphForCodePoint(letter.codePointAt(0))?.id === gidOf(code)) matches += 1
  }
  if (matches / samples.size < 0.9) { cache.set(cacheKey, null); return null }

  const targets = new Map([...unmappedCodes].map((code) => [gidOf(code), code]))
  const recovered = new Map()
  const base = [...samples.values()][0].codePointAt(0) & ~0x7f
  const letters = scriptLetters(base)
  const singleGlyph = (character) => program.glyphForCodePoint(character.codePointAt(0))?.id
  const record = (gid, text) => {
    const code = targets.get(gid)
    if (code !== undefined && !recovered.has(code)) recovered.set(code, text)
  }
  for (const group of candidateGroups(letters)) {
    for (const text of group) {
      let glyphs
      try { glyphs = program.layout(text).glyphs } catch { continue }
      if (glyphs.length === 1) record(glyphs[0].id, text)
      else if (glyphs.length === 2) {
        for (let index = 0; index < 2; index += 1) {
          const known = glyphs[index].id
          const letter = [...text].find((character) => singleGlyph(character) === known)
          if (letter && text.split(letter).length === 2) record(glyphs[1 - index].id, text.replace(letter, ''))
        }
      }
    }
    if (recovered.size === targets.size) break
  }
  const result = recovered.size ? recovered : null
  cache.set(cacheKey, result)
  return result
}
