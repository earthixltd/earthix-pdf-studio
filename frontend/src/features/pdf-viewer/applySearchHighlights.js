/**
 * Apply page-level PDF.js text-run highlights without modifying the text layer's content.
 * A match spanning multiple PDF.js text items passes the indexes returned by searchPdfDocument.
 */
export function applySearchHighlights(textLayer, query, searchItemIndexes = []) {
  const normalizedQuery = String(query || '').trim().toLocaleLowerCase()
  const selectedIndexes = new Set(searchItemIndexes)
  const textDivs = textLayer?.textDivs || []
  const textItems = textLayer?.textContentItemsStr || []
  let matches = 0

  textDivs.forEach((element, index) => {
    const text = String(textItems[index] || '')
    const isSearchHit = selectedIndexes.has(index)
      || Boolean(normalizedQuery && text.toLocaleLowerCase().includes(normalizedQuery))
    element.classList.toggle('earthix-search-hit', isSearchHit)
    if (isSearchHit) matches += 1
  })

  return matches
}
