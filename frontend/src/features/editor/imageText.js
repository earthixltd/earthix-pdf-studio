// Text inside pictures: read it with on-device OCR (Tesseract, English and
// Hindi), then prepare an edit that paints over the old letters and puts an
// editable text box in the same place, size and colour.

import { familyMetrics, TEXT_PADDING } from '../../engine/page-objects/textLayout.js'
import { estimateFontSize, inpaintBox, measureTextStyle } from '../../engine/page-objects/imageTextEdit.js'
import { measurerFor } from './textMeasure.js'
import { newId } from './objectFactory.js'

let workerPromise = null

function assetUrl(path) {
  const base = import.meta.env?.BASE_URL || '/'
  return new URL(`${base.endsWith('/') ? base : `${base}/`}${path}`, window.location.origin).href
}

/** One shared OCR worker, loaded from the app's own files (nothing is sent anywhere). */
export function getOcrWorker() {
  if (!workerPromise) {
    workerPromise = import('tesseract.js')
      .then(({ createWorker }) => createWorker(['eng', 'hin'], 1, {
        workerPath: assetUrl('tesseract/worker.min.js'),
        corePath: assetUrl('tesseract/core'),
        langPath: assetUrl('tesseract/lang'),
        workerBlobURL: false,
        gzip: true,
      }))
      .catch((error) => {
        workerPromise = null
        throw error
      })
  }
  return workerPromise
}

/**
 * Render the page sharply and read the text inside `rect` (view space).
 * Returns { lines, canvas, scale, rect } — lines are in view space.
 */
export async function readTextInArea(session, pageIndex, rect, overlayImage = null) {
  const scale = Math.max(2, Math.min(4, 1800 / Math.max(40, rect.width)))
  const canvas = document.createElement('canvas')
  await session.renderPage(pageIndex, canvas, { scale, dpr: 1 })
  if (overlayImage?.data?.length) {
    // Pictures added in Earthix are not part of the PDF rendering yet.
    const bitmap = await createImageBitmap(new Blob([overlayImage.data], { type: overlayImage.format === 'png' ? 'image/png' : 'image/jpeg' }))
    const context = canvas.getContext('2d')
    context.save()
    context.globalAlpha = overlayImage.opacity ?? 1
    const cx = (overlayImage.x + overlayImage.width / 2) * scale
    const cy = (overlayImage.y + overlayImage.height / 2) * scale
    context.translate(cx, cy)
    context.rotate(((overlayImage.rotation || 0) * Math.PI) / 180)
    context.drawImage(bitmap, (-overlayImage.width / 2) * scale, (-overlayImage.height / 2) * scale, overlayImage.width * scale, overlayImage.height * scale)
    context.restore()
    bitmap.close?.()
  }
  const sx = Math.max(0, Math.floor(rect.x * scale))
  const sy = Math.max(0, Math.floor(rect.y * scale))
  const sw = Math.min(canvas.width - sx, Math.ceil(rect.width * scale))
  const sh = Math.min(canvas.height - sy, Math.ceil(rect.height * scale))
  const crop = document.createElement('canvas')
  crop.width = Math.max(1, sw)
  crop.height = Math.max(1, sh)
  crop.getContext('2d').drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh)

  const worker = await getOcrWorker()
  const { data } = await worker.recognize(crop, {}, { blocks: true, text: true })
  const lines = []
  for (const block of data.blocks || []) {
    for (const paragraph of block.paragraphs || []) {
      for (const line of paragraph.lines || []) {
        const text = String(line.text || '').replace(/\s+/g, ' ').trim()
        if (!text || (line.confidence ?? 100) < 45 || !/[\p{L}\p{N}]/u.test(text)) continue
        const { x0, y0, x1, y1 } = line.bbox
        const baseline = line.baseline && Number.isFinite(line.baseline.y0)
          ? (line.baseline.y0 + line.baseline.y1) / 2
          : y1
        lines.push({
          id: newId('ocr'),
          text,
          confidence: line.confidence,
          // Device pixels in the rendered page canvas.
          px: { x0: sx + x0, y0: sy + y0, x1: sx + x1, y1: sy + y1, baseline: sy + baseline },
          // View space (points) for drawing on the page.
          rect: { x: (sx + x0) / scale, y: (sy + y0) / scale, width: (x1 - x0) / scale, height: (y1 - y0) / scale },
        })
      }
    }
  }
  return { lines, canvas, scale, rect }
}

