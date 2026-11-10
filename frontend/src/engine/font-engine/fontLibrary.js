// The free font library: fonts found by name when a PDF uses one of them, and
// the closest match when nothing has the same name. Only a font's name goes
// over the network; the PDF itself never leaves the device.

import { openFontProgram } from './fontEmbedder.js'
import { normalizeFontKey } from './pdfFontLoader.js'

/** Popular free fonts offered by name in the Font list. */
export const FREE_FONT_FAMILIES = [
  'Abril Fatface', 'Antic Didone', 'Bebas Neue', 'Bodoni Moda', 'Cinzel', 'Cormorant Garamond', 'Josefin Sans',
  'League Spartan', 'Libre Bodoni', 'Montserrat', 'Oswald', 'Playfair Display', 'Prata', 'Tenor Sans',
]

const wait = (ms, value) => new Promise((resolve) => { setTimeout(() => resolve(value), ms) })

export const SAMPLE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

const WEIGHT_STYLES = { 100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black' }
const WIDTH_STEP = 5
const WIDTH_CANDIDATES = 20
const CLOSEST_DEADLINE_MS = 3500
const INSTALLED_WAIT_MS = 1200
const MASK_SIZE = 24

const SCRIPT_RANGES = [
  [0x0370, 0x03ff, 'greek'], [0x0400, 0x04ff, 'cyrillic'], [0x0500, 0x052f, 'cyrillic-ext'], [0x0530, 0x058f, 'armenian'],
  [0x0590, 0x05ff, 'hebrew'], [0x0600, 0x06ff, 'arabic'], [0x0900, 0x097f, 'devanagari'], [0x0980, 0x09ff, 'bengali'],
  [0x0a00, 0x0a7f, 'gurmukhi'], [0x0a80, 0x0aff, 'gujarati'], [0x0b00, 0x0b7f, 'oriya'], [0x0b80, 0x0bff, 'tamil'],
  [0x0c00, 0x0c7f, 'telugu'], [0x0c80, 0x0cff, 'kannada'], [0x0d00, 0x0d7f, 'malayalam'], [0x0d80, 0x0dff, 'sinhala'],
  [0x0e00, 0x0e7f, 'thai'], [0x0e80, 0x0eff, 'lao'], [0x0f00, 0x0fff, 'tibetan'], [0x1000, 0x109f, 'myanmar'],
  [0x10a0, 0x10ff, 'georgian'], [0x1200, 0x137f, 'ethiopic'], [0x1780, 0x17ff, 'khmer'], [0x1ea0, 0x1ef9, 'vietnamese'],
  [0x0100, 0x024f, 'latin-ext'], [0x1e00, 0x1eff, 'latin-ext'], [0x20a0, 0x20cf, 'latin-ext'],
]
const isLatin = (code) => code <= 0xff || (code >= 0x2000 && code <= 0x206f) || code === 0x20ac || code === 0x2122

export const fontFileUrl = (id, subset, weight, style) => `https://cdn.jsdelivr.net/fontsource/fonts/${id}@latest/${subset}-${weight}-${style}.ttf`

/** Which of a font's language files draws this text; null when it has none. */
export function pickSubset(text, subsets) {
  let needed = 'latin'
  for (const character of text) {
    const code = character.codePointAt(0)
    if (/\s/.test(character) || isLatin(code)) continue
    const script = SCRIPT_RANGES.find(([from, to]) => code >= from && code <= to)
    if (!script) return null
    needed = script[2]
    if (needed !== 'latin-ext') break
  }
  return subsets.includes(needed) ? needed : null
}

/** Ink and proportions of one letter, in thousandths of the font size. */
export function glyphShape(glyph, unitsPerEm) {
  let area = 0
  let perimeter = 0
  const segments = []
  let start = null
  let last = null
  let minY = Infinity
  let maxY = -Infinity
  let minX = Infinity
  let maxX = -Infinity
  const lineTo = (x, y) => {
    area += last.x * y - x * last.y
    perimeter += Math.hypot(x - last.x, y - last.y)
    segments.push([last.x, last.y, x, y])
    last = { x, y }
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
  }
  for (const { command, args } of glyph.path.commands) {
    if (command === 'moveTo') {
      start = { x: args[0], y: args[1] }
      last = start
      minX = Math.min(minX, last.x)
      maxX = Math.max(maxX, last.x)
      minY = Math.min(minY, last.y)
      maxY = Math.max(maxY, last.y)
    } else if (command === 'lineTo') {
      lineTo(args[0], args[1])
    } else if (command === 'quadraticCurveTo') {
      const from = last
      for (let step = 1; step <= 4; step += 1) {
        const t = step / 4
        const u = 1 - t
        lineTo(u * u * from.x + 2 * u * t * args[0] + t * t * args[2], u * u * from.y + 2 * u * t * args[1] + t * t * args[3])
      }
    } else if (command === 'bezierCurveTo') {
      const from = last
      for (let step = 1; step <= 4; step += 1) {
        const t = step / 4
        const u = 1 - t
        const a = u * u * u
        const b = 3 * u * u * t
        const c = 3 * u * t * t
        const d = t * t * t
        lineTo(a * from.x + b * args[0] + c * args[2] + d * args[4], a * from.y + b * args[1] + c * args[3] + d * args[5])
      }
    } else if (command === 'closePath' && start && last) {
      lineTo(start.x, start.y)
    }
  }
  if (!perimeter || maxX <= minX || maxY <= minY) return null
  const scale = 1000 / unitsPerEm
  return {
    width: (maxX - minX) * scale,
    height: (maxY - minY) * scale,
    stem: ((Math.abs(area) / perimeter) * 2) * scale,
    mask: rasterize(segments, minX, minY, maxX, maxY),
  }
}

/** The letter drawn on a small grid, filled the way fonts are (non-zero winding). */
function rasterize(segments, minX, minY, maxX, maxY) {
  const mask = new Uint8Array(MASK_SIZE * MASK_SIZE)
  const cellWidth = (maxX - minX) / MASK_SIZE
  const cellHeight = (maxY - minY) / MASK_SIZE
  for (let row = 0; row < MASK_SIZE; row += 1) {
    const y = minY + (row + 0.5) * cellHeight
    const crossings = []
    for (const [x0, y0, x1, y1] of segments) {
      if ((y0 <= y) === (y1 <= y)) continue
      crossings.push([x0 + ((y - y0) / (y1 - y0)) * (x1 - x0), y1 > y0 ? 1 : -1])
    }
    crossings.sort((a, b) => a[0] - b[0])
    let winding = 0
    let crossing = 0
    for (let column = 0; column < MASK_SIZE; column += 1) {
      const x = minX + (column + 0.5) * cellWidth
      while (crossing < crossings.length && crossings[crossing][0] <= x) {
        winding += crossings[crossing][1]
        crossing += 1
      }
      mask[row * MASK_SIZE + column] = winding !== 0 ? 1 : 0
    }
  }
  return mask
}

/** How much two letters differ on the grid: 0 is identical, 1 shares nothing. */
function maskDifference(a, b) {
  let both = 0
  let either = 0
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] && b[index]) both += 1
    if (a[index] || b[index]) either += 1
  }
  return either ? 1 - both / either : 0
}

