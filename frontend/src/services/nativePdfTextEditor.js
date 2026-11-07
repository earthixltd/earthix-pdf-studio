// Earthix native PDF text editor.
//
// Text is edited inside the page content streams themselves: the original
// text-showing operators are rewritten in place (no overlay, no duplicate).
// Font, size, colour, rendering mode and matrices are inherited from the
// original graphics state. When the original embedded (subset) font lacks a
// typed character, the same font installed on this computer — or the closest
// available match — is embedded and used for that text block only.
// Words that follow the edited text on the same line are moved by exactly the
// width difference so lengthening or shortening text never overlaps.

import { PdfDocumentIndex } from '../engine/pdf-parser/pdfDocumentIndex.js'
import { writeIncrementalUpdate } from '../engine/pdf-parser/incrementalWriter.js'
import { deflate } from '../engine/pdf-parser/pdfStreams.js'
import { formatPdfNumber, latin1Bytes, name, PdfDict, PdfRef } from '../engine/pdf-parser/pdfSyntax.js'
import { interpretPageText } from '../engine/content-stream/contentStream.js'
import { buildTextBlocks, hasSeparatorBetween, runAlong, runAngle } from '../engine/content-stream/textBlocks.js'
import { resolveFallbackFont } from '../engine/font-engine/fallbackFonts.js'
import { createStandardFontEncoder } from '../engine/font-engine/fontEmbedder.js'
import { normalizeFontKey } from '../engine/font-engine/pdfFontLoader.js'
import { invertMatrix, multiplyMatrix, pageGeometry, rotateMatrix, scaleMatrix, transformPoint, translateMatrix } from '../engine/page-objects/pageGeometry.js'
import { isStandardFamily, standardFontFor } from '../engine/page-objects/textLayout.js'
import { buildImageXObject, detectImageFormat } from '../engine/page-objects/imageCodec.js'

const dot = (point, vector) => point.x * vector.x + point.y * vector.y
const stripSpaces = (value) => String(value || '').replace(/\s+/g, '')
// Scripts whose PDF glyph order differs from Unicode order (Indic, Arabic, Hebrew, Thai, ...).
const COMPLEX_SCRIPT = /[\u0590-\u08ff\u0900-\u0dff\u0e00-\u0fff\u1000-\u109f\u1780-\u17ff]/

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

async function analyzeDocument(bytes) {
  const index = await PdfDocumentIndex.open(bytes)
  const pages = index.getPages()
  const context = { fontCache: new Map(), streams: new Map(), runs: [], warnings: [], activeForms: new Set() }
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    try {
      await interpretPageText(index, pages[pageIndex], pageIndex, context)
    } catch (error) {
      context.warnings.push(`Page ${pageIndex + 1}: ${error?.message || 'text could not be read'}`)
    }
  }

  // Keys must be unique even when a Form XObject is drawn more than once.
  const seen = new Map()
  for (const run of context.runs) {
    const count = seen.get(run.key) || 0
    seen.set(run.key, count + 1)
    if (count) run.key = `${run.key}#${count}`
  }

  const metadataCache = new Map()
  const fontRecords = new Map()
  for (const run of context.runs) {
    const font = context.fontCache.get(run.fontKey)
    if (!font) continue
    const resourceName = run.fontResource || 'ExtGState'
    const cacheKey = `${run.fontKey}|${resourceName}`
    if (!metadataCache.has(cacheKey)) metadataCache.set(cacheKey, font.metadataFor(resourceName))
    const metadata = metadataCache.get(cacheKey)
    run.fontMetadata = metadata
    run.fontInfoId = `${run.pageIndex}:${metadata.id}`
    run.fontEncoding = metadata.encoding
    const record = fontRecords.get(metadata.id)
    if (record) {
      if (!record.pageIndices.includes(run.pageIndex)) {
        record.pageIndices.push(run.pageIndex)
        record.pageNumbers.push(run.pageIndex + 1)
      }
    } else fontRecords.set(metadata.id, { ...metadata, pageIndices: [run.pageIndex], pageNumbers: [run.pageIndex + 1] })
  }

  const runsByPage = new Map()
  context.runsByKey = new Map()
  for (const run of context.runs) {
    context.runsByKey.set(run.key, run)
    if (!runsByPage.has(run.pageIndex)) runsByPage.set(run.pageIndex, [])
    runsByPage.get(run.pageIndex).push(run)
  }
  const blocks = []
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    for (const block of buildTextBlocks(runsByPage.get(pageIndex) || [], pageIndex, context.rules?.get(pageIndex))) {
      decorateBlock(block, context)
      blocks.push(block)
    }
  }
  const images = describeImages(index, pages, context.images || [])
  return { index, pages, context, runs: context.runs, blocks, images, fonts: [...fontRecords.values()], rules: context.rules || new Map() }
}

export { analyzeDocument as analyzePdfDocument }

/** Page images with their on-screen box (view space at 100 %). */
function describeImages(index, pages, images) {
  const geometries = new Map()
  const seen = new Map()
  return images.map((image) => {
    if (!geometries.has(image.pageIndex)) geometries.set(image.pageIndex, pageGeometry(index, pages[image.pageIndex]))
    const geometry = geometries.get(image.pageIndex)
    const corners = image.corners.map((point) => transformPoint(geometry.toView, point.x, point.y))
    const xs = corners.map((point) => point.x)
    const ys = corners.map((point) => point.y)
    const count = seen.get(image.key) || 0
    seen.set(image.key, count + 1)
    let editable = true
    let reason = ''
    if (image.depth > 0 || image.owner?.kind !== 'page') {
      editable = false
      reason = 'This image is part of a reusable graphic in the PDF, so it cannot be moved or replaced on its own.'
    }
    return {
      key: count ? `${image.key}#${count}` : image.key,
      pageIndex: image.pageIndex,
      pageNumber: image.pageIndex + 1,
      kind: image.kind,
      name: image.name,
      pixelWidth: image.pixelWidth,
      pixelHeight: image.pixelHeight,
      imageMask: image.imageMask,
      viewRect: { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) },
      viewCorners: corners,
      pageSize: { width: geometry.width, height: geometry.height },
      editable,
      reason,
      // Internal (not needed by the UI).
      streamObjectNumber: image.streamObjectNumber,
      start: image.start,
      end: image.end,
      ctm: image.ctm,
      depth: image.depth,
    }
  }).filter((image) => image.viewRect.width > 0.5 && image.viewRect.height > 0.5)
}

