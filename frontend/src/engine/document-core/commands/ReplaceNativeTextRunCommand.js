import { PdfEngineError } from '../../engineErrors.js'
import { validatePdfInput } from '../../validation/validatePdfInput.js'
import { replaceNativePdfText } from '../../font-engine/nativePdfTextEditor.js'

function copyRun(run) {
  try {
    return structuredClone(run)
  } catch (error) {
    throw new PdfEngineError('The selected PDF text run is not serializable.', {
      code: 'INVALID_NATIVE_TEXT_RUN',
      cause: error,
    })
  }
}

export class ReplaceNativeTextRunCommand {
  constructor(run, replacementText, {
    label = 'Replace original PDF text',
    replaceOperation = replaceNativePdfText,
  } = {}) {
    if (!run || typeof run.key !== 'string' || !Number.isInteger(run.pageIndex)) {
      throw new PdfEngineError('Select a supported original PDF text run first.', { code: 'INVALID_NATIVE_TEXT_RUN' })
    }
    if (typeof replacementText !== 'string' || !replacementText.length) {
      throw new PdfEngineError('Replacement text cannot be empty.', { code: 'EMPTY_NATIVE_REPLACEMENT' })
    }
    if (typeof replaceOperation !== 'function') {
      throw new PdfEngineError('A native PDF text replacement operation is required.', { code: 'INVALID_NATIVE_REPLACEMENT_OPERATION' })
    }
    this.run = copyRun(run)
    this.replacementText = replacementText
    this.label = label
    this.replaceOperation = replaceOperation
    this.beforeState = null
    this.afterState = null
    this.result = null
    this.applied = false
  }

  async execute(core) {
    if (this.applied) {
      throw new PdfEngineError('This native text command is already applied.', { code: 'NATIVE_TEXT_COMMAND_ALREADY_APPLIED' })
    }

    if (this.afterState) {
      core.restoreContentState(this.afterState)
      this.applied = true
      return true
    }

    const beforeState = core.captureContentState()
    const sourceBytes = core.getWorkingBytes()
    const result = await this.replaceOperation(sourceBytes, this.run, this.replacementText)
    const nextBytes = validatePdfInput(result?.bytes)
    const nextState = {
      ...beforeState,
      bytes: nextBytes,
      currentPageIndex: Math.max(0, Math.min(this.run.pageIndex, beforeState.pageCount - 1)),
    }

    core.restoreContentState(nextState)
    this.beforeState = beforeState
    this.afterState = core.captureContentState()
    this.result = { ...result, bytes: nextBytes.slice() }
    this.applied = true
    return true
  }

  async undo(core) {
    if (!this.applied) return false
    if (!this.beforeState) {
      throw new PdfEngineError('The native text command has no previous document state.', { code: 'NATIVE_TEXT_COMMAND_STATE_MISSING' })
    }
    core.restoreContentState(this.beforeState)
    this.applied = false
    return true
  }

  getResult() {
    if (!this.result) return null
    return { ...this.result, bytes: this.result.bytes.slice() }
  }
}
