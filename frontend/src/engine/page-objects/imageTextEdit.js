// Editing text that is part of a picture: the old letters are painted over
// with the surrounding background, and the original text colour and weight
// are measured so the new text can be drawn in the same style.
//
// Works on raw RGBA pixels ({ width, height, data }) so it runs anywhere.

const channels = 4

function pixel(image, x, y) {
  const offset = (y * image.width + x) * channels
  return [image.data[offset], image.data[offset + 1], image.data[offset + 2]]
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function medianColor(samples) {
  if (!samples.length) return null
  return [0, 1, 2].map((channel) => median(samples.map((sample) => sample[channel])))
}

/** Background colour just outside the box edge, along one side. */
function sideSample(image, x, y, dx, dy, depth = 3) {
  const samples = []
  for (let step = 1; step <= depth; step += 1) {
    const sx = x + dx * step
    const sy = y + dy * step
    if (sx < 0 || sy < 0 || sx >= image.width || sy >= image.height) break
    samples.push(pixel(image, sx, sy))
  }
  return medianColor(samples)
}

/**
 * Fill `box` (inclusive pixel bounds) with colours interpolated from the
 * pixels around it. Returns a new pixel array; the input is not changed.
 */
export function inpaintBox(image, box) {
  const output = new Uint8ClampedArray(image.data)
  const x0 = Math.max(0, Math.floor(box.x0))
  const y0 = Math.max(0, Math.floor(box.y0))
  const x1 = Math.min(image.width - 1, Math.ceil(box.x1))
  const y1 = Math.min(image.height - 1, Math.ceil(box.y1))
  const left = []
  const right = []
  for (let y = y0; y <= y1; y += 1) {
    left[y] = sideSample(image, x0, y, -1, 0)
    right[y] = sideSample(image, x1, y, 1, 0)
  }
  const top = []
  const bottom = []
  for (let x = x0; x <= x1; x += 1) {
    top[x] = sideSample(image, x, y0, 0, -1)
    bottom[x] = sideSample(image, x, y1, 0, 1)
  }
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const candidates = []
      const tx = (x - x0 + 1) / (x1 - x0 + 2)
      const ty = (y - y0 + 1) / (y1 - y0 + 2)
      const horizontal = left[y] && right[y]
        ? left[y].map((value, channel) => value * (1 - tx) + right[y][channel] * tx)
        : left[y] || right[y]
      const vertical = top[x] && bottom[x]
        ? top[x].map((value, channel) => value * (1 - ty) + bottom[x][channel] * ty)
        : top[x] || bottom[x]
      if (horizontal) candidates.push({ color: horizontal, weight: 1 / Math.min(x - x0 + 1, x1 - x + 1) })
      if (vertical) candidates.push({ color: vertical, weight: 1 / Math.min(y - y0 + 1, y1 - y + 1) })
      if (!candidates.length) continue
      const total = candidates.reduce((sum, item) => sum + item.weight, 0)
      const offset = (y * image.width + x) * channels
      for (let channel = 0; channel < 3; channel += 1) {
        output[offset + channel] = Math.round(candidates.reduce((sum, item) => sum + item.color[channel] * item.weight, 0) / total)
      }
      output[offset + 3] = 255
    }
  }
  return output
}

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
const toHex = (color) => `#${color.map((value) => Math.round(value).toString(16).padStart(2, '0')).join('').toUpperCase()}`

/**
 * Colour and weight of the letters inside `box`, comparing the original
 * pixels with the painted-over background.
 */
export function measureTextStyle(image, background, box) {
  const x0 = Math.max(0, Math.floor(box.x0))
  const y0 = Math.max(0, Math.floor(box.y0))
  const x1 = Math.min(image.width - 1, Math.ceil(box.x1))
  const y1 = Math.min(image.height - 1, Math.ceil(box.y1))
  const samples = []
  let maxDifference = 0
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const offset = (y * image.width + x) * channels
      const original = [image.data[offset], image.data[offset + 1], image.data[offset + 2]]
      const behind = [background[offset], background[offset + 1], background[offset + 2]]
      const difference = distance(original, behind)
      samples.push({ original, difference })
      if (difference > maxDifference) maxDifference = difference
    }
  }
  const area = Math.max(1, samples.length)
  const threshold = Math.max(36, maxDifference * 0.55)
  const ink = samples.filter((sample) => sample.difference >= threshold)
  const core = ink.filter((sample) => sample.difference >= Math.max(threshold, maxDifference * 0.8))
  const chosen = core.length >= 4 ? core : ink
  const color = chosen.length ? medianColor(chosen.map((sample) => sample.original)) : [0, 0, 0]
  const coverage = samples.filter((sample) => sample.difference >= Math.max(30, maxDifference * 0.4)).length / area
  return { color: toHex(color), coverage, bold: coverage > 0.3, contrast: maxDifference }
}

/** Font size (pt) for a line of text from its measured box. */
export function estimateFontSize({ text, heightPt, widthPt, measure }) {
  const hasAscender = /[A-Z0-9bdfhiklt'"!?]/.test(text) || /[\u0905-\u0939]/.test(text)
  const hasDescender = /[gjpqyQ,;()]/.test(text)
  const factor = (hasAscender ? 0.72 : 0.53) + (hasDescender ? 0.21 : 0)
  const byHeight = Math.max(3, heightPt / factor)
  let size = byHeight
  if (measure && widthPt > 0 && text.trim()) {
    const measured = measure(text, byHeight)
    if (measured > 0) {
      const byWidth = byHeight * (widthPt / measured)
      if (byWidth > byHeight * 0.75 && byWidth < byHeight * 1.35) size = byWidth
    }
  }
  return Math.round(size * 2) / 2
}