/** Compare letter widths by pattern, so a bold PDF font can still match a regular measurement. */
export function widthScore(row, sample) {
  if (!row.m) return Infinity
  const pairs = []
  for (const [letter, width] of sample) {
    const index = SAMPLE_LETTERS.indexOf(letter)
    if (index >= 0 && row.m[index] > 0 && width > 0) pairs.push([width, row.m[index] * WIDTH_STEP])
  }
  if (!pairs.length) return Infinity
  const meanOf = (pick) => pairs.reduce((sum, pair) => sum + pick(pair), 0) / pairs.length
  const sourceMean = meanOf((pair) => pair[0])
  const candidateMean = meanOf((pair) => pair[1])
  const pattern = meanOf((pair) => Math.abs(pair[0] / sourceMean - pair[1] / candidateMean))
  return pattern * 1000 + Math.abs(sourceMean - candidateMean) * 0.2
}

const wantedWeight = (request) => (Number.isFinite(request.weight) && request.weight > 0 ? request.weight : request.bold ? 700 : 400)

function nearestWeight(row, wanted) {
  return [...row.w].sort((a, b) => Math.abs(a - wanted) - Math.abs(b - wanted))[0]
}

/** Keeps out fonts that can't be right: fixed-width mismatches and missing weights. */
function fitPenalty(row, request) {
  const pitch = Boolean(request.fixedPitch) === (row.c === 'm') ? 0 : 300
  return pitch + (Math.abs(nearestWeight(row, wantedWeight(request)) - wantedWeight(request)) / 100) * 10
}

