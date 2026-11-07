import { PdfEngineError } from '../../engineErrors.js'
import { validatePdfInput } from '../../validation/validatePdfInput.js'
import { replaceNativeTextBlock } from '../../../services/nativePdfTextEditor.js'

function blockReference(block) {
  if (!block || typeof block.key !== 'string' || !Number.isInteger(block.pageIndex)) {
    throw new PdfEngineError('Select editable PDF text first.', { code: 'INVALID_NATIVE_TEXT_BLOCK' })
  }
  return { key: block.key, pageIndex: block.pageIndex, runKeys: [...(block.runKeys || [])], text: block.text }
}

/**
 * Undoable Document Core command that rewrites one text block in the page
 * content stream (same font, size and colour; following words re-flow).
 */
export class ReplaceNativeTextBlockCommand {
  constructor(block, replacementText, {
    label = 'Edit PDF text',
    fontProvider = null,
    replaceOperation = replaceNativeTextBlock,
  } = {}) {
    if (typeof replacementText !== 'string') {
      throw new PdfEngineError('Replacement text must be a string.', { code: 'INVALID_NATIVE_REPLACEMENT' })
    }
    this.block = blockReference(block)
    this.replacementText = replacementText
    this.label = label
    this.fontProvider = fontProvider
    this.replaceOperation = replaceOperation
    this.beforeState = null
    this.afterState = null
    this.result = null
    this.applied = false
  }

  async execute(core) {
    if (this.applied) {
      throw new PdfEngineError('This text edit is already applied.', { code: 'NATIVE_TEXT_COMMAND_ALREADY_APPLIED' })
    }
    if (this.afterState) {
      core.restoreContentState(this.afterState)
      this.applied = true
      return true
    }
    const beforeState = core.captureContentState()
    const result = await this.replaceOperation(core.getWorkingBytes(), this.block, this.replacementText, { fontProvider: this.fontProvider })
    const nextBytes = validatePdfInput(result?.bytes)
    core.restoreContentState({
      ...beforeState,
      bytes: nextBytes,
      currentPageIndex: Math.max(0, Math.min(this.block.pageIndex, beforeState.pageCount - 1)),
    })
    this.beforeState = beforeState
    this.afterState = core.captureContentState()
    this.result = { ...result, bytes: nextBytes.slice() }
    this.applied = true
    return true
  }

  async undo(core) {
    if (!this.applied) return false
    if (!this.beforeState) {
      throw new PdfEngineError('The text edit has no previous document state.', { code: 'NATIVE_TEXT_COMMAND_STATE_MISSING' })
    }
    core.restoreContentState(this.beforeState)
    this.applied = false
    return true
  }

  getResult() {
    return this.result ? { ...this.result, bytes: this.result.bytes.slice() } : null
  }
}
