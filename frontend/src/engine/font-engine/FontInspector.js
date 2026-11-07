import { inspectNativePdfText } from '../../services/nativePdfTextEditor.js'

export async function inspectDocumentFonts(bytes) {
  const inspection = await inspectNativePdfText(bytes)
  return {
    fonts: inspection.fonts || [],
    runs: inspection.runs || [],
    pageCount: inspection.pageCount,
  }
}

export function findFontForRun(fonts, run) {
  if (!run) return null
  return (fonts || []).find((font) => (
    font.fontObjectNumber === run.fontObjectNumber &&
    font.resourceName === run.fontResource &&
    font.pageIndices?.includes(run.pageIndex)
  )) || run.fontMetadata || null
}
