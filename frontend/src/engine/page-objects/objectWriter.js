// Writes the objects added in the editor (text boxes, images, shapes, freehand
// drawings, highlights and notes) into the PDF.
//
// * Text, images, shapes and drawings become ordinary page content in an extra
//   content stream, so every PDF viewer shows them and the text is searchable.
// * Highlights, underlines, strike-outs and notes become standard PDF comment
//   annotations with appearance streams.
// * Unless `flatten` is set, the page also records an /EarthixLayer with the
//   editable object model, so Earthix can turn them back into adjustable
//   objects when the file is opened again.

import { PdfDocumentIndex } from '../pdf-parser/pdfDocumentIndex.js'
import { writeIncrementalUpdate } from '../pdf-parser/incrementalWriter.js'
import { deflate } from '../pdf-parser/pdfStreams.js'
import { formatPdfNumber, latin1Bytes, name, PdfDict, PdfRef, PdfString } from '../pdf-parser/pdfSyntax.js'
import { createEmbeddedFontEncoder, createStandardFontEncoder } from '../font-engine/fontEmbedder.js'
import { resolveFallbackFont } from '../font-engine/fallbackFonts.js'
import { normalizeFontKey } from '../font-engine/pdfFontLoader.js'
import { boxLocalToView, multiplyMatrix, pageGeometry, transformPoint } from './pageGeometry.js'
import { familyMetrics, isStandardFamily, standardFontFor, textObjectLayout } from './textLayout.js'
import { arrowHeadSegments, arrowShaftEnd, ellipseSegments, rectSegments, segmentsToPdf, strokeSegments } from './shapePaths.js'
import { buildImageXObject } from './imageCodec.js'

export const EARTHIX_LAYER_VERSION = 1
const ANNOTATION_TYPES = new Set(['highlight', 'note'])

const f = (value) => formatPdfNumber(Math.round((Number(value) || 0) * 1000) / 1000)
const matrixText = (m) => m.map(f).join(' ')

export function hexToRgb(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim())
  if (!match) return [0, 0, 0]
  const value = parseInt(match[1], 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((component) => component / 255)
}

const colorOps = (hex, stroke = false) => `${hexToRgb(hex).map(f).join(' ')} ${stroke ? 'RG' : 'rg'}`

function pdfTextString(text) {
  const value = String(text ?? '')
  if (/^[\x20-\x7e\r\n\t]*$/.test(value)) return new PdfString(latin1Bytes(value))
  const bytes = [0xfe, 0xff]
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    bytes.push(code >> 8, code & 255)
  }
  return new PdfString(Uint8Array.from(bytes))
}

function pdfDate(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return new PdfString(latin1Bytes(`D:${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`))
}

function hexCodes(parts, codeBytes) {
  const output = []
  let hex = ''
  for (const part of parts) {
    if (part.code !== undefined) {
      hex += part.code.toString(16).padStart(codeBytes * 2, '0').toUpperCase()
      continue
    }
    if (hex) { output.push(`<${hex}>`); hex = '' }
    if (Math.abs(part.adjust) > 0.0005) output.push(f(part.adjust))
  }
  if (hex) output.push(`<${hex}>`)
  return output.join(' ')
}

function randomTag() {
  let tag = ''
  for (let index = 0; index < 4; index += 1) tag += String.fromCharCode(65 + Math.floor(Math.random() * 26))
  return tag
}

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

const isBoldStyle = (style) => /bold|black|heavy|semibold|demi/i.test(style || '')
const isItalicStyle = (style) => /italic|oblique/i.test(style || '')

/** Chooses (and caches) the font program used for each text object. */
export class TextFontManager {
  constructor(fontProvider, warnings = []) {
    this.provider = fontProvider
    this.warnings = warnings
    this.entries = new Map()
    this.localList = null
  }

  async localFonts() {
    if (!this.localList) this.localList = this.provider ? await this.provider.listFonts().catch(() => []) : []
    return this.localList
  }

  register(key, encoder, extra = {}) {
    if (!this.entries.has(key)) this.entries.set(key, { key, encoder, ref: null, name: null, ...extra })
    return this.entries.get(key)
  }

