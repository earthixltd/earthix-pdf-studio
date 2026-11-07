import test from 'node:test'
import assert from 'node:assert/strict'
import { searchPdfDocument } from '../../frontend/src/features/pdf-viewer/searchPdfDocument.js'

function makeSession(pages) {
  const cleanupCounts = pages.map(() => 0)
  const pdfJsDocument = {
    async getPage(pageNumber) {
      const pageIndex = pageNumber - 1
      const content = pages[pageIndex]
      if (content instanceof Error) throw content
      return {
        async getTextContent() {
          return { items: content }
        },
        cleanup() {
          cleanupCounts[pageIndex] += 1
        },
      }
    },
  }
  return { session: { pdfJsDocument, pageCount: pages.length }, cleanupCounts }
}

function item(str, x = 0, y = 100, width = str.length * 5, extra = {}) {
  return { str, transform: [10, 0, 0, 10, x, y], width, height: 10, dir: 'ltr', ...extra }
}

test('search finds case-insensitive text within a text item', async () => {
  const { session, cleanupCounts } = makeSession([[item('Passenger MD GULREZ', 0)]])
  const results = await searchPdfDocument(session, 'md gulrez')
  assert.equal(results.length, 1)
  assert.equal(results[0].pageNumber, 1)
  assert.deepEqual(results[0].itemIndexes, [0])
  assert.match(results[0].text, /MD GULREZ/)
  assert.deepEqual(cleanupCounts, [1])
})

test('search matches a phrase split across adjacent PDF text runs', async () => {
  const { session } = makeSession([[
    item('Reservation', 0, 100, 48),
    item('Slip', 50, 100, 16),
  ]])
  const results = await searchPdfDocument(session, 'reservation slip')
  assert.equal(results.length, 1)
  assert.deepEqual(results[0].itemIndexes, [0, 1])
  assert.equal(results[0].text, 'Reservation Slip')
})

test('search preserves line boundaries between PDF text runs', async () => {
  const { session } = makeSession([[
    item('First line', 0, 100, 45, { hasEOL: true }),
    item('Second line', 0, 80, 55),
  ]])
  const results = await searchPdfDocument(session, 'line second')
  assert.equal(results.length, 0)
  const lineResults = await searchPdfDocument(session, 'first line')
  assert.equal(lineResults.length, 1)
})

test('search scans multiple pages and reports correct page indexes', async () => {
  const { session, cleanupCounts } = makeSession([
    [item('No match here')],
    [item('The important reference 12345')],
  ])
  const progress = []
  const results = await searchPdfDocument(session, '12345', { onProgress: (value) => progress.push(value) })
  assert.equal(results.length, 1)
  assert.equal(results[0].pageIndex, 1)
  assert.deepEqual(progress.map((value) => value.pagesScanned), [1, 2])
  assert.deepEqual(cleanupCounts, [1, 1])
})

test('search applies the maximum result limit', async () => {
  const { session } = makeSession([[item('one one one one one')], [item('one one')]])
  const results = await searchPdfDocument(session, 'one', { maxMatches: 3 })
  assert.equal(results.length, 3)
})

test('search rejects an already aborted operation', async () => {
  const { session } = makeSession([[item('anything')]])
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    searchPdfDocument(session, 'anything', { signal: controller.signal }),
    (error) => error.code === 'SEARCH_CANCELLED',
  )
})

test('search cleans up a page when text extraction fails', async () => {
  const pageError = new Error('text extraction failed')
  let cleanupCount = 0
  const session = {
    pageCount: 1,
    pdfJsDocument: {
      async getPage() {
        return {
          async getTextContent() { throw pageError },
          cleanup() { cleanupCount += 1 },
        }
      },
    },
  }
  await assert.rejects(searchPdfDocument(session, 'test'), /text extraction failed/)
  assert.equal(cleanupCount, 1)
})

test('search rejects missing sessions and invalid result limits', async () => {
  await assert.rejects(searchPdfDocument(null, 'test'), (error) => error.code === 'NO_DOCUMENT')
  const { session } = makeSession([[item('test')]])
  await assert.rejects(searchPdfDocument(session, 'test', { maxMatches: 0 }), (error) => error.code === 'INVALID_SEARCH_LIMIT')
})
