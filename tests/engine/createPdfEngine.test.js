import test from 'node:test'
import assert from 'node:assert/strict'
import { createPdfEngine } from '../../frontend/src/engine/createPdfEngine.js'

const validPdfBytes = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF')

function createMockAdapters() {
  const calls = { pdfiumOpened: 0, pdfiumClosed: 0, pdfJsDestroyed: 0, pdfiumDisposed: 0 }
  const pdfJsAdapter = {
    async open() { return { numPages: 1 } },
    async destroy() { calls.pdfJsDestroyed += 1 },
    async getPageInfo() { return { pageIndex: 0, width: 612, height: 792 } },
    async renderPage() { return { pageIndex: 0, width: 612, height: 792 } },
    async getTextContent() { return { items: [] } },
  }
  const pdfiumAdapter = {
    async openDocument() {
      calls.pdfiumOpened += 1
      return {
        pageCount: 1,
        async close() { calls.pdfiumClosed += 1 },
        async getPageInfo() { return { pageIndex: 0, width: 612, height: 792 } },
        async renderPage() { return { pageIndex: 0, width: 612, height: 792 } },
      }
    },
    async dispose() { calls.pdfiumDisposed += 1 },
  }
  return { calls, pdfJsAdapter, pdfiumAdapter }
}

test('tracks document sessions and removes a session after it closes', async () => {
  const { calls, pdfJsAdapter, pdfiumAdapter } = createMockAdapters()
  const engine = createPdfEngine({ pdfJsAdapter, pdfiumAdapter })
  const session = await engine.openDocument(validPdfBytes)
  await session.pdfiumReady

  assert.equal(engine.activeDocumentCount, 1)
  await session.close()
  assert.equal(engine.activeDocumentCount, 0)
  assert.equal(calls.pdfiumClosed, 1)
  assert.equal(calls.pdfJsDestroyed, 1)
  await engine.dispose()
  assert.equal(calls.pdfiumDisposed, 1)
})

test('engine disposal closes active sessions and rejects future document opens', async () => {
  const { calls, pdfJsAdapter, pdfiumAdapter } = createMockAdapters()
  const engine = createPdfEngine({ pdfJsAdapter, pdfiumAdapter })
  const session = await engine.openDocument(validPdfBytes)
  await session.pdfiumReady

  await engine.dispose()
  assert.equal(engine.disposed, true)
  assert.equal(engine.activeDocumentCount, 0)
  assert.equal(session.engineStatus, 'closed')
  assert.equal(calls.pdfiumClosed, 1)
  assert.equal(calls.pdfJsDestroyed, 1)
  assert.equal(calls.pdfiumDisposed, 1)
  await assert.rejects(engine.openDocument(validPdfBytes), { code: 'ENGINE_DISPOSED' })
})

test('does not open a document when disposal races with adapter resolution', async () => {
  const { calls, pdfJsAdapter, pdfiumAdapter } = createMockAdapters()
  const engine = createPdfEngine({ pdfJsAdapter, pdfiumAdapter })
  const opening = engine.openDocument(validPdfBytes)
  await engine.dispose()

  await assert.rejects(opening, { code: 'ENGINE_DISPOSED' })
  assert.equal(calls.pdfiumOpened, 0)
  assert.equal(calls.pdfJsDestroyed, 0)
  assert.equal(engine.activeDocumentCount, 0)
})

test('closes a PDF.js session if engine disposal races with document parsing', async () => {
  let finishPdfJs
  const { calls, pdfiumAdapter } = createMockAdapters()
  const pdfJsAdapter = {
    open() { return new Promise((resolve) => { finishPdfJs = resolve }) },
    async destroy() { calls.pdfJsDestroyed += 1 },
    async getPageInfo() { return { pageIndex: 0, width: 612, height: 792 } },
    async renderPage() { return { pageIndex: 0, width: 612, height: 792 } },
    async getTextContent() { return { items: [] } },
  }
  const engine = createPdfEngine({ pdfJsAdapter, pdfiumAdapter })
  const opening = engine.openDocument(validPdfBytes)
  await Promise.resolve()
  await engine.dispose()

  finishPdfJs({ numPages: 1 })
  await assert.rejects(opening, { code: 'ENGINE_DISPOSED' })
  assert.equal(engine.activeDocumentCount, 0)
  assert.equal(calls.pdfJsDestroyed, 1)
  assert.equal(calls.pdfiumOpened, 1)
  assert.equal(calls.pdfiumClosed, 1)
})

test('keeps PDF.js viewing available when the PDFium Web Worker cannot be constructed', async () => {
  const calls = { destroyed: 0 }
  const pdfJsAdapter = {
    async open() { return { numPages: 1 } },
    async destroy() { calls.destroyed += 1 },
    async getPageInfo() { return { pageIndex: 0, width: 612, height: 792, engine: 'pdfjs' } },
    async renderPage() { return { pageIndex: 0, width: 612, height: 792, engine: 'pdfjs' } },
    async getTextContent() { return { items: [] } },
  }
  const engine = createPdfEngine({
    pdfJsAdapter,
    workerFactory() { throw new Error('Web Workers are blocked by this browser context.') },
  })

  const session = await engine.openDocument(validPdfBytes)
  await session.pdfiumReady
  assert.equal(session.engineStatus, 'degraded')
  assert.match(session.pdfiumError.message, /Web Workers are blocked/)
  assert.equal((await session.getPageInfo(0)).engine, 'pdfjs')
  assert.equal((await session.renderPage(0, {})).engine, 'pdfjs')

  await session.close()
  await engine.dispose()
  assert.equal(calls.destroyed, 1)
})