/** With no letter shapes to compare, plain fonts are the safer guess. */
function plainBias(row, request) {
  if (!row) return 0
  if (request.serif) return row.c === 'r' ? 0 : 30
  return { s: 0, r: 30, d: 50, h: 90, m: 0 }[row.c] ?? 0
}

/** Rows most likely to look like the PDF's font, from the catalog alone. */
export function rankByWidth(rows, request, text, limit = WIDTH_CANDIDATES) {
  const usable = rows.filter((row) => pickSubset(text, row.s))
  const italics = request.italic ? usable.filter((row) => row.t) : []
  return (italics.length ? italics : usable)
    .map((row) => ({ row, score: widthScore(row, request.sample) + fitPenalty(row, request) }))
    .filter((item) => Number.isFinite(item.score))
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map((item) => item.row)
}

/** Lower is closer: real letter widths and, when known, the letters' shapes. */
export function candidateScore(program, request, shapes) {
  let widthTotal = 0
  let widthCount = 0
  let missing = 0
  for (const [letter, width] of request.sample) {
    const code = letter.codePointAt(0)
    if (!program.hasGlyphForCodePoint(code)) { missing += 1; continue }
    widthTotal += Math.abs((program.glyphForCodePoint(code).advanceWidth / program.unitsPerEm) * 1000 - width)
    widthCount += 1
  }
  if (!widthCount) return Infinity
  let shapeTotal = 0
  let shapeCount = 0
  for (const [letter, source] of shapes || []) {
    const code = letter.codePointAt(0)
    if (!program.hasGlyphForCodePoint(code)) continue
    const shape = glyphShape(program.glyphForCodePoint(code), program.unitsPerEm)
    if (!shape) continue
    shapeTotal += Math.abs(shape.width - source.width) + Math.abs(shape.height - source.height) +
      Math.abs(shape.stem - source.stem) * 3 + maskDifference(shape.mask, source.mask) * 800
    shapeCount += 1
  }
  return widthTotal / widthCount + (shapeCount ? shapeTotal / shapeCount : 0) + missing * 20
}

function styleName(weight, italic) {
  if (!italic) return WEIGHT_STYLES[weight] || 'Regular'
  return weight === 400 ? 'Italic' : `${WEIGHT_STYLES[weight] || ''}Italic`
}

/**
 * catalog() resolves to the catalog rows; download(url) to a font file's bytes.
 * Both are passed in so the library doesn't depend on where it runs.
 */
