import test from 'node:test'
import assert from 'node:assert/strict'
import { createDocumentCore } from '../../frontend/src/engine/document-core/createDocumentCore.js'
import { ReplaceNativeTextRunCommand } from '../../frontend/src/engine/document-core/commands/ReplaceNativeTextRunCommand.js'

function createPdfBytes(label = 'original') {
  return new TextEncoder().encode('%PDF-1.4\n%' + label + '\n%%EOF\n')
}

function createCore(bytes = createPdfBytes()) {
  return createDocumentCore({
    fileName: 'test.pdf',
    bytes,
    originalBytes: bytes,
    pageCount: 2,
    autosave: false,
  })
}

const run = {
  key: '0:17:120:142',
  pageIndex: 0,
  pageNumber: 1,
  originalText: 'Original',
  fontResource: 'F1',
  fontObjectNumber: 2,
}

test('native text command applies verified replacement as one undoable document command', async () => {
  const initialBytes = createPdfBytes('original')
  const core = createCore(initialBytes)
  const replaceOperation = async (bytes, selectedRun, replacementText) => ({
    bytes: new Uint8Array([...bytes, ...new TextEncoder().encode('%' + replacementText)]),
    run: { ...selectedRun, originalText: replacementText, key: selectedRun.key },
    originalText: selectedRun.originalText,
    replacementText,
  })
  const command = new ReplaceNativeTextRunCommand(run, 'Replacement', { replaceOperation })

  await core.execute(command)
  assert.equal(core.isDirty, true)
  assert.equal(core.canUndo, true)
  assert.equal(core.getSnapshot().history.at(-1).label, 'Replace original PDF text')
  assert.match(new TextDecoder().decode(core.getWorkingBytes()), /Replacement/)
  assert.match(command.getResult().replacementText, /Replacement/)

  await core.undo()
  assert.deepEqual(core.getWorkingBytes(), initialBytes)
  assert.equal(core.canRedo, true)

  await core.redo()
  assert.match(new TextDecoder().decode(core.getWorkingBytes()), /Replacement/)
  await core.close({ flushAutosave: false })
})

test('native text command failure leaves the original document untouched', async () => {
  const initialBytes = createPdfBytes('unchanged')
  const core = createCore(initialBytes)
  const command = new ReplaceNativeTextRunCommand(run, 'Replacement', {
    replaceOperation: async () => { throw new Error('Unsupported embedded glyph.') },
  })

  await assert.rejects(core.execute(command), /Unsupported embedded glyph/)
  assert.deepEqual(core.getWorkingBytes(), initialBytes)
  assert.equal(core.isDirty, false)
  assert.equal(core.canUndo, false)
  await core.close({ flushAutosave: false })
})

test('native text command does not mutate caller-owned run metadata', async () => {
  const core = createCore()
  const originalRun = structuredClone(run)
  const command = new ReplaceNativeTextRunCommand(run, 'Replacement', {
    replaceOperation: async (bytes, selectedRun, replacementText) => ({
      bytes: new Uint8Array([...bytes, 0x20]),
      run: { ...selectedRun, originalText: replacementText },
      originalText: selectedRun.originalText,
      replacementText,
    }),
  })

  await core.execute(command)
  assert.deepEqual(run, originalRun)
  await core.close({ flushAutosave: false })
})
