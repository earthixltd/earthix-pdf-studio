import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DocumentCore,
  DocumentPageRegistry,
  DocumentObjectRegistry,
  DocumentRecoveryService,
  MemoryCheckpointStorage,
  ReplacePdfBytesCommand,
  SetPageObjectCommand,
} from '../../frontend/src/engine/document-core/index.js'

const sourceBytes = new TextEncoder().encode('%PDF-1.7\nsource-state\n%%EOF')
const firstEdit = new TextEncoder().encode('%PDF-1.7\nfirst-edit\n%%EOF')
const secondEdit = new TextEncoder().encode('%PDF-1.7\nsecond-edit\n%%EOF')

function createCore(options = {}) {
  return new DocumentCore({ fileName: 'source.pdf', bytes: sourceBytes, pageCount: 2, ...options })
}

test('savepoint identity remains dirty after creating a new branch at the same history index', async () => {
  const core = createCore()
  await core.execute(new ReplacePdfBytesCommand(firstEdit, { pageCount: 2, label: 'Edit A' }))
  await core.execute(new ReplacePdfBytesCommand(secondEdit, { pageCount: 2, label: 'Edit B' }))
  await core.markSaved()
  assert.equal(core.isDirty, false)

  await core.undo()
  assert.equal(core.isDirty, true)
  await core.execute(new ReplacePdfBytesCommand(firstEdit, { pageCount: 2, label: 'Edit C' }))
  assert.equal(core.getSnapshot().historyIndex, 2)
  assert.equal(core.isDirty, true, 'new branch must not impersonate the saved history state')
  await core.close()
})

test('history exposes labels and applied/undone state without exposing command instances', async () => {
  const core = createCore()
  await core.execute(new SetPageObjectCommand({ id: 'label-test', pageIndex: 0, type: 'text', text: 'A' }, { label: 'Insert heading' }))
  await core.undo()
  const [entry] = core.getHistory()
  assert.equal(entry.label, 'Insert heading')
  assert.equal(entry.status, 'undone')
  assert.equal(entry.isCurrent, false)
  assert.equal(Object.hasOwn(entry, 'command'), false)
  await core.close()
})

test('a successful command publishes one atomic snapshot after its history state is committed', async () => {
  const core = createCore()
  const events = []
  core.subscribe((snapshot, event) => events.push({ snapshot, type: event.type }), { emitCurrent: false })
  await core.execute(new SetPageObjectCommand({ id: 'atomic-1', pageIndex: 0, type: 'text', text: 'A' }))
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'history')
  assert.equal(events[0].snapshot.objectCount, 1)
  assert.equal(events[0].snapshot.historyIndex, 1)
  await core.close()
})

test('a transaction exposes no intermediate states and publishes one committed snapshot', async () => {
  const core = createCore()
  const events = []
  core.subscribe((snapshot, event) => events.push({ snapshot, type: event.type }), { emitCurrent: false })
  await core.transact('Insert two objects', async (transaction) => {
    await transaction.execute(new SetPageObjectCommand({ id: 'tx-a', pageIndex: 0, type: 'text', text: 'A' }))
    await transaction.execute(new SetPageObjectCommand({ id: 'tx-b', pageIndex: 1, type: 'image', source: 'local-image' }))
  })
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'history')
  assert.equal(events[0].snapshot.objectCount, 2)
  assert.equal(events[0].snapshot.historyLength, 1)
  await core.close()
})

test('transaction rollback publishes a rollback event and restores the pre-transaction registry', async () => {
  const core = createCore()
  const events = []
  core.subscribe((snapshot, event) => events.push({ snapshot, type: event.type }), { emitCurrent: false })
  await assert.rejects(core.transact('Fail after partial update', async (transaction) => {
    await transaction.execute(new SetPageObjectCommand({ id: 'tx-partial', pageIndex: 0, type: 'text', text: 'Temporary' }))
    await transaction.execute({
      execute() { throw new Error('failure after starting command') },
      undo() {},
    })
  }), /failure after starting command/)
  assert.equal(core.objects.get('tx-partial'), null)
  assert.equal(core.getSnapshot().historyLength, 0)
  assert.deepEqual(events.map((event) => event.type), ['rollback'])
  await core.close()
})

test('a command that partially mutates and then rejects is rolled back before it leaves the manager', async () => {
  const core = createCore()
  const command = {
    async execute(document) {
      document.objects.upsert({ id: 'partial-object', pageIndex: 0, type: 'text', text: 'Partial' })
      document.notifyContentChange()
      throw new Error('simulated command failure')
    },
    async undo(document) {
      document.objects.remove('partial-object')
      document.notifyContentChange()
    },
  }
  await assert.rejects(core.execute(command), /simulated command failure/)
  assert.equal(core.objects.get('partial-object'), null)
  assert.equal(core.canUndo, false)
  assert.equal(core.isDirty, false)
  await core.close()
})

