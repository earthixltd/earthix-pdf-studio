import { init } from '@embedpdf/pdfium'
import { bitmapToRgba } from '../engine/pdfium/bitmapToRgba.js'
import { createPdfiumPasswordPointer } from '../engine/pdfium/passwordPointer.js'

const PDFIUM_RENDER_FLAGS = {
  INCLUDE_ANNOTATIONS: 0x01,
}

let pdfiumModule = null
let wasmSource = ''
const openDocuments = new Map()

function mapPdfiumError(code) {
  const messages = {
    1: 'PDFium reported an unknown error.',
    2: 'The PDF file could not be opened.',
    3: 'The PDF file is malformed or unsupported.',
    4: 'The PDF requires a password.',
    5: 'The PDF has security restrictions.',
    6: 'A PDF page could not be loaded.',
  }
  return messages[Number(code)] || `PDFium failed with error code ${code}.`
}

function initializePdfiumOrThrow() {
  if (!pdfiumModule) throw new Error('PDFium has not been initialized.')
  return pdfiumModule
}

async function initialize(payload = {}) {
  const wasmUrl = typeof payload === 'string' ? payload : payload.wasmUrl
  if (pdfiumModule) return { initialized: true, wasmSource }
  if (!wasmUrl) throw new Error('The local PDFium WebAssembly asset URL is missing.')

  const response = await fetch(wasmUrl)
  if (!response.ok) throw new Error(`Could not load PDFium WebAssembly (${response.status}). Check npm install and public/pdfium/pdfium.wasm.`)
  const wasmBinary = await response.arrayBuffer()
  const instance = await init({ wasmBinary })
  instance.PDFiumExt_Init()
  pdfiumModule = instance
  wasmSource = wasmUrl
  return { initialized: true, wasmSource }
}

function getDocument(documentId) {
  const document = openDocuments.get(documentId)
  if (!document) throw new Error('The PDFium document session is no longer available. Reopen the PDF and try again.')
  return document
}

function openDocument({ documentId, data, password }) {
  const module = initializePdfiumOrThrow()
  if (!documentId || openDocuments.has(documentId)) throw new Error('A unique PDF document session ID is required.')

  const bytes = new Uint8Array(data)
  if (!bytes.length) throw new Error('The selected PDF is empty.')

  const wasm = module.pdfium
  const filePointer = wasm.wasmExports.malloc(bytes.length)
  if (!filePointer) throw new Error('PDFium could not allocate memory for this PDF.')

  let documentPointer = 0
  let passwordAllocation = null
  let keepBuffer = false
  try {
    passwordAllocation = createPdfiumPasswordPointer(wasm, password || '')
    wasm.HEAPU8.set(bytes, filePointer)
    documentPointer = module.FPDF_LoadMemDocument(filePointer, bytes.length, passwordAllocation.pointer)
    if (!documentPointer) {
      const errorCode = module.FPDF_GetLastError()
      const error = new Error(mapPdfiumError(errorCode))
      error.code = errorCode === 4 ? 'PASSWORD_REQUIRED' : errorCode === 5 ? 'PDF_PERMISSION_DENIED' : 'PDFIUM_OPEN_FAILED'
      error.pdfiumCode = errorCode
      throw error
    }

    const pageCount = module.FPDF_GetPageCount(documentPointer)
    if (!Number.isInteger(pageCount) || pageCount < 1) {
      throw new Error('PDFium opened the file but reported no pages.')
    }

    // PDFium reads from this buffer for as long as the document is open, so it
    // is kept with the document and freed only in closeDocument().
    openDocuments.set(documentId, { documentPointer, pageCount, filePointer })
    documentPointer = 0
    keepBuffer = true
    return { documentId, pageCount }
  } finally {
    try {
      passwordAllocation?.release()
    } finally {
      try {
        if (documentPointer) module.FPDF_CloseDocument(documentPointer)
      } finally {
        // Only free the buffer when the document did not open.
        if (!keepBuffer) wasm.wasmExports.free(filePointer)
      }
    }
  }
}

function loadPage(documentId, pageIndex) {
  const module = initializePdfiumOrThrow()
  const record = getDocument(documentId)
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= record.pageCount) {
    throw new Error(`Invalid PDF page index: ${pageIndex}.`)
  }

  const pagePointer = module.FPDF_LoadPage(record.documentPointer, pageIndex)
  if (!pagePointer) throw new Error(mapPdfiumError(module.FPDF_GetLastError()))
  return { module, pagePointer }
}

function getPageInfo({ documentId, pageIndex }) {
  const { module, pagePointer } = loadPage(documentId, pageIndex)
  try {
    const width = module.FPDF_GetPageWidthF(pagePointer)
    const height = module.FPDF_GetPageHeightF(pagePointer)
    const rotation = module.FPDFPage_GetRotation(pagePointer) * 90
    const isQuarterTurn = rotation === 90 || rotation === 270
    return {
      pageIndex,
      pageNumber: pageIndex + 1,
      width: isQuarterTurn ? height : width,
      height: isQuarterTurn ? width : height,
      rotation,
    }
  } finally {
    module.FPDF_ClosePage(pagePointer)
  }
}

