// Indic (Devanagari, Bengali, Gurmukhi, Gujarati, Oriya, Tamil, Telugu,
// Kannada, Malayalam) text read from PDFs often comes out in *visual* glyph
// order: the short-i matra (ि) appears before its consonant and the reph (र्)
// after the cluster it sits on. This converts such text back to the logical
// order people type, and leaves text that is already logical unchanged.

export const INDIC_SCRIPT = /[\u0900-\u0DFF]/

const CONSONANT_RANGES = [
  [0x0915, 0x0939], [0x0958, 0x095f], [0x0978, 0x097f], // Devanagari
  [0x0995, 0x09b9], [0x09dc, 0x09df], // Bengali
  [0x0a15, 0x0a39], [0x0a59, 0x0a5e], // Gurmukhi
  [0x0a95, 0x0ab9], // Gujarati
  [0x0b15, 0x0b39], [0x0b5c, 0x0b5f], // Oriya
  [0x0b95, 0x0bb9], // Tamil
  [0x0c15, 0x0c39], // Telugu
  [0x0c95, 0x0cb9], // Kannada
  [0x0d15, 0x0d3a], // Malayalam
]
const HALANTS = new Set([0x094d, 0x09cd, 0x0a4d, 0x0acd, 0x0b4d, 0x0bcd, 0x0c4d, 0x0ccd, 0x0d4d])
const NUKTAS = new Set([0x093c, 0x09bc, 0x0a3c, 0x0abc, 0x0b3c, 0x0cbc])
const PRE_BASE = new Set([0x093f, 0x09bf, 0x09c7, 0x09c8, 0x0a3f, 0x0abf, 0x0b47, 0x0bc6, 0x0bc7, 0x0bc8, 0x0d46, 0x0d47, 0x0d48])
const RA = new Set([0x0930, 0x09b0, 0x0a30, 0x0ab0, 0x0b30, 0x0cb0, 0x0d30])

const code = (character) => character?.codePointAt(0) ?? -1
export const isConsonant = (character) => {
  const value = code(character)
  return CONSONANT_RANGES.some(([low, high]) => value >= low && value <= high)
}
const isHalant = (character) => HALANTS.has(code(character))
const isNukta = (character) => NUKTAS.has(code(character))
const isPreBase = (character) => PRE_BASE.has(code(character))
/** Dependent vowel signs and other marks that follow a cluster. */
const isMark = (character) => {
  const value = code(character)
  if (value < 0x0900 || value > 0x0dff) return false
  const offset = value & 0x7f
  return (offset >= 0x00 && offset <= 0x03) || (offset >= 0x3a && offset <= 0x4f && !HALANTS.has(value)) || (offset >= 0x51 && offset <= 0x57) || offset === 0x62 || offset === 0x63
}

/** Length of the consonant cluster (C N? (H C N?)*) starting at `start`. */
function clusterLength(chars, start) {
  if (!isConsonant(chars[start])) return 0
  let end = start + 1
  if (isNukta(chars[end])) end += 1
  while (isHalant(chars[end]) && isConsonant(chars[end + 1])) {
    end += 2
    if (isNukta(chars[end])) end += 1
  }
  return end - start
}

function isReph(chars, index) {
  return RA.has(code(chars[index])) && isHalant(chars[index + 1])
}

/** True when the text shows pre-base matras or rephs in visual positions. */
export function looksVisual(text) {
  const chars = [...text]
  let visual = 0
  let logical = 0
  for (let index = 0; index < chars.length; index += 1) {
    if (isPreBase(chars[index])) {
      const before = chars[index - 1]
      const afterIsConsonant = isConsonant(chars[index + 1])
      if (!isConsonant(before) && !isNukta(before) && afterIsConsonant) visual += 1
      else if (!afterIsConsonant && (isConsonant(before) || isNukta(before))) logical += 1
    } else if (isReph(chars, index)) {
      if (!isConsonant(chars[index + 2])) visual += 1
      else logical += 1
    }
  }
  return visual > 0 && logical === 0
}

/** Convert visual-order Indic text to logical order (no-op for logical text). */
export function toLogicalIndic(text) {
  if (!INDIC_SCRIPT.test(text) || !looksVisual(text)) return text
  const chars = [...text]
  // 1. Pre-base matras: move after the following consonant cluster.
  for (let index = 0; index < chars.length; index += 1) {
    if (!isPreBase(chars[index])) continue
    const length = clusterLength(chars, index + 1)
    if (!length) continue
    const [matra] = chars.splice(index, 1)
    chars.splice(index + length, 0, matra)
    index += length
  }
  // 2. Rephs drawn after their cluster: move before the cluster.
  for (let index = 0; index < chars.length - 1; index += 1) {
    if (!isReph(chars, index) || isConsonant(chars[index + 2])) continue
    let start = index
    while (start > 0 && isMark(chars[start - 1])) start -= 1
    // Walk back over the consonant cluster that carries the reph.
    let clusterStart = start - 1
    while (clusterStart > 0 && isNukta(chars[clusterStart])) clusterStart -= 1
    while (clusterStart >= 2 && isHalant(chars[clusterStart - 1]) && isConsonant(chars[clusterStart - 2])) clusterStart -= 2
    if (clusterStart < 0 || !isConsonant(chars[clusterStart])) continue
    const reph = chars.splice(index, 2)
    chars.splice(clusterStart, 0, ...reph)
    index += 1
  }
  return chars.join('')
}
