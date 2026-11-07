import { PdfEngineError } from '../../engineErrors.js'
import { validatePdfInput } from '../../validation/validatePdfInput.js'

function copyBytes(bytes) {
  if (bytes instanceof Uint8Array) return bytes.slice()
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes.slice(0))
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).slice()
  throw new PdfEngineError('Replacement document data must be PDF bytes.', { code: 'INVALID_PDF_DATA' })
}

export class ReplacePdfBytesCommand {
  constructor(bytes, { fileName, pageCount, label = 'Replace document content', objects = [] } = {}) {
    if (!Number.isInteger(pageCount) || pageCount < 1) {
      throw new PdfEngineError('Replacement document must contain at least one page.', { code: 'INVALID_PAGE_COUNT' })
    }
    this.bytes = validatePdfInput(copyBytes(bytes))
    this.fileName = fileName
    this.pageCount = pageCount
    this.label = label
    this.objects = structuredClone(objects || [])
    this.previousState = null
  }

  async execute(core) {
    if (!this.previousState) this.previousState = core.captureContentState()
    core.restoreContentState({
      bytes: this.bytes,
      fileName: this.fileName ?? core.fileName,
      pageCount: this.pageCount,
      pages: null,
      objects: this.objects,
    })
  }

  async undo(core) {
    if (!this.previousState) throw new Error('The document command has not been executed.')
    core.restoreContentState(this.previousState)
  }
}
