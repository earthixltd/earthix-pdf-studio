const PDFIUM_ERROR_MESSAGES = {
  0: 'No PDFium error was reported.',
  1: 'PDFium reported an unknown error.',
  2: 'The PDF file could not be opened. Check that the file is valid and readable.',
  3: 'The PDF file is malformed or uses an unsupported structure.',
  4: 'This PDF is password-protected. Unlock it before opening.',
  5: 'The PDF uses security restrictions that prevent this operation.',
  6: 'A PDF page could not be loaded.',
}

export class PdfEngineError extends Error {
  constructor(message, { code = 'PDF_ENGINE_ERROR', cause, details } = {}) {
    super(message, cause ? { cause } : undefined)
    this.name = 'PdfEngineError'
    this.code = code
    this.details = details
  }
}

export function getPdfiumErrorMessage(errorCode) {
  return PDFIUM_ERROR_MESSAGES[Number(errorCode)] || `PDFium failed with error code ${errorCode}.`
}

export function normalizePdfEngineError(error, fallback = 'The PDF operation failed.') {
  if (error instanceof PdfEngineError) return error
  if (error instanceof Error) {
    return new PdfEngineError(error.message || fallback, { cause: error })
  }
  return new PdfEngineError(fallback, { details: error })
}
