import test from 'node:test'
import assert from 'node:assert/strict'
import { findFontForRun } from '../../frontend/src/engine/font-engine/FontInspector.js'

const font = (fontObjectNumber, resourceName, pageIndices) => ({
  fontObjectNumber,
  resourceName,
  pageIndices,
})

test('finds the font resource used by the selected page text run', () => {
  const expected = font(17, 'F1', [0, 1])
  const result = findFontForRun([font(20, 'F2', [0]), expected], {
    fontObjectNumber: 17,
    fontResource: 'F1',
    pageIndex: 1,
  })
  assert.equal(result, expected)
})

test('does not match a font resource from a different page', () => {
  const fallback = { fontFamily: 'Embedded Font' }
  const result = findFontForRun([font(17, 'F1', [0])], {
    fontObjectNumber: 17,
    fontResource: 'F1',
    pageIndex: 1,
    fontMetadata: fallback,
  })
  assert.equal(result, fallback)
})

test('returns null when neither a matching font nor run metadata is available', () => {
  assert.equal(findFontForRun([], null), null)
  assert.equal(findFontForRun([], { pageIndex: 0 }), null)
})