test('undo failure is compensated and leaves history cursor unchanged', async () => {
  const core = createCore()
  let value = 'initial'
  const command = {
    label: 'Set external value',
    async execute() { value = 'changed' },
    async undo() { value = 'initial'; throw new Error('undo failed midway') },
  }
  await core.execute(command)
  const stateId = core.currentStateId
  await assert.rejects(core.undo(), /undo failed midway/)
  assert.equal(value, 'changed')
  assert.equal(core.currentStateId, stateId)
  assert.equal(core.canUndo, true)
  await core.close()
})

test('redo failure is compensated and leaves history cursor unchanged', async () => {
  const core = createCore()
  let value = 'initial'
  let failRedo = false
  const command = {
    label: 'Set external value',
    async execute() {
      value = 'changed'
      if (failRedo) throw new Error('redo failed midway')
    },
    async undo() { value = 'initial' },
  }
  await core.execute(command)
  await core.undo()
  failRedo = true
  await assert.rejects(core.redo(), /redo failed midway/)
  assert.equal(value, 'initial')
  assert.equal(core.canRedo, true)
  assert.equal(core.canUndo, false)
  await core.close()
})

test('checkpoint v2 preserves original source bytes separately from working bytes', async () => {
  const storage = new MemoryCheckpointStorage()
  const core = createCore({ checkpointStorage: storage, autosave: true, autosaveDelayMs: 1 })
  await core.execute(new ReplacePdfBytesCommand(firstEdit, { pageCount: 2 }))
  await core.flushCheckpoint()
  const checkpoint = await storage.load(core.documentId)
  assert.equal(checkpoint.schemaVersion, 2)
  assert.deepEqual(checkpoint.originalBytes, sourceBytes)
  assert.deepEqual(checkpoint.bytes, firstEdit)

  const recovered = DocumentCore.recoverCheckpoint(checkpoint, { checkpointStorage: storage, autosave: false })
  assert.deepEqual(recovered.getOriginalBytes(), sourceBytes)
  assert.deepEqual(recovered.getWorkingBytes(), firstEdit)
  assert.equal(recovered.getSnapshot().recoveredUnsaved, true)
  await recovered.close({ flushAutosave: false })
  await core.close()
})

test('legacy checkpoint v1 remains recoverable without an original byte snapshot', async () => {
  const legacy = {
    schemaVersion: 1,
    documentId: 'legacy-document',
    fileName: 'legacy.pdf',
    pageCount: 1,
    bytes: firstEdit,
    currentPageIndex: 0,
    pages: [],
    objects: [],
  }
  const recovered = DocumentCore.recoverCheckpoint(legacy)
  assert.deepEqual(recovered.getOriginalBytes(), firstEdit)
  assert.deepEqual(recovered.getWorkingBytes(), firstEdit)
  await recovered.close()
})

test('recovery service lists metadata, restores a checkpoint and discards it', async () => {
  const storage = new MemoryCheckpointStorage()
  const core = createCore({ checkpointStorage: storage, autosave: true, autosaveDelayMs: 1 })
  await core.execute(new ReplacePdfBytesCommand(firstEdit, { pageCount: 2 }))
  await core.flushCheckpoint()
  const recovery = new DocumentRecoveryService({ storage, coreOptions: { autosave: false } })
  const [candidate] = await recovery.listRecoverable()
  assert.equal(candidate.documentId, core.documentId)
  assert.equal(candidate.fileName, 'source.pdf')
  assert.equal(candidate.pageCount, 2)
  assert.equal(Object.hasOwn(candidate, 'bytes'), false)

  const recovered = await recovery.recover(core.documentId)
  assert.deepEqual(recovered.getWorkingBytes(), firstEdit)
  await recovered.close({ flushAutosave: false })
  await recovery.discard(core.documentId)
  assert.deepEqual(await recovery.listRecoverable(), [])
  await core.close()
})

test('recovery service rejects missing checkpoint ids', async () => {
  const recovery = new DocumentRecoveryService({ storage: new MemoryCheckpointStorage() })
  await assert.rejects(recovery.recover('missing'), { code: 'RECOVERY_CHECKPOINT_NOT_FOUND' })
  await assert.rejects(recovery.discard(''), { code: 'INVALID_RECOVERY_DOCUMENT_ID' })
})

test('page registry preserves page identity across reordering and restores valid descriptors', () => {
  const pages = new DocumentPageRegistry(3)
  const originalIds = pages.list().map((page) => page.id)
  const reordered = pages.reorder([2, 0, 1])
  assert.deepEqual(reordered.map((page) => page.id), [originalIds[2], originalIds[0], originalIds[1]])
  assert.deepEqual(reordered.map((page) => page.pageNumber), [1, 2, 3])
  assert.equal(pages.indexOf(originalIds[0]), 1)
  assert.throws(() => pages.reorder([0, 0, 1]), { code: 'INVALID_PAGE_ORDER' })
})

test('page registry rejects invalid dimensions and duplicate stable ids without changing current pages', () => {
  const pages = new DocumentPageRegistry(2)
  const before = pages.snapshot()
  assert.throws(() => pages.restore([
    { id: 'same', index: 0, width: 595, height: 842 },
    { id: 'same', index: 1, width: 595, height: 842 },
  ]), { code: 'DUPLICATE_PAGE_ID' })
  assert.deepEqual(pages.snapshot(), before)
  assert.throws(() => pages.updateInfo(0, { width: -1 }), { code: 'INVALID_PAGE_DIMENSIONS' })
})