function decorateBlock(block, context) {
  const run = context.runsByKey?.get(block.runKeys[0]) || context.runs.find((item) => item.key === block.runKeys[0])
  const font = context.fontCache.get(block.fontKey)
  block.fontMetadata = run?.fontMetadata || null
  block.cssFontStack = font?.cssFontStack || 'sans-serif'
  block.fontWeight = font?.bold ? 700 : 400
  block.fontStyle = font?.italic ? 'italic' : 'normal'
  block.ascentUser = ((font?.ascent ?? 800) / 1000) * block.fontSizeUser
  block.descentUser = ((font?.descent ?? -200) / 1000) * block.fontSizeUser
  block.editable = true
  block.reason = ''
  if (!block.decodable) {
    block.editable = false
    block.reason = 'Some characters of this text have no Unicode mapping in the PDF, so it cannot be edited without changing its meaning.'
  } else if (COMPLEX_SCRIPT.test(block.text)) {
    block.editable = false
    block.reason = 'Hindi and other complex-script text is stored as shaped glyphs in PDFs; editing it is not supported yet.'
  } else if (!run?.fontResource) {
    block.editable = false
    block.reason = 'This text selects its font through a graphics-state resource, which cannot be edited safely yet.'
  } else if (font?.unsupportedReason) {
    block.editable = false
    block.reason = font.unsupportedReason
  }
}

function toPublicInspection(analysis, bytes) {
  const runs = analysis.runs.filter((run) => run.decodable && !run.invisible)
  return {
    runs,
    blocks: analysis.blocks,
    images: analysis.images,
    fonts: analysis.fonts,
    pageCount: analysis.pages.length,
    warnings: analysis.context.warnings,
    repaired: analysis.index.repaired,
    sourceBytes: bytes.slice(),
  }
}

export async function inspectNativePdfText(bytes) {
  const analysis = await analyzeDocument(bytes)
  return toPublicInspection(analysis, bytes)
}

// ---------------------------------------------------------------------------
// Content-stream emission helpers
// ---------------------------------------------------------------------------

function hexCode(code, codeBytes) {
  return code.toString(16).padStart(codeBytes * 2, '0').toUpperCase()
}

/** Serialise [{code}|{adjust}] elements as the inside of a TJ array. */
function elementsToTJ(elements, codeBytes) {
  const parts = []
  let hex = ''
  for (const element of elements) {
    if (element.code !== undefined) {
      hex += hexCode(element.code, codeBytes)
      continue
    }
    if (hex) { parts.push(`<${hex}>`); hex = '' }
    if (Math.abs(element.adjust) > 0.0005) parts.push(formatPdfNumber(Number(element.adjust.toFixed(3))))
  }
  if (hex) parts.push(`<${hex}>`)
  return parts.join(' ')
}

function showPrefix(run) {
  if (run.operator === "'") return 'T* '
  if (run.operator === '"') {
    const [aw, ac] = run.extraOperands || [run.wordSpacing, run.characterSpacing]
    return `${formatPdfNumber(aw)} Tw ${formatPdfNumber(ac)} Tc T* `
  }
  return ''
}

const originalElements = (glyphs) => glyphs.map((glyph) => (glyph.code !== undefined ? { code: glyph.code } : { adjust: glyph.adjust }))

function textSpaceUnitsToAdjust(units, run) {
  const scale = run.fontSize * (run.horizontalScaling / 100)
  return scale ? (-units * 1000) / scale : 0
}

function adjustToTextSpace(adjust, run) {
  return (-adjust / 1000) * run.fontSize * (run.horizontalScaling / 100)
}

