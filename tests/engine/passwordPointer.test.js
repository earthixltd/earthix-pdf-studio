import test from 'node:test'
import assert from 'node:assert/strict'
import { createPdfiumPasswordPointer } from '../../frontend/src/engine/pdfium/passwordPointer.js'

function createFakePdfium({ allocationFailure = false } = {}) {
  const heap = new Uint8Array(1024)
  const allocations = new Set()
  let nextPointer = 16
  const freed = []
  return {
    heap,
    allocations,
    freed,
    pdfium: {
      HEAPU8: heap,
      wasmExports: {
        malloc(size) {
          if (allocationFailure) return 0
          const pointer = nextPointer
          nextPointer += size
          allocations.add(pointer)
          return pointer
        },
        free(pointer) {
          assert.ok(allocations.has(pointer), `Pointer ${pointer} must be allocated before free.`)
          allocations.delete(pointer)
          freed.push(pointer)
        },
      },
    },
  }
}

test('uses a null pointer when the PDF has no password', () => {
  const fake = createFakePdfium()
  const allocation = createPdfiumPasswordPointer(fake.pdfium, '')
  assert.equal(allocation.pointer, 0)
  allocation.release()
  assert.equal(fake.freed.length, 0)
})

test('encodes a password as null-terminated UTF-8 for PDFium', () => {
  const fake = createFakePdfium()
  const allocation = createPdfiumPasswordPointer(fake.pdfium, 'Päss🔐')
  const encoded = new TextEncoder().encode('Päss🔐')
  assert.deepEqual(fake.heap.slice(allocation.pointer, allocation.pointer + encoded.length), encoded)
  assert.equal(fake.heap[allocation.pointer + encoded.length], 0)
  assert.ok(fake.allocations.has(allocation.pointer))
  allocation.release()
  allocation.release()
  assert.equal(fake.allocations.size, 0)
  assert.deepEqual(fake.freed, [allocation.pointer])
})

test('rejects non-string passwords', () => {
  const fake = createFakePdfium()
  assert.throws(() => createPdfiumPasswordPointer(fake.pdfium, 1234), { code: 'INVALID_PDF_PASSWORD' })
  assert.equal(fake.allocations.size, 0)
})

test('reports password allocation failure without returning an invalid pointer', () => {
  const fake = createFakePdfium({ allocationFailure: true })
  assert.throws(() => createPdfiumPasswordPointer(fake.pdfium, 'secret'), { code: 'PDFIUM_PASSWORD_ALLOCATION_FAILED' })
})
