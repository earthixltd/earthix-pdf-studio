export const MIN_PDF_ZOOM = 0.25
export const MAX_PDF_ZOOM = 4
export const PDF_VIEWER_GUTTER = 64

export function clampPdfZoom(value) {
  if (!Number.isFinite(value)) return 1
  return Math.min(MAX_PDF_ZOOM, Math.max(MIN_PDF_ZOOM, value))
}

export function calculatePdfZoom({
  mode = 'width',
  containerWidth,
  containerHeight,
  pageWidth,
  pageHeight,
  manualZoom = 1,
  gutter = PDF_VIEWER_GUTTER,
} = {}) {
  const safePageWidth = Number(pageWidth)
  const safePageHeight = Number(pageHeight)
  if (!(safePageWidth > 0) || !(safePageHeight > 0)) return clampPdfZoom(manualZoom)

  if (mode === 'manual') return clampPdfZoom(manualZoom)

  const availableWidth = Math.max(1, Number(containerWidth || 0) - gutter)
  const widthScale = availableWidth / safePageWidth
  if (mode === 'width') return clampPdfZoom(widthScale)

  const availableHeight = Math.max(1, Number(containerHeight || 0) - gutter)
  const heightScale = availableHeight / safePageHeight
  return clampPdfZoom(Math.min(widthScale, heightScale))
}
