import { PdfEngineError } from '../engineErrors.js'
import { DocumentCore } from './DocumentCore.js'

function isUsableCheckpoint(checkpoint) {
  const supportedSchema = checkpoint?.schemaVersion === 1 || checkpoint?.schemaVersion === 2
  return supportedSchema
    && typeof checkpoint.documentId === 'string'
    && typeof checkpoint.fileName === 'string'
    && Number.isInteger(checkpoint.pageCount)
    && checkpoint.pageCount > 0
    && checkpoint.bytes instanceof Uint8Array
    && checkpoint.bytes.byteLength > 8
    && (checkpoint.schemaVersion === 1 || (checkpoint.originalBytes instanceof Uint8Array && checkpoint.originalBytes.byteLength > 8))
}

export class DocumentRecoveryService {
  #storage
  #coreOptions

  constructor({ storage, coreOptions = {} } = {}) {
    if (!storage || typeof storage.list !== 'function' || typeof storage.load !== 'function' || typeof storage.delete !== 'function') {
      throw new PdfEngineError('Document recovery requires a checkpoint storage provider.', { code: 'RECOVERY_STORAGE_REQUIRED' })
    }
    this.#storage = storage
    this.#coreOptions = coreOptions
  }

  async listRecoverable() {
    const records = await this.#storage.list()
    return records
      .filter(isUsableCheckpoint)
      .map((record) => ({
        documentId: record.documentId,
        fileName: record.fileName,
        originalFileName: record.originalFileName || record.fileName,
        pageCount: record.pageCount,
        byteLength: record.bytes.byteLength,
        revision: Number.isInteger(record.revision) ? record.revision : 0,
        updatedAt: record.updatedAt || null,
        schemaVersion: record.schemaVersion,
      }))
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
  }

  async recover(documentId, options = {}) {
    if (typeof documentId !== 'string' || !documentId.trim()) {
      throw new PdfEngineError('A document id is required for checkpoint recovery.', { code: 'INVALID_RECOVERY_DOCUMENT_ID' })
    }
    const checkpoint = await this.#storage.load(documentId)
    if (!isUsableCheckpoint(checkpoint)) {
      throw new PdfEngineError('No valid recovery checkpoint was found for this document.', { code: 'RECOVERY_CHECKPOINT_NOT_FOUND' })
    }
    return DocumentCore.recoverCheckpoint(checkpoint, {
      ...this.#coreOptions,
      ...options,
      checkpointStorage: options.checkpointStorage || this.#storage,
      autosave: options.autosave ?? this.#coreOptions.autosave ?? true,
    })
  }

  async discard(documentId) {
    if (typeof documentId !== 'string' || !documentId.trim()) {
      throw new PdfEngineError('A document id is required to discard a recovery checkpoint.', { code: 'INVALID_RECOVERY_DOCUMENT_ID' })
    }
    await this.#storage.delete(documentId)
  }

  async discardAll() {
    const records = await this.#storage.list()
    await Promise.all(records.map((record) => record?.documentId ? this.#storage.delete(record.documentId) : null))
    return records.length
  }
}

export function createDocumentRecoveryService(options) {
  return new DocumentRecoveryService(options)
}
