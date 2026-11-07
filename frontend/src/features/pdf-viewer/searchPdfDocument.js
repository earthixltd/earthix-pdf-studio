import { PdfEngineError } from '../../engine/engineErrors.js'

const DEFAULT_MAX_MATCHES = 80

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new PdfEngineError('PDF text search was cancelled.', { code: 'SEARCH_CANCELLED' })
  }
}

function getItemSeparator(previous, current) {
  if (!previous) return ''
  if (previous.hasEOL) return '\n'

  const previousTransform = previous.transform
  const currentTransform = current.transform
  if (!Array.isArray(previousTransform) || !Array.isArray(currentTransform)) return ''

  const fontHeight = Math.max(1, Number(previous.height) || 0, Number(current.height) || 0)
  const verticalGap = Math.abs((Number(previousTransform[5]) || 0) - (Number(currentTransform[5]) || 0))
  if (verticalGap > fontHeight * 0.55) return '\n'

  if (previous.dir === 'rtl' || current.dir === 'rtl') {
    const horizontalGap = Math.abs((Number(previousTransform[4]) || 0) - (Number(currentTransform[4]) || 0))
    return horizontalGap > fontHeight * 0.2 ? ' ' : ''
  }

  const previousEnd = (Number(previousTransform[4]) || 0) + (Number(previous.width) || 0)
  const currentStart = Number(currentTransform[4]) || 0
  return currentStart - previousEnd > fontHeight * 0.16 ? ' ' : ''
}

function buildPageText(items) {
  let text = ''
  const ranges = []
  let previous = null

  items.forEach((item, itemIndex) => {
    if (typeof item?.str !== 'string' || !item.str) return
    const separator = getItemSeparator(previous, item)
    text += separator
    const start = text.length
    text += item.str
    ranges.push({ start, end: text.length, itemIndex })
    previous = item
  })

  return { text, ranges }
}

function getMatchedItemIndexes(ranges, start, end) {
  return ranges
    .filter((range) => range.end > start && range.start < end)
    .map((range) => range.itemIndex)
}

export async function searchPdfDocument(session, query, {
  maxMatches = DEFAULT_MAX_MATCHES,
  signal,
  onProgress,
} = {}) {
  if (!session?.pdfJsDocument || !Number.isInteger(session.pageCount)) {
    throw new PdfEngineError('Open a PDF before searching its text.', { code: 'NO_DOCUMENT' })
  }

  const needle = String(query || '').trim().toLocaleLowerCase()
  if (!needle) return []
  if (!Number.isInteger(maxMatches) || maxMatches < 1) {
    throw new PdfEngineError('The search result limit must be a positive integer.', { code: 'INVALID_SEARCH_LIMIT' })
  }

  const results = []
  for (let pageIndex = 0; pageIndex < session.pageCount; pageIndex += 1) {
    throwIfAborted(signal)
    const page = await session.pdfJsDocument.getPage(pageIndex + 1)
    try {
      const content = await page.getTextContent({
        includeMarkedContent: false,
        disableNormalization: true,
      })
      const items = content.items || []
      const { text, ranges } = buildPageText(items)
      const normalized = text.toLocaleLowerCase()
      let matchIndex = normalized.indexOf(needle)

      while (matchIndex >= 0) {
        const matchEnd = matchIndex + needle.length
        const contextStart = Math.max(0, matchIndex - 44)
        const contextEnd = Math.min(text.length, matchEnd + 44)
        results.push({
          id: `${pageIndex}:${matchIndex}`,
          pageIndex,
          pageNumber: pageIndex + 1,
          itemIndexes: getMatchedItemIndexes(ranges, matchIndex, matchEnd),
          text: text.slice(contextStart, contextEnd).replace(/\s+/g, ' ').trim(),
          matchIndex,
          matchLength: needle.length,
        })
        if (results.length >= maxMatches) break
        matchIndex = normalized.indexOf(needle, matchEnd)
      }
    } finally {
      page.cleanup?.()
    }

    onProgress?.({ pagesScanned: pageIndex + 1, pageCount: session.pageCount, matches: results.length })
    if (results.length >= maxMatches) break
    // Yield between pages so typing and navigation remain responsive on long documents.
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  throwIfAborted(signal)
  return results
}
