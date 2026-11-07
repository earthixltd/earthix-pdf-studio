# Document Core module

See [`docs/architecture/DOCUMENT-CORE.md`](../../../../docs/architecture/DOCUMENT-CORE.md) for the full architecture and command contract.

Public entry point: `index.js`.

Core API:

- `createDocumentCore(options)` / `new DocumentCore(options)`
- `core.execute(command)`
- `core.transact(label, callback)`
- `core.undo()` / `core.redo()`
- `core.getSnapshot()` / `core.getHistory()` / `core.subscribe(listener)`
- `core.createCheckpoint()` / `core.flushCheckpoint()`
- `core.validateForExport(options)` / `core.markSaved()` / `core.close()`
- `createDocumentRecoveryService({ storage })`

The core does not itself rewrite PDF text operators. Future native PDF commands must call the appropriate engine adapter, validate the produced PDF bytes, and then commit the resulting bytes through a reversible document command.
