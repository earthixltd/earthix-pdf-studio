// Text box layout shared by the on-page editor and the PDF writer, so line
// breaks, alignment and baselines are identical on screen and in the file.

import { loadStandardFontMetrics, standardFontName, winAnsiEncodeCharacter } from '../font-engine/standardFonts.js'

export const TEXT_PADDING = 2

export const STANDARD_FAMILIES = [
  { id: 'Helvetica', label: 'Helvetica (Arial)', css: 'Helvetica, Arial, "Liberation Sans", Arimo, sans-serif', ascent: 0.905, descent: 0.212 },
  { id: 'Times', label: 'Times New Roman', css: '"Times New Roman", Times, "Liberation Serif", Tinos, serif', ascent: 0.891, descent: 0.216 },
  { id: 'Courier', label: 'Courier New', css: '"Courier New", Courier, "Liberation Mono", Cousine, monospace', ascent: 0.833, descent: 0.3 },
]

const STANDARD_BY_ID = new Map(STANDARD_FAMILIES.map((family) => [family.id, family]))

export function isStandardFamily(family) {
  return STANDARD_BY_ID.has(family)
}

export function standardFontFor(family, bold, italic) {
  return standardFontName(isStandardFamily(family) ? family : 'Helvetica', bold, italic)
}

const NOTE_FONT_SIZE = 11
const NOTE_MIN_WIDTH = 44
const NOTE_MAX_WIDTH = 220
const NOTE_PADDING = 5

/** Dark or white, whichever reads better on the comment's colour. */
function readableOn(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex || '')
  if (!match) return '#1B2333'
  const value = parseInt(match[1], 16)
  const brightness = (((value >> 16) & 255) * 299 + ((value >> 8) & 255) * 587 + (value & 255) * 114) / 1000
  return brightness > 110 ? '#1B2333' : '#FFFFFF'
}

/**
 * The message box of a comment, sized to its words. It appears when the
 * comment's icon is clicked. Returns null for an empty comment.
 */
export function noteMessage(note) {
  const text = String(note?.text ?? '').replace(/\s+$/, '')
  if (!text.trim()) return null
  const measure = (value) => createStandardMeasurer('Helvetica')(value, NOTE_FONT_SIZE)
  const longest = Math.max(...text.split('\n').map(measure))
  const width = Math.min(NOTE_MAX_WIDTH, Math.max(NOTE_MIN_WIDTH, Math.ceil(longest) + NOTE_PADDING * 2 + 2))
  const layout = layoutText({ text, fontSize: NOTE_FONT_SIZE, lineHeight: 1.3, wrapWidth: width - NOTE_PADDING * 2, measure, metrics: familyMetrics('Helvetica') })
  return {
    text,
    width,
    height: layout.contentHeight + NOTE_PADDING * 2,
    padding: NOTE_PADDING,
    fontSize: NOTE_FONT_SIZE,
    lineHeight: 1.3,
    color: readableOn(note.color),
    background: note.color || '#FDB022',
  }
}

/** Numeric weight of a text object; older items only carry the bold flag. */
export function textWeight(object) {
  return Number.isFinite(object?.weight) && object.weight > 0 ? object.weight : object?.bold ? 700 : 400
}