function averageVirtualSpace(blockRuns) {
  const values = blockRuns.flatMap((run) => run.glyphs.filter((glyph) => glyph.virtualSpace).map((glyph) => glyph.adjust))
  if (!values.length) return -250
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

function codePoints(value) {
  return [...value]
}

function computeDiff(oldChars, newText) {
  const oldPoints = oldChars.map((item) => item.ch)
  const newPoints = codePoints(newText)
  let prefix = 0
  while (prefix < oldPoints.length && prefix < newPoints.length && oldPoints[prefix] === newPoints[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < oldPoints.length - prefix && suffix < newPoints.length - prefix &&
    oldPoints[oldPoints.length - 1 - suffix] === newPoints[newPoints.length - 1 - suffix]
  ) suffix += 1
  const sameItem = (a, b) => a && b && a.kind === 'glyph' && b.kind === 'glyph' && a.run === b.run && a.item === b.item
  // Never split a ligature glyph (one code drawing several characters).
  while (prefix > 0 && prefix < oldChars.length && sameItem(oldChars[prefix], oldChars[prefix - 1])) prefix -= 1
  let suffixStart = oldChars.length - suffix
  while (suffix > 0 && suffixStart > 0 && sameItem(oldChars[suffixStart], oldChars[suffixStart - 1])) { suffix -= 1; suffixStart += 1 }
  return { prefix, suffix, middle: newPoints.slice(prefix, newPoints.length - suffix).join('') }
}

/**
 * Plan the content-stream rewrite for one block. Returns the stream edits, the
 * along-line width change (delta, user space) and the old/new extent.
 */
function planBlockRewrite({ block, blockRuns, font, newText, fallback, fallbackResourceName }) {
  const chars = block.chars
  let { prefix, suffix, middle } = computeDiff(chars, newText)
  if (fallback) { prefix = 0; suffix = 0; middle = newText }
  const lastRun = blockRuns.length - 1

  let firstRun
  let prefixEnd
  if (prefix < chars.length) {
    const item = chars[prefix]
    firstRun = item.run
    prefixEnd = item.kind === 'gap' ? blockRuns[item.run].glyphs.length : item.item
  } else {
    firstRun = lastRun
    prefixEnd = blockRuns[lastRun].glyphs.length
  }
  let endRun
  let suffixStart
  let suffixGap = 0
  if (suffix > 0) {
    const item = chars[chars.length - suffix]
    if (item.kind === 'gap') { endRun = item.run + 1; suffixStart = 0; suffixGap = item.gap }
    else { endRun = item.run; suffixStart = item.item }
  } else {
    endRun = Math.max(firstRun, prefix < chars.length ? chars[chars.length - 1].run : lastRun)
    suffixStart = blockRuns[endRun].glyphs.length
  }
  if (endRun < firstRun) { endRun = firstRun; suffixStart = prefixEnd }

  const target = blockRuns[firstRun]
  const horizontal = target.horizontalScaling / 100
  const elements = []
  let advance = 0
  const pushOriginal = (glyphs) => {
    for (const glyph of glyphs) {
      if (glyph.code !== undefined) {
        elements.push({ code: glyph.code, font: 'original' })
        advance += glyph.advance
      } else {
        elements.push({ adjust: glyph.adjust })
        advance += adjustToTextSpace(glyph.adjust, target)
      }
    }
  }
  pushOriginal(target.glyphs.slice(0, prefixEnd))

  // Middle (new) text.
  const spaceAdjust = averageVirtualSpace(blockRuns)
  if (fallback) {
    for (const glyph of fallback.encoder.encode(middle)) {
      elements.push({ code: glyph.code, font: 'fallback' })
      const isOneByteSpace = fallback.encoder.codeBytes === 1 && glyph.code === 32
      advance += ((glyph.width / 1000) * target.fontSize + target.characterSpacing + (isOneByteSpace ? target.wordSpacing : 0)) * horizontal
      let extra = glyph.kern ? -glyph.kern : 0
      if (glyph.isSpace && fallback.encoder.codeBytes === 2 && target.wordSpacing && target.fontSize) {
        extra += (-target.wordSpacing * 1000) / target.fontSize
      }
      if (extra) {
        elements.push({ adjust: extra })
        advance += adjustToTextSpace(extra, target)
      }
    }
  } else {
    for (const character of middle) {
      const isWhitespace = /\s/.test(character)
      const code = font.encodeCharacter(isWhitespace ? ' ' : character)
      if (code === null || code === undefined) {
        if (!isWhitespace) throw new Error(`The font cannot draw “${character}”.`)
        elements.push({ adjust: spaceAdjust })
        advance += adjustToTextSpace(spaceAdjust, target)
        continue
      }
      elements.push({ code, font: 'original' })
      const isSpace = font.codeBytes === 1 && code === 32
      advance += (font.widthOf(code) * target.fontSize + target.characterSpacing + (isSpace ? target.wordSpacing : 0)) * horizontal
    }
  }

  // Suffix.
  if (endRun !== firstRun) {
    if (suffixGap > 0) {
      const adjust = textSpaceUnitsToAdjust(suffixGap / target.scaleX, target)
      elements.push({ adjust })
      advance += suffixGap / target.scaleX
    }
    pushOriginal(blockRuns[endRun].glyphs.slice(suffixStart))
  } else {
    pushOriginal(target.glyphs.slice(suffixStart))
  }

  // Keep the operator's original advance so absolutely positioned content
  // after it is untouched; following text is moved explicitly instead.
  const keepAdvance = textSpaceUnitsToAdjust(target.advance - advance, target)
  const finalElements = [...elements, { adjust: keepAdvance }]

  let operatorText
  if (fallback) {
    const glyphElements = finalElements.map((element) => (element.code !== undefined ? { code: element.code } : element))
    operatorText = `${showPrefix(target)}/${fallbackResourceName} ${formatPdfNumber(target.fontSize)} Tf [${elementsToTJ(glyphElements, fallback.encoder.codeBytes)}] TJ /${target.fontResource} ${formatPdfNumber(target.fontSize)} Tf`
  } else {
    operatorText = `${showPrefix(target)}[${elementsToTJ(finalElements, font.codeBytes)}] TJ`
  }

  const edits = [{ run: target, text: operatorText }]
  for (let runIndex = firstRun + 1; runIndex <= endRun; runIndex += 1) {
    const run = blockRuns[runIndex]
    const adjust = textSpaceUnitsToAdjust(run.advance, run)
    const blank = Math.abs(adjust) > 0.0005 ? `[${formatPdfNumber(Number(adjust.toFixed(3)))}] TJ` : ''
    edits.push({ run, text: `${showPrefix(run)}${blank}`.trim() || ' ' })
  }

  const direction = block.direction
  const newEnd = dot(target.originPoint, direction) + advance * target.scaleX
  const oldEnd = dot(blockRuns[endRun].advanceEndPoint, direction)
  return { edits, delta: newEnd - oldEnd, oldEnd, newEnd, endRun, firstRun }
}

function buildShiftEdits({ analysis, block, blockRunKeys, excludedKeys, oldEnd, delta, codeBytesFor }) {
  if (Math.abs(delta) < 0.01) return { edits: [], warnings: [] }
  const warnings = []
  const direction = block.direction
  const size = block.fontSizeUser
  const blockStart = dot(block.startPoint, direction)
  const baseline = dot(block.startPoint, block.normal)
  const angle = block.angle
  const pageRuns = analysis.runs.filter((run) => run.pageIndex === block.pageIndex && run.glyphs.length)
  const onLine = pageRuns.filter((run) => (
    !excludedKeys.has(run.key) &&
    Math.abs(runAngle(run) - angle) <= 1 &&
    Math.abs(dot(run.startPoint, block.normal) - baseline) <= Math.max(0.5, 0.3 * size)
  ))
  const candidates = onLine
    .map((run) => ({ run, ...runAlong(run, direction) }))
    .filter((item) => item.start >= blockStart - 0.3 * size && (blockRunKeys.has(item.run.key) || item.start >= oldEnd - 0.5 * size))
    .sort((a, b) => a.start - b.start)

  const rules = analysis.rules.get(block.pageIndex) || []
  const line = { direction, normal: block.normal, baseline, size }
  const chain = new Set()
  let lastEnd = oldEnd
  let nextOutside = null
  for (const item of candidates) {
    // Stop at wide gaps and at painted rules (table borders, box edges): text
    // in the next column or cell keeps its position.
    if (item.start - lastEnd > 1.0 * size || hasSeparatorBetween(rules, line, lastEnd, item.start)) { nextOutside = item; break }
    chain.add(item.run.key)
    lastEnd = Math.max(lastEnd, item.end)
  }
  let boundary = nextOutside ? nextOutside.start : Infinity
  for (const rule of rules) {
    const a1 = rule.x1 * direction.x + rule.y1 * direction.y
    const a2 = rule.x2 * direction.x + rule.y2 * direction.y
    if (Math.abs(a1 - a2) > 0.75 || a1 <= lastEnd - 0.25 || a1 >= boundary) continue
    const c1 = rule.x1 * block.normal.x + rule.y1 * block.normal.y
    const c2 = rule.x2 * block.normal.x + rule.y2 * block.normal.y
    if (Math.min(c1, c2) <= baseline + 0.6 * size && Math.max(c1, c2) >= baseline - 0.1 * size) boundary = a1
  }
  if (delta > 0 && lastEnd + delta > boundary - 0.05 * size) {
    warnings.push('The edited text is now wider than the space available and may cross a table border or the next column.')
  } else if (delta > 0 && !Number.isFinite(boundary)) {
    // Right margin of the surrounding text: the furthest line end on this page.
    let margin = -Infinity
    for (const run of pageRuns) {
      if (Math.abs(runAngle(run) - angle) > 1 || Math.abs(dot(run.startPoint, block.normal) - baseline) <= 0.3 * size) continue
      margin = Math.max(margin, dot(run.endPoint, direction))
    }
    if (Number.isFinite(margin) && lastEnd <= margin + 0.5 && lastEnd + delta > margin + 0.5) {
      warnings.push('This line is now longer than the paragraph and extends past its right margin. Shorten the text or edit the next line too.')
    }
  }

  const moved = new Set()
  const edits = []
  const ordered = [...pageRuns].sort((a, b) => a.sequence - b.sequence)
  for (const run of ordered) {
    if (excludedKeys.has(run.key)) continue
    const previousMoved = run.positioning === 'continuation' && run.previousRunKey && moved.has(run.previousRunKey)
    if (chain.has(run.key)) {
      if (previousMoved) { moved.add(run.key); continue }
      edits.push(shiftEdit(run, delta, codeBytesFor(run)))
      moved.add(run.key)
    } else if (previousMoved) {
      // Continuation text that is not part of the chain keeps its position.
      edits.push(shiftEdit(run, -delta, codeBytesFor(run)))
    }
  }
  return { edits, warnings }
}

function shiftEdit(run, deltaUser, codeBytes) {
  const shift = textSpaceUnitsToAdjust(deltaUser / run.scaleX, run)
  const elements = [{ adjust: shift }, ...originalElements(run.glyphs)]
  return { run, text: `${showPrefix(run)}[${elementsToTJ(elements, codeBytes)}] TJ` }
}

function cloneDict(dict) {
  return new PdfDict(dict instanceof Map ? dict : [])
}

/** Adds a font to the resource dictionary used by a content stream. */
class ResourceUpdater {
  constructor(index, analysis) {
    this.index = index
    this.analysis = analysis
    this.updates = new Map()
    this.xobjectResources = new Map()
  }

  currentValue(num) {
    return this.updates.get(num)?.value ?? this.index.getObject(num)?.value
  }

  setObject(num, value) {
    const gen = this.index.getObject(num)?.gen ?? 0
    const existing = this.updates.get(num)
    this.updates.set(num, { num, gen, value, stream: existing?.stream })
  }

  withResource(resources, category, resourceName, value) {
    const updated = cloneDict(resources)
    const entry = updated.get(category)
    if (entry instanceof PdfRef) {
      const dict = cloneDict(this.currentValue(entry.num))
      dict.set(resourceName, value)
      this.setObject(entry.num, dict)
      return { dict: updated, changed: false }
    }
    const dict = cloneDict(this.index.resolve(entry))
    dict.set(resourceName, value)
    updated.set(category, dict)
    return { dict: updated, changed: true }
  }

  existingNames(resources, category) {
    const entry = resources?.get?.(category)
    const dict = entry instanceof PdfRef ? this.currentValue(entry.num) : entry
    return new Set(dict instanceof Map ? dict.keys() : [])
  }

  uniqueName(resources, category = 'Font', prefix = 'EF') {
    const names = this.existingNames(resources, category)
    let counter = 1
    while (names.has(`${prefix}${counter}`)) counter += 1
    return `${prefix}${counter}`
  }

  /** Returns the resource name under which `value` is available to the stream. */
  addResource(stream, category, value, prefix) {
    const owner = stream.owner
    if (owner.kind === 'xobject') {
      const xobject = this.index.getObject(owner.num)
      const resourcesValue = xobject.value.get('Resources')
      if (resourcesValue instanceof PdfRef) {
        const resources = this.currentValue(resourcesValue.num)
        const resourceName = this.uniqueName(resources, category, prefix)
        const { dict, changed } = this.withResource(resources, category, resourceName, value)
        if (changed) this.setObject(resourcesValue.num, dict)
        return resourceName
      }
      const resources = this.xobjectResources.get(owner.num) || this.index.resolve(resourcesValue) || stream.resources
      const resourceName = this.uniqueName(resources, category, prefix)
      const { dict } = this.withResource(resources, category, resourceName, value)
      this.xobjectResources.set(owner.num, dict)
      return resourceName
    }
    const page = this.analysis.pages.find((item) => item.num === owner.pageNum)
    const pageDict = this.currentValue(page.num)
    const resourcesValue = pageDict.get('Resources')
    if (resourcesValue instanceof PdfRef) {
      const resources = this.currentValue(resourcesValue.num)
      const resourceName = this.uniqueName(resources, category, prefix)
      const { dict, changed } = this.withResource(resources, category, resourceName, value)
      if (changed) this.setObject(resourcesValue.num, dict)
      return resourceName
    }
    const resources = resourcesValue instanceof PdfDict ? resourcesValue : this.index.resolve(page.inherited.Resources?.value) || new PdfDict()
    const resourceName = this.uniqueName(resources, category, prefix)
    const { dict } = this.withResource(resources, category, resourceName, value)
    const updatedPage = cloneDict(pageDict)
    updatedPage.set('Resources', dict)
    this.setObject(page.num, updatedPage)
    return resourceName
  }

  addFont(stream, fontRef) {
    return this.addResource(stream, 'Font', fontRef, 'EF')
  }
}

/**
 * Apply content-stream edits ({ streamObjectNumber, start, end, text }) plus
 * resource updates and new objects, and write an incremental update.
 */
async function commitStreamEdits(analysis, rawEdits, resources, extraObjects = []) {
  const { index, context } = analysis
  const editsByStream = new Map()
  const seenRanges = new Set()
  for (const edit of rawEdits) {
    const rangeKey = `${edit.streamObjectNumber}:${edit.start}:${edit.end}`
    if (seenRanges.has(rangeKey)) continue
    seenRanges.add(rangeKey)
    if (!editsByStream.has(edit.streamObjectNumber)) editsByStream.set(edit.streamObjectNumber, [])
    editsByStream.get(edit.streamObjectNumber).push(edit)
  }

  const objects = new Map()
  for (const [streamNumber, edits] of editsByStream) {
    const stream = context.streams.get(streamNumber)
    edits.sort((a, b) => b.start - a.start)
    let source = stream.source
    for (const edit of edits) source = source.slice(0, edit.start) + edit.text + source.slice(edit.end)
    const compressed = await deflate(latin1Bytes(source))
    const original = index.getObject(streamNumber)
    const dict = cloneDict(resources.updates.get(streamNumber)?.value ?? original.value)
    dict.delete('DecodeParms')
    dict.delete('DP')
    dict.delete('DL')
    dict.set('Filter', name('FlateDecode'))
    dict.set('Length', compressed.length)
    if (stream.owner.kind === 'xobject' && resources.xobjectResources.has(streamNumber)) dict.set('Resources', resources.xobjectResources.get(streamNumber))
    objects.set(streamNumber, { num: streamNumber, gen: original.gen ?? 0, value: dict, stream: compressed })
  }
  for (const [num, update] of resources.updates) {
    if (objects.has(num)) continue
    if (update.stream === undefined && index.getObject(num)?.stream) continue
    objects.set(num, update)
  }
  for (const [num, dict] of resources.xobjectResources) {
    if (objects.has(num)) continue
    const original = index.getObject(num)
    const updated = cloneDict(original.value)
    updated.set('Resources', dict)
    objects.set(num, { num, gen: original.gen ?? 0, value: updated, stream: original.stream })
  }
  for (const object of extraObjects) objects.set(object.num, object)
  return writeIncrementalUpdate(index, [...objects.values()])
}

const runEdit = (edit) => ({ streamObjectNumber: edit.run.streamObjectNumber, start: edit.run.start, end: edit.run.end, text: edit.text })

function locateBlock(analysis, reference) {
  if (!reference) return null
  const byKey = analysis.blocks.find((block) => block.key === reference.key)
  if (byKey) return byKey
  const firstRun = reference.runKeys?.[0]
  if (firstRun) {
    const containing = analysis.blocks.find((block) => block.runKeys.includes(firstRun))
    if (containing) return containing
  }
  return null
}

function lineTextFrom(analysis, pageIndex, origin, block) {
  const size = block.fontSizeUser
  const start = dot(origin, block.direction)
  const baseline = dot(origin, block.normal)
  return analysis.blocks
    .filter((candidate) => (
      candidate.pageIndex === pageIndex &&
      Math.abs(candidate.angle - block.angle) <= 1 &&
      Math.abs(dot(candidate.startPoint, block.normal) - baseline) <= Math.max(0.5, 0.3 * size) &&
      dot(candidate.startPoint, block.direction) >= start - 0.3 * size
    ))
    .sort((a, b) => dot(a.startPoint, block.direction) - dot(b.startPoint, block.direction))
    .map((candidate) => candidate.text)
    .join('')
}

function findBlockNear(analysis, pageIndex, origin, block) {
  const size = block.fontSizeUser
  let best = null
  let bestDistance = Infinity
  for (const candidate of analysis.blocks) {
    if (candidate.pageIndex !== pageIndex) continue
    const distance = Math.hypot(candidate.startPoint.x - origin.x, candidate.startPoint.y - origin.y)
    if (distance < bestDistance && distance <= Math.max(1, 0.6 * size)) { best = candidate; bestDistance = distance }
  }
  return best
}

function fontRequestFor(font) {
  return {
    postscriptName: font.postscriptName,
    family: font.family,
    bold: font.bold,
    italic: font.italic,
    serif: font.serif,
    fixedPitch: font.fixedPitch,
  }
}

/**
 * Replace the text of one editable block (a line fragment with one style).
 * options.fontProvider supplies installed fonts for characters missing from
 * the PDF's embedded subset font.
 */
export async function replaceNativeTextBlock(bytes, blockReference, replacementText, options = {}) {
  const analysis = await analyzeDocument(bytes)
  const block = locateBlock(analysis, blockReference)
  if (!block) throw new Error('The selected text changed. Click it again before editing.')
  if (blockReference.text !== undefined && stripSpaces(blockReference.text) !== stripSpaces(block.text)) {
    throw new Error('The selected text changed. Click it again before editing.')
  }
  if (!block.editable) throw new Error(block.reason || 'This text cannot be edited.')
  const newText = String(replacementText ?? '').replace(/[\r\n\t]+/g, ' ')
  if (newText === block.text) throw new Error('The replacement text is identical to the original text. Make a change before replacing it.')
  if (COMPLEX_SCRIPT.test(newText)) throw new Error('Typing Hindi or other complex-script text into a PDF is not supported yet.')
  return applyBlockEdit(bytes, analysis, block, newText, options)
}

async function applyBlockEdit(bytes, analysis, block, newText, options) {
  const { index, context } = analysis
  const runsByKey = new Map(context.runs.map((run) => [run.key, run]))
  const font = context.fontCache.get(block.fontKey)
  const warnings = []

  // Decide whether the original font can draw the new characters.
  const { middle } = computeDiff(block.chars, newText)
  const missing = [...new Set([...middle].filter((character) => !/\s/.test(character) && font.encodeCharacter(character) === null))]
  let fallback = null
  if (missing.length) {
    fallback = await resolveFallbackFont(fontRequestFor(font), newText, options.fontProvider)
    if (!fallback) {
      throw new Error(`The PDF font cannot draw ${missing.join(' ')} and no matching font is installed on this computer. Install the font (or allow font access) and try again.`)
    }
  }

  let nextObjectNumber = index.size
  const allocate = () => nextObjectNumber++
  const resources = new ResourceUpdater(index, analysis)
  // The font objects are built after planning so the glyph subset is complete.
  let fallbackFontRef = null
  const fallbackNames = new Map()

  const allBlocks = [block, ...(block.twinBlocks || [])]
  const excludedKeys = new Set(allBlocks.flatMap((item) => item.runKeys))
  const plans = []
  for (const target of allBlocks) {
    const targetRuns = target.runKeys.map((key) => runsByKey.get(key))
    if (targetRuns.some((run) => !run)) continue
    const targetFont = context.fontCache.get(target.fontKey) || font
    const stream = context.streams.get(targetRuns[0].streamObjectNumber)
    let resourceName = null
    if (fallback) {
      if (!fallbackFontRef) fallbackFontRef = new PdfRef(allocate(), 0)
      const key = stream.owner.kind === 'xobject' ? `x:${stream.owner.num}` : `p:${stream.owner.pageNum}`
      if (!fallbackNames.has(key)) fallbackNames.set(key, resources.addFont(stream, fallbackFontRef))
      resourceName = fallbackNames.get(key)
    }
    let plan
    try {
      plan = planBlockRewrite({ block: target, blockRuns: targetRuns, font: targetFont, newText, fallback, fallbackResourceName: resourceName })
    } catch (error) {
      if (target === block) throw error
      continue
    }
    plans.push({ target, plan })
  }
  const primary = plans[0].plan

  const blockRunKeys = new Set(block.runKeys)
  const codeBytesFor = (run) => context.fontCache.get(run.fontKey)?.codeBytes || 1
  // Runs of the edited block after the rewritten range move with the chain.
  const chainExcluded = new Set([...excludedKeys].filter((key) => {
    const position = block.runKeys.indexOf(key)
    return position < 0 || position <= primary.endRun
  }))
  const shift = buildShiftEdits({
    analysis, block, blockRunKeys, excludedKeys: chainExcluded, oldEnd: primary.oldEnd, delta: primary.delta, codeBytesFor,
  })
  warnings.push(...shift.warnings)

  const extraObjects = fallback ? (await fallback.encoder.buildObjects(allocate, fallbackFontRef.num)).objects : []
  const nextBytes = await commitStreamEdits(analysis, [...plans.flatMap((item) => item.plan.edits), ...shift.edits].map(runEdit), resources, extraObjects)

  // Verify: the edited line now reads the new text from the same origin.
  const verification = await analyzeDocument(nextBytes)
  if (newText.trim()) {
    const lineText = lineTextFrom(verification, block.pageIndex, block.startPoint, block)
    if (!stripSpaces(lineText).startsWith(stripSpaces(newText))) {
      throw new Error('The edit could not be verified in the rewritten PDF, so it was not applied.')
    }
  }
  const updatedBlock = findBlockNear(verification, block.pageIndex, block.startPoint, block)
  const firstRun = updatedBlock ? verification.runs.find((run) => run.key === updatedBlock.runKeys[0]) : null
  return {
    bytes: nextBytes,
    block: updatedBlock,
    run: firstRun,
    originalText: block.text,
    replacementText: newText,
    fontPlan: fallback ? { kind: 'fallback', match: fallback.match, label: fallback.label } : { kind: 'original', label: font.family },
    warnings,
    inspection: toPublicInspection(verification, nextBytes),
  }
}

// ---------------------------------------------------------------------------
// Restyling existing text (font, size, colour, bold, italic)
// ---------------------------------------------------------------------------

function fillColorOperators(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''))
  if (!match) return null
  const value = parseInt(match[1], 16)
  const components = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((component) => formatPdfNumber(Math.round((component / 255) * 1000) / 1000))
  return { fill: `${components.join(' ')} rg`, stroke: `${components.join(' ')} RG` }
}

