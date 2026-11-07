import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { inspectNativePdfText } from '../src/services/nativePdfTextEditor.js'

const inputPath = process.argv[2]

if (!inputPath) {
  console.error('Usage: node frontend/scripts/diagnose-pdf-compatibility.js <path-to-pdf>')
  process.exit(1)
}

const resolvedPath = path.resolve(process.cwd(), inputPath)

try {
  const bytes = new Uint8Array(await readFile(resolvedPath))
  const source = Buffer.from(bytes).toString('latin1')
  const version = source.match(/^%PDF-(\d+\.\d+)/)?.[1] || 'unknown'
  const startXref = [...source.matchAll(/startxref\s+(\d+)\s+%%EOF/g)].map((match) => Number(match[1]))
  const xrefStreamObjects = [...source.matchAll(/\/Type\s*\/XRef\b/g)].length
  const objectStreamObjects = [...source.matchAll(/\/Type\s*\/ObjStm\b/g)].length
  const linearized = /\/Linearized\s+1\b/.test(source.slice(0, Math.min(source.length, 4096)))

  const inspection = await inspectNativePdfText(bytes)
  const encodings = [...new Set(inspection.fonts.map((font) => font.encoding))].sort()
  const nativeRuns = inspection.runs.filter((run) => run.fontMetadata?.canNativeReplace)

  console.log(JSON.stringify({
    file: path.basename(resolvedPath),
    sizeBytes: bytes.byteLength,
    pdfVersion: version,
    linearized,
    startXrefOffsets: startXref,
    xrefStreamObjects,
    objectStreamObjects,
    pages: inspection.pageCount,
    fonts: inspection.fonts.length,
    fontEncodings: encodings,
    nativeTextRuns: inspection.runs.length,
    replaceableTextRuns: nativeRuns.length,
    inspection: 'passed',
  }, null, 2))
} catch (error) {
  console.error(JSON.stringify({
    file: path.basename(resolvedPath),
    inspection: 'failed',
    error: error?.message || String(error),
  }, null, 2))
  process.exitCode = 2
}
