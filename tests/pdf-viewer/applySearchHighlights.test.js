import test from 'node:test'
import assert from 'node:assert/strict'
import { applySearchHighlights } from '../../frontend/src/features/pdf-viewer/applySearchHighlights.js'

function createLayer(items) {
  const flags = items.map(() => false)
  const textDivs = flags.map((_, index) => ({
    classList: {
      toggle(className, enabled) {
        assert.equal(className, 'earthix-search-hit')
        flags[index] = enabled
      },
    },
  }))
  return { layer: { textDivs, textContentItemsStr: items }, flags }
}

test('highlights a case-insensitive match within a text run', () => {
  const { layer, flags } = createLayer(['Passenger MD GULREZ', 'Train details'])
  assert.equal(applySearchHighlights(layer, 'md gulrez'), 1)
  assert.deepEqual(flags, [true, false])
})

test('highlights all text runs intersecting a cross-run search result', () => {
  const { layer, flags } = createLayer(['Reservation', 'Slip', 'Other text'])
  assert.equal(applySearchHighlights(layer, 'reservation slip', [0, 1]), 2)
  assert.deepEqual(flags, [true, true, false])
})

test('clearing the search removes existing highlights', () => {
  const { layer, flags } = createLayer(['Matched text', 'Other text'])
  applySearchHighlights(layer, 'matched')
  assert.deepEqual(flags, [true, false])
  assert.equal(applySearchHighlights(layer, '', []), 0)
  assert.deepEqual(flags, [false, false])
})

test('a new query clears old highlights from non-matching runs', () => {
  const { layer, flags } = createLayer(['Alpha text', 'Beta text'])
  applySearchHighlights(layer, 'alpha')
  assert.equal(applySearchHighlights(layer, 'beta'), 1)
  assert.deepEqual(flags, [false, true])
})