/** Font for restyled text: a standard PDF font, or the requested installed family. */
async function resolveStyleFont(request, text, fontProvider) {
  const visible = text.replace(/\s+/g, '') || 'a'
  if (request.source === 'standard' || isStandardFamily(request.family)) {
    const encoder = createStandardFontEncoder(standardFontFor(isStandardFamily(request.family) ? request.family : 'Helvetica', request.bold, request.italic))
    if (encoder.canEncode(visible)) return { encoder, match: 'exact', label: encoder.label }
  }
  return resolveFallbackFont({ postscriptName: '', family: request.family, bold: request.bold, italic: request.italic, serif: request.serif, fixedPitch: request.fixedPitch }, visible, fontProvider)
}

/** Rewrite a whole block in one operator with a new font/size/colour. */
function planRestyle({ block, blockRuns, font, encoder, resourceName, newFontSize, fillOps }) {
  const target = blockRuns[0]
  const oldSize = target.fontSize
  const size = newFontSize ?? oldSize
  const horizontal = target.horizontalScaling / 100
  const toTextSpace = (adjust) => (-adjust / 1000) * size * horizontal
  const elements = []
  let advance = 0
  if (encoder) {
    for (const glyph of encoder.encode(block.text)) {
      elements.push({ code: glyph.code })
      const isOneByteSpace = encoder.codeBytes === 1 && glyph.code === 32
      advance += ((glyph.width / 1000) * size + target.characterSpacing + (isOneByteSpace ? target.wordSpacing : 0)) * horizontal
      let extra = glyph.kern ? -glyph.kern : 0
      if (glyph.isSpace && encoder.codeBytes === 2 && target.wordSpacing && size) extra += (-target.wordSpacing * 1000) / size
      if (extra) { elements.push({ adjust: extra }); advance += toTextSpace(extra) }
    }
  } else {
    blockRuns.forEach((run, runIndex) => {
      if (runIndex > 0) {
        const previous = blockRuns[runIndex - 1]
        const gapText = (dot(run.originPoint, block.direction) - dot(previous.advanceEndPoint, block.direction)) / target.scaleX
        // Relative to the original size so word gaps scale with the text.
        const adjust = -(gapText * 1000) / (oldSize * horizontal)
        elements.push({ adjust })
        advance += toTextSpace(adjust)
      }
      for (const glyph of run.glyphs) {
        if (glyph.code !== undefined) {
          elements.push({ code: glyph.code })
          const isSpace = font.codeBytes === 1 && glyph.code === 32
          advance += (glyph.width * size + target.characterSpacing + (isSpace ? target.wordSpacing : 0)) * horizontal
        } else {
          elements.push({ adjust: glyph.adjust })
          advance += toTextSpace(glyph.adjust)
        }
      }
    })
  }
  const keepAdvance = -((target.advance - advance) * 1000) / (size * horizontal)
  const codeBytes = encoder ? encoder.codeBytes : font.codeBytes
  const restoreFill = fillOps ? target.fillColorOps : ''
  const strokes = [1, 2, 5, 6].includes(target.textRenderingMode)
  const parts = []
  if (fillOps) parts.push(fillOps.fill)
  if (fillOps && strokes) parts.push(fillOps.stroke)
  parts.push(showPrefix(target).trim())
  parts.push(`/${encoder ? resourceName : target.fontResource} ${formatPdfNumber(size)} Tf`)
  parts.push(`[${elementsToTJ([...elements, { adjust: keepAdvance }], codeBytes)}] TJ`)
  parts.push(`/${target.fontResource} ${formatPdfNumber(oldSize)} Tf`)
  if (restoreFill) parts.push(restoreFill)
  if (fillOps && strokes) parts.push(target.strokeColorOps)
  const edits = [{ run: target, text: parts.filter(Boolean).join(' ') }]
  for (const run of blockRuns.slice(1)) {
    const adjust = textSpaceUnitsToAdjust(run.advance, run)
    const blank = Math.abs(adjust) > 0.0005 ? `[${formatPdfNumber(Number(adjust.toFixed(3)))}] TJ` : ''
    edits.push({ run, text: `${showPrefix(run)}${blank}`.trim() || ' ' })
  }
  const newEnd = dot(target.originPoint, block.direction) + advance * target.scaleX
  const oldEnd = dot(blockRuns.at(-1).advanceEndPoint, block.direction)
  return { edits, delta: newEnd - oldEnd, oldEnd, newEnd }
}

