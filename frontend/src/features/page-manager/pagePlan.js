export function createPagePlan(pageCount) {
  return Array.from({ length: pageCount }, (_, index) => ({
    id: `source-${index}`,
    sourceIndex: index,
    rotationDelta: 0,
    isBlank: false,
  }))
}

export function movePage(plan, fromIndex, toIndex) {
  if (!Array.isArray(plan) || fromIndex < 0 || toIndex < 0 || fromIndex >= plan.length || toIndex >= plan.length) return plan
  if (fromIndex === toIndex) return plan
  const next = [...plan]
  const [item] = next.splice(fromIndex, 1)
  next.splice(toIndex, 0, item)
  return next
}

export function rotatePage(plan, index, degrees) {
  if (!Array.isArray(plan) || !plan[index] || ![90, -90, 180, 270].includes(degrees)) return plan
  return plan.map((page, pageIndex) => pageIndex === index
    ? { ...page, rotationDelta: ((page.rotationDelta + degrees) % 360 + 360) % 360 }
    : page)
}

export function removePage(plan, index) {
  if (!Array.isArray(plan) || plan.length <= 1 || index < 0 || index >= plan.length) return plan
  return plan.filter((_, pageIndex) => pageIndex !== index)
}

export function addBlankPage(plan) {
  const nextId = `blank-${Date.now()}-${plan.length}`
  return [...plan, { id: nextId, sourceIndex: null, rotationDelta: 0, isBlank: true }]
}

export function isPagePlanChanged(plan, originalPageCount = plan.length) {
  return plan.length !== originalPageCount || plan.some((page, index) => page.isBlank || page.sourceIndex !== index || page.rotationDelta !== 0)
}

export function validatePagePlan(plan) {
  if (!Array.isArray(plan) || plan.length === 0) return { valid: false, reason: 'A PDF must contain at least one page.' }
  const sourceIndexes = plan.filter((page) => !page.isBlank).map((page) => page.sourceIndex)
  if (sourceIndexes.some((index) => !Number.isInteger(index) || index < 0)) {
    return { valid: false, reason: 'The page plan contains an invalid source page.' }
  }
  return { valid: true }
}
