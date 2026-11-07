import { PdfEngineError } from '../engineErrors.js'

const DEFAULT_MAX_PDF_BYTES = 200 * 1024 * 1024
const PDF_HEADER_WINDOW = 1024

export function validatePdfInput(input, { maxBytes = DEFAULT_MAX_PDF_BYTES } = {}) {
  let bytes
  if (input instanceof Uint8Array) bytes = input
  else if (input instanceof ArrayBuffer) bytes = new Uint8Array(input)
  else if (ArrayBuffer.isView(input)) {
    bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
  } else {
    throw new PdfEngineError('Choose a PDF file or provide PDF bytes.', { code: 'INVALID_PDF_DATA' })
  }

  if (!bytes.byteLength) throw new PdfEngineError('The selected PDF is empty.', { code: 'EMPTY_PDF' })
  if (bytes.byteLength > maxBytes) {
    const maximumMegabytes = Math.round(maxBytes / 1024 / 1024)
    throw new PdfEngineError(`This PDF is larger than the ${maximumMegabytes} MB application limit.`, {
      code: 'PDF_TOO_LARGE',
      details: { byteLength: bytes.byteLength, maxBytes },
    })
  }

  const header = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, PDF_HEADER_WINDOW)))
  if (!header.includes('%PDF-')) {
    throw new PdfEngineError('The file does not contain a valid PDF header. Choose an actual .pdf document.', {
      code: 'INVALID_PDF_HEADER',
    })
  }

  return bytes.slice()
}
