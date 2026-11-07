import test from 'node:test'
import assert from 'node:assert/strict'
import { assessFontReplacement, getFontStyleLabel } from '../../frontend/src/engine/font-engine/fontCapabilities.js'

const font = {
  canNativeReplace: true,
  supportedCharacters: ['A', 'B', 'C', ' ', '1'],
  isBold: true,
  isItalic: true,
  limitations: [],
}

test('font replacement assessment accepts mapped characters', () => {
  const result = assessFontReplacement(font, 'ABC 1')
  assert.equal(result.supported, true)
  assert.deepEqual(result.missingCharacters, [])
  assert.equal(result.reason, '')
})

test('font replacement assessment reports missing glyphs without substitution', () => {
  const result = assessFontReplacement(font, 'ABZ')
  assert.equal(result.supported, false)
  assert.deepEqual(result.missingCharacters, ['Z'])
  assert.match(result.reason, /does not contain/)
})

test('font replacement assessment rejects unsupported font encodings', () => {
  const result = assessFontReplacement({ canNativeReplace: false, limitations: ['No ToUnicode map.'] }, 'ABC')
  assert.equal(result.supported, false)
  assert.equal(result.reason, 'No ToUnicode map.')
})

test('font replacement assessment rejects empty replacement strings', () => {
  const result = assessFontReplacement(font, '')
  assert.equal(result.supported, false)
  assert.match(result.reason, /cannot be empty/)
})

test('font style label reflects bold and italic flags', () => {
  assert.equal(getFontStyleLabel(font), 'Bold Italic')
  assert.equal(getFontStyleLabel({ isBold: true }), 'Bold')
  assert.equal(getFontStyleLabel({ isItalic: true }), 'Italic')
  assert.equal(getFontStyleLabel({}), 'Regular')
})
