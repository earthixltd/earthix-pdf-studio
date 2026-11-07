import { PdfEngineError } from '../engineErrors.js'
import { CommandManager } from './CommandManager.js'
import { DocumentPageRegistry } from './DocumentPageRegistry.js'
import { DocumentObjectRegistry } from './DocumentObjectRegistry.js'
import { AutosaveCheckpointManager } from './AutosaveCheckpointManager.js'
import { validateDocumentForExport } from './validation/validateDocumentForExport.js'
import { validatePdfInput } from '../validation/validatePdfInput.js'

const CHECKPOINT_SCHEMA_VERSION = 2

function copyBytes(bytes) {
  if (bytes instanceof Uint8Array) return bytes.slice()
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes.slice(0))
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).slice()
  throw new PdfEngineError('A document requires PDF bytes.', { code: 'INVALID_PDF_DATA' })
}

function createId() {
  return globalThis.crypto?.randomUUID?.() || `earthix-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function validatePageCount(pageCount) {
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    throw new PdfEngineError('A document must contain at least one page.', { code: 'INVALID_PAGE_COUNT' })
  }
}

function dispatchListenerError(handler, error) {
  try {
    handler?.(error)
  } catch {
    // Observer failures must never interrupt a committed document operation.
  }
}

export class DocumentCore {
  #documentId
  #fileName
  #originalFileName
  #originalBytes
  #workingBytes
  #pageCount
  #currentPageIndex = 0
  #revision = 0
  #savedStateId = 'earthix-state-root'
  #listeners = new Set()
  #closed = false
  #autosaveStatus = 'idle'
  #autosaveError = null
  #autosaveManager
  #checkpointStorage
  #commandManager
  #recoveredUnsaved = false
  #atomicDepth = 0
  #atomicEvents = new Set()
  #atomicAutosaveRequested = false
  #onListenerError

  constructor({
    documentId = createId(),
    fileName = 'Untitled.pdf',
    originalFileName = fileName,
    bytes,
    originalBytes = bytes,
    pageCount,
    checkpointStorage = null,
    autosave = false,
    autosaveDelayMs = 900,
    onListenerError,
  } = {}) {
    validatePageCount(pageCount)
    this.#documentId = documentId
    this.#fileName = fileName
    this.#originalFileName = originalFileName
    this.#originalBytes = validatePdfInput(copyBytes(originalBytes))
    this.#workingBytes = validatePdfInput(copyBytes(bytes))
    this.#pageCount = pageCount
    this.#checkpointStorage = checkpointStorage
    this.#onListenerError = onListenerError
    this.pages = new DocumentPageRegistry(pageCount)
    this.objects = new DocumentObjectRegistry(pageCount)
    this.#commandManager = new CommandManager(this)
    this.#commandManager.subscribe(() => {
      this.#revision += 1
      this.#emit('history')
      this.#scheduleAutosave()
    })
    this.#autosaveManager = autosave && checkpointStorage
      ? new AutosaveCheckpointManager({
        storage: checkpointStorage,
        delayMs: autosaveDelayMs,
        onStatus: (status, error) => {
          this.#autosaveStatus = status
          this.#autosaveError = error || null
          this.#emit('autosave')
        },
      })
      : null
  }

  get documentId() { return this.#documentId }
  get fileName() { return this.#fileName }
  get originalFileName() { return this.#originalFileName }
  get pageCount() { return this.#pageCount }
  get currentPageIndex() { return this.#currentPageIndex }
  get byteLength() { return this.#workingBytes.byteLength }
  get originalByteLength() { return this.#originalBytes.byteLength }
  get revision() { return this.#revision }
  get isDirty() { return this.#recoveredUnsaved || this.#commandManager.currentStateId !== this.#savedStateId }
  get canUndo() { return this.#commandManager.canUndo }
  get canRedo() { return this.#commandManager.canRedo }
  get autosaveStatus() { return this.#autosaveStatus }
  get autosaveError() { return this.#autosaveError }
  get closed() { return this.#closed }
  get currentStateId() { return this.#commandManager.currentStateId }

  getOriginalBytes() { return this.#originalBytes.slice() }
  getWorkingBytes() { return this.#workingBytes.slice() }
  getHistory() { return this.#commandManager.getHistory() }

  getSnapshot() {
    return {
      documentId: this.#documentId,
      fileName: this.#fileName,
      originalFileName: this.#originalFileName,
      pageCount: this.#pageCount,
      currentPageIndex: this.#currentPageIndex,
      byteLength: this.#workingBytes.byteLength,
      originalByteLength: this.#originalBytes.byteLength,
      revision: this.#revision,
      currentStateId: this.#commandManager.currentStateId,
      savedStateId: this.#savedStateId,
      isDirty: this.isDirty,
      recoveredUnsaved: this.#recoveredUnsaved,
      canUndo: this.canUndo,
      canRedo: this.canRedo,
      historyIndex: this.#commandManager.historyIndex,
      historyLength: this.#commandManager.historyLength,
      history: this.#commandManager.getHistory(),
      autosaveStatus: this.#autosaveStatus,
      autosaveError: this.#autosaveError?.message || null,
      pages: this.pages.list(),
      objectCount: this.objects.list().length,
      closed: this.#closed,
    }
  }

  subscribe(listener, { emitCurrent = true } = {}) {
    if (typeof listener !== 'function') throw new TypeError('A document listener must be a function.')
    this.#listeners.add(listener)
    if (emitCurrent) {
      try {
        listener(this.getSnapshot(), { type: 'initial' })
      } catch (error) {
        dispatchListenerError(this.#onListenerError, error)
      }
    }
    return () => this.#listeners.delete(listener)
  }

  #dispatch(type) {
    const snapshot = this.getSnapshot()
    for (const listener of this.#listeners) {
      try {
        listener(snapshot, { type })
      } catch (error) {
        dispatchListenerError(this.#onListenerError, error)
      }
    }
  }

  #emit(type) {
    if (this.#atomicDepth > 0) {
      this.#atomicEvents.add(type)
      return
    }
    this.#dispatch(type)
  }

  #assertOpen() {
    if (this.#closed) throw new PdfEngineError('This document core has been closed.', { code: 'DOCUMENT_CORE_CLOSED' })
  }

  beginAtomicChange() {
    this.#assertOpen()
    this.#atomicDepth += 1
  }

  endAtomicChange({ commit = true } = {}) {
    if (this.#atomicDepth < 1) {
      throw new PdfEngineError('No atomic document change is active.', { code: 'DOCUMENT_ATOMIC_CHANGE_NOT_ACTIVE' })
    }
    this.#atomicDepth -= 1
    if (this.#atomicDepth > 0) return

    const pendingEvents = this.#atomicEvents
    const autosaveRequested = this.#atomicAutosaveRequested
    this.#atomicEvents = new Set()
    this.#atomicAutosaveRequested = false

    if (pendingEvents.size) {
      if (!commit) {
        this.#dispatch('rollback')
      } else {
        const eventType = pendingEvents.has('history')
          ? 'history'
          : pendingEvents.has('content')
            ? 'content'
            : [...pendingEvents].at(-1)
        this.#dispatch(eventType)
      }
    }

    if (autosaveRequested) this.#applyAutosaveState()
  }

  #applyAutosaveState() {
    if (!this.#autosaveManager) return
    if (this.isDirty) this.#autosaveManager.schedule(this)
    else void this.#autosaveManager.clear(this.#documentId).catch((error) => {
      this.#autosaveStatus = 'error'
      this.#autosaveError = error
      this.#emit('autosave')
    })
  }

  #scheduleAutosave() {
    if (!this.#autosaveManager) return
    if (this.#atomicDepth > 0) {
      this.#atomicAutosaveRequested = true
      return
    }
    this.#applyAutosaveState()
  }

  setActivePage(index) {
    this.#assertOpen()
    if (!Number.isInteger(index) || index < 0 || index >= this.#pageCount) {
      throw new PdfEngineError('The selected page is outside this document.', { code: 'PAGE_NOT_FOUND' })
    }
    if (this.#currentPageIndex === index) return
    this.#currentPageIndex = index
    this.#emit('navigation')
  }

  updatePageInfo(index, info) {
    this.#assertOpen()
    const page = this.pages.updateInfo(index, info)
    this.#emit('page-info')
    return page
  }

  async execute(command) {
    this.#assertOpen()
    return this.#commandManager.execute(command)
  }

  async transact(label, callback) {
    this.#assertOpen()
    return this.#commandManager.transact(label, callback)
  }

  async undo() {
    this.#assertOpen()
    return this.#commandManager.undo()
  }

  async redo() {
    this.#assertOpen()
    return this.#commandManager.redo()
  }

  captureContentState() {
    return {
      bytes: this.#workingBytes.slice(),
      fileName: this.#fileName,
      pageCount: this.#pageCount,
      pages: this.pages.snapshot(),
      objects: this.objects.snapshot(),
      currentPageIndex: this.#currentPageIndex,
    }
  }

  restoreContentState(state) {
    this.#assertOpen()
    if (!state || !Number.isInteger(state.pageCount) || state.pageCount < 1) {
      throw new PdfEngineError('The restored document state has an invalid page count.', { code: 'INVALID_DOCUMENT_STATE' })
    }
    const nextBytes = validatePdfInput(copyBytes(state.bytes))
    const nextFileName = typeof state.fileName === 'string' && state.fileName.trim() ? state.fileName.trim() : this.#fileName
    const nextPageCount = state.pageCount
    const nextPages = Array.isArray(state.pages) && state.pages.length === nextPageCount ? state.pages : []
    const nextObjects = Array.isArray(state.objects) ? state.objects : []
    const nextPageIndex = Math.max(0, Math.min(Number.isInteger(state.currentPageIndex) ? state.currentPageIndex : 0, nextPageCount - 1))

    // Build the registries before mutating the live state so a bad snapshot
    // cannot leave the document half-restored.
    const pages = new DocumentPageRegistry(nextPageCount, nextPages)
    const objects = new DocumentObjectRegistry(nextPageCount, nextObjects)
    this.#workingBytes = nextBytes
    this.#fileName = nextFileName
    this.#pageCount = nextPageCount
    // Keep the registry instances stable for UI/services that hold references.
    this.pages.restore(pages.snapshot())
    this.objects.restore(objects.snapshot(), nextPageCount)
    this.#currentPageIndex = nextPageIndex
    this.#emit('content')
    this.#scheduleAutosave()
  }

  notifyContentChange() {
    this.#assertOpen()
    this.#emit('content')
    this.#scheduleAutosave()
  }

  createCheckpoint() {
    this.#assertOpen()
    return {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      documentId: this.#documentId,
      fileName: this.#fileName,
      originalFileName: this.#originalFileName,
      pageCount: this.#pageCount,
      currentPageIndex: this.#currentPageIndex,
      originalBytes: this.#originalBytes.slice(),
      bytes: this.#workingBytes.slice(),
      revision: this.#revision,
      historyIndex: this.#commandManager.historyIndex,
      currentStateId: this.#commandManager.currentStateId,
      savedStateId: this.#savedStateId,
      pages: this.pages.snapshot(),
      objects: this.objects.snapshot(),
      updatedAt: new Date().toISOString(),
    }
  }

  async flushCheckpoint() {
    this.#assertOpen()
    if (!this.#autosaveManager) return null
    return this.#autosaveManager.flush()
  }

  async validateForExport({ expectedPageCount } = {}) {
    this.#assertOpen()
    return validateDocumentForExport({
      bytes: this.#workingBytes,
      pageCount: this.#pageCount,
      expectedPageCount,
      fileName: this.#fileName,
    })
  }

  async markSaved() {
    this.#assertOpen()
    this.#savedStateId = this.#commandManager.currentStateId
    this.#recoveredUnsaved = false
    this.#autosaveStatus = 'idle'
    this.#autosaveError = null
    if (this.#autosaveManager) {
      try {
        await this.#autosaveManager.clear(this.#documentId)
      } catch (error) {
        this.#autosaveStatus = 'error'
        this.#autosaveError = error
      }
    }
    this.#emit('saved')
  }

  async close({ flushAutosave = true } = {}) {
    if (this.#closed) return
    if (this.#atomicDepth > 0) {
      throw new PdfEngineError('Cannot close a document while an atomic change is active.', { code: 'DOCUMENT_CHANGE_IN_PROGRESS' })
    }
    if (this.#autosaveManager) {
      await this.#autosaveManager.close({ flush: flushAutosave, documentId: this.#documentId })
    }
    this.#closed = true
    this.#listeners.clear()
    await this.#checkpointStorage?.close?.()
  }

  static recoverCheckpoint(checkpoint, options = {}) {
    const isSupportedVersion = checkpoint?.schemaVersion === 1 || checkpoint?.schemaVersion === CHECKPOINT_SCHEMA_VERSION
    if (!isSupportedVersion || !(checkpoint.bytes instanceof Uint8Array)) {
      throw new PdfEngineError('This autosave checkpoint is invalid or uses an unsupported version.', { code: 'INVALID_DOCUMENT_CHECKPOINT' })
    }
    if (checkpoint.schemaVersion >= 2 && !(checkpoint.originalBytes instanceof Uint8Array)) {
      throw new PdfEngineError('This recovery checkpoint is missing its immutable source PDF bytes.', { code: 'INVALID_DOCUMENT_CHECKPOINT' })
    }
    const originalBytes = checkpoint.schemaVersion >= 2 ? checkpoint.originalBytes : checkpoint.bytes
    const core = new DocumentCore({
      documentId: checkpoint.documentId,
      fileName: checkpoint.fileName,
      originalFileName: checkpoint.originalFileName || checkpoint.fileName,
      originalBytes,
      bytes: checkpoint.bytes,
      pageCount: checkpoint.pageCount,
      ...options,
    })
    if (Array.isArray(checkpoint.pages)) core.pages.restore(checkpoint.pages)
    if (Array.isArray(checkpoint.objects)) core.objects.restore(checkpoint.objects, checkpoint.pageCount)
    if (Number.isInteger(checkpoint.currentPageIndex)) {
      core.#currentPageIndex = Math.max(0, Math.min(checkpoint.currentPageIndex, checkpoint.pageCount - 1))
    }
    core.#recoveredUnsaved = true
    core.#emit('recovered')
    core.#scheduleAutosave()
    return core
  }
}