export function cssFontFamily(family) {
  const standard = STANDARD_BY_ID.get(family)
  if (standard) return standard.css
  const safe = String(family || 'Helvetica').replace(/["\\]/g, '')
  return `"${safe}", Helvetica, Arial, sans-serif`
}

/** Vertical metrics (em units) used for baselines on screen and in the PDF. */
export function familyMetrics(family, override) {
  if (override && Number.isFinite(override.ascent) && Number.isFinite(override.descent)) return override
  const standard = STANDARD_BY_ID.get(family)
  return standard ? { ascent: standard.ascent, descent: standard.descent } : { ascent: 0.9, descent: 0.22 }
}

const measurerCache = new Map()
/** Exact advance widths of a standard-14 font (WinAnsi), in points at `size`. */
export function createStandardMeasurer(fontName) {
  if (measurerCache.has(fontName)) return measurerCache.get(fontName)
  const metrics = loadStandardFontMetrics(fontName)
  const widths = new Map()
  const widthOf = (character) => {
    if (widths.has(character)) return widths.get(character)
    const encoded = winAnsiEncodeCharacter(character)
    const width = encoded ? (metrics?.getWidthOfGlyph(encoded.name) ?? 500) : 556
    widths.set(character, width)
    return width
  }
  const measure = (text, size) => {
    let total = 0
    for (const character of text) total += widthOf(character)
    return (total * size) / 1000
  }
  measurerCache.set(fontName, measure)
  return measure
}

function breakLongWord(word, width, measure) {
  const pieces = []
  let current = ''
  for (const character of word) {
    if (current && measure(current + character) > width) {
      pieces.push(current)
      current = character
    } else current += character
  }
  if (current) pieces.push(current)
  return pieces
}

/**
 * Lay out a text box. `measure(text)` returns a width in points at the box's
 * font size. `wrapWidth` (content width) enables word wrapping; null keeps
 * the author's line breaks only.
 */
export function layoutText({ text, fontSize, lineHeight = 1.25, wrapWidth = null, measure, metrics }) {
  const paragraphs = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  const lines = []
  for (const paragraph of paragraphs) {
    if (!(wrapWidth > 0)) { lines.push(paragraph); continue }
    const tokens = paragraph.split(/(\s+)/).filter((token) => token.length)
    let current = ''
    for (const token of tokens) {
      const isSpace = /^\s+$/.test(token)
      const candidate = current + token
      if (isSpace) { current = candidate; continue }
      if (!current.trim() || measure(candidate.trimEnd()) <= wrapWidth) {
        if (!current.trim() && measure(token) > wrapWidth) {
          const pieces = breakLongWord(token, wrapWidth, measure)
          lines.push(...pieces.slice(0, -1).map((piece, index) => (index === 0 ? current + piece : piece)))
          current = pieces.at(-1) || ''
        } else current = candidate
        continue
      }
      lines.push(current.trimEnd())
      if (measure(token) > wrapWidth) {
        const pieces = breakLongWord(token, wrapWidth, measure)
        lines.push(...pieces.slice(0, -1))
        current = pieces.at(-1) || ''
      } else current = token
    }
    lines.push(current.trimEnd())
  }
  const { ascent, descent } = metrics
  const lineBox = fontSize * lineHeight
  const baselineOffset = (lineBox - (ascent + descent) * fontSize) / 2 + ascent * fontSize
  const measured = lines.map((line) => ({ text: line, width: measure(line) }))
  return {
    lines: measured,
    lineBox,
    baselineOffset,
    contentWidth: Math.max(0, ...measured.map((line) => line.width)),
    contentHeight: Math.max(1, measured.length) * lineBox,
  }
}

/**
 * Full geometry of a text object in its local frame (origin top-left, y down):
 * box size plus per-line x offset and baseline.
 */
export function textObjectLayout(object, measure, metrics) {
  const padding = TEXT_PADDING
  const wrapWidth = object.autoWidth ? null : Math.max(4, object.width - padding * 2)
  const layout = layoutText({ text: object.text, fontSize: object.fontSize, lineHeight: object.lineHeight || 1.25, wrapWidth, measure, metrics })
  const width = object.autoWidth ? layout.contentWidth + padding * 2 : object.width
  const height = layout.contentHeight + padding * 2
  const innerWidth = width - padding * 2
  const lines = layout.lines.map((line, index) => {
    const free = Math.max(0, innerWidth - line.width)
    const offset = object.align === 'center' ? free / 2 : object.align === 'right' ? free : 0
    return { ...line, x: padding + offset, baseline: padding + index * layout.lineBox + layout.baselineOffset }
  })
  return { width: Math.max(width, 6), height, lines, lineBox: layout.lineBox }
}