test('object registry validates object types, bounds, ids and atomic restoration', () => {
  const objects = new DocumentObjectRegistry(2)
  objects.upsert({ id: 'obj-1', pageIndex: 0, type: 'text', text: 'A', bounds: { x: 1, y: 2, width: 20, height: 10 } })
  const before = objects.snapshot()
  assert.throws(() => objects.upsert({ id: 'bad', pageIndex: 9, type: 'text' }), { code: 'INVALID_OBJECT_PAGE' })
  assert.throws(() => objects.upsert({ id: 'bad', pageIndex: 0, type: 'text', bounds: { x: 0, y: 0, width: -1, height: 2 } }), { code: 'INVALID_DOCUMENT_OBJECT_BOUNDS' })
  assert.throws(() => objects.restore([
    { id: 'duplicate', pageIndex: 0, type: 'text' },
    { id: 'duplicate', pageIndex: 1, type: 'image' },
  ], 2), { code: 'DUPLICATE_DOCUMENT_OBJECT_ID' })
  assert.deepEqual(objects.snapshot(), before)
  assert.equal(objects.update('obj-1', { text: 'Updated' }).text, 'Updated')
  assert.equal(objects.count, 1)
})

test('autosave does not persist intermediate states from an open transaction', async () => {
  const saved = []
  const storage = {
    async save(checkpoint) { saved.push(checkpoint); return checkpoint.documentId },
    async load() { return null },
    async delete() {},
    async close() {},
  }
  const core = createCore({ checkpointStorage: storage, autosave: true, autosaveDelayMs: 1 })
  await core.transact('Atomic two-object insert', async (transaction) => {
    await transaction.execute(new SetPageObjectCommand({ id: 'one', pageIndex: 0, type: 'text', text: 'One' }))
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(saved.length, 0, 'autosave must wait until the transaction commits')
    await transaction.execute(new SetPageObjectCommand({ id: 'two', pageIndex: 1, type: 'text', text: 'Two' }))
  })
  await core.flushCheckpoint()
  assert.equal(saved.length, 1)
  assert.equal(saved[0].objects.length, 2)
  await core.close()
})

test('restoring content state keeps public registry instances stable', async () => {
  const core = createCore()
  const pages = core.pages
  const objects = core.objects
  await core.execute(new ReplacePdfBytesCommand(firstEdit, { pageCount: 2 }))
  assert.strictEqual(core.pages, pages)
  assert.strictEqual(core.objects, objects)
  assert.equal(pages.count, 2)
  await core.undo()
  assert.strictEqual(core.pages, pages)
  assert.strictEqual(core.objects, objects)
  await core.close()
})

test('recovered checkpoint retains the immutable source filename and byte snapshot', async () => {
  const core = createCore()
  await core.execute(new ReplacePdfBytesCommand(firstEdit, { fileName: 'edited-name.pdf', pageCount: 2 }))
  const checkpoint = core.createCheckpoint()
  const recovered = DocumentCore.recoverCheckpoint(checkpoint)
  assert.equal(recovered.fileName, 'edited-name.pdf')
  assert.equal(recovered.originalFileName, 'source.pdf')
  assert.deepEqual(recovered.getOriginalBytes(), sourceBytes)
  assert.deepEqual(recovered.getWorkingBytes(), firstEdit)
  await recovered.close()
  await core.close()
})

test('redo returns to the exact saved state token and clears dirty status', async () => {
  const core = createCore()
  await core.execute(new ReplacePdfBytesCommand(firstEdit, { pageCount: 2 }))
  await core.execute(new ReplacePdfBytesCommand(secondEdit, { pageCount: 2 }))
  await core.markSaved()
  const savedStateId = core.currentStateId
  await core.undo()
  assert.equal(core.isDirty, true)
  await core.redo()
  assert.equal(core.currentStateId, savedStateId)
  assert.equal(core.isDirty, false)
  await core.close()
})

test('schema v2 recovery rejects a checkpoint that omits immutable original bytes', () => {
  assert.throws(() => DocumentCore.recoverCheckpoint({
    schemaVersion: 2,
    documentId: 'broken-v2',
    fileName: 'broken.pdf',
    pageCount: 1,
    bytes: firstEdit,
  }), { code: 'INVALID_DOCUMENT_CHECKPOINT' })
})

test('listener failures are reported without interrupting committed document commands', async () => {
  const listenerErrors = []
  const core = createCore({ onListenerError: (error) => listenerErrors.push(error) })
  core.subscribe(() => { throw new Error('subscriber failed') }, { emitCurrent: false })
  await core.execute(new SetPageObjectCommand({ id: 'listener-safe', pageIndex: 0, type: 'text', text: 'Committed' }))
  assert.equal(core.objects.get('listener-safe').text, 'Committed')
  assert.equal(listenerErrors.length, 1)
  assert.equal(core.canUndo, true)
  await core.close()
})
