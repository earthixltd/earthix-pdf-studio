import test from 'node:test'
import assert from 'node:assert/strict'
import { calculatePdfZoom, clampPdfZoom } from '../../frontend/src/features/pdf-viewer/zoomMath.js'

test('fits page width without changing the page aspect ratio', () => {
  assert.equal(calculatePdfZoom({
    mode: 'width',
    containerWidth: 900,
    containerHeight: 700,
    pageWidth: 600,
    pageHeight: 800,
    gutter: 64,
  }), 1.3933333333333333)
})

test('fits the whole page using the smaller width or height scale', () => {
  assert.equal(calculatePdfZoom({
    mode: 'page',
    containerWidth: 900,
    containerHeight: 700,
    pageWidth: 600,
    pageHeight: 800,
    gutter: 64,
  }), 0.795)
})

test('manual zoom is clamped to supported safe bounds', () => {
  assert.equal(calculatePdfZoom({ mode: 'manual', manualZoom: 1.4 }), 1.4)
  assert.equal(clampPdfZoom(0.01), 0.25)
  assert.equal(clampPdfZoom(10), 4)
})

test('invalid page geometry falls back to the requested manual zoom', () => {
  assert.equal(calculatePdfZoom({ mode: 'width', pageWidth: 0, pageHeight: 0, manualZoom: 1.25 }), 1.25)
})