async function canvasToPng(canvas) {
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
  return new Uint8Array(await blob.arrayBuffer())
}

/**
 * Prepare the edit for one OCR line: a background patch that hides the old
 * letters and a text box with the same position, size, colour and weight.
 */
export async function prepareImageTextEdit(reading, line, pageIndex) {
  const { canvas, scale } = reading
  const height = line.px.y1 - line.px.y0
  const pad = Math.max(2, Math.round(height * 0.14))
  const mask = { x0: line.px.x0 - pad, y0: line.px.y0 - pad, x1: line.px.x1 + pad, y1: line.px.y1 + pad }
  const border = 4
  const region = {
    x: Math.max(0, Math.floor(mask.x0) - border),
    y: Math.max(0, Math.floor(mask.y0) - border),
  }
  region.width = Math.min(canvas.width - region.x, Math.ceil(mask.x1 - mask.x0) + border * 2 + 1)
  region.height = Math.min(canvas.height - region.y, Math.ceil(mask.y1 - mask.y0) + border * 2 + 1)
  const context = canvas.getContext('2d', { willReadFrequently: true })
  const pixels = context.getImageData(region.x, region.y, region.width, region.height)
  const local = (box) => ({ x0: box.x0 - region.x, y0: box.y0 - region.y, x1: box.x1 - region.x, y1: box.y1 - region.y })
  const image = { width: pixels.width, height: pixels.height, data: pixels.data }
  const filled = inpaintBox(image, local(mask))
  const style = measureTextStyle(image, filled, local(line.px))

  // Patch image: exactly the painted-over area.
  const maskLocal = local(mask)
  const px0 = Math.max(0, Math.floor(maskLocal.x0))
  const py0 = Math.max(0, Math.floor(maskLocal.y0))
  const px1 = Math.min(image.width - 1, Math.ceil(maskLocal.x1))
  const py1 = Math.min(image.height - 1, Math.ceil(maskLocal.y1))
  const patchCanvas = document.createElement('canvas')
  patchCanvas.width = px1 - px0 + 1
  patchCanvas.height = py1 - py0 + 1
  const full = new ImageData(filled, image.width, image.height)
  patchCanvas.getContext('2d').putImageData(full, -px0, -py0)
  const data = await canvasToPng(patchCanvas)
  const patch = {
    id: newId('image'),
    type: 'image',
    pageIndex,
    assetId: newId('asset'),
    data,
    format: 'png',
    pixelWidth: patchCanvas.width,
    pixelHeight: patchCanvas.height,
    imageTextPatch: true,
    x: (region.x + px0) / scale,
    y: (region.y + py0) / scale,
    width: patchCanvas.width / scale,
    height: patchCanvas.height / scale,
    rotation: 0,
    opacity: 1,
  }

  // Text box: same baseline, size, colour and weight as the picture's text.
  const fontFamily = 'Helvetica'
  const bold = style.bold
  const measure = (text, size) => measurerFor({ fontFamily, fontSource: 'standard', bold, fontSize: size }).measure(text)
  const fontSize = estimateFontSize({ text: line.text, heightPt: (line.px.y1 - line.px.y0) / scale, widthPt: (line.px.x1 - line.px.x0) / scale, measure })
  const lineHeight = 1.2
  const metrics = familyMetrics(fontFamily)
  const lineBox = fontSize * lineHeight
  const baselineOffset = (lineBox - (metrics.ascent + metrics.descent) * fontSize) / 2 + metrics.ascent * fontSize
  const text = {
    id: newId('text'),
    type: 'text',
    pageIndex,
    text: line.text,
    originalText: line.text,
    imageTextPatchId: patch.id,
    fontFamily,
    fontSource: 'standard',
    fontSize,
    color: style.color,
    bold,
    italic: false,
    underline: false,
    strike: false,
    align: 'left',
    lineHeight,
    autoWidth: true,
    x: line.px.x0 / scale - TEXT_PADDING,
    y: line.px.baseline / scale - TEXT_PADDING - baselineOffset,
    width: (line.px.x1 - line.px.x0) / scale + TEXT_PADDING * 2,
    height: lineBox + TEXT_PADDING * 2,
    rotation: 0,
    opacity: 1,
    isNew: true,
  }
  return { patch, text }
}
