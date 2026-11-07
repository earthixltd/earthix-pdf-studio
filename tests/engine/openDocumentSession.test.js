import test from 'node:test'
import assert from 'node:assert/strict'
import { openDocumentSession } from '../../frontend/src/engine/document-core/openDocumentSession.js'
import { validatePdfInput } from '../../frontend/src/engine/validation/validatePdfInput.js'

const validPdfBytes = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF')

function createAdapters({ pdfiumPageCount = 2, pdfiumError = null, pdfiumRenderError = null, openPdfium } = {}) {
  const calls = {
    pdfJsOpened: 0,
    pdfiumOpened: 0,
    pdfiumClosed: 0,
    pdfJsDestroyed: 0,
    pdfJsRendered: 0,
    pdfiumRendered: 0,
  }
  const pdfJsAdapter = {
    async open(bytes) {
      calls.pdfJsOpened += 1
      assert.notStrictEqual(bytes, validPdfBytes)
      return {
        numPages: 2,
        async destroy() { calls.pdfJsDestroyed += 1 },
      }
    },
    async getPageInfo() { return { width: 612, height: 792, engine: 'pdfjs' } },
    async renderPage() { calls.pdfJsRendered += 1; return { width: 612, height: 792, engine: 'pdfjs' } },
    async getTextContent() { return { items: [] } },
    async destroy(document) { await document.destroy() },
  }
  const pdfiumAdapter = {
    async openDocument() {
      calls.pdfiumOpened += 1
      if (openPdfium) return openPdfium()
      if (pdfiumError) throw pdfiumError
      return {
        pageCount: pdfiumPageCount,
        async getPageInfo() { return { width: 612, height: 792, engine: 'pdfium' } },
        async renderPage() {
          calls.pdfiumRendered += 1
          if (pdfiumRenderError) throw pdfiumRenderError
          return { width: 612, height: 792, engine: 'pdfium' }
        },
        async close() { calls.pdfiumClosed += 1 },
      }
    },
    async dispose() {},
  }
  return { calls, pdfJsAdapter, pdfiumAdapter }
}

async function openReadySession(options) {
  const session = await openDocumentSession(validPdfBytes, options)
  await session.pdfiumReady
  return session
}

test('validates a PDF header and returns an isolated byte copy', () => {
  const copy = validatePdfInput(validPdfBytes)
  assert.deepEqual(copy, validPdfBytes)
  assert.notStrictEqual(copy, validPdfBytes)
})

test('rejects empty, non-PDF and oversized input', () => {
  assert.throws(() => validatePdfInput(new Uint8Array()), { code: 'EMPTY_PDF' })
  assert.throws(() => validatePdfInput(new TextEncoder().encode('not a pdf')), { code: 'INVALID_PDF_HEADER' })
  assert.throws(() => validatePdfInput(validPdfBytes, { maxBytes: 4 }), { code: 'PDF_TOO_LARGE' })
})

test('returns a usable PDF.js session while PDFium initializes in the background', async () => {
  let finishPdfium
  const { calls, pdfJsAdapter, pdfiumAdapter } = createAdapters({
    openPdfium: () => new Promise((resolve) => { finishPdfium = resolve }),
  })
  const session = await openDocumentSession(validPdfBytes, { pdfJsAdapter, pdfiumAdapter })

  assert.equal(session.pageCount, 2)
  assert.equal(session.engineStatus, 'loading')
  assert.equal((await session.getPageInfo(0)).engine, 'pdfjs')
  assert.equal(calls.pdfJsOpened, 1)
  assert.equal(calls.pdfiumOpened, 1)

  finishPdfium({
    pageCount: 2,
    async getPageInfo() { return { width: 612, height: 792, engine: 'pdfium' } },
    async renderPage() { return { width: 612, height: 792, engine: 'pdfium' } },
    async close() { calls.pdfiumClosed += 1 },
  })
  await session.pdfiumReady

  assert.equal(session.engineStatus, 'ready')
  assert.equal((await session.getPageInfo(0)).engine, 'pdfium')
  await session.close()
  assert.equal(calls.pdfiumClosed, 1)
  assert.equal(calls.pdfJsDestroyed, 1)
})

