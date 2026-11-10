import { PdfEngineError, normalizePdfEngineError } from '../engineErrors.js'
import { validatePdfInput } from '../validation/validatePdfInput.js'

export async function openDocumentSession(input, {
  fileName = 'Untitled.pdf',
  pdfJsAdapter,
  pdfiumAdapter,
  pdfiumUnavailableError,
  password,
  onProgress,
  signal,
  pdfiumWaitMs = 1500,
} = {}) {
  if (!pdfJsAdapter) {
    throw new PdfEngineError('The PDF.js adapter is required to create an Earthix document session.', {
      code: 'PDFJS_ADAPTER_MISSING',
    })
  }

  const pdfBytes = validatePdfInput(input)
  const pdfJsDocument = await pdfJsAdapter.open(pdfBytes, { password, onProgress, signal })
  if (!Number.isInteger(pdfJsDocument?.numPages) || pdfJsDocument.numPages < 1) {
    await pdfJsAdapter.destroy?.(pdfJsDocument)
    throw new PdfEngineError('PDF.js opened the file but returned an invalid page count.', {
      code: 'INVALID_PDFJS_DOCUMENT_DESCRIPTOR',
    })
  }

  let pdfiumDocument = null
  let pdfiumError = null
  let pdfiumState = 'loading'
  let runtimePdfiumFailure = null
  let closed = false
  let closePromise = null

  const pdfiumReady = (async () => {
    if (!pdfiumAdapter) {
      pdfiumState = 'degraded'
      pdfiumError = pdfiumUnavailableError
        ? normalizePdfEngineError(pdfiumUnavailableError, 'The PDFium worker is unavailable in this browser session.')
        : new PdfEngineError('The PDFium worker is unavailable in this browser session.', {
          code: 'PDFIUM_ADAPTER_UNAVAILABLE',
        })
      return null
    }

    let candidate
    try {
      candidate = await pdfiumAdapter.openDocument(pdfBytes, { password })
      if (closed) {
        await candidate.close()
        pdfiumState = 'closed'
        return null
      }
      if (candidate.pageCount !== pdfJsDocument.numPages) {
        const pdfiumPageCount = candidate.pageCount
        await candidate.close()
        pdfiumError = new PdfEngineError(
          `PDF.js found ${pdfJsDocument.numPages} page(s), but PDFium found ${pdfiumPageCount}. The engines disagree about this document.`,
          { code: 'ENGINE_PAGE_COUNT_MISMATCH', details: { pdfJsPageCount: pdfJsDocument.numPages, pdfiumPageCount } },
        )
        pdfiumState = 'degraded'
        return null
      }
      pdfiumDocument = candidate
      pdfiumState = 'ready'
      return candidate
    } catch (error) {
      if (candidate) await candidate.close().catch(() => undefined)
      pdfiumError = normalizePdfEngineError(error, 'PDFium could not open this document.')
      pdfiumState = closed ? 'closed' : 'degraded'
      return null
    }
  })()

  function assertOpen() {
    if (closed) throw new PdfEngineError('This document session has been closed.', { code: 'DOCUMENT_CLOSED' })
  }

  function recordPdfiumFailure(error) {
    runtimePdfiumFailure = normalizePdfEngineError(error, 'PDFium could not process this page.')
    pdfiumError = runtimePdfiumFailure
    pdfiumState = 'degraded'
  }

  return {
    fileName,
    byteLength: pdfBytes.byteLength,
    pageCount: pdfJsDocument.numPages,
    pdfJsDocument,
    pdfiumReady,
    get pdfiumDocument() { return pdfiumDocument },
    get pdfiumError() { return pdfiumError },
    get engineStatus() {
      if (closed) return 'closed'
      if (pdfiumState === 'loading') return 'loading'
      return pdfiumDocument && !runtimePdfiumFailure ? 'ready' : 'degraded'
    },
    async getPageInfo(pageIndex) {
      assertOpen()
      if (pdfiumDocument) {
        try {
          return await pdfiumDocument.getPageInfo(pageIndex)
        } catch (error) {
          recordPdfiumFailure(error)
        }
      }
      return pdfJsAdapter.getPageInfo(pdfJsDocument, pageIndex)
    },
    async renderPage(pageIndex, canvas, options) {
      assertOpen()
      // PDFium draws pages many times faster than PDF.js, so wait briefly for it.
      if (pdfiumState === 'loading') {
        let timer
        await Promise.race([pdfiumReady, new Promise((resolve) => { timer = setTimeout(resolve, pdfiumWaitMs) })])
        clearTimeout(timer)
        assertOpen()
      }
      if (pdfiumDocument) {
        try {
          return await pdfiumDocument.renderPage(pageIndex, canvas, options)
        } catch (error) {
          recordPdfiumFailure(error)
        }
      }
      return pdfJsAdapter.renderPage(pdfJsDocument, pageIndex, canvas, options)
    },
    async getTextContent(pageIndex, options) {
      assertOpen()
      return pdfJsAdapter.getTextContent(pdfJsDocument, pageIndex, options)
    },
    getPageFonts(pageIndex) {
      return pdfJsAdapter.getPageFonts?.(pdfJsDocument, pageIndex) ?? []
    },
    async close() {
      if (closePromise) return closePromise
      if (closed) return undefined
      closed = true
      closePromise = (async () => {
        await pdfiumReady
        await Promise.allSettled([
          pdfiumDocument?.close(),
          pdfJsAdapter.destroy?.(pdfJsDocument),
        ])
        pdfiumDocument = null
        pdfiumState = 'closed'
      })()
      return closePromise
    },
  }
}
