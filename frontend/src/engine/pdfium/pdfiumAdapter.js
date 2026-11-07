import { PdfEngineError } from '../engineErrors.js'

const DEFAULT_BASE_URL = import.meta.env?.BASE_URL || '/'

function joinBaseUrl(baseUrl, assetPath) {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  return `${base}${assetPath.replace(/^\//, '')}`
}

function createDocumentId() {
  if (globalThis.crypto?.randomUUID) return `earthix-${globalThis.crypto.randomUUID()}`
  return `earthix-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export class PdfiumDocumentSession {
  constructor(adapter, descriptor) {
    this.adapter = adapter
    this.documentId = descriptor.documentId
    this.pageCount = descriptor.pageCount
    this.closed = false
    this.closePromise = null
  }

  async getPageInfo(pageIndex) {
    this.assertOpen()
    return this.adapter.request('get-page-info', { documentId: this.documentId, pageIndex })
  }

  async renderPage(pageIndex, canvas, { scale = 1, dpr = globalThis.devicePixelRatio || 1, rotation = 0 } = {}) {
    this.assertOpen()
    if (typeof HTMLCanvasElement === 'undefined' || !(canvas instanceof HTMLCanvasElement)) {
      throw new PdfEngineError('A valid HTML canvas is required to render a PDFium page.', { code: 'INVALID_CANVAS' })
    }

    const rendered = await this.adapter.request('render-page', {
      documentId: this.documentId,
      pageIndex,
      scale,
      dpr,
      rotation,
    })

    canvas.width = rendered.width
    canvas.height = rendered.height
    canvas.style.width = `${rendered.cssWidth}px`
    canvas.style.height = `${rendered.cssHeight}px`
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) throw new PdfEngineError('The browser could not create a 2D canvas context.', { code: 'CANVAS_UNAVAILABLE' })

    const pixels = new Uint8ClampedArray(rendered.pixelBuffer)
    context.putImageData(new ImageData(pixels, rendered.width, rendered.height), 0, 0)

    return {
      pageIndex,
      width: rendered.cssWidth,
      height: rendered.cssHeight,
      pixelWidth: rendered.width,
      pixelHeight: rendered.height,
      rotation: rendered.rotation,
    }
  }

  async close() {
    if (this.closePromise) return this.closePromise
    if (this.closed) return undefined
    this.closed = true
    this.closePromise = this.adapter.request('close-document', { documentId: this.documentId })
      .catch(() => undefined)
      .finally(() => this.adapter.documents.delete(this))
    return this.closePromise
  }

  assertOpen() {
    if (this.closed) throw new PdfEngineError('This PDFium document session has already been closed.', { code: 'DOCUMENT_CLOSED' })
  }
}

export class PdfiumAdapter {
  constructor({ baseUrl = DEFAULT_BASE_URL, workerFactory, requestTimeoutMs = 120_000 } = {}) {
    this.baseUrl = baseUrl
    this.worker = workerFactory
      ? workerFactory()
      : new Worker(new URL('../../workers/pdfium.worker.js', import.meta.url), { type: 'module', name: 'earthix-pdfium' })
    this.requestTimeoutMs = requestTimeoutMs
    this.requestSequence = 0
    this.pendingRequests = new Map()
    this.documents = new Set()
    this.disposed = false
    this.workerFailure = null

    this.handleMessage = this.handleMessage.bind(this)
    this.handleWorkerError = this.handleWorkerError.bind(this)
    this.handleMessageError = this.handleMessageError.bind(this)
    this.worker.addEventListener('message', this.handleMessage)
    this.worker.addEventListener('error', this.handleWorkerError)
    this.worker.addEventListener('messageerror', this.handleMessageError)
  }

  handleMessage(event) {
    const { requestId, ok, result, error } = event.data || {}
    const pending = this.pendingRequests.get(requestId)
    if (!pending) return
    clearTimeout(pending.timeoutId)
    this.pendingRequests.delete(requestId)
    if (ok) pending.resolve(result)
    else pending.reject(new PdfEngineError(error?.message || 'PDFium operation failed.', {
      code: error?.code || 'PDFIUM_WORKER_ERROR',
      details: error,
    }))
  }

  handleWorkerError(event) {
    this.workerFailure = new PdfEngineError(event.message || 'The PDFium Web Worker stopped unexpectedly.', { code: 'PDFIUM_WORKER_CRASH' })
    this.rejectAll(this.workerFailure)
  }

  handleMessageError() {
    this.workerFailure = new PdfEngineError('The PDFium worker returned a message that could not be read.', { code: 'PDFIUM_WORKER_MESSAGE_ERROR' })
    this.rejectAll(this.workerFailure)
  }

  request(action, payload = {}, transfer = []) {
    if (this.disposed) return Promise.reject(new PdfEngineError('The PDFium adapter has been disposed.', { code: 'ENGINE_DISPOSED' }))
    if (this.workerFailure) return Promise.reject(this.workerFailure)
    const requestId = ++this.requestSequence

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(requestId)
        reject(new PdfEngineError(`PDFium operation timed out (${action}).`, {
          code: 'PDFIUM_REQUEST_TIMEOUT',
          details: { action, requestId, timeoutMs: this.requestTimeoutMs },
        }))
      }, this.requestTimeoutMs)

      this.pendingRequests.set(requestId, { resolve, reject, timeoutId })
      try {
        this.worker.postMessage({ requestId, action, payload }, transfer)
      } catch (error) {
        clearTimeout(timeoutId)
        this.pendingRequests.delete(requestId)
        reject(new PdfEngineError(error.message || 'Could not communicate with the PDFium worker.', {
          code: 'PDFIUM_WORKER_POST_FAILED',
          cause: error,
        }))
      }
    })
  }

  rejectAll(error) {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeoutId)
      pending.reject(error)
    }
    this.pendingRequests.clear()
  }

  async initialize() {
    if (!this.initializationPromise) {
      const wasmUrl = joinBaseUrl(this.baseUrl, 'pdfium/pdfium.wasm')
      this.initializationPromise = this.request('initialize', { wasmUrl }).catch((error) => {
        this.initializationPromise = null
        throw error
      })
    }
    return this.initializationPromise
  }

  async openDocument(input, { password } = {}) {
    await this.initialize()
    const source = input instanceof Uint8Array
      ? input
      : input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : ArrayBuffer.isView(input)
          ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
          : null
    if (!source?.byteLength) throw new PdfEngineError('PDF data is empty or has an unsupported type.', { code: 'INVALID_PDF_DATA' })

    const data = source.slice().buffer
    const documentId = createDocumentId()
    let descriptor
    try {
      descriptor = await this.request('open-document', { documentId, data, password }, [data])
    } catch (error) {
      // If the worker completed the open after the main-thread request timed out,
      // this queued close message releases the late document before the worker is reused.
      if (!this.disposed && !this.workerFailure) {
        void this.request('close-document', { documentId }).catch(() => undefined)
      }
      throw error
    }
    if (!Number.isInteger(descriptor?.pageCount) || descriptor.pageCount < 1) {
      if (!this.disposed && !this.workerFailure) {
        void this.request('close-document', { documentId }).catch(() => undefined)
      }
      throw new PdfEngineError('PDFium opened the file but returned an invalid page count.', {
        code: 'INVALID_PDFIUM_DOCUMENT_DESCRIPTOR',
        details: descriptor,
      })
    }
    const session = new PdfiumDocumentSession(this, descriptor)
    this.documents.add(session)
    return session
  }

  async dispose() {
    if (this.disposed) return
    await Promise.allSettled([...this.documents].map((document) => document.close()))
    this.disposed = true
    this.rejectAll(new PdfEngineError('The PDFium adapter was disposed.', { code: 'ENGINE_DISPOSED' }))
    this.worker.removeEventListener('message', this.handleMessage)
    this.worker.removeEventListener('error', this.handleWorkerError)
    this.worker.removeEventListener('messageerror', this.handleMessageError)
    this.worker.terminate()
  }
}
