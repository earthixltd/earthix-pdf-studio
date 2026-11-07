import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import { PdfEngineError } from '../engineErrors.js'

const DEFAULT_BASE_URL = import.meta.env?.BASE_URL || '/'

function joinBaseUrl(baseUrl, assetPath) {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  return `${base}${assetPath.replace(/^\//, '')}`
}

function toUint8Array(input) {
  if (input instanceof Uint8Array) return input.slice()
  if (input instanceof ArrayBuffer) return new Uint8Array(input.slice(0))
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength))
  }
  throw new PdfEngineError('PDF data must be a File, ArrayBuffer or Uint8Array.', {
    code: 'INVALID_PDF_DATA',
  })
}

export class PdfJsAdapter {
  constructor({ baseUrl = DEFAULT_BASE_URL } = {}) {
    this.baseUrl = baseUrl
    this.workerConfigured = false
    this.documentTasks = new WeakMap()
  }

  assetUrl(assetPath) {
    return joinBaseUrl(this.baseUrl, assetPath)
  }

  configureWorker() {
    if (this.workerConfigured) return
    GlobalWorkerOptions.workerSrc = this.assetUrl('pdfjs/pdf.worker.mjs')
    this.workerConfigured = true
  }

  async open(input, { password, onProgress, signal } = {}) {
    this.configureWorker()
    const data = toUint8Array(input)
    const loadingTask = getDocument({
      data,
      password,
      cMapUrl: this.assetUrl('pdfjs/cmaps/'),
      cMapPacked: true,
      standardFontDataUrl: this.assetUrl('pdfjs/standard_fonts/'),
      wasmUrl: this.assetUrl('pdfjs/wasm/'),
      iccUrl: this.assetUrl('pdfjs/iccs/'),
      useWorkerFetch: true,
      isEvalSupported: false,
      enableXfa: false,
      stopAtErrors: false,
    })

    if (typeof onProgress === 'function') loadingTask.onProgress = onProgress

    let abortHandler
    if (signal) {
      if (signal.aborted) {
        await loadingTask.destroy()
        throw new PdfEngineError('PDF loading was cancelled.', { code: 'ABORTED' })
      }
      abortHandler = () => { void loadingTask.destroy().catch(() => undefined) }
      signal.addEventListener('abort', abortHandler, { once: true })
    }

    try {
      const document = await loadingTask.promise
      this.documentTasks.set(document, loadingTask)
      if (signal?.aborted) {
        this.documentTasks.delete(document)
        await loadingTask.destroy()
        throw new PdfEngineError('PDF loading was cancelled.', { code: 'ABORTED' })
      }
      return document
    } catch (error) {
      if (error instanceof PdfEngineError) throw error
      await loadingTask.destroy().catch(() => undefined)
      const isPasswordError = error?.name === 'PasswordException'
      const isAbortError = error?.name === 'AbortException' || signal?.aborted
      throw new PdfEngineError(
        isPasswordError ? 'This PDF requires a password.' : isAbortError ? 'PDF loading was cancelled.' : error?.message || 'PDF.js could not open this document.',
        {
          code: isPasswordError ? 'PASSWORD_REQUIRED' : isAbortError ? 'ABORTED' : 'PDFJS_OPEN_FAILED',
          cause: error,
        },
      )
    } finally {
      if (abortHandler) signal.removeEventListener('abort', abortHandler)
    }
  }

  async getPageInfo(document, pageIndex) {
    this.assertPage(document, pageIndex)
    const page = await document.getPage(pageIndex + 1)
    try {
      const viewport = page.getViewport({ scale: 1 })
      return {
        pageIndex,
        pageNumber: pageIndex + 1,
        width: viewport.width,
        height: viewport.height,
        rotation: viewport.rotation,
        view: [...page.view],
      }
    } finally {
      page.cleanup?.()
    }
  }

  async renderPage(document, pageIndex, canvas, { scale = 1, dpr = globalThis.devicePixelRatio || 1, background = '#ffffff', rotation } = {}) {
    this.assertPage(document, pageIndex)
    if (typeof HTMLCanvasElement === 'undefined' || !(canvas instanceof HTMLCanvasElement)) {
      throw new PdfEngineError('A valid HTML canvas is required to render a PDF page.', {
        code: 'INVALID_CANVAS',
      })
    }
    if (!Number.isFinite(scale) || scale <= 0 || scale > 8 || !Number.isFinite(dpr) || dpr <= 0 || dpr > 4) {
      throw new PdfEngineError('PDF render scale or device pixel ratio is outside the supported range.', { code: 'INVALID_RENDER_SCALE' })
    }

    const page = await document.getPage(pageIndex + 1)
    let renderTask
    try {
      const viewport = page.getViewport({ scale: scale * dpr, ...(rotation === undefined ? {} : { rotation }) })
      const context = canvas.getContext('2d', { alpha: false })
      if (!context) throw new PdfEngineError('The browser could not create a 2D canvas context.', { code: 'CANVAS_UNAVAILABLE' })

      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      canvas.style.width = `${Math.ceil(viewport.width / dpr)}px`
      canvas.style.height = `${Math.ceil(viewport.height / dpr)}px`

      renderTask = page.render({ canvasContext: context, viewport, background })
      await renderTask.promise

      return {
        pageIndex,
        width: viewport.width / dpr,
        height: viewport.height / dpr,
        pixelWidth: canvas.width,
        pixelHeight: canvas.height,
        rotation: viewport.rotation,
      }
    } catch (error) {
      if (error?.name === 'RenderingCancelledException') {
        throw new PdfEngineError('PDF page rendering was cancelled.', { code: 'RENDER_CANCELLED', cause: error })
      }
      throw error
    } finally {
      page.cleanup?.()
    }
  }

  async getTextContent(document, pageIndex, options = {}) {
    this.assertPage(document, pageIndex)
    const page = await document.getPage(pageIndex + 1)
    try {
      return await page.getTextContent(options)
    } finally {
      page.cleanup?.()
    }
  }

  async destroy(document) {
    const loadingTask = document ? this.documentTasks.get(document) : null
    if (!loadingTask) return
    this.documentTasks.delete(document)
    await loadingTask.destroy()
  }

  assertPage(document, pageIndex) {
    if (!document) throw new PdfEngineError('No PDF.js document is open.', { code: 'NO_DOCUMENT' })
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= document.numPages) {
      throw new PdfEngineError(`Page index ${pageIndex} is outside this document.`, { code: 'INVALID_PAGE_INDEX' })
    }
  }
}

export const pdfJsAdapter = new PdfJsAdapter()