  standard(fontName) {
    return this.register(`std:${fontName}`, createStandardFontEncoder(fontName))
  }

  async local(family, bold, italic, text) {
    const wanted = normalizeFontKey(family)
    const candidates = (await this.localFonts())
      .filter((entry) => normalizeFontKey(entry.family) === wanted)
      .sort((a, b) => (
        ((isBoldStyle(a.style) !== bold) * 4 + (isItalicStyle(a.style) !== italic) * 2 + (/light|thin|narrow|condensed|medium/i.test(a.style || '') ? 1 : 0)) -
        ((isBoldStyle(b.style) !== bold) * 4 + (isItalicStyle(b.style) !== italic) * 2 + (/light|thin|narrow|condensed|medium/i.test(b.style || '') ? 1 : 0))
      ))
    for (const entry of candidates) {
      const key = `local:${entry.postscriptName}`
      if (this.entries.has(key)) {
        const existing = this.entries.get(key)
        if (existing.encoder.canEncode(text)) return existing
        continue
      }
      try {
        const encoder = await createEmbeddedFontEncoder(await entry.load(), entry.postscriptName, entry.fullName)
        if (!encoder.canEncode(text)) continue
        return this.register(key, encoder)
      } catch {
        // Try the next style of the family.
      }
    }
    return null
  }

  /** Font for one text object; `text` is everything the object draws. */
  async forText(object, text) {
    const family = object.fontFamily || 'Helvetica'
    const bold = Boolean(object.bold)
    const italic = Boolean(object.italic)
    const visible = text.replace(/\s+/g, '')
    if (object.fontSource === 'local' && !isStandardFamily(family)) {
      const local = await this.local(family, bold, italic, visible)
      if (local) return local
    } else {
      const standard = this.standard(standardFontFor(family, bold, italic))
      if (standard.encoder.canEncode(visible)) return standard
    }
    const fallback = await resolveFallbackFont({ family, bold, italic, serif: family === 'Times', fixedPitch: family === 'Courier' }, visible || 'a', this.provider)
    if (fallback) {
      if (object.fontSource === 'local' && fallback.match !== 'exact') {
        this.warnings.push(`Used ${fallback.label} — “${family}” is not available here.`)
      }
      return this.register(`fallback:${fallback.label}:${fallback.encoder.kind}`, fallback.encoder)
    }
    this.warnings.push('Some letters couldn’t be drawn and show as “?”.')
    const standard = this.standard(standardFontFor(family, bold, italic))
    return { ...standard, lossy: true, entry: standard }
  }
}

// ---------------------------------------------------------------------------
// Content emission
// ---------------------------------------------------------------------------

