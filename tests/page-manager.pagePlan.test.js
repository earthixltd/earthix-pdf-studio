import test from 'node:test'
import assert from 'node:assert/strict'
import { createPagePlan, movePage, rotatePage, removePage, addBlankPage, isPagePlanChanged, validatePagePlan } from '../frontend/src/features/page-manager/pagePlan.js'

test('creates stable page entries for the source PDF', () => {
  const plan = createPagePlan(3)
  assert.deepEqual(plan.map((page) => page.sourceIndex), [0, 1, 2])
  assert.equal(isPagePlanChanged(plan, 3), false)
})

test('reorders pages without losing their source references', () => {
  const plan = movePage(createPagePlan(3), 0, 2)
  assert.deepEqual(plan.map((page) => page.sourceIndex), [1, 2, 0])
  assert.equal(isPagePlanChanged(plan, 3), true)
})

test('rotates one page in 90 degree increments and normalizes angle', () => {
  let plan = createPagePlan(2)
  plan = rotatePage(plan, 1, -90)
  assert.equal(plan[1].rotationDelta, 270)
  assert.equal(plan[0].rotationDelta, 0)
})

test('prevents removing the final page', () => {
  const plan = createPagePlan(1)
  assert.equal(removePage(plan, 0).length, 1)
})

test('supports appending a blank page', () => {
  const plan = addBlankPage(createPagePlan(2))
  assert.equal(plan.length, 3)
  assert.equal(plan[2].isBlank, true)
})

test('rejects an empty output plan', () => {
  assert.deepEqual(validatePagePlan([]), { valid: false, reason: 'A PDF must contain at least one page.' })
})

test('detects deleting the last source page', () => {
  const plan = removePage(createPagePlan(3), 2)
  assert.equal(isPagePlanChanged(plan, 3), true)
})
