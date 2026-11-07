// Page geometry shared by the editor UI and the PDF writer.
//
// Added objects are stored in "view space": PDF points at zoom 100 %, origin at
// the top-left corner of the page exactly as it is displayed (after /Rotate and
// the crop box). The writer converts view space back to PDF user space.

import { PdfRef } from '../pdf-parser/pdfSyntax.js'

/** Row-vector affine multiply: apply m1, then m2. */
export function multiplyMatrix(m1, m2) {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ]
}

export function invertMatrix(m) {
  const determinant = m[0] * m[3] - m[1] * m[2]
  if (!determinant) return [1, 0, 0, 1, 0, 0]
  return [
    m[3] / determinant,
    -m[1] / determinant,
    -m[2] / determinant,
    m[0] / determinant,
    (m[2] * m[5] - m[3] * m[4]) / determinant,
    (m[1] * m[4] - m[0] * m[5]) / determinant,
  ]
}

export function transformPoint(m, x, y) {
  return { x: x * m[0] + y * m[2] + m[4], y: x * m[1] + y * m[3] + m[5] }
}

export const translateMatrix = (x, y) => [1, 0, 0, 1, x, y]
export const scaleMatrix = (x, y = x) => [x, 0, 0, y, 0, 0]
/** Clockwise rotation in a y-down space (CSS `rotate(deg)`). */
export function rotateMatrix(degrees) {
  const radians = (degrees * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  return [cos, sin, -sin, cos, 0, 0]
}

export function normalizeRotation(value) {
  const rotation = Number.isFinite(value) ? value : 0
  if (rotation % 90 !== 0) return 0
  return ((rotation % 360) + 360) % 360
}

function normalizeBox(value) {
  if (!Array.isArray(value) || value.length !== 4 || !value.every((item) => typeof item === 'number' && Number.isFinite(item))) return null
  const [x0, y0, x1, y1] = value
  return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)]
}

/** The visible page box (CropBox clipped to MediaBox) and rotation, like PDF.js. */
export function pageBoxInfo(index, page) {
  const resolve = (entry) => (entry ? index.resolve(entry.value instanceof PdfRef ? entry.value : entry.value) : null)
  const media = normalizeBox(resolve(page.inherited.MediaBox)) || [0, 0, 612, 792]
  let view = media
  const crop = normalizeBox(resolve(page.inherited.CropBox))
  if (crop) {
    const clipped = [Math.max(crop[0], media[0]), Math.max(crop[1], media[1]), Math.min(crop[2], media[2]), Math.min(crop[3], media[3])]
    if (clipped[2] > clipped[0] && clipped[3] > clipped[1]) view = clipped
  }
  const rotate = normalizeRotation(resolve(page.inherited.Rotate))
  return { viewBox: view, rotate }
}

/**
 * User space -> view space transform at scale 1 (identical to PDF.js
 * PageViewport for the same viewBox and rotation).
 */
export function pageViewTransform(viewBox, rotate) {
  const rotation = normalizeRotation(rotate)
  const centerX = (viewBox[2] + viewBox[0]) / 2
  const centerY = (viewBox[3] + viewBox[1]) / 2
  let a
  let b
  let c
  let d
  switch (rotation) {
    case 180: a = -1; b = 0; c = 0; d = 1; break
    case 90: a = 0; b = 1; c = 1; d = 0; break
    case 270: a = 0; b = -1; c = -1; d = 0; break
    default: a = 1; b = 0; c = 0; d = -1; break
  }
  let offsetX
  let offsetY
  if (a === 0) {
    offsetX = Math.abs(centerY - viewBox[1])
    offsetY = Math.abs(centerX - viewBox[0])
  } else {
    offsetX = Math.abs(centerX - viewBox[0])
    offsetY = Math.abs(centerY - viewBox[1])
  }
  return [a, b, c, d, offsetX - a * centerX - c * centerY, offsetY - b * centerX - d * centerY]
}

export function pageViewSize(viewBox, rotate) {
  const width = viewBox[2] - viewBox[0]
  const height = viewBox[3] - viewBox[1]
  return normalizeRotation(rotate) % 180 === 0 ? { width, height } : { width: height, height: width }
}

export function pageGeometry(index, page) {
  const { viewBox, rotate } = pageBoxInfo(index, page)
  const toView = pageViewTransform(viewBox, rotate)
  return { viewBox, rotate, toView, toUser: invertMatrix(toView), ...pageViewSize(viewBox, rotate) }
}

/**
 * Matrix mapping an object's local frame (origin at the box's top-left, y down,
 * unrotated box) to view space, rotating about the box centre.
 */
export function boxLocalToView(box) {
  const { x, y, width, height } = box
  const rotation = box.rotation || 0
  return multiplyMatrix(
    multiplyMatrix(translateMatrix(-width / 2, -height / 2), rotateMatrix(rotation)),
    translateMatrix(x + width / 2, y + height / 2),
  )
}

/** Axis-aligned view-space bounds of a (possibly rotated) box. */
export function rotatedBounds(box) {
  const matrix = boxLocalToView(box)
  const corners = [[0, 0], [box.width, 0], [box.width, box.height], [0, box.height]].map(([px, py]) => transformPoint(matrix, px, py))
  const xs = corners.map((point) => point.x)
  const ys = corners.map((point) => point.y)
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) }
}
