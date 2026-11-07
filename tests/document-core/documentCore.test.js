import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DocumentCore,
  MemoryCheckpointStorage,
  RemovePageObjectCommand,
  ReplacePdfBytesCommand,
  SetPageObjectCommand,
  validateDocumentForExport,
} from '../../frontend/src/engine/document-core/index.js'

const sourceBytes = new TextEncoder().encode('%PDF-1.7\nsource-document\n%%EOF')
const editedBytes = new TextEncoder().encode('%PDF-1.7\nedited-document\n%%EOF')
const mergedBytes = new TextEncoder().encode('%PDF-1.7\nmerged-document\n%%EOF')

function createCore(options = {}) {
  return new DocumentCore({ fileName: 'sample.pdf', bytes: sourceBytes, pageCount: 2, ...options })
}

test('creates isolated original and working document state', async () => {
  const core = createCore()
  const original = core.getOriginalBytes()
  const working = core.getWorkingBytes()
  assert.deepEqual(original, sourceBytes)
  assert.deepEqual(working, sourceBytes)
  assert.notStrictEqual(original, working)
  assert.equal(core.pageCount, 2)
  assert.equal(core.isDirty, false)
  await core.close()
})

test('page registry keeps stable ids and protects page identity fields', async () => {
  const core = createCore()
  const updated = core.updatePageInfo(0, { width: 595, height: 842, rotation: 90, pageNumber: 99 })
  assert.equal(updated.id, 'page:0')
  assert.equal(updated.pageNumber, 1)
  assert.equal(updated.width, 595)
  assert.equal(updated.rotation, 90)
  assert.equal(core.pages.count, 2)
  assert.throws(() => core.setActivePage(2), { code: 'PAGE_NOT_FOUND' })
  await core.close()
})

test('replacement command updates bytes and supports undo, redo and saved state', async () => {
  const core = createCore()
  await core.execute(new ReplacePdfBytesCommand(editedBytes, { fileName: 'edited.pdf', pageCount: 3 }))
  assert.deepEqual(core.getWorkingBytes(), editedBytes)
  assert.equal(core.fileName, 'edited.pdf')
  assert.equal(core.pageCount, 3)
  assert.equal(core.isDirty, true)
  assert.equal(core.canUndo, true)

  assert.equal(await core.undo(), true)
  assert.deepEqual(core.getWorkingBytes(), sourceBytes)
  assert.equal(core.fileName, 'sample.pdf')
  assert.equal(core.pageCount, 2)
  assert.equal(core.isDirty, false)

  assert.equal(await core.redo(), true)
  assert.deepEqual(core.getWorkingBytes(), editedBytes)
  assert.equal(core.isDirty, true)
  await core.markSaved()
  assert.equal(core.isDirty, false)
  assert.equal(core.canUndo, true)
  await core.close()
})

test('new command after undo truncates abandoned redo branch', async () => {
  const core = createCore()
  await core.execute(new ReplacePdfBytesCommand(editedBytes, { pageCount: 2 }))
  await core.undo()
  await core.execute(new SetPageObjectCommand({ id: 'text-1', pageIndex: 0, type: 'text', text: 'Hello' }))
  assert.equal(core.canRedo, false)
  assert.equal(core.canUndo, true)
  assert.equal(core.objects.get('text-1').text, 'Hello')
  await core.close()
})

test('page-object commands support upsert, update, remove and history', async () => {
  const core = createCore()
  const original = { id: 'object-1', pageIndex: 0, type: 'text', text: 'Original', bounds: { x: 10, y: 20, width: 90, height: 18 } }
  await core.execute(new SetPageObjectCommand(original))
  await core.execute(new SetPageObjectCommand({ ...original, text: 'Updated' }))
  assert.equal(core.objects.get('object-1').text, 'Updated')
  await core.undo()
  assert.equal(core.objects.get('object-1').text, 'Original')
  await core.redo()
  assert.equal(core.objects.get('object-1').text, 'Updated')
  await core.execute(new RemovePageObjectCommand('object-1'))
  assert.equal(core.objects.get('object-1'), null)
  await core.undo()
  assert.equal(core.objects.get('object-1').text, 'Updated')
  await assert.rejects(core.execute(new RemovePageObjectCommand('missing')), /does not exist/)
  await core.close()
})

