import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { inspectNativePdfText, replaceNativePdfText } from '../src/services/nativePdfTextEditor.js'

const [, , inputPath, searchText, replacementText, outputPath] = process.argv

if (!inputPath || !searchText || !replacementText) {
  console.error('Usage: node scripts/verify-native-pdf-edit.js <input.pdf> "<exact original text>" "<replacement text>" [output.pdf]')
  process.exit(1)
}

try {
  const inputBytes = new Uint8Array(await readFile(inputPath))
  const inspection = await inspectNativePdfText(inputBytes)
  const selectedRun = inspection.runs.find((run) => run.originalText === searchText)

  if (!selectedRun) {
    throw new Error(`No supported native text run exactly matches: ${searchText}`)
  }

  const result = await replaceNativePdfText(inputBytes, selectedRun, replacementText)
  const nextInspection = await inspectNativePdfText(result.bytes)
  const verifiedRun = nextInspection.runs.find((run) =>
    run.pageIndex === selectedRun.pageIndex &&
    run.streamObjectNumber === selectedRun.streamObjectNumber &&
    run.start === selectedRun.start &&
    run.originalText === replacementText,
  )

  if (!verifiedRun) throw new Error('The exported PDF did not pass native text replacement verification.')

  const resolvedOutput = outputPath || path.join(
    path.dirname(inputPath),
    `${path.basename(inputPath, path.extname(inputPath))}.native-edited.pdf`,
  )
  await writeFile(resolvedOutput, result.bytes)

  console.log('Native PDF text replacement verified.')
  console.log(`Pages: ${nextInspection.pageCount}`)
  console.log(`Operator: ${selectedRun.tokenType}`)
  console.log(`Font resource: ${selectedRun.fontResource}`)
  console.log(`Original: ${selectedRun.originalText}`)
  console.log(`Replacement: ${replacementText}`)
  console.log(`Output: ${resolvedOutput}`)
} catch (error) {
  console.error(`Native PDF edit test failed: ${error.message}`)
  process.exitCode = 1
}
