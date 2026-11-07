import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PDFDocument, rgb } from 'pdf-lib'

async function pdfWithColor(color, label) {
  const document = await PDFDocument.create()
  const page = document.addPage([200, 200])
  page.drawRectangle({ x: 0, y: 0, width: 200, height: 200, color })
  document.setTitle(label)
  return new Uint8Array(await document.save({ useObjectStreams: false }))
}

/** Load the real PDFium worker module with a minimal worker environment. */
async function loadWorker() {
  const wasm = await readFile(new URL('../../node_modules/@embedpdf/pdfium/dist/pdfium.wasm', import.meta.url))
  const pending = new Map()
  let handler = null
  globalThis.self = {
    addEventListener: (type, listener) => { if (type === 'message') handler = listener },
    postMessage: (message) => pending.get(message.requestId)?.(message),
  }
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => (String(url).endsWith('pdfium.wasm') ? new Response(wasm) : realFetch(url))
  await import('../../frontend/src/workers/pdfium.worker.js')
  let counter = 0
  return (action, payload) => new Promise((resolve, reject) => {
    const requestId = `r${++counter}`
    pending.set(requestId, (message) => (message.ok ? resolve(message.result) : reject(new Error(message.error.message))))
    handler({ data: { requestId, action, payload } })
  })
}

function centerPixel(result) {
  const pixels = new Uint8ClampedArray(result.pixelBuffer)
  const offset = ((Math.floor(result.height / 2) * result.width) + Math.floor(result.width / 2)) * 4
  return [pixels[offset], pixels[offset + 1], pixels[offset + 2]]
}

test('PDFium keeps rendering an open PDF correctly while other PDFs are opened and closed', async () => {
  const request = await loadWorker()
  await request('initialize', { wasmUrl: 'http://local/pdfium.wasm' })
  const red = await pdfWithColor(rgb(0.9, 0.1, 0.1), 'red')
  await request('open-document', { documentId: 'red', data: red.buffer })
  // Churn memory with similar-sized documents, like re-opening after edits.
  for (let round = 0; round < 4; round += 1) {
    const blue = await pdfWithColor(rgb(0.1, 0.2, 0.9), 'blue')
    await request('open-document', { documentId: `blue${round}`, data: blue.buffer })
    const rendered = await request('render-page', { documentId: `blue${round}`, pageIndex: 0, scale: 0.5, dpr: 1 })
    const [r, , b] = centerPixel(rendered)
    assert.ok(b > 180 && r < 60, `blue page renders blue (${centerPixel(rendered)})`)
    await request('close-document', { documentId: `blue${round}` })
  }
  const result = await request('render-page', { documentId: 'red', pageIndex: 0, scale: 0.5, dpr: 1 })
  const [r, g, b] = centerPixel(result)
  assert.ok(r > 180 && g < 60 && b < 60, `red page still renders red (${[r, g, b]})`)
  await request('close-document', { documentId: 'red' })
})
