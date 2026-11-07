import { PdfEngineError } from '../../engineErrors.js'

export class RemovePageObjectCommand {
  constructor(objectId, { label = 'Remove page object' } = {}) {
    if (typeof objectId !== 'string' || !objectId.trim()) {
      throw new PdfEngineError('A document object id is required.', { code: 'INVALID_DOCUMENT_OBJECT_ID' })
    }
    this.objectId = objectId
    this.label = label
    this.previousObject = null
  }

  async execute(core) {
    if (!this.previousObject) this.previousObject = core.objects.get(this.objectId)
    if (!this.previousObject) {
      throw new PdfEngineError(`Document object "${this.objectId}" does not exist.`, { code: 'DOCUMENT_OBJECT_NOT_FOUND' })
    }
    core.objects.remove(this.objectId)
    core.notifyContentChange()
  }

  async undo(core) {
    if (!this.previousObject) return
    core.objects.upsert(this.previousObject)
    core.notifyContentChange()
  }
}