function textOps(object, font, layout) {
  const ops = []
  const size = object.fontSize
  const encoder = font.encoder
  const lineWidth = Math.max(0.5, size * 0.055)
  if (object.backgroundColor) ops.push(`${colorOps(object.backgroundColor)} 0 0 ${f(layout.width)} ${f(layout.height)} re f`)
  if (object.borderColor && object.borderWidth > 0) {
    const inset = object.borderWidth / 2
    ops.push(`${f(object.borderWidth)} w ${colorOps(object.borderColor, true)} ${f(inset)} ${f(inset)} ${f(layout.width - object.borderWidth)} ${f(layout.height - object.borderWidth)} re S`)
  }
  for (const line of layout.lines) {
    if (!line.text.trim()) continue
    let text = line.text
    if (font.lossy) text = [...text].map((character) => (encoder.canEncode(character) ? character : '?')).join('')
    const glyphs = encoder.encode(text)
    const chunks = []
    let current = { rise: 0, parts: [] }
    for (const glyph of glyphs) {
      const rise = glyph.yOffset ? (glyph.yOffset / 1000) * size : 0
      if (Math.abs(rise - current.rise) > 0.001) {
        if (current.parts.length) chunks.push(current)
        current = { rise, parts: [] }
      }
      if (glyph.xOffset) current.parts.push({ adjust: -glyph.xOffset })
      current.parts.push({ code: glyph.code })
      if (glyph.xOffset) current.parts.push({ adjust: glyph.xOffset })
      if (glyph.kern) current.parts.push({ adjust: -glyph.kern })
    }
    if (current.parts.length) chunks.push(current)
    const body = chunks.map((chunk, index) => {
      const needsRise = chunk.rise || (index > 0 && chunks[index - 1].rise)
      return `${needsRise ? `${f(chunk.rise)} Ts ` : ''}[${hexCodes(chunk.parts, encoder.codeBytes)}] TJ`
    }).join(' ')
    ops.push(`BT /${font.name} ${f(size)} Tf ${colorOps(object.color)} 1 0 0 -1 ${f(line.x)} ${f(line.baseline)} Tm ${body}${chunks.some((chunk) => chunk.rise) ? ' 0 Ts' : ''} ET`)
    if (object.underline) ops.push(`${colorOps(object.color)} ${f(line.x)} ${f(line.baseline + size * 0.1)} ${f(line.width)} ${f(lineWidth)} re f`)
    if (object.strike) ops.push(`${colorOps(object.color)} ${f(line.x)} ${f(line.baseline - size * 0.3)} ${f(line.width)} ${f(lineWidth)} re f`)
  }
  return ops.join('\n')
}

function paintOperator(fill, stroke) {
  if (fill && stroke) return 'B'
  return fill ? 'f' : stroke ? 'S' : 'n'
}

function shapeOps(object) {
  const strokeWidth = Math.max(0, object.strokeWidth ?? 2)
  const stroke = strokeWidth > 0 && object.strokeColor
  const fill = object.fillColor
  const ops = ['1 j']
  if (stroke) ops.push(`${f(strokeWidth)} w ${colorOps(object.strokeColor, true)}`)
  if (stroke && object.dashed) ops.push(`[${f(strokeWidth * 3)} ${f(strokeWidth * 2)}] 0 d`)
  if (fill) ops.push(colorOps(fill))
  const inset = stroke ? strokeWidth / 2 : 0
  const width = Math.max(0, object.width - inset * 2)
  const height = Math.max(0, object.height - inset * 2)
  const segments = object.shape === 'ellipse'
    ? ellipseSegments(object.width / 2, object.height / 2, width / 2, height / 2)
    : rectSegments(inset, inset, width, height)
  ops.push(segmentsToPdf(segments, f), paintOperator(fill, stroke))
  return ops.join('\n')
}

function lineOps(object) {
  const [from, to] = object.points
  const strokeWidth = Math.max(0.5, object.strokeWidth ?? 2)
  const ops = [`1 J 1 j ${f(strokeWidth)} w ${colorOps(object.strokeColor || '#000000', true)}`]
  if (object.dashed) ops.push(`[${f(strokeWidth * 3)} ${f(strokeWidth * 2)}] 0 d`)
  const end = object.shape === 'arrow' ? arrowShaftEnd(from, to, strokeWidth) : to
  ops.push(`${f(from.x)} ${f(from.y)} m ${f(end.x)} ${f(end.y)} l S`)
  if (object.shape === 'arrow') ops.push(`[] 0 d ${colorOps(object.strokeColor || '#000000')} ${segmentsToPdf(arrowHeadSegments(from, to, strokeWidth), f)} f`)
  return ops.join('\n')
}

function inkOps(object) {
  const ops = [`1 J 1 j ${f(object.strokeWidth ?? 2)} w ${colorOps(object.color || '#000000', true)}`]
  for (const stroke of object.strokes || []) {
    if (!stroke.length) continue
    ops.push(`${segmentsToPdf(strokeSegments(stroke), f)} S`)
  }
  return ops.join('\n')
}