/**
 * Change the look of an existing text block: style = { fontSize (points as
 * displayed), color ('#RRGGBB'), fontFamily, fontSource, bold, italic }.
 * Text after it on the same line moves to fit, like a normal edit.
 */
export async function restyleNativeTextBlock(bytes, blockReference, style = {}, options = {}) {
  const analysis = await analyzeDocument(bytes)
  const block = locateBlock(analysis, blockReference)
  if (!block) throw new Error('The selected text changed. Click it again before changing its style.')
  if (blockReference.text !== undefined && stripSpaces(blockReference.text) !== stripSpaces(block.text)) {
    throw new Error('The selected text changed. Click it again before changing its style.')
  }
  if (!block.editable) throw new Error(block.reason || 'This text cannot be changed.')
  const { index, context } = analysis
  const font = context.fontCache.get(block.fontKey)
  const warnings = []

  const currentFamily = font.family || block.fontMetadata?.fontFamily || ''
  const familyChanged = style.fontFamily && normalizeFontKey(style.fontFamily) !== normalizeFontKey(currentFamily)
  const boldChanged = style.bold !== undefined && Boolean(style.bold) !== Boolean(font.bold)
  const italicChanged = style.italic !== undefined && Boolean(style.italic) !== Boolean(font.italic)
  let fallback = null
  if (familyChanged || boldChanged || italicChanged) {
    const request = {
      family: style.fontFamily || currentFamily || 'Helvetica',
      source: style.fontSource,
      bold: style.bold ?? font.bold,
      italic: style.italic ?? font.italic,
      serif: font.serif,
      fixedPitch: font.fixedPitch,
    }
    fallback = await resolveStyleFont(request, block.text, options.fontProvider)
    if (!fallback) throw new Error(`No installed font can draw this text in ${request.family}${request.bold ? ' bold' : ''}${request.italic ? ' italic' : ''}. Allow font access in Chrome or Edge, or pick another font.`)
    if (fallback.match !== 'exact') warnings.push(`${request.family}${request.bold ? ' Bold' : ''}${request.italic ? ' Italic' : ''} is not available on this computer, so ${fallback.label} was used.`)
  }
  const scaleRatio = Math.abs(block.fontSize) ? block.fontSizeUser / Math.abs(block.fontSize) : 1
  const newFontSize = Number.isFinite(style.fontSize) && style.fontSize > 0 && Math.abs(style.fontSize - block.fontSizeUser) > 0.01
    ? (Math.sign(block.fontSize) || 1) * (style.fontSize / scaleRatio)
    : null
  const fillOps = style.color && style.color.toUpperCase() !== String(block.fillColor || '').toUpperCase() ? fillColorOperators(style.color) : null
  if (!fallback && newFontSize === null && !fillOps) throw new Error('Choose a different font, size or colour first.')

  let nextObjectNumber = index.size
  const allocate = () => nextObjectNumber++
  const resources = new ResourceUpdater(index, analysis)
  const fontRef = fallback ? new PdfRef(allocate(), 0) : null
  const fontNames = new Map()
  const allBlocks = [block, ...(block.twinBlocks || [])]
  const excludedKeys = new Set(allBlocks.flatMap((item) => item.runKeys))
  const plans = []
  for (const target of allBlocks) {
    const targetRuns = target.runKeys.map((key) => context.runsByKey.get(key))
    if (targetRuns.some((run) => !run)) continue
    const stream = context.streams.get(targetRuns[0].streamObjectNumber)
    let resourceName = null
    if (fallback) {
      const key = stream.owner.kind === 'xobject' ? `x:${stream.owner.num}` : `p:${stream.owner.pageNum}`
      if (!fontNames.has(key)) fontNames.set(key, resources.addFont(stream, fontRef))
      resourceName = fontNames.get(key)
    }
    plans.push(planRestyle({
      block: target, blockRuns: targetRuns, font: context.fontCache.get(target.fontKey) || font,
      encoder: fallback?.encoder || null, resourceName, newFontSize, fillOps,
    }))
  }
  if (!plans.length) throw new Error('This text cannot be changed.')
  const primary = plans[0]
  const codeBytesFor = (run) => context.fontCache.get(run.fontKey)?.codeBytes || 1
  const shift = buildShiftEdits({ analysis, block, blockRunKeys: new Set(block.runKeys), excludedKeys, oldEnd: primary.oldEnd, delta: primary.delta, codeBytesFor })
  warnings.push(...shift.warnings)
  const extraObjects = fallback ? (await fallback.encoder.buildObjects(allocate, fontRef.num)).objects : []
  const nextBytes = await commitStreamEdits(analysis, [...plans.flatMap((plan) => plan.edits), ...shift.edits].map(runEdit), resources, extraObjects)

  const verification = await analyzeDocument(nextBytes)
  const updatedBlock = findBlockNear(verification, block.pageIndex, block.startPoint, block)
  if (!updatedBlock || stripSpaces(updatedBlock.text) !== stripSpaces(block.text)) {
    throw new Error('The style change could not be verified in the rewritten PDF, so it was not applied.')
  }
  return {
    bytes: nextBytes,
    block: updatedBlock,
    fontPlan: fallback ? { kind: 'fallback', match: fallback.match, label: fallback.label } : { kind: 'original', label: font.family },
    warnings,
    inspection: toPublicInspection(verification, nextBytes),
  }
}

