import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const assetScript = await readFile(new URL('../../frontend/scripts/copy-pdf-assets.js', import.meta.url), 'utf8')
const pdfJsAdapter = await readFile(new URL('../../frontend/src/engine/pdfjs/pdfJsAdapter.js', import.meta.url), 'utf8')

test('self-hosts the worker and PDF.js 6.5.438 auxiliary assets from their package locations', () => {
  for (const entry of [
    "'build/pdf.worker.mjs'",
    "'cmaps'",
    "'standard_fonts'",
    "'wasm'",
    "'image_decoders'",
    "'iccs'",
  ]) {
    assert.ok(assetScript.includes(entry), `Missing asset copy entry: ${entry}`)
  }
  assert.ok(assetScript.includes("'dist/pdfium.wasm'"))
  assert.ok(!assetScript.includes("'web/cmaps'"))
  assert.ok(!assetScript.includes("'web/standard_fonts'"))
  assert.ok(!assetScript.includes("'web/wasm'"))
})

test('PDF.js adapter points to local self-hosted worker and auxiliary assets', () => {
  for (const path of [
    'pdfjs/pdf.worker.mjs',
    'pdfjs/cmaps/',
    'pdfjs/standard_fonts/',
    'pdfjs/wasm/',
    'pdfjs/iccs/',
  ]) {
    assert.ok(pdfJsAdapter.includes(path), `Missing local PDF.js asset path: ${path}`)
  }
})
