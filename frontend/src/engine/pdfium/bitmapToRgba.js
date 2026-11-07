import { PdfEngineError } from '../engineErrors.js'

/**
 * Convert a PDFium bitmap buffer to ImageData-compatible RGBA pixels.
 * PDFium scanlines are BGRA/BGRx, and their stride can exceed width * 4.
 *
 * Supported PDFium formats:
 * 1 = Gray, 2 = BGR, 3 = BGRx, 4 = BGRA, 5 = premultiplied BGRA.
 */
export function bitmapToRgba(source, { width, height, stride, format }) {
  if (!(source instanceof Uint8Array)) {
    throw new PdfEngineError('PDFium bitmap data must be a Uint8Array.', { code: 'INVALID_BITMAP_DATA' })
  }
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new PdfEngineError('PDFium returned invalid bitmap dimensions.', { code: 'INVALID_BITMAP_DIMENSIONS' })
  }

  const bytesPerPixel = format === 1 ? 1 : format === 2 ? 3 : [3, 4, 5].includes(format) ? 4 : 0
  if (!bytesPerPixel) {
    throw new PdfEngineError(`PDFium returned an unsupported bitmap format (${format}).`, { code: 'UNSUPPORTED_BITMAP_FORMAT' })
  }

  const minimumStride = width * bytesPerPixel
  const rowStride = stride ?? minimumStride
  if (!Number.isInteger(rowStride) || rowStride < minimumStride || source.byteLength < rowStride * height) {
    throw new PdfEngineError('PDFium returned an incomplete bitmap buffer.', { code: 'INVALID_BITMAP_STRIDE' })
  }

  const rgba = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    const sourceRow = y * rowStride
    const targetRow = y * width * 4
    for (let x = 0; x < width; x += 1) {
      const sourceOffset = sourceRow + x * bytesPerPixel
      const targetOffset = targetRow + x * 4

      if (format === 1) {
        const gray = source[sourceOffset]
        rgba[targetOffset] = gray
        rgba[targetOffset + 1] = gray
        rgba[targetOffset + 2] = gray
        rgba[targetOffset + 3] = 255
      } else if (format === 2) {
        rgba[targetOffset] = source[sourceOffset + 2]
        rgba[targetOffset + 1] = source[sourceOffset + 1]
        rgba[targetOffset + 2] = source[sourceOffset]
        rgba[targetOffset + 3] = 255
      } else {
        const blue = source[sourceOffset]
        const green = source[sourceOffset + 1]
        const red = source[sourceOffset + 2]
        const alpha = format === 3 ? 255 : source[sourceOffset + 3]

        if (format === 5 && alpha > 0 && alpha < 255) {
          rgba[targetOffset] = Math.min(255, Math.round((red * 255) / alpha))
          rgba[targetOffset + 1] = Math.min(255, Math.round((green * 255) / alpha))
          rgba[targetOffset + 2] = Math.min(255, Math.round((blue * 255) / alpha))
        } else {
          rgba[targetOffset] = red
          rgba[targetOffset + 1] = green
          rgba[targetOffset + 2] = blue
        }
        rgba[targetOffset + 3] = alpha
      }
    }
  }

  return rgba
}