test('opens both engines and closes PDFium and PDF.js exactly once', async () => {
  const { calls, pdfJsAdapter, pdfiumAdapter } = createAdapters()
  const session = await openReadySession({ fileName: 'sample.pdf', pdfJsAdapter, pdfiumAdapter })

  assert.equal(session.pageCount, 2)
  assert.equal(session.engineStatus, 'ready')
  assert.equal(session.fileName, 'sample.pdf')
  assert.equal((await session.getPageInfo(0)).engine, 'pdfium')
  await session.close()
  await session.close()
  assert.equal(calls.pdfiumClosed, 1)
  assert.equal(calls.pdfJsDestroyed, 1)
  await assert.rejects(session.getPageInfo(0), { code: 'DOCUMENT_CLOSED' })
})

test('keeps the PDF.js document available when PDFium is unavailable', async () => {
  const { calls, pdfJsAdapter, pdfiumAdapter } = createAdapters({ pdfiumError: new Error('WASM unavailable') })
  const session = await openReadySession({ pdfJsAdapter, pdfiumAdapter })

  assert.equal(session.pageCount, 2)
  assert.equal(session.engineStatus, 'degraded')
  assert.match(session.pdfiumError.message, /WASM unavailable/)
  assert.equal((await session.getPageInfo(0)).engine, 'pdfjs')
  await session.close()
  assert.equal(calls.pdfiumClosed, 0)
  assert.equal(calls.pdfJsDestroyed, 1)
})

test('falls back to PDF.js if a PDFium render fails after the document has opened', async () => {
  const { calls, pdfJsAdapter, pdfiumAdapter } = createAdapters({ pdfiumRenderError: new Error('Unsupported page render') })
  const session = await openReadySession({ pdfJsAdapter, pdfiumAdapter })

  const rendered = await session.renderPage(0, {})
  assert.equal(rendered.engine, 'pdfjs')
  assert.equal(session.engineStatus, 'degraded')
  assert.match(session.pdfiumError.message, /Unsupported page render/)
  assert.equal(calls.pdfiumRendered, 1)
  assert.equal(calls.pdfJsRendered, 1)
  await session.close()
})

test('rejects a PDFium/PDF.js page-count mismatch and closes the PDFium document', async () => {
  const { calls, pdfJsAdapter, pdfiumAdapter } = createAdapters({ pdfiumPageCount: 3 })
  const session = await openReadySession({ pdfJsAdapter, pdfiumAdapter })

  assert.equal(session.engineStatus, 'degraded')
  assert.equal(session.pdfiumDocument, null)
  assert.equal(session.pdfiumError.code, 'ENGINE_PAGE_COUNT_MISMATCH')
  assert.equal(calls.pdfiumClosed, 1)
  await session.close()
})

test('does not initialize PDFium when required PDF.js loading fails', async () => {
  const { calls, pdfiumAdapter } = createAdapters()
  const failingPdfJsAdapter = {
    async open() { throw new Error('PDF.js parse failure') },
  }

  await assert.rejects(
    openDocumentSession(validPdfBytes, { pdfJsAdapter: failingPdfJsAdapter, pdfiumAdapter }),
    /PDF.js parse failure/,
  )
  assert.equal(calls.pdfiumOpened, 0)
  assert.equal(calls.pdfiumClosed, 0)
})

test('rejects an invalid PDF.js document descriptor without opening PDFium', async () => {
  const { calls, pdfiumAdapter } = createAdapters()
  const invalidPdfJsAdapter = {
    async open() { return { numPages: 0 } },
    async destroy() {},
  }
  await assert.rejects(
    openDocumentSession(validPdfBytes, { pdfJsAdapter: invalidPdfJsAdapter, pdfiumAdapter }),
    { code: 'INVALID_PDFJS_DOCUMENT_DESCRIPTOR' },
  )
  assert.equal(calls.pdfiumOpened, 0)
  assert.equal(calls.pdfiumClosed, 0)
})

