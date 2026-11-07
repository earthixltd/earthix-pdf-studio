// Keep this entrypoint lightweight. The heavyweight PDF.js and PDFium adapters
// are loaded dynamically by createPdfEngine() only when the first document opens.
export { PdfEngineError, getPdfiumErrorMessage, normalizePdfEngineError } from './engineErrors.js'
export { bitmapToRgba } from './pdfium/bitmapToRgba.js'
export { openDocumentSession } from './document-core/openDocumentSession.js'
export { createPdfEngine } from './createPdfEngine.js'
export { validatePdfInput } from './validation/validatePdfInput.js'

export { inspectDocumentFonts, findFontForRun, assessFontReplacement, getFontStyleLabel } from './font-engine/index.js'