function renderPage({ documentId, pageIndex, scale = 1, dpr = 1, rotation = 0 }) {
  const { module, pagePointer } = loadPage(documentId, pageIndex)
  let bitmapPointer = 0

  try {
    if (!Number.isFinite(scale) || scale <= 0 || scale > 8) throw new Error('PDF render scale must be between 0 and 8.')
    if (!Number.isFinite(dpr) || dpr <= 0 || dpr > 4) throw new Error('Device pixel ratio must be between 0 and 4.')
    if (![0, 90, 180, 270].includes(rotation)) throw new Error('Rotation must be 0, 90, 180 or 270 degrees.')

    const pageWidth = module.FPDF_GetPageWidthF(pagePointer)
    const pageHeight = module.FPDF_GetPageHeightF(pagePointer)
    const intrinsicRotation = module.FPDFPage_GetRotation(pagePointer)
    const effectiveRotation = (intrinsicRotation + rotation / 90) % 4
    const rotateFlag = effectiveRotation
    const isQuarterTurn = rotateFlag === 1 || rotateFlag === 3

    let width = Math.max(1, Math.ceil(pageWidth * scale * dpr))
    let height = Math.max(1, Math.ceil(pageHeight * scale * dpr))
    if (isQuarterTurn) [width, height] = [height, width]

    if (width > 12000 || height > 12000 || width * height > 48_000_000) {
      throw new Error('Requested render resolution is too large. Reduce zoom or device pixel ratio.')
    }

    // FPDFBitmap_Create returns BGRx (format 3) when alpha is disabled.
    bitmapPointer = module.FPDFBitmap_Create(width, height, 0)
    if (!bitmapPointer) throw new Error('PDFium could not create a render bitmap.')
    module.FPDFBitmap_FillRect(bitmapPointer, 0, 0, width, height, 0xFFFFFFFF)
    module.FPDF_RenderPageBitmap(bitmapPointer, pagePointer, 0, 0, width, height, rotateFlag, PDFIUM_RENDER_FLAGS.INCLUDE_ANNOTATIONS)

    const bufferPointer = module.FPDFBitmap_GetBuffer(bitmapPointer)
    if (!bufferPointer) throw new Error('PDFium did not return a render buffer.')

    const bitmapWidth = module.FPDFBitmap_GetWidth(bitmapPointer)
    const bitmapHeight = module.FPDFBitmap_GetHeight(bitmapPointer)
    const stride = module.FPDFBitmap_GetStride(bitmapPointer)
    const format = module.FPDFBitmap_GetFormat(bitmapPointer)
    const byteLength = stride * bitmapHeight
    const heap = module.pdfium.HEAPU8
    const rawPixels = new Uint8Array(heap.buffer, heap.byteOffset + bufferPointer, byteLength).slice()
    const rgbaPixels = bitmapToRgba(rawPixels, {
      width: bitmapWidth,
      height: bitmapHeight,
      stride,
      format,
    })

    return {
      pageIndex,
      width: bitmapWidth,
      height: bitmapHeight,
      cssWidth: bitmapWidth / dpr,
      cssHeight: bitmapHeight / dpr,
      rotation: effectiveRotation * 90,
      pixelBuffer: rgbaPixels.buffer,
    }
  } finally {
    if (bitmapPointer) module.FPDFBitmap_Destroy(bitmapPointer)
    module.FPDF_ClosePage(pagePointer)
  }
}

function closeDocument(documentId) {
  const module = initializePdfiumOrThrow()
  const record = openDocuments.get(documentId)
  if (!record) return { closed: false }
  try {
    module.FPDF_CloseDocument(record.documentPointer)
  } finally {
    if (record.filePointer) module.pdfium.wasmExports.free(record.filePointer)
    openDocuments.delete(documentId)
  }
  return { closed: true }
}

function closeAllDocuments() {
  const results = [...openDocuments.keys()].map((documentId) => {
    try { closeDocument(documentId); return true } catch { return false }
  })
  return { closed: results.every(Boolean) }
}

const handlers = {
  initialize,
  'open-document': openDocument,
  'get-page-info': getPageInfo,
  'render-page': renderPage,
  'close-document': ({ documentId }) => closeDocument(documentId),
  'close-all': closeAllDocuments,
}

self.addEventListener('message', async (event) => {
  const { requestId, action, payload = {} } = event.data || {}
  if (!requestId || !handlers[action]) return

  try {
    const result = await handlers[action](payload)
    const transfer = result?.pixelBuffer instanceof ArrayBuffer ? [result.pixelBuffer] : []
    self.postMessage({ requestId, ok: true, result }, transfer)
  } catch (error) {
    self.postMessage({
      requestId,
      ok: false,
      error: {
        message: error?.message || 'PDFium worker operation failed.',
        code: error?.code || 'PDFIUM_WORKER_ERROR',
        pdfiumCode: error?.pdfiumCode,
      },
    })
  }
})
