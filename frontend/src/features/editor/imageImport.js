// Turns a picture chosen by the user into JPEG or PNG bytes that can be
// embedded in a PDF. Photos keep their original JPEG data when possible;
// other formats (WebP, GIF, BMP, SVG, rotated photos, huge images) are
// re-encoded with a canvas.

import { detectImageFormat, readJpegInfo, readPngInfo } from '../../engine/page-objects/imageCodec.js'

const MAX_SIDE = 3000

function loadElement(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const image = new Image()
    image.onload = () => { resolve({ image, release: () => URL.revokeObjectURL(url) }) }
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('This picture could not be read. Try a JPG or PNG file.')) }
    image.src = url
  })
}

async function reencode(blob) {
  let source
  let release
  let width
  let height
  try {
    source = await createImageBitmap(blob, { imageOrientation: 'from-image' })
    width = source.width
    height = source.height
    release = () => source.close?.()
  } catch {
    const loaded = await loadElement(blob)
    source = loaded.image
    release = loaded.release
    width = source.naturalWidth || 800
    height = source.naturalHeight || 600
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  const context = canvas.getContext('2d')
  context.drawImage(source, 0, 0, canvas.width, canvas.height)
  release()
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
  let transparent = false
  for (let index = 3; index < pixels.length; index += 4) {
    if (pixels[index] < 255) { transparent = true; break }
  }
  const type = transparent ? 'image/png' : 'image/jpeg'
  const output = await new Promise((resolve) => canvas.toBlob(resolve, type, 0.92))
  if (!output) throw new Error('The picture could not be converted.')
  return { data: new Uint8Array(await output.arrayBuffer()), format: transparent ? 'png' : 'jpeg', pixelWidth: canvas.width, pixelHeight: canvas.height }
}

export async function importImageFile(file) {
  if (!file) throw new Error('No picture was selected.')
  const data = new Uint8Array(await file.arrayBuffer())
  const format = detectImageFormat(data)
  try {
    if (format === 'jpeg') {
      const info = readJpegInfo(data)
      if (info.orientation === 1 && Math.max(info.width, info.height) <= MAX_SIDE && info.components !== 4) {
        return { data, format, pixelWidth: info.width, pixelHeight: info.height }
      }
    } else if (format === 'png') {
      const info = readPngInfo(data)
      if (!info.interlace && info.bitDepth <= 8 && Math.max(info.width, info.height) <= MAX_SIDE) {
        return { data, format, pixelWidth: info.width, pixelHeight: info.height }
      }
    }
  } catch {
    // Fall through to re-encoding.
  }
  return reencode(new Blob([data], { type: file.type || 'application/octet-stream' }))
}

/** Render text as a transparent PNG (used for typed signatures). */
export async function renderTextImage(text, { fontFamily, color = '#1B2333', fontSize = 96 }) {
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  const font = `${fontSize}px ${fontFamily}`
  if (document.fonts?.load) await document.fonts.load(font, text).catch(() => undefined)
  context.font = font
  const metrics = context.measureText(text)
  const padding = Math.round(fontSize * 0.25)
  const ascent = metrics.actualBoundingBoxAscent || fontSize * 0.8
  const descent = metrics.actualBoundingBoxDescent || fontSize * 0.25
  canvas.width = Math.ceil((metrics.actualBoundingBoxRight || metrics.width) + (metrics.actualBoundingBoxLeft || 0) + padding * 2)
  canvas.height = Math.ceil(ascent + descent + padding * 2)
  context.font = font
  context.fillStyle = color
  context.fillText(text, padding + (metrics.actualBoundingBoxLeft || 0), padding + ascent)
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
  return { data: new Uint8Array(await blob.arrayBuffer()), format: 'png', pixelWidth: canvas.width, pixelHeight: canvas.height }
}

const urlCache = new Map()
/** Object URL for an image object's bytes (cached per asset). */
export function imageUrlFor(object) {
  const key = object.assetId || object.id
  if (!urlCache.has(key) && object.data?.length) {
    urlCache.set(key, URL.createObjectURL(new Blob([object.data], { type: object.format === 'png' ? 'image/png' : 'image/jpeg' })))
  }
  return urlCache.get(key) || ''
}