// ---------------------------------------------------------------------------
// Existing page images: move, resize, rotate, replace, delete, opacity
// ---------------------------------------------------------------------------

function boxMatrix(from, to, rotation = 0) {
  const sx = from.width ? to.width / from.width : 1
  const sy = from.height ? to.height / from.height : 1
  let matrix = multiplyMatrix(multiplyMatrix(translateMatrix(-from.x, -from.y), scaleMatrix(sx, sy)), translateMatrix(to.x, to.y))
  if (rotation) {
    const cx = to.x + to.width / 2
    const cy = to.y + to.height / 2
    matrix = multiplyMatrix(matrix, multiplyMatrix(multiplyMatrix(translateMatrix(-cx, -cy), rotateMatrix(rotation)), translateMatrix(cx, cy)))
  }
  return matrix
}

const matrixOperands = (m) => m.map((value) => formatPdfNumber(Math.round(value * 100000) / 100000)).join(' ')

/**
 * Edit an image that is part of the page content.
 * operation: { type: 'transform', from, to, rotation } (view-space boxes at 100 %),
 *            { type: 'delete' }, { type: 'replace', data }, { type: 'opacity', value }
 */
export async function editPageImage(bytes, imageReference, operation) {
  const analysis = await analyzeDocument(bytes)
  const image = analysis.images.find((item) => item.key === imageReference?.key)
  if (!image) throw new Error('The selected image changed. Click it again.')
  if (!image.editable) throw new Error(image.reason)
  const { index, context } = analysis
  const stream = context.streams.get(image.streamObjectNumber)
  const original = stream.source.slice(image.start, image.end)
  const resources = new ResourceUpdater(index, analysis)
  let nextObjectNumber = index.size
  const allocate = () => nextObjectNumber++
  const extraObjects = []
  let text
  if (operation?.type === 'transform') {
    const geometry = pageGeometry(index, analysis.pages[image.pageIndex])
    const viewMatrix = boxMatrix(operation.from || image.viewRect, operation.to, operation.rotation || 0)
    const userMatrix = multiplyMatrix(multiplyMatrix(geometry.toView, viewMatrix), geometry.toUser)
    // New placement D = C x S; inserted operator X satisfies X x C = D.
    const inserted = multiplyMatrix(multiplyMatrix(image.ctm, userMatrix), invertMatrix(image.ctm))
    text = `q ${matrixOperands(inserted)} cm ${original} Q`
  } else if (operation?.type === 'delete') {
    text = ' '
  } else if (operation?.type === 'replace') {
    if (image.kind !== 'xobject') throw new Error('This image is stored inline in the page and cannot be replaced. Delete it and add a new image instead.')
    if (!detectImageFormat(operation.data)) throw new Error('Choose a JPEG or PNG image.')
    const built = await buildImageXObject(operation.data, allocate)
    extraObjects.push(...built.objects)
    const resourceName = resources.addResource(stream, 'XObject', built.ref, 'EXI')
    // Keep the new picture's proportions inside the old frame.
    const frameWidth = Math.hypot(image.ctm[0], image.ctm[1])
    const frameHeight = Math.hypot(image.ctm[2], image.ctm[3])
    const frameAspect = frameHeight ? frameWidth / frameHeight : 1
    const aspect = built.height ? built.width / built.height : 1
    let sx = 1
    let sy = 1
    if (aspect > frameAspect) sy = frameAspect / aspect
    else sx = aspect / frameAspect
    text = `q ${matrixOperands([sx, 0, 0, sy, (1 - sx) / 2, (1 - sy) / 2])} cm /${resourceName} Do Q`
  } else if (operation?.type === 'opacity') {
    const value = Math.max(0, Math.min(1, Number(operation.value)))
    const gsRef = new PdfRef(allocate(), 0)
    extraObjects.push({ num: gsRef.num, gen: 0, value: new PdfDict([['Type', name('ExtGState')], ['ca', value], ['CA', value]]) })
    const resourceName = resources.addResource(stream, 'ExtGState', gsRef, 'EXG')
    text = `q /${resourceName} gs ${original} Q`
  } else {
    throw new Error('Unknown image operation.')
  }
  const nextBytes = await commitStreamEdits(analysis, [{ streamObjectNumber: image.streamObjectNumber, start: image.start, end: image.end, text }], resources, extraObjects)
  const verification = await analyzeDocument(nextBytes)
  const expected = analysis.images.filter((item) => item.pageIndex === image.pageIndex).length - (operation.type === 'delete' ? 1 : 0)
  if (verification.images.filter((item) => item.pageIndex === image.pageIndex).length !== expected) {
    throw new Error('The image change could not be verified in the rewritten PDF, so it was not applied.')
  }
  const updatedImage = operation.type === 'delete'
    ? null
    : verification.images.find((item) => item.pageIndex === image.pageIndex && item.streamObjectNumber === image.streamObjectNumber && item.start >= image.start && item.start <= image.start + text.length) || null
  return { bytes: nextBytes, image: updatedImage, inspection: toPublicInspection(verification, nextBytes) }
}

