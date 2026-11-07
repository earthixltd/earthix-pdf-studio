import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const workerSource = await readFile(new URL('../../frontend/src/workers/pdfium.worker.js', import.meta.url), 'utf8')

test('passes PDFium a WASM password pointer instead of a JavaScript string', () => {
  assert.ok(workerSource.includes('createPdfiumPasswordPointer(wasm, password || \'\')'))
  assert.ok(workerSource.includes('passwordAllocation.pointer'))
  assert.ok(!workerSource.includes('FPDF_LoadMemDocument(filePointer, bytes.length, password ||'))
  assert.ok(workerSource.includes('passwordAllocation?.release()'))
})

test('releases the input buffer immediately after the memory load call', () => {
  assert.ok(workerSource.includes('FPDF_LoadMemDocument(filePointer, bytes.length, passwordAllocation.pointer)'))
  assert.ok(workerSource.includes('wasm.wasmExports.free(filePointer)'))
  assert.ok(!workerSource.includes('filePointer, pageCount'))
})

test('keeps rendering pointers and PDFium memory in the worker only', () => {
  assert.ok(workerSource.includes('module.FPDFBitmap_GetStride(bitmapPointer)'))
  assert.ok(workerSource.includes('module.FPDFBitmap_GetFormat(bitmapPointer)'))
  assert.ok(workerSource.includes('bitmapToRgba(rawPixels'))
  assert.ok(workerSource.includes('module.FPDFBitmap_Destroy(bitmapPointer)'))
  assert.ok(workerSource.includes('module.FPDF_ClosePage(pagePointer)'))
  assert.ok(workerSource.includes('transfer.push') === false)
  assert.ok(workerSource.includes('self.postMessage({ requestId, ok: true, result }, transfer)'))
})
