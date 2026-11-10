// Builds frontend/public/fonts/catalog.json: the free fonts Earthix can use,
// with each font's letter widths so the closest one can be picked for a PDF.
// Only names and measurements are stored; the font files stay on the CDN.
// Run with: npm run fonts:catalog

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openFontProgram } from '../frontend/src/engine/font-engine/fontEmbedder.js'
import { fontFileUrl, SAMPLE_LETTERS } from '../frontend/src/engine/font-engine/fontLibrary.js'

const OUTPUT = resolve(dirname(fileURLToPath(import.meta.url)), '../frontend/public/fonts/catalog.json')
const CONCURRENCY = 12
const CATEGORY = { 'sans-serif': 's', serif: 'r', display: 'd', handwriting: 'h', monospace: 'm' }

async function fetchWithRetry(url, parse) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(45000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await parse(response)
    } catch (error) {
      if (attempt >= 3) throw error
    }
  }
}

function nearestWeight(weights) {
  return [...weights].sort((a, b) => Math.abs(a - 400) - Math.abs(b - 400))[0]
}

async function measure(font) {
  if (!font.subsets.includes('latin')) return null
  const url = fontFileUrl(font.id, 'latin', nearestWeight(font.weights), font.styles.includes('normal') ? 'normal' : 'italic')
  const bytes = await fetchWithRetry(url, async (response) => new Uint8Array(await response.arrayBuffer()))
  const program = await openFontProgram(bytes)
  const scale = 1000 / program.unitsPerEm
  return [...SAMPLE_LETTERS].map((letter) => {
    const codePoint = letter.codePointAt(0)
    return program.hasGlyphForCodePoint(codePoint) ? Math.round((program.glyphForCodePoint(codePoint).advanceWidth * scale) / 5) : 0
  })
}

const fonts = (await fetchWithRetry('https://api.fontsource.org/v1/fonts', (response) => response.json()))
  .filter((font) => CATEGORY[font.category])
console.log(`${fonts.length} fonts`)

const rows = new Array(fonts.length)
let next = 0
let done = 0
let unmeasured = 0
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (next < fonts.length) {
    const index = next
    next += 1
    const font = fonts[index]
    const row = { f: font.family, i: font.id, w: font.weights, s: font.subsets, c: CATEGORY[font.category] }
    if (font.styles.includes('italic')) row.t = 1
    if (!font.styles.includes('normal')) row.n = 0
    try {
      const widths = await measure(font)
      if (widths) row.m = widths
      else unmeasured += 1
    } catch (error) {
      unmeasured += 1
      console.log(`  skipped measuring ${font.id}: ${error.message}`)
    }
    rows[index] = row
    done += 1
    if (done % 200 === 0) console.log(`${done} / ${fonts.length}`)
  }
}))

mkdirSync(dirname(OUTPUT), { recursive: true })
writeFileSync(OUTPUT, JSON.stringify(rows))
console.log(`Wrote ${rows.length} fonts (${unmeasured} without measurements)`)
