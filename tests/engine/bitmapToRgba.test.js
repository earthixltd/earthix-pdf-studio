import test from 'node:test'
import assert from 'node:assert/strict'
import { bitmapToRgba } from '../../frontend/src/engine/pdfium/bitmapToRgba.js'

test('converts BGRA pixels to browser RGBA and preserves alpha', () => {
  const source = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80])
  const result = bitmapToRgba(source, { width: 2, height: 1, stride: 8, format: 4 })
  assert.deepEqual([...result], [30, 20, 10, 40, 70, 60, 50, 80])
})

test('converts BGRx and ignores the unused fourth channel', () => {
  const source = new Uint8Array([10, 20, 30, 0])
  const result = bitmapToRgba(source, { width: 1, height: 1, stride: 4, format: 3 })
  assert.deepEqual([...result], [30, 20, 10, 255])
})

test('respects padded scanline stride', () => {
  const source = new Uint8Array([
    3, 2, 1, 0, 6, 5, 4, 0, 99, 99, 99, 99,
    9, 8, 7, 0, 12, 11, 10, 0, 88, 88, 88, 88,
  ])
  const result = bitmapToRgba(source, { width: 2, height: 2, stride: 12, format: 3 })
  assert.deepEqual([...result], [1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255])
})

test('converts grayscale and BGR formats', () => {
  assert.deepEqual([...bitmapToRgba(new Uint8Array([42]), { width: 1, height: 1, stride: 1, format: 1 })], [42, 42, 42, 255])
  assert.deepEqual([...bitmapToRgba(new Uint8Array([4, 5, 6]), { width: 1, height: 1, stride: 3, format: 2 })], [6, 5, 4, 255])
})

test('rejects unknown formats, invalid dimensions and incomplete buffers', () => {
  assert.throws(() => bitmapToRgba(new Uint8Array(4), { width: 1, height: 1, stride: 4, format: 0 }), { code: 'UNSUPPORTED_BITMAP_FORMAT' })
  assert.throws(() => bitmapToRgba(new Uint8Array(4), { width: 0, height: 1, stride: 4, format: 3 }), { code: 'INVALID_BITMAP_DIMENSIONS' })
  assert.throws(() => bitmapToRgba(new Uint8Array(3), { width: 1, height: 1, stride: 4, format: 3 }), { code: 'INVALID_BITMAP_STRIDE' })
})
