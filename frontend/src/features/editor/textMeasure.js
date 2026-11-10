// Text measurement for the on-page preview. Standard PDF fonts use their exact
// AFM metrics; installed fonts are measured with the font file itself (via
// fontkit) once it has loaded, so the preview wraps exactly like the PDF.

import {
  createStandardMeasurer, cssFontFamily, familyMetrics, isStandardFamily, standardFontFor, textObjectLayout, textWeight,
} from '../../engine/page-objects/textLayout.js'
import { openFontProgram } from '../../engine/font-engine/fontEmbedder.js'
import { normalizeFontKey } from '../../engine/font-engine/pdfFontLoader.js'
import { styleDistance } from '../../engine/font-engine/fallbackFonts.js'

let fontProvider = null
const localFonts = new Map()
const listeners = new Set()
let canvasContext = null

export function setMeasureFontProvider(provider) {
  fontProvider = provider
}

export function subscribeFontLoads(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function loadLocalFont(family, weight, italic) {
  const key = `${normalizeFontKey(family)}|${weight}|${italic ? 1 : 0}`
  if (localFonts.has(key)) return localFonts.get(key)
  const entry = { status: 'loading', font: null }
  localFonts.set(key, entry)
  void (async () => {
    try {
      const fonts = fontProvider ? await fontProvider.listFonts() : []
      const candidates = fonts
        .filter((item) => normalizeFontKey(item.family) === normalizeFontKey(family))
        .sort((a, b) => styleDistance(a.style, { weight, italic }) - styleDistance(b.style, { weight, italic }))
      if (!candidates.length) throw new Error('not installed')
      entry.font = await openFontProgram(await candidates[0].load(''), candidates[0].postscriptName)
      entry.status = 'ready'
    } catch {
      entry.status = 'failed'
    }
    for (const listener of listeners) listener()
  })()
  return entry
}

function canvasMeasure(text, size, family, weight, italic) {
  if (!canvasContext) {
    const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null
    canvasContext = canvas?.getContext('2d') || null
  }
  if (!canvasContext) return text.length * size * 0.5
  canvasContext.font = `${italic ? 'italic ' : ''}${weight} 100px ${cssFontFamily(family)}`
  return (canvasContext.measureText(text).width / 100) * size
}

/** { measure(text) -> points, metrics } for a text object's font and size. */
export function measurerFor(object) {
  const family = object.fontFamily || 'Helvetica'
  const weight = textWeight(object)
  const bold = weight >= 600
  const italic = Boolean(object.italic)
  const size = object.fontSize || 12
  if (isStandardFamily(family) || object.fontSource !== 'local') {
    const measure = createStandardMeasurer(standardFontFor(family, bold, italic))
    return { measure: (text) => measure(text, size), metrics: familyMetrics(family), ready: true }
  }
  const entry = loadLocalFont(family, weight, italic)
  if (entry.status === 'ready' && entry.font) {
    const font = entry.font
    return {
      measure: (text) => (text ? (font.layout(text).advanceWidth / font.unitsPerEm) * size : 0),
      metrics: { ascent: font.ascent / font.unitsPerEm, descent: Math.abs(font.descent) / font.unitsPerEm },
      ready: true,
    }
  }
  return { measure: (text) => canvasMeasure(text, size, family, weight, italic), metrics: familyMetrics(family), ready: entry.status !== 'loading' }
}

export function layoutTextObject(object) {
  const { measure, metrics } = measurerFor(object)
  return textObjectLayout(object, measure, metrics)
}

/** Recompute a text object's box size from its content. */
export function fitTextObject(object) {
  const layout = layoutTextObject(object)
  return { ...object, width: object.autoWidth ? layout.width : object.width, height: layout.height }
}

export function textCss(object, scale = 1) {
  return {
    fontFamily: cssFontFamily(object.fontFamily),
    fontWeight: textWeight(object),
    fontStyle: object.italic ? 'italic' : 'normal',
    fontSize: `${(object.fontSize || 12) * scale}px`,
    lineHeight: `${(object.fontSize || 12) * (object.lineHeight || 1.25) * scale}px`,
    color: object.color || '#000000',
    textDecoration: [object.underline ? 'underline' : '', object.strike ? 'line-through' : ''].filter(Boolean).join(' ') || 'none',
  }
}