/**
 * Backwards-compatible API: replace one text-showing operator. The run is
 * edited through the block engine (same-line text after it is moved to fit).
 */
export async function replaceNativePdfText(bytes, run, replacementText, options = {}) {
  if (!run || !Number.isInteger(run.streamObjectNumber)) throw new Error('Select an existing PDF text line before replacing it.')
  const analysis = await analyzeDocument(bytes)
  const target = analysis.runs.find((item) => item.key === run.key)
  if (!target) throw new Error('The selected text run changed. Select it again before replacing.')
  if (replacementText === target.originalText) throw new Error('The replacement text is identical to the original text. Make a change before replacing it.')
  if (!String(replacementText || '').length) throw new Error('Replacement text cannot be empty.')
  const owner = analysis.blocks.find((block) => block.runKeys.includes(target.key))
  let block = owner
  if (!owner || owner.runKeys.length !== 1) {
    const [single] = buildTextBlocks([target], target.pageIndex)
    if (!single) throw new Error('This PDF text run cannot be edited.')
    decorateBlock(single, analysis.context)
    single.twinBlocks = []
    block = single
  }
  if (!block.editable) throw new Error(block.reason || 'This text cannot be edited.')
  const result = await applyBlockEdit(bytes, analysis, block, String(replacementText).replace(/[\r\n\t]+/g, ' '), options)
  const verifyRun = result.inspection.runs.find((item) => item.pageIndex === target.pageIndex && item.streamObjectNumber === target.streamObjectNumber && item.start === target.start)
  return { ...result, run: verifyRun || result.run }
}