export function createFontLibrary({ catalog, download }) {
  let rowsPromise = null
  let weightMap = new Map()
  let entriesCache = null
  const files = new Map()

  const rows = () => {
    if (!rowsPromise) {
      rowsPromise = Promise.resolve().then(catalog).then((list) => {
        weightMap = new Map(list.map((row) => [normalizeFontKey(row.f), row.w]))
        return list
      }).catch((error) => {
        rowsPromise = null
        throw error
      })
    }
    return rowsPromise
  }

  const fetchFile = (url) => {
    if (!files.has(url)) {
      const pending = Promise.resolve().then(() => download(url))
      files.set(url, pending)
      pending.catch(() => files.delete(url))
    }
    return files.get(url)
  }

  const entryFor = (row, weight, italic) => {
    const style = styleName(weight, italic)
    const spaced = style.replace(/([a-z])([A-Z])/g, '$1 $2')
    return {
      source: 'library',
      row,
      family: row.f,
      style: spaced,
      fullName: `${row.f} ${spaced}`,
      postscriptName: `${row.f.replace(/\s+/g, '')}-${style}`,
      load(text = '') {
        const subset = pickSubset(text, row.s)
        if (!subset) throw new Error('This font has no letters for that language.')
        return fetchFile(fontFileUrl(row.i, subset, weight, italic ? 'italic' : 'normal'))
      },
    }
  }

  const nearestEntry = (row, request) => {
    const weight = nearestWeight(row, wantedWeight(request))
    const italic = row.n === 0 || (Boolean(request.italic) && Boolean(row.t))
    return entryFor(row, weight, italic)
  }

  return {
    rows,
    weightsFor: (family) => weightMap.get(normalizeFontKey(family)) || [],

    /** Every variant of every font, for lookups by name. */
    async entries() {
      if (!entriesCache) {
        entriesCache = (await rows()).flatMap((row) => row.w.flatMap((weight) => [
          ...(row.n === 0 ? [] : [entryFor(row, weight, false)]),
          ...(row.t ? [entryFor(row, weight, true)] : []),
        ]))
      }
      return entriesCache
    },

    /** Library fonts closest to the PDF's font, best first. */
    async closest(request, text, { shapes = null, extra = [] } = {}) {
      if (!request.sample?.length) return []
      const candidates = [...extra, ...rankByWidth(await rows(), request, text).map((row) => nearestEntry(row, request))]
      // A slow connection must not hold up the edit: whatever arrived in time is compared.
      const scored = await Promise.all(candidates.map((entry) => Promise.race([
        wait(CLOSEST_DEADLINE_MS, { entry, score: Infinity }),
        (async () => {
          try {
            const program = await openFontProgram(await entry.load(text), entry.postscriptName)
            return { entry, score: candidateScore(program, request, shapes) + (shapes ? 0 : plainBias(entry.row, request)) }
          } catch {
            return { entry, score: Infinity }
          }
        })(),
      ])))
      return scored.filter((item) => Number.isFinite(item.score)).sort((a, b) => a.score - b.score).map((item) => item.entry)
    },
  }
}

/** Fonts from every source, best first: uploaded, on this computer, then the free library. */
export function createCombinedFontProvider(local, library, uploads) {
  let stopWaiting = false
  const installedFonts = () => {
    const fonts = local.listFonts().catch(() => [])
    if (local.status === 'granted') return fonts
    if (stopWaiting) return []
    return Promise.race([fonts, wait(INSTALLED_WAIT_MS).then(() => { stopWaiting = true; return [] })])
  }
  return {
    get supported() { return local.supported },
    get denied() { return local.denied },
    get status() { return local.status },
    prepare: () => local.prepare(),
    prepareLibrary: () => library.rows(),
    async listFonts() {
      // The browser's font permission popup must never hold up an edit.
      const [uploaded, installed, free] = await Promise.all([
        uploads.list().catch(() => []),
        installedFonts(),
        library.entries().catch(() => []),
      ])
      return [...uploaded, ...installed, ...free]
    },
    weightsFor: (family) => library.weightsFor(family),
    async closest(request, text) {
      if (!request.sample?.length) return []
      const shapes = await this.shapeSource?.().catch(() => null)
      const extra = await uploads.list().catch(() => [])
      return library.closest(request, text, { shapes, extra })
    },
    /** The same provider, also able to compare against one block's letter shapes. */
    withShapes(shapeSource) {
      const scoped = Object.create(this)
      scoped.shapeSource = shapeSource
      return scoped
    },
  }
}
