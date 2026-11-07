import { PdfEngineError } from '../../engineErrors.js'

export function validateDocumentForExport({ bytes, pageCount, expectedPageCount, fileName = 'document.pdf' }) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 8) {
    throw new PdfEngineError('The document does not contain enough PDF data to export.', { code: 'INVALID_EXPORT_BYTES' })
  }
  const header = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 1024)))
  if (!header.includes('%PDF-')) {
    throw new PdfEngineError('The exported file does not contain a valid PDF header.', { code: 'INVALID_EXPORT_HEADER' })
  }
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    throw new PdfEngineError('The document must contain at least one page before export.', { code: 'INVALID_EXPORT_PAGE_COUNT' })
  }
  if (Number.isInteger(expectedPageCount) && pageCount !== expectedPageCount) {
    throw new PdfEngineError(`The document model has ${pageCount} page(s), but the PDF engine reports ${expectedPageCount}.`, {
      code: 'EXPORT_PAGE_COUNT_MISMATCH',
      details: { pageCount, expectedPageCount },
    })
  }
  if (typeof fileName !== 'string' || !fileName.trim()) {
    throw new PdfEngineError('A file name is required for document export.', { code: 'INVALID_EXPORT_FILE_NAME' })
  }
  return { bytes: bytes.slice(), byteLength: bytes.byteLength, pageCount, fileName: fileName.trim() }
}
