/** PDF user-space rectangle [x0, y0, x1, y1] -> CSS pixel rect (PDF.js 6 has no rectangle helper). */
export function viewportRect(viewport, bbox) {
  const [x0, y0, x1, y1] = bbox
  const corners = [[x0, y0], [x0, y1], [x1, y0], [x1, y1]].map(([x, y]) => viewport.convertToViewportPoint(x, y))
  const xs = corners.map((point) => point[0])
  const ys = corners.map((point) => point[1])
  const left = Math.min(...xs)
  const top = Math.min(...ys)
  return { left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top }
}

/** Convert a text block from PDF user space into viewer (CSS pixel) geometry. */
export function blockViewGeometry(block, viewport) {
  const toView = (point) => {
    const [x, y] = viewport.convertToViewportPoint(point.x, point.y)
    return { x, y }
  }
  const origin = toView(block.startPoint)
  const along = toView({ x: block.startPoint.x + block.direction.x, y: block.startPoint.y + block.direction.y })
  const angle = (Math.atan2(along.y - origin.y, along.x - origin.x) * 180) / Math.PI
  const scale = viewport.scale
  const lengthUser = (block.endPoint.x - block.startPoint.x) * block.direction.x + (block.endPoint.y - block.startPoint.y) * block.direction.y
  const ascentPx = Math.max(1, block.ascentUser * scale)
  const descentPx = Math.max(1, -block.descentUser * scale)
  return {
    origin,
    angle: Math.abs(angle) < 0.01 ? 0 : angle,
    fontPx: block.fontSizeUser * scale,
    ascentPx,
    heightPx: ascentPx + descentPx,
    widthPx: Math.max(4, lengthUser * scale),
    letterSpacingPx: (block.characterSpacingUser || 0) * scale,
    horizontalScale: (block.horizontalScaling || 100) / 100,
    rect: viewportRect(viewport, block.bbox),
  }
}

/** Find the block nearest to a PDF user-space point on a page. */
export function findBlockNearPoint(blocks, pageIndex, point, maxDistance = 6) {
  let best = null
  let bestDistance = Infinity
  for (const block of blocks) {
    if (block.pageIndex !== pageIndex) continue
    const distance = Math.hypot(block.startPoint.x - point.x, block.startPoint.y - point.y)
    if (distance < bestDistance) { best = block; bestDistance = distance }
  }
  return bestDistance <= maxDistance ? best : null
}