test('transactions commit as one history step and roll back on failure', async () => {
  const core = createCore()
  await core.transact('Add two objects', async (transaction) => {
    await transaction.execute(new SetPageObjectCommand({ id: 'a', pageIndex: 0, type: 'text', text: 'A' }))
    await transaction.execute(new SetPageObjectCommand({ id: 'b', pageIndex: 1, type: 'image', source: 'local' }))
  })
  assert.equal(core.objects.list().length, 2)
  assert.equal(core.getSnapshot().historyLength, 1)
  await core.undo()
  assert.equal(core.objects.list().length, 0)
  await core.redo()
  assert.equal(core.objects.list().length, 2)
  await core.undo()

  await assert.rejects(core.transact('Fail safely', async (transaction) => {
    await transaction.execute(new SetPageObjectCommand({ id: 'temp', pageIndex: 0, type: 'text', text: 'Temporary' }))
    await transaction.execute({ execute() { throw new Error('simulated command failure') }, undo() {} })
  }), /simulated command failure/)
  assert.equal(core.objects.get('temp'), null)
  assert.equal(core.getSnapshot().historyLength, 1)
  await core.close()
})

test('autosave writes local checkpoint and recovery restores an unsaved document', async () => {
  const storage = new MemoryCheckpointStorage()
  const core = createCore({ checkpointStorage: storage, autosave: true, autosaveDelayMs: 5 })
  await core.execute(new ReplacePdfBytesCommand(editedBytes, { fileName: 'recovered.pdf', pageCount: 2 }))
  await core.flushCheckpoint()
  const checkpoint = await storage.load(core.documentId)
  assert.ok(checkpoint)
  assert.deepEqual(checkpoint.bytes, editedBytes)
  assert.equal(checkpoint.fileName, 'recovered.pdf')

  const recovered = DocumentCore.recoverCheckpoint(checkpoint)
  assert.equal(recovered.isDirty, true)
  assert.equal(recovered.getSnapshot().recoveredUnsaved, true)
  assert.deepEqual(recovered.getWorkingBytes(), editedBytes)
  await recovered.markSaved()
  assert.equal(recovered.isDirty, false)
  await recovered.close()
  await core.close()
})

test('autosave flush does not lose a change made while a write is in flight', async () => {
  let releaseFirstSave
  const saved = []
  const storage = {
    async save(checkpoint) {
      if (!saved.length) await new Promise((resolve) => { releaseFirstSave = resolve })
      saved.push(checkpoint)
      return checkpoint.documentId
    },
    async delete() {},
  }
  const core = createCore({ checkpointStorage: storage, autosave: true, autosaveDelayMs: 2 })
  await core.execute(new ReplacePdfBytesCommand(editedBytes, { pageCount: 2 }))
  const flushPromise = core.flushCheckpoint()
  await new Promise((resolve) => setImmediate(resolve))
  await core.execute(new ReplacePdfBytesCommand(mergedBytes, { pageCount: 2 }))
  releaseFirstSave()
  await flushPromise
  assert.equal(saved.length, 2)
  assert.deepEqual(saved.at(-1).bytes, mergedBytes)
  await core.close()
})

test('checkpoint recovery rejects invalid or unsupported records', () => {
  assert.throws(() => DocumentCore.recoverCheckpoint({ schemaVersion: 3, bytes: sourceBytes, pageCount: 1 }), { code: 'INVALID_DOCUMENT_CHECKPOINT' })
  assert.throws(() => DocumentCore.recoverCheckpoint({ schemaVersion: 1, bytes: 'not bytes', pageCount: 1 }), { code: 'INVALID_DOCUMENT_CHECKPOINT' })
})

test('autosave is not silently enabled without a configured provider', async () => {
  const core = createCore({ autosave: true })
  await core.execute(new ReplacePdfBytesCommand(editedBytes, { pageCount: 2 }))
  assert.equal(core.autosaveStatus, 'idle')
  await core.close()
})

test('export validation checks PDF bytes, page count and file name', () => {
  const result = validateDocumentForExport({ bytes: editedBytes, pageCount: 2, expectedPageCount: 2, fileName: 'result.pdf' })
  assert.deepEqual(result.bytes, editedBytes)
  assert.notStrictEqual(result.bytes, editedBytes)
  assert.equal(result.fileName, 'result.pdf')
  assert.throws(() => validateDocumentForExport({ bytes: new Uint8Array([1, 2]), pageCount: 1 }), { code: 'INVALID_EXPORT_BYTES' })
  assert.throws(() => validateDocumentForExport({ bytes: editedBytes, pageCount: 2, expectedPageCount: 1 }), { code: 'EXPORT_PAGE_COUNT_MISMATCH' })
  assert.throws(() => validateDocumentForExport({ bytes: editedBytes, pageCount: 0 }), { code: 'INVALID_EXPORT_PAGE_COUNT' })
})

test('listeners receive snapshots and can unsubscribe', async () => {
  const core = createCore()
  const events = []
  const unsubscribe = core.subscribe((snapshot, event) => events.push({ snapshot, event }))
  await core.execute(new ReplacePdfBytesCommand(editedBytes, { pageCount: 2 }))
  unsubscribe()
  core.setActivePage(1)
  assert.ok(events.some(({ snapshot }) => snapshot.isDirty))
  assert.equal(events.some(({ event }) => event.type === 'navigation'), false)
  await core.close()
})
