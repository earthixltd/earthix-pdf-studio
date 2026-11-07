// Vector paths shared by the SVG preview and the PDF writer.
// A path is a list of segments: { op: 'M' | 'L', x, y } | { op: 'C', x1, y1, x2, y2, x, y } | { op: 'Z' }.

const KAPPA = 0.5522847498

export function rectSegments(x, y, width, height) {
  return [
    { op: 'M', x, y },
    { op: 'L', x: x + width, y },
    { op: 'L', x: x + width, y: y + height },
    { op: 'L', x, y: y + height },
    { op: 'Z' },
  ]
}

export function ellipseSegments(cx, cy, rx, ry) {
  const ox = rx * KAPPA
  const oy = ry * KAPPA
  return [
    { op: 'M', x: cx + rx, y: cy },
    { op: 'C', x1: cx + rx, y1: cy + oy, x2: cx + ox, y2: cy + ry, x: cx, y: cy + ry },
    { op: 'C', x1: cx - ox, y1: cy + ry, x2: cx - rx, y2: cy + oy, x: cx - rx, y: cy },
    { op: 'C', x1: cx - rx, y1: cy - oy, x2: cx - ox, y2: cy - ry, x: cx, y: cy - ry },
    { op: 'C', x1: cx + ox, y1: cy - ry, x2: cx + rx, y2: cy - oy, x: cx + rx, y: cy },
    { op: 'Z' },
  ]
}

/** Smooth freehand stroke through the points (quadratic midpoints as cubics). */
export function strokeSegments(points) {
  if (!points?.length) return []
  if (points.length === 1) return [{ op: 'M', ...points[0] }, { op: 'L', x: points[0].x + 0.01, y: points[0].y }]
  if (points.length === 2) return [{ op: 'M', ...points[0] }, { op: 'L', ...points[1] }]
  const segments = [{ op: 'M', x: points[0].x, y: points[0].y }]
  let start = points[0]
  for (let index = 1; index < points.length - 1; index += 1) {
    const control = points[index]
    const end = { x: (control.x + points[index + 1].x) / 2, y: (control.y + points[index + 1].y) / 2 }
    segments.push({
      op: 'C',
      x1: start.x + (2 / 3) * (control.x - start.x),
      y1: start.y + (2 / 3) * (control.y - start.y),
      x2: end.x + (2 / 3) * (control.x - end.x),
      y2: end.y + (2 / 3) * (control.y - end.y),
      x: end.x,
      y: end.y,
    })
    start = end
  }
  segments.push({ op: 'L', ...points.at(-1) })
  return segments
}

/** Filled triangle for an arrow pointing from `from` to `to`. */
export function arrowHeadSegments(from, to, strokeWidth) {
  const length = Math.max(8, strokeWidth * 4)
  const angle = Math.atan2(to.y - from.y, to.x - from.x)
  const spread = Math.PI / 7
  const left = { x: to.x - length * Math.cos(angle - spread), y: to.y - length * Math.sin(angle - spread) }
  const right = { x: to.x - length * Math.cos(angle + spread), y: to.y - length * Math.sin(angle + spread) }
  return [{ op: 'M', ...to }, { op: 'L', ...left }, { op: 'L', ...right }, { op: 'Z' }]
}

/** Where the arrow's shaft should end so it does not poke through the head. */
export function arrowShaftEnd(from, to, strokeWidth) {
  const length = Math.max(8, strokeWidth * 4) * Math.cos(Math.PI / 7) * 0.8
  const total = Math.hypot(to.x - from.x, to.y - from.y)
  if (total <= length) return from
  const ratio = (total - length) / total
  return { x: from.x + (to.x - from.x) * ratio, y: from.y + (to.y - from.y) * ratio }
}

const round = (value) => Math.round(value * 100) / 100

export function segmentsToSvg(segments) {
  return segments.map((segment) => {
    if (segment.op === 'Z') return 'Z'
    if (segment.op === 'C') return `C${round(segment.x1)} ${round(segment.y1)} ${round(segment.x2)} ${round(segment.y2)} ${round(segment.x)} ${round(segment.y)}`
    return `${segment.op}${round(segment.x)} ${round(segment.y)}`
  }).join(' ')
}

export function segmentsToPdf(segments, format) {
  return segments.map((segment) => {
    if (segment.op === 'Z') return 'h'
    if (segment.op === 'C') return `${format(segment.x1)} ${format(segment.y1)} ${format(segment.x2)} ${format(segment.y2)} ${format(segment.x)} ${format(segment.y)} c`
    return `${format(segment.x)} ${format(segment.y)} ${segment.op === 'M' ? 'm' : 'l'}`
  }).join('\n')
}

export function pointsBounds(points, padding = 0) {
  if (!points.length) return { x: 0, y: 0, width: 0, height: 0 }
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  const x = Math.min(...xs) - padding
  const y = Math.min(...ys) - padding
  return { x, y, width: Math.max(...xs) + padding - x, height: Math.max(...ys) + padding - y }
}
