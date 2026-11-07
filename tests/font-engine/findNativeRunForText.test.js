import test from 'node:test'
import assert from 'node:assert/strict'
import { findNativeRunForText } from '../../frontend/src/features/text-editor/findNativeRunForText.js'

const run = (key, originalText, pageIndex = 0) => ({ key, originalText, pageIndex })

test('matches an exact text-layer span to one original PDF text run', () => {
  const selected = run('r1', 'Passenger Name')
  assert.deepEqual(findNativeRunForText([selected], 0, 'Passenger Name'), {
    run: selected,
    matchType: 'exact',
    reason: '',
  })
})

test('normalizes whitespace before matching text-layer spans', () => {
  const selected = run('r1', 'Prescribed original ID proof')
  assert.equal(findNativeRunForText([selected], 0, 'Prescribed  original\nID proof').run, selected)
})

test('matches a unique span contained in a single native text run', () => {
  const selected = run('r1', 'The passenger name is MD GULREZ')
  const result = findNativeRunForText([selected], 0, 'MD GULREZ')
  assert.equal(result.run, selected)
  assert.equal(result.matchType, 'partial')
})

test('does not match text on a different page', () => {
  const result = findNativeRunForText([run('r1', 'Passenger Name', 1)], 0, 'Passenger Name')
  assert.equal(result.run, null)
  assert.equal(result.matchType, 'unsupported')
})

test('rejects duplicate exact matches instead of selecting an arbitrary object', () => {
  const result = findNativeRunForText([run('r1', 'Repeated'), run('r2', 'Repeated')], 0, 'Repeated')
  assert.equal(result.run, null)
  assert.equal(result.matchType, 'ambiguous')
})

test('rejects multiple partial matches instead of choosing the first run', () => {
  const result = findNativeRunForText([
    run('r1', 'First repeated value'),
    run('r2', 'Second repeated value'),
  ], 0, 'repeated value')
  assert.equal(result.run, null)
  assert.equal(result.matchType, 'ambiguous')
})

test('reports an unsupported click when no original text operator matches', () => {
  const result = findNativeRunForText([run('r1', 'Other text')], 0, 'Image caption')
  assert.equal(result.run, null)
  assert.equal(result.matchType, 'unsupported')
  assert.match(result.reason, /No duplicate overlay/i)
})

test('rejects empty clicked text', () => {
  const result = findNativeRunForText([run('r1', 'Other text')], 0, '   ')
  assert.equal(result.run, null)
  assert.equal(result.matchType, 'none')
})
