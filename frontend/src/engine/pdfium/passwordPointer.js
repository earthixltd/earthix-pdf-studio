import { PdfEngineError } from '../engineErrors.js'

/**
 * Allocate a null-terminated UTF-8 password for FPDF_LoadMemDocument.
 * PDFium expects a WASM pointer (or 0), not a JavaScript string.
 */
export function createPdfiumPasswordPointer(pdfium, password = '') {
  if (typeof password !== 'string') {
    throw new PdfEngineError('The PDF password must be a string.', { code: 'INVALID_PDF_PASSWORD' })
  }

  if (!password) {
    return { pointer: 0, release() {} }
  }

  const encoded = new TextEncoder().encode(password)
  const pointer = pdfium.wasmExports.malloc(encoded.byteLength + 1)
  if (!pointer) {
    throw new PdfEngineError('PDFium could not allocate memory for the PDF password.', {
      code: 'PDFIUM_PASSWORD_ALLOCATION_FAILED',
    })
  }

  try {
    pdfium.HEAPU8.set(encoded, pointer)
    pdfium.HEAPU8[pointer + encoded.byteLength] = 0
  } catch (error) {
    pdfium.wasmExports.free(pointer)
    throw new PdfEngineError('PDFium could not prepare the PDF password.', {
      code: 'PDFIUM_PASSWORD_ENCODING_FAILED',
      cause: error,
    })
  }

  let released = false
  return {
    pointer,
    release() {
      if (released) return
      released = true
      pdfium.wasmExports.free(pointer)
    },
  }
}
