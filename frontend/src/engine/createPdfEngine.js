import { PdfEngineError, normalizePdfEngineError } from './engineErrors.js'
import { openDocumentSession } from './document-core/openDocumentSession.js'

/**
 * Create one browser-side Earthix PDF engine instance.
 * PDF.js is required for viewing; PDFium is an optional accelerated/native adapter.
 */
export function createPdfEngine({ baseUrl, pdfJsAdapter: injectedPdfJs, pdfiumAdapter: injectedPdfium, workerFactory, requestTimeoutMs } = {}) {
  let pdfJs = injectedPdfJs || null
  let pdfium = injectedPdfium || null
  let pdfiumInitializationError = null
  let adapterInitialization = null
  const sessions = new Set()
  let disposed = false

  async function ensureAdapters() {
    if (pdfJs && (pdfium || pdfiumInitializationError)) return { pdfJs, pdfium, pdfiumInitializationError }
    if (!adapterInitialization) {
      adapterInitialization = (async () => {
        if (!pdfJs) {
          const { PdfJsAdapter } = await import('./pdfjs/pdfJsAdapter.js')
          pdfJs = new PdfJsAdapter({ baseUrl })
        }
        if (!pdfium && !pdfiumInitializationError) {
          try {
            const { PdfiumAdapter } = await import('./pdfium/pdfiumAdapter.js')
            pdfium = new PdfiumAdapter({ baseUrl, workerFactory, requestTimeoutMs })
          } catch (error) {
            // A viewer must remain usable when Web Workers are unavailable.
            pdfiumInitializationError = normalizePdfEngineError(error, 'PDFium could not be initialized.')
          }
        }
        return { pdfJs, pdfium, pdfiumInitializationError }
      })().catch((error) => {
        adapterInitialization = null
        throw error
      })
    }
    return adapterInitialization
  }

  return {
    async openDocument(input, options = {}) {
      if (disposed) throw new PdfEngineError('The Earthix PDF engine has been disposed.', { code: 'ENGINE_DISPOSED' })
      const adapters = await ensureAdapters()
      if (disposed) throw new PdfEngineError('The Earthix PDF engine has been disposed.', { code: 'ENGINE_DISPOSED' })
      const session = await openDocumentSession(input, {
        ...options,
        pdfJsAdapter: adapters.pdfJs,
        pdfiumAdapter: adapters.pdfium,
        pdfiumUnavailableError: adapters.pdfiumInitializationError,
      })
      if (disposed) {
        await session.close()
        throw new PdfEngineError('The Earthix PDF engine was disposed while the document was opening.', { code: 'ENGINE_DISPOSED' })
      }
      sessions.add(session)
      const originalClose = session.close.bind(session)
      session.close = async () => {
        await originalClose()
        sessions.delete(session)
      }
      return session
    },

    /** Load the renderers ahead of time so the first PDF opens quickly. */
    async warmUp() {
      if (disposed) return
      const adapters = await ensureAdapters().catch(() => null)
      await adapters?.pdfium?.initialize?.().catch(() => undefined)
    },

    get activeDocumentCount() {
      return sessions.size
    },

    get disposed() {
      return disposed
    },

    async dispose() {
      if (disposed) return
      disposed = true
      await Promise.allSettled([...sessions].map((session) => session.close()))
      sessions.clear()
      if (adapterInitialization) await adapterInitialization.catch(() => undefined)
      await pdfium?.dispose?.()
    },
  }
}
