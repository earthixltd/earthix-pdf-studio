// Reads objects written by Earthix (see objectWriter.js) back into editable
// objects and returns the PDF without them, so they can be adjusted again.
// Pages whose structure was changed by another program are left untouched.

import { PdfDocumentIndex } from '../pdf-parser/pdfDocumentIndex.js'
import { writeIncrementalUpdate } from '../pdf-parser/incrementalWriter.js'
import { PdfDict, PdfRef } from '../pdf-parser/pdfSyntax.js'
import { invertMatrix, multiplyMatrix, pageGeometry, pageViewTransform, transformPoint } from './pageGeometry.js'
import { readImageXObject } from './imageCodec.js'
import { pointsBounds } from './shapePaths.js'
import { EARTHIX_LAYER_VERSION } from './objectWriter.js'

const sameRef = (a, b) => a instanceof PdfRef && b instanceof PdfRef && a.num === b.num

function sameBox(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === 4 && a.every((value, index) => Math.abs(value - b[index]) < 0.01)
}

/** Move an object from an old page geometry to the current one (page rotated or cropped later). */
function remapObject(object, matrix, deltaRotation) {
  const point = (p) => transformPoint(matrix, p.x, p.y)
  const copy = { ...object }
  if (Array.isArray(object.points)) copy.points = object.points.map(point)
  if (Array.isArray(object.strokes)) copy.strokes = object.strokes.map((stroke) => stroke.map(point))
  if (Array.isArray(object.rects)) {
    copy.rects = object.rects.map((rect) => {
      const corners = [point({ x: rect.x, y: rect.y }), point({ x: rect.x + rect.width, y: rect.y + rect.height })]
      const bounds = pointsBounds(corners)
      return bounds
    })
  }
  if (object.type === 'note') {
    const position = point({ x: object.x + 10, y: object.y + 10 })
    copy.x = position.x - 10
    copy.y = position.y - 10
  } else if (copy.points || copy.strokes) {
    const all = copy.points || copy.strokes.flat()
    Object.assign(copy, pointsBounds(all, copy.points ? 0 : Math.max(1, (object.strokeWidth ?? 2) / 2)))
  } else if (copy.rects) {
    Object.assign(copy, pointsBounds(copy.rects.flatMap((rect) => [{ x: rect.x, y: rect.y }, { x: rect.x + rect.width, y: rect.y + rect.height }])))
  } else {
    const center = point({ x: object.x + object.width / 2, y: object.y + object.height / 2 })
    copy.x = center.x - object.width / 2
    copy.y = center.y - object.height / 2
    copy.rotation = (((object.rotation || 0) + deltaRotation) % 360 + 360) % 360
  }
  return copy
}

function decodeUtf8(bytes) {
  return new TextDecoder('utf-8').decode(bytes)
}

/**
 * Returns { bytes, objects, pages } where `bytes` no longer contains the
 * Earthix objects and `objects` are editable again. When the file has no
 * Earthix layer the input bytes are returned unchanged.
 */
export async function extractPageObjects(bytes) {
  const index = await PdfDocumentIndex.open(bytes)
  const pages = index.getPages()
  const updates = []
  const objects = []
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const page = pages[pageIndex]
    const layer = index.resolve(page.dict.get('EarthixLayer'))
    if (!(layer instanceof PdfDict)) continue
    try {
      if (index.resolve(layer.get('Version')) !== EARTHIX_LAYER_VERSION) continue
      const modelRef = layer.get('Model')
      if (!(modelRef instanceof PdfRef)) continue
      const modelBytes = await index.getStreamBytes(modelRef.num)
      if (!modelBytes) continue
      const model = JSON.parse(decodeUtf8(modelBytes))
      if (!Array.isArray(model?.objects)) continue

      const pageDict = new PdfDict(page.dict)
      const pre = layer.get('Pre')
      const post = layer.get('Post')
      if (pre || post) {
        const contents = index.resolve(page.dict.get('Contents'))
        if (!Array.isArray(contents) || contents.length < 2 || !sameRef(contents[0], pre) || !sameRef(contents.at(-1), post)) continue
        pageDict.set('Contents', contents.slice(1, -1))
      }
      const ours = (index.resolve(layer.get('Annots')) || []).filter((item) => item instanceof PdfRef)
      if (ours.length) {
        const annots = index.resolve(page.dict.get('Annots'))
        if (!Array.isArray(annots) || !ours.every((ref) => annots.some((item) => sameRef(item, ref)))) continue
        const remaining = annots.filter((item) => !ours.some((ref) => sameRef(item, ref)))
        if (remaining.length) pageDict.set('Annots', remaining)
        else pageDict.delete('Annots')
      }
      pageDict.delete('EarthixLayer')

      const geometry = pageGeometry(index, page)
      const changed = Array.isArray(model.viewBox) && (model.rotate !== geometry.rotate || !sameBox(model.viewBox, geometry.viewBox))
      const remap = changed ? multiplyMatrix(invertMatrix(pageViewTransform(model.viewBox, model.rotate)), geometry.toView) : null
      const deltaRotation = changed ? geometry.rotate - (model.rotate || 0) : 0
      const pageObjects = []
      for (const stored of model.objects) {
        if (!stored || typeof stored.id !== 'string' || typeof stored.type !== 'string') continue
        let object = { ...stored, pageIndex }
        if (object.type === 'image') {
          const image = Number.isInteger(object.imageRef) ? await readImageXObject(index, object.imageRef) : null
          if (!image) continue
          object.data = image.data
          object.format = image.format
          delete object.imageRef
        }
        if (remap) object = remapObject(object, remap, deltaRotation)
        pageObjects.push(object)
      }
      objects.push(...pageObjects)
      updates.push({ num: page.num, gen: page.gen ?? 0, value: pageDict })
    } catch {
      // Leave this page as it is: its objects stay part of the page content.
    }
  }
  if (!updates.length) return { bytes, objects: [], found: false }
  return { bytes: writeIncrementalUpdate(index, updates), objects, found: true }
}
