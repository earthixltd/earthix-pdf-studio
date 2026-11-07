// Defaults and geometry helpers for objects added in the editor.
// All coordinates are view space at 100 % (PDF points, origin top-left).

import { pointsBounds } from '../../engine/page-objects/shapePaths.js'
import { rotatedBounds } from '../../engine/page-objects/pageGeometry.js'

export const COLOR_SWATCHES = ['#1B2333', '#667085', '#FFFFFF', '#D92D20', '#F79009', '#12B76A', '#2454E6', '#7A5AF8', '#DD2590']
export const HIGHLIGHT_COLORS = ['#FFE066', '#A6F4C5', '#B2DDFF', '#FECDD6', '#FDDCAB', '#D9D6FE']
export const NOTE_COLORS = ['#FDB022', '#F97066', '#32D583', '#53B1FD', '#9B8AFB']

export const DEFAULT_TOOL_SETTINGS = {
  text: { fontFamily: 'Helvetica', fontSource: 'standard', fontSize: 14, color: '#1B2333', bold: false, italic: false, underline: false, strike: false, align: 'left', lineHeight: 1.25 },
  highlight: { kind: 'highlight', color: '#FFE066', opacity: 0.45 },
  draw: { color: '#2454E6', width: 2.5, opacity: 1 },
  shape: { shape: 'rect', strokeColor: '#D92D20', fillColor: null, strokeWidth: 2, dashed: false, opacity: 1 },
  note: { color: '#FDB022' },
}

export function newId(prefix = 'obj') {
  const random = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  return `${prefix}-${random}`
}

export const OBJECT_LABELS = {
  text: 'Text box',
  image: 'Image',
  shape: 'Shape',
  ink: 'Drawing',
  highlight: 'Highlight',
  note: 'Comment',
}

export function objectLabel(object) {
  if (!object) return ''
  if (object.signature) return 'Signature'
  if (object.whiteout) return 'Whiteout'
  if (object.type === 'shape') return { rect: 'Rectangle', ellipse: 'Ellipse', line: 'Line', arrow: 'Arrow' }[object.shape] || 'Shape'
  if (object.type === 'highlight') return { underline: 'Underline', strikeout: 'Strikethrough' }[object.kind] || 'Highlight'
  return OBJECT_LABELS[object.type] || 'Object'
}

export const isLineShape = (object) => object?.type === 'shape' && (object.shape === 'line' || object.shape === 'arrow')
export const isBoxObject = (object) => ['text', 'image', 'ink'].includes(object?.type) || (object?.type === 'shape' && !isLineShape(object))
export const canRotate = (object) => ['text', 'image'].includes(object?.type) || (object?.type === 'shape' && !isLineShape(object))

/** Axis-aligned bounds (view space). */
export function objectBounds(object) {
  if (!object) return { x: 0, y: 0, width: 0, height: 0 }
  if (isLineShape(object)) return pointsBounds(object.points || [], (object.strokeWidth || 2) / 2 + 2)
  if (object.type === 'note') return { x: object.x, y: object.y, width: 20, height: 20 }
  if (object.type === 'highlight') {
    return pointsBounds((object.rects || []).flatMap((rect) => [{ x: rect.x, y: rect.y }, { x: rect.x + rect.width, y: rect.y + rect.height }]))
  }
  return object.rotation ? rotatedBounds(object) : { x: object.x, y: object.y, width: object.width, height: object.height }
}

export function inkBounds(strokes, width) {
  return pointsBounds(strokes.flat(), Math.max(1, width / 2))
}

export function moveObject(object, dx, dy) {
  const shiftPoint = (point) => ({ x: point.x + dx, y: point.y + dy })
  const moved = { ...object, x: (object.x || 0) + dx, y: (object.y || 0) + dy }
  if (object.points) moved.points = object.points.map(shiftPoint)
  if (object.strokes) moved.strokes = object.strokes.map((stroke) => stroke.map(shiftPoint))
  if (object.rects) moved.rects = object.rects.map((rect) => ({ ...rect, x: rect.x + dx, y: rect.y + dy }))
  return moved
}

