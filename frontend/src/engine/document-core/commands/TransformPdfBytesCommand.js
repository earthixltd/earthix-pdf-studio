import { PdfEngineError } from '../../engineErrors.js'
import { validatePdfInput } from '../../validation/validatePdfInput.js'

/**
 * Undoable command that rewrites the working PDF bytes with an async
 * operation `(bytes) => ({ bytes, ...details })` (text restyle, image edit…).
 */
export class TransformPdfBytesCommand {
  constructor(operation, { label = 'Edit PDF', pageIndex = null } = {}) {
    if (typeof operation !== 'function') {
      throw new PdfEngineError('A PDF transform needs an operation.', { code: 'INVALID_PDF_TRANSFORM' })
    }
    this.operation = operation
    this.label = label
    this.pageIndex = pageIndex
    this.beforeState = null
    this.afterState = null
    this.result = null
    this.applied = false
  }

  async execute(core) {
    if (this.applied) throw new PdfEngineError('This change is already applied.', { code: 'PDF_TRANSFORM_ALREADY_APPLIED' })
    if (this.afterState) {
      core.restoreContentState(this.afterState)
      this.applied = true
      return true
    }
    const beforeState = core.captureContentState()
    const result = await this.operation(core.getWorkingBytes())
    const nextBytes = validatePdfInput(result?.bytes)
    const pageIndex = Number.isInteger(this.pageIndex) ? this.pageIndex : beforeState.currentPageIndex
    core.restoreContentState({
      ...beforeState,
      bytes: nextBytes,
      currentPageIndex: Math.max(0, Math.min(pageIndex, beforeState.pageCount - 1)),
    })
    this.beforeState = beforeState
    this.afterState = core.captureContentState()
    this.result = { ...result, bytes: nextBytes.slice() }
    this.applied = true
    return true
  }

  async undo(core) {
    if (!this.applied) return false
    core.restoreContentState(this.beforeState)
    this.applied = false
    return true
  }

  getResult() {
    return this.result ? { ...this.result, bytes: this.result.bytes.slice() } : null
  }
}

/** Add, change or remove several editor objects as one undo step. */
export class SetPageObjectsCommand {
  constructor({ upsert = [], remove = [] } = {}, { label = 'Edit objects' } = {}) {
    this.upsert = upsert.map((object) => structuredClone(object))
    this.remove = [...remove]
    this.label = label
    this.previous = null
  }

  async execute(core) {
    if (!this.previous) {
      const ids = new Set([...this.upsert.map((object) => object.id), ...this.remove])
      this.previous = [...ids].map((id) => ({ id, object: core.objects.get(id) }))
    }
    for (const id of this.remove) core.objects.remove(id)
    for (const object of this.upsert) core.objects.upsert(object)
    core.notifyContentChange()
  }

  async undo(core) {
    for (const { id, object } of this.previous || []) {
      if (object) core.objects.upsert(object)
      else core.objects.remove(id)
    }
    core.notifyContentChange()
  }
}
