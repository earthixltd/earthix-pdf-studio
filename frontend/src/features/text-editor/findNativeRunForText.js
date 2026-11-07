function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

/**
 * Match a PDF.js text-layer span to one native PDF content-stream text run.
 * Ambiguous matches are rejected instead of guessing which original object to edit.
 */
export function findNativeRunForText(nativeRuns, pageIndex, clickedText) {
  const normalized = normalizeText(clickedText)
  if (!normalized) {
    return { run: null, matchType: 'none', reason: 'No text was detected in the clicked PDF area.' }
  }

  const pageRuns = (nativeRuns || []).filter((run) => run.pageIndex === pageIndex)
  const exactMatches = pageRuns.filter((run) => normalizeText(run.originalText) === normalized)

  if (exactMatches.length === 1) {
    return { run: exactMatches[0], matchType: 'exact', reason: '' }
  }

  if (exactMatches.length > 1) {
    return {
      run: null,
      matchType: 'ambiguous',
      reason: 'This text appears more than once on the current page. Choose the exact original text run from the editor list.',
    }
  }

  const partialMatches = pageRuns.filter((run) => normalizeText(run.originalText).includes(normalized))
  if (partialMatches.length === 1) {
    return { run: partialMatches[0], matchType: 'partial', reason: '' }
  }

  if (partialMatches.length > 1) {
    return {
      run: null,
      matchType: 'ambiguous',
      reason: 'The clicked text belongs to multiple possible PDF text runs. Choose the exact original text run from the editor list.',
    }
  }

  return {
    run: null,
    matchType: 'unsupported',
    reason: 'This text is selectable, but it does not map to a supported native PDF text operator. No duplicate overlay was created.',
  }
}