function highlightRectOps(object) {
  const ops = [colorOps(object.color || '#FFE066')]
  for (const rect of object.rects || []) {
    if (object.kind === 'underline') ops.push(`${f(rect.x)} ${f(rect.y + rect.height * 0.9)} ${f(rect.width)} ${f(Math.max(0.6, rect.height * 0.08))} re f`)
    else if (object.kind === 'strikeout') ops.push(`${f(rect.x)} ${f(rect.y + rect.height * 0.52)} ${f(rect.width)} ${f(Math.max(0.6, rect.height * 0.08))} re f`)
    else ops.push(`${f(rect.x)} ${f(rect.y)} ${f(rect.width)} ${f(rect.height)} re f`)
  }
  return ops.join('\n')
}

// Speech-bubble icon for notes, drawn in a 20 x 20 box (PDF coordinates, y up).
function noteIconOps(color) {
  const [r, g, b] = hexToRgb(color || '#FFC83D')
  const dark = [r, g, b].map((value) => value * 0.55)
  return [
    `${f(r)} ${f(g)} ${f(b)} rg ${dark.map(f).join(' ')} RG 1 w 1 j`,
    '3 18.5 m 17 18.5 l 18.2 18.5 19 17.7 19 16.5 c 19 7.5 l 19 6.3 18.2 5.5 17 5.5 c 9 5.5 l 5 1.5 l 6 5.5 l 3 5.5 l 1.8 5.5 1 6.3 1 7.5 c 1 16.5 l 1 17.7 1.8 18.5 3 18.5 c h B',
    `${dark.map(f).join(' ')} rg 4.5 14.5 11 1.2 re f 4.5 11.5 11 1.2 re f 4.5 8.5 7 1.2 re f`,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

function cloneDict(value) {
  return new PdfDict(value instanceof Map ? value : [])
}

function modelObject(object, imageRefs) {
  const copy = { ...object }
  delete copy.data
  if (object.type === 'image') copy.imageRef = imageRefs.get(object.assetId || object.id)?.num ?? null
  return copy
}

/**
 * Write editor objects into `bytes`. Returns { bytes, warnings }.
 * options.fontProvider supplies installed fonts (Local Font Access).
 */
export async function writePageObjects(bytes, objects, { fontProvider = null, flatten = false, author = 'Earthix PDF Studio' } = {}) {
  const warnings = []
  const list = (objects || []).filter((object) => object && Number.isInteger(object.pageIndex))
  if (!list.length) return { bytes, warnings }
  const index = await PdfDocumentIndex.open(bytes)
  const pages = index.getPages()
  let nextNumber = index.size
  const allocate = () => nextNumber++
  const updates = new Map()
  const current = (num) => updates.get(num)?.value ?? index.getObject(num)?.value
  const setObject = (num, value, stream) => {
    const gen = index.getObject(num)?.gen ?? 0
    updates.set(num, { num, gen, value, ...(stream ? { stream } : {}) })
  }
  const newObjects = []
  const tag = randomTag()
  const fonts = new TextFontManager(fontProvider, warnings)
  const imageRefs = new Map()
  const gsCache = new Map()
  let fontCounter = 0
  let imageCounter = 0
  let gsCounter = 0
  const now = pdfDate()

  const byPage = new Map()
  for (const object of list) {
    if (object.pageIndex >= pages.length) continue
    if (!byPage.has(object.pageIndex)) byPage.set(object.pageIndex, [])
    byPage.get(object.pageIndex).push(object)
  }

  for (const [pageIndex, pageObjects] of byPage) {
    const page = pages[pageIndex]
    const geometry = pageGeometry(index, page)
    const ordered = [...pageObjects].sort((a, b) => (a.z ?? 0) - (b.z ?? 0))
    const additions = { Font: new Map(), XObject: new Map(), ExtGState: new Map() }
    const ops = []
    const annotationRefs = []
    const pageRef = new PdfRef(page.num, page.gen ?? 0)

    const graphicsState = (fillAlpha, strokeAlpha = fillAlpha, blend = null) => {
      const key = `${f(fillAlpha)}|${f(strokeAlpha)}|${blend || ''}`
      if (!gsCache.has(key)) {
        const dict = new PdfDict([['Type', name('ExtGState')], ['ca', fillAlpha], ['CA', strokeAlpha]])
        if (blend) dict.set('BM', name(blend))
        const ref = new PdfRef(allocate(), 0)
        newObjects.push({ num: ref.num, gen: 0, value: dict })
        gsCache.set(key, { ref, name: `EX${tag}G${++gsCounter}` })
      }
      const entry = gsCache.get(key)
      additions.ExtGState.set(entry.name, entry.ref)
      return entry.name
    }

    for (const object of ordered) {
      const opacity = Number.isFinite(object.opacity) ? Math.max(0, Math.min(1, object.opacity)) : 1
      if (object.type === 'highlight' && !flatten) continue
      if (object.type === 'note') continue
      const gs = object.type === 'highlight'
        ? graphicsState(Number.isFinite(object.opacity) ? object.opacity : 0.45, 1, object.kind === 'highlight' || !object.kind ? 'Multiply' : null)
        : opacity < 1 ? graphicsState(opacity) : null
      const head = `q${gs ? ` /${gs} gs` : ''}`
      try {
        if (object.type === 'text') {
          if (!String(object.text || '').trim()) continue
          const font = await fonts.forText(object, object.text)
          const measure = (text) => font.encoder.measure(text, object.fontSize)
          const metrics = familyMetrics(object.fontFamily, font.encoder.metrics && !isStandardFamily(object.fontFamily) ? font.encoder.metrics : null)
          const layout = textObjectLayout(object, measure, metrics)
          const fontEntry = font.entry || font
          if (!fontEntry.ref) {
            fontEntry.ref = new PdfRef(allocate(), 0)
            fontEntry.name = `EX${tag}F${++fontCounter}`
          }
          additions.Font.set(fontEntry.name, fontEntry.ref)
          const box = { ...object, width: layout.width, height: layout.height }
          const matrix = multiplyMatrix(boxLocalToView(box), geometry.toUser)
          ops.push(`${head} ${matrixText(matrix)} cm\n${textOps(object, { ...font, name: fontEntry.name }, layout)}\nQ`)
        } else if (object.type === 'image') {
          if (!object.data?.length) continue
          const assetKey = object.assetId || object.id
          if (!imageRefs.has(assetKey)) {
            const built = await buildImageXObject(object.data, allocate)
            newObjects.push(...built.objects)
            imageRefs.set(assetKey, { ref: built.ref, num: built.ref.num, name: `EX${tag}I${++imageCounter}` })
          }
          const image = imageRefs.get(assetKey)
          additions.XObject.set(image.name, image.ref)
          const matrix = multiplyMatrix(boxLocalToView(object), geometry.toUser)
          ops.push(`${head} ${matrixText(matrix)} cm ${f(object.width)} 0 0 ${f(-object.height)} 0 ${f(object.height)} cm /${image.name} Do Q`)
        } else if (object.type === 'shape' && (object.shape === 'line' || object.shape === 'arrow')) {
          if (!Array.isArray(object.points) || object.points.length < 2) continue
          ops.push(`${head} ${matrixText(geometry.toUser)} cm\n${lineOps(object)}\nQ`)
        } else if (object.type === 'shape') {
          const matrix = multiplyMatrix(boxLocalToView(object), geometry.toUser)
          ops.push(`${head} ${matrixText(matrix)} cm\n${shapeOps(object)}\nQ`)
        } else if (object.type === 'ink') {
          ops.push(`${head} ${matrixText(geometry.toUser)} cm\n${inkOps(object)}\nQ`)
        } else if (object.type === 'highlight') {
          ops.push(`${head} ${matrixText(geometry.toUser)} cm\n${highlightRectOps(object)}\nQ`)
        }
      } catch {
        warnings.push(`One item on page ${pageIndex + 1} couldn’t be saved.`)
      }
    }

    // Annotations (comments).
    for (const object of ordered) {
      if (!ANNOTATION_TYPES.has(object.type)) continue
      if (object.type === 'highlight' && flatten) continue
      const annotRef = new PdfRef(allocate(), 0)
      const apRef = new PdfRef(allocate(), 0)
      const color = hexToRgb(object.color || (object.type === 'note' ? '#FFC83D' : '#FFE066'))
      let annot
      let apDict
      let apContent
      if (object.type === 'highlight') {
        const quads = []
        const points = []
        for (const rect of object.rects || []) {
          const corners = [[rect.x, rect.y], [rect.x + rect.width, rect.y], [rect.x, rect.y + rect.height], [rect.x + rect.width, rect.y + rect.height]]
            .map(([x, y]) => transformPoint(geometry.toUser, x, y))
          for (const corner of corners) { quads.push(corner.x, corner.y); points.push(corner) }
        }
        if (!points.length) continue
        const xs = points.map((point) => point.x)
        const ys = points.map((point) => point.y)
        const rect = [Math.min(...xs) - 1, Math.min(...ys) - 1, Math.max(...xs) + 1, Math.max(...ys) + 1]
        const subtype = object.kind === 'underline' ? 'Underline' : object.kind === 'strikeout' ? 'StrikeOut' : 'Highlight'
        const opacity = Number.isFinite(object.opacity) ? object.opacity : subtype === 'Highlight' ? 0.45 : 1
        const pathOps = []
        for (let offset = 0; offset < quads.length; offset += 8) {
          const [x1, y1, x2, y2, x3, y3, x4, y4] = quads.slice(offset, offset + 8)
          if (subtype === 'Highlight') {
            pathOps.push(`${f(x1)} ${f(y1)} m ${f(x2)} ${f(y2)} l ${f(x4)} ${f(y4)} l ${f(x3)} ${f(y3)} l h f`)
          } else {
            const height = Math.hypot(x3 - x1, y3 - y1)
            const thickness = Math.max(0.6, height * 0.08)
            const t = subtype === 'Underline' ? 0.92 : 0.5
            const ax = x1 + (x3 - x1) * t
            const ay = y1 + (y3 - y1) * t
            const bx = x2 + (x4 - x2) * t
            const by = y2 + (y4 - y2) * t
            pathOps.push(`${f(thickness)} w ${f(ax)} ${f(ay)} m ${f(bx)} ${f(by)} l S`)
          }
        }
        apContent = `/GS0 gs ${color.map(f).join(' ')} rg ${color.map(f).join(' ')} RG\n${pathOps.join('\n')}`
        const gsDict = new PdfDict([['Type', name('ExtGState')], ['ca', opacity], ['CA', opacity]])
        if (subtype === 'Highlight') gsDict.set('BM', name('Multiply'))
        apDict = new PdfDict([
          ['Type', name('XObject')], ['Subtype', name('Form')], ['BBox', rect],
          ['Resources', new PdfDict([['ExtGState', new PdfDict([['GS0', gsDict]])]])],
        ])
        annot = new PdfDict([
          ['Type', name('Annot')], ['Subtype', name(subtype)], ['Rect', rect], ['QuadPoints', quads],
          ['C', color], ['CA', opacity], ['F', 4], ['P', pageRef],
        ])
        if (object.comment) annot.set('Contents', pdfTextString(object.comment))
      } else {
        const topLeft = transformPoint(geometry.toUser, object.x, object.y)
        const bottomRight = transformPoint(geometry.toUser, object.x + 20, object.y + 20)
        const rect = [Math.min(topLeft.x, bottomRight.x), Math.min(topLeft.y, bottomRight.y), Math.max(topLeft.x, bottomRight.x), Math.max(topLeft.y, bottomRight.y)]
        apContent = noteIconOps(object.color)
        apDict = new PdfDict([['Type', name('XObject')], ['Subtype', name('Form')], ['BBox', [0, 0, 20, 20]]])
        annot = new PdfDict([
          ['Type', name('Annot')], ['Subtype', name('Text')], ['Rect', rect], ['Name', name('Comment')],
          ['C', color], ['F', 28], ['Open', false], ['P', pageRef], ['Contents', pdfTextString(object.text || '')],
        ])
      }
      annot.set('T', pdfTextString(object.author || author))
      annot.set('M', now)
      annot.set('NM', pdfTextString(object.id))
      const apBytes = await deflate(latin1Bytes(apContent))
      apDict.set('Filter', name('FlateDecode'))
      apDict.set('Length', apBytes.length)
      annot.set('AP', new PdfDict([['N', apRef]]))
      newObjects.push({ num: apRef.num, gen: 0, value: apDict, stream: apBytes }, { num: annotRef.num, gen: 0, value: annot })
      annotationRefs.push(annotRef)
    }

    const pageDict = cloneDict(current(page.num))
    let preRef = null
    let postRef = null
    if (ops.length) {
      preRef = new PdfRef(allocate(), 0)
      postRef = new PdfRef(allocate(), 0)
      const pre = latin1Bytes('q\n')
      // Leading newline: the original contents may not end with whitespace.
      const post = await deflate(latin1Bytes(`\nQ\n${ops.join('\n')}\n`))
      newObjects.push(
        { num: preRef.num, gen: 0, value: new PdfDict([['Length', pre.length]]), stream: pre },
        { num: postRef.num, gen: 0, value: new PdfDict([['Length', post.length], ['Filter', name('FlateDecode')]]), stream: post },
      )
      const contents = pageDict.get('Contents')
      const resolved = contents instanceof PdfRef ? index.resolve(contents) : contents
      const existing = Array.isArray(resolved) ? [...resolved] : contents instanceof PdfRef ? [contents] : []
      pageDict.set('Contents', [preRef, ...existing, postRef])

      // Resources: add our fonts, images and graphics states.
      const resourcesValue = pageDict.get('Resources')
      let resources
      let resourcesRef = null
      if (resourcesValue instanceof PdfRef) {
        resourcesRef = resourcesValue
        resources = cloneDict(current(resourcesValue.num))
      } else if (resourcesValue instanceof PdfDict) {
        resources = cloneDict(resourcesValue)
      } else {
        resources = cloneDict(index.resolve(page.inherited.Resources?.value))
      }
      for (const [category, entries] of Object.entries(additions)) {
        if (!entries.size) continue
        const existingCategory = resources.get(category)
        if (existingCategory instanceof PdfRef) {
          const dict = cloneDict(current(existingCategory.num))
          for (const [key, value] of entries) dict.set(key, value)
          setObject(existingCategory.num, dict)
        } else {
          const dict = cloneDict(index.resolve(existingCategory))
          for (const [key, value] of entries) dict.set(key, value)
          resources.set(category, dict)
        }
      }
      if (resourcesRef) setObject(resourcesRef.num, resources)
      else pageDict.set('Resources', resources)
    }
    if (annotationRefs.length) {
      const annots = index.resolve(pageDict.get('Annots'))
      pageDict.set('Annots', [...(Array.isArray(annots) ? annots : []), ...annotationRefs])
    }
    if (!flatten) {
      const model = {
        version: EARTHIX_LAYER_VERSION,
        rotate: geometry.rotate,
        viewBox: geometry.viewBox,
        objects: ordered.map((object) => modelObject(object, imageRefs)),
      }
      const modelRef = new PdfRef(allocate(), 0)
      const modelBytes = await deflate(new TextEncoder().encode(JSON.stringify(model)))
      newObjects.push({ num: modelRef.num, gen: 0, value: new PdfDict([['Length', modelBytes.length], ['Filter', name('FlateDecode')]]), stream: modelBytes })
      const layer = new PdfDict([['Type', name('EarthixLayer')], ['Version', EARTHIX_LAYER_VERSION], ['Model', modelRef], ['Annots', annotationRefs]])
      if (preRef) { layer.set('Pre', preRef); layer.set('Post', postRef) }
      pageDict.set('EarthixLayer', layer)
    }
    setObject(page.num, pageDict)
  }

  for (const entry of fonts.entries.values()) {
    if (!entry.ref) continue
    const built = await entry.encoder.buildObjects(allocate, entry.ref.num)
    newObjects.push(...built.objects)
  }

  const output = writeIncrementalUpdate(index, [...updates.values(), ...newObjects])
  return { bytes: output, warnings: [...new Set(warnings)] }
}