const rotateVector = (x, y, degrees) => {
  const radians = (degrees * Math.PI) / 180
  return { x: x * Math.cos(radians) - y * Math.sin(radians), y: x * Math.sin(radians) + y * Math.cos(radians) }
}

/**
 * Resize a box object from `start` by dragging handle (hx, hy in -1/0/1) by
 * (dx, dy) view units. The opposite edge/corner stays fixed, even when rotated.
 */
export function resizeBox(start, hx, hy, dx, dy, { keepAspect = false, minSize = 6 } = {}) {
  const rotation = start.rotation || 0
  const local = rotateVector(dx, dy, -rotation)
  let width = hx ? Math.max(minSize, start.width + hx * local.x) : start.width
  let height = hy ? Math.max(minSize, start.height + hy * local.y) : start.height
  if (keepAspect && hx && hy && start.width && start.height) {
    const scale = Math.max(width / start.width, height / start.height)
    width = Math.max(minSize, start.width * scale)
    height = Math.max(minSize, start.height * scale)
  }
  const center = { x: start.x + start.width / 2, y: start.y + start.height / 2 }
  const anchorOffset = rotateVector((-hx * start.width) / 2, (-hy * start.height) / 2, rotation)
  const anchor = { x: center.x + anchorOffset.x, y: center.y + anchorOffset.y }
  const newOffset = rotateVector((hx * width) / 2, (hy * height) / 2, rotation)
  const newCenter = { x: anchor.x + newOffset.x, y: anchor.y + newOffset.y }
  return { x: newCenter.x - width / 2, y: newCenter.y - height / 2, width, height }
}

/** Apply a new box to an object (scales drawings, keeps lines' points). */
export function applyBox(object, box) {
  const next = { ...object, ...box }
  if (object.type === 'ink' && object.strokes && object.width !== undefined) {
    const from = { x: object.x, y: object.y, width: object.width, height: object.height }
    const sx = from.width ? box.width / from.width : 1
    const sy = from.height ? box.height / from.height : 1
    next.strokes = object.strokes.map((stroke) => stroke.map((point) => ({ x: box.x + (point.x - from.x) * sx, y: box.y + (point.y - from.y) * sy })))
  }
  return next
}

export function rotationFromPointer(object, pointer, snap = false) {
  const center = { x: object.x + object.width / 2, y: object.y + object.height / 2 }
  let angle = (Math.atan2(pointer.y - center.y, pointer.x - center.x) * 180) / Math.PI + 90
  angle = ((angle % 360) + 360) % 360
  const step = snap ? 15 : 45
  const nearest = Math.round(angle / step) * step
  if (snap || Math.abs(nearest - angle) < 4) angle = nearest % 360
  return Math.round(angle * 10) / 10
}

/** Merge text-selection rectangles into one rectangle per line. */
export function mergeLineRects(rects) {
  const usable = rects.filter((rect) => rect.width > 0.5 && rect.height > 1).sort((a, b) => a.y - b.y || a.x - b.x)
  const lines = []
  for (const rect of usable) {
    const line = lines.find((candidate) => {
      const overlap = Math.min(candidate.y + candidate.height, rect.y + rect.height) - Math.max(candidate.y, rect.y)
      return overlap > Math.min(candidate.height, rect.height) * 0.5
    })
    if (line) line.items.push(rect)
    else lines.push({ y: rect.y, height: rect.height, items: [rect] })
  }
  const merged = []
  for (const line of lines) {
    const items = line.items.sort((a, b) => a.x - b.x)
    let current = null
    for (const rect of items) {
      if (current && rect.x <= current.x + current.width + Math.max(2, rect.height * 0.6)) {
        const right = Math.max(current.x + current.width, rect.x + rect.width)
        const top = Math.min(current.y, rect.y)
        const bottom = Math.max(current.y + current.height, rect.y + rect.height)
        current = { x: current.x, y: top, width: right - current.x, height: bottom - top }
      } else {
        if (current) merged.push(current)
        current = { ...rect }
      }
    }
    if (current) merged.push(current)
  }
  return merged
}
