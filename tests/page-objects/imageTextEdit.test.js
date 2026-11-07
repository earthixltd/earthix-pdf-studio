import { test } from 'node:test'
import assert from 'node:assert/strict'
import { estimateFontSize, inpaintBox, measureTextStyle } from '../../frontend/src/engine/page-objects/imageTextEdit.js'
import { createStandardMeasurer } from '../../frontend/src/engine/page-objects/textLayout.js'

/** 120 x 40 picture: horizontal blue gradient with a dark red "text" bar pattern. */
function picture() {
  const width = 120
  const height = 40
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4
      const inText = x >= 30 && x <= 90 && y >= 14 && y <= 26 && (x % 4 < 2)
      const color = inText ? [150, 20, 30] : [40 + x, 110, 220]
      data.set([...color, 255], offset)
    }
  }
  return { width, height, data }
}

test('painting over text restores the surrounding background, even on gradients', () => {
  const image = picture()
  const filled = inpaintBox(image, { x0: 28, y0: 12, x1: 92, y1: 28 })
  for (const [x, y] of [[30, 14], [60, 20], [88, 26]]) {
    const offset = (y * image.width + x) * 4
    const expected = [40 + x, 110, 220]
    const actual = [filled[offset], filled[offset + 1], filled[offset + 2]]
    assert.ok(actual.every((value, channel) => Math.abs(value - expected[channel]) <= 3), `${actual} vs ${expected}`)
  }
  // Pixels outside the box are untouched.
  assert.equal(filled[(5 * image.width + 5) * 4], image.data[(5 * image.width + 5) * 4])
})

test('the original text colour and weight are measured', () => {
  const image = picture()
  const box = { x0: 30, y0: 14, x1: 90, y1: 26 }
  const background = inpaintBox(image, { x0: 28, y0: 12, x1: 92, y1: 28 })
  const style = measureTextStyle(image, background, box)
  assert.equal(style.color, '#96141E')
  assert.equal(style.bold, true)
})

test('font size is estimated from the text box and refined by its width', () => {
  const measure = createStandardMeasurer('Helvetica')
  const text = 'Boarding At'
  const realSize = 18
  const widthPt = measure(text, realSize)
  const heightPt = realSize * 0.93 // capital B + descender g
  const size = estimateFontSize({ text, heightPt, widthPt, measure })
  assert.ok(Math.abs(size - realSize) <= 0.5, `estimated ${size}`)
})