test('closes a PDFium document that finishes opening after the session has closed', async () => {
  let finishPdfium
  const { calls, pdfJsAdapter, pdfiumAdapter } = createAdapters({
    openPdfium: () => new Promise((resolve) => { finishPdfium = resolve }),
  })
  const session = await openDocumentSession(validPdfBytes, { pdfJsAdapter, pdfiumAdapter })

  const closing = session.close()
  finishPdfium({
    pageCount: 2,
    async getPageInfo() { return { width: 612, height: 792, engine: 'pdfium' } },
    async renderPage() { return { width: 612, height: 792, engine: 'pdfium' } },
    async close() { calls.pdfiumClosed += 1 },
  })
  await session.pdfiumReady
  await closing

  assert.equal(session.engineStatus, 'closed')
  assert.equal(calls.pdfiumClosed, 1)
  assert.equal(calls.pdfJsDestroyed, 1)
})

test('bridges PDFium worker requests, closes documents and terminates the worker on dispose', async () => {
  const { PdfiumAdapter } = await import('../../frontend/src/engine/pdfium/pdfiumAdapter.js')
  class MockWorker {
    listeners = new Map()
    terminated = false
    addEventListener(type, listener) { this.listeners.set(type, listener) }
    removeEventListener(type) { this.listeners.delete(type) }
    postMessage(message) {
      queueMicrotask(() => {
        const result = message.action === 'open-document'
          ? { documentId: message.payload.documentId, pageCount: 2 }
          : { closed: true, initialized: true }
        this.listeners.get('message')?.({ data: { requestId: message.requestId, ok: true, result } })
      })
    }
    terminate() { this.terminated = true }
  }

  const worker = new MockWorker()
  const adapter = new PdfiumAdapter({ workerFactory: () => worker, requestTimeoutMs: 1000 })
  const document = await adapter.openDocument(validPdfBytes)
  assert.equal(document.pageCount, 2)
  await document.close()
  await adapter.dispose()
  assert.equal(worker.terminated, true)
  await assert.rejects(adapter.request('initialize'), { code: 'ENGINE_DISPOSED' })
})

test('expires unanswered PDFium worker requests and clears pending state', async () => {
  const { PdfiumAdapter } = await import('../../frontend/src/engine/pdfium/pdfiumAdapter.js')
  class SilentWorker {
    listeners = new Map()
    addEventListener(type, listener) { this.listeners.set(type, listener) }
    removeEventListener(type) { this.listeners.delete(type) }
    postMessage() {}
    terminate() {}
  }

  const adapter = new PdfiumAdapter({ workerFactory: () => new SilentWorker(), requestTimeoutMs: 5 })
  await assert.rejects(adapter.request('never-responds'), { code: 'PDFIUM_REQUEST_TIMEOUT' })
  assert.equal(adapter.pendingRequests.size, 0)
  await adapter.dispose()
})

test('queues cleanup if PDFium returns an invalid document descriptor', async () => {
  const { PdfiumAdapter } = await import('../../frontend/src/engine/pdfium/pdfiumAdapter.js')
  class InvalidDescriptorWorker {
    listeners = new Map()
    actions = []
    addEventListener(type, listener) { this.listeners.set(type, listener) }
    removeEventListener(type) { this.listeners.delete(type) }
    postMessage(message) {
      this.actions.push(message.action)
      queueMicrotask(() => {
        const result = message.action === 'open-document'
          ? { documentId: message.payload.documentId, pageCount: 0 }
          : { closed: true }
        this.listeners.get('message')?.({ data: { requestId: message.requestId, ok: true, result } })
      })
    }
    terminate() {}
  }

  const worker = new InvalidDescriptorWorker()
  const adapter = new PdfiumAdapter({ workerFactory: () => worker, requestTimeoutMs: 1000 })
  await assert.rejects(adapter.openDocument(validPdfBytes), { code: 'INVALID_PDFIUM_DOCUMENT_DESCRIPTOR' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(worker.actions, ['initialize', 'open-document', 'close-document'])
  await adapter.dispose()
})
