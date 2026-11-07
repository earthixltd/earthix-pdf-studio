# Earthix Document Core

The Document Core is the single in-memory authority for an open PDF session. The viewer may keep transient UI state (zoom, search query, panel visibility), but document bytes, page metadata, registered editable objects, history, savepoint state and recovery checkpoints belong to the core.

## Responsibilities

- Preserve an immutable source byte snapshot and a separate working PDF byte snapshot.
- Maintain a page registry with stable page IDs, dimensions and rotation metadata.
- Maintain a serializable page-object registry for future native text/image/vector commands.
- Execute reversible commands through one command manager.
- Group multi-command operations into atomic transactions.
- Track dirty state by state identity rather than by the numeric history cursor.
- Autosave recovery checkpoints to IndexedDB when a storage provider is configured.
- Validate exported bytes and expected page count before download.

## State model

`DocumentCore` keeps:

- `originalBytes`: immutable bytes from the imported source document.
- `workingBytes`: the current editable PDF representation.
- `originalFileName`: the imported source name.
- `fileName`: the current output name.
- `pages`: `DocumentPageRegistry`.
- `objects`: `DocumentObjectRegistry`.
- `currentPageIndex`: current navigation position.
- `revision`: increments after committed command history changes.
- `currentStateId` and `savedStateId`: unique state tokens for reliable dirty tracking.

A state token is used instead of comparing `historyIndex` to a saved numeric cursor. This prevents a history-branch bug where a new command after Undo could land on the same numeric cursor as an earlier saved state and be incorrectly reported as clean.

## Commands

A document command implements:

```js
{
  label: 'Human-readable operation',
  async execute(documentCore) {},
  async undo(documentCore) {},
}
```

Commands must be reversible. If `execute()` or `undo()` fails after partially changing state, the command must leave enough information for its inverse operation to restore the prior state. The command manager attempts compensation when an operation fails and keeps the history cursor unchanged unless the operation commits successfully.

Built-in commands:

- `ReplacePdfBytesCommand`: replaces the working PDF byte snapshot and document metadata.
- `SetPageObjectCommand`: inserts or updates a serializable object in the page-object registry.
- `RemovePageObjectCommand`: removes a registered page object and keeps its previous value for Undo.

Commands are intended to be the mutation boundary for future text, image, vector and page-operation modules.

## Atomic transactions

Use `core.transact(label, callback)` to group related commands:

```js
await core.transact('Insert text and background', async (transaction) => {
  await transaction.execute(addBackgroundCommand)
  await transaction.execute(addTextCommand)
})
```

A committed transaction is one Undo/Redo history item and emits one final document snapshot. Intermediate command notifications and autosave requests are buffered until commit. If one command fails, attempted commands are undone in reverse order and one rollback snapshot is published.

## Undo, Redo and dirty state

- `core.undo()` moves to the previous state token.
- `core.redo()` reapplies the next command and its state token.
- `core.getHistory()` returns safe metadata (label, timestamp, applied/undone status), not command instances.
- `core.markSaved()` records the current state token as the savepoint.
- A new command after Undo creates a new unique state token and truncates the old Redo branch. It cannot accidentally match an older saved token.

Navigation changes (such as changing the active page) do not mark the PDF dirty.

## Checkpoints and recovery

Checkpoint schema v2 stores:

- Current working bytes.
- Immutable original bytes and original filename.
- Current filename and page count.
- Active page, page descriptors and registered page objects.
- Revision, history cursor and state token metadata.
- Update timestamp.

Schema v1 checkpoints remain recoverable. Since v1 did not store the immutable source bytes separately, the current checkpoint bytes are used as the recovered original baseline for backward compatibility.

`DocumentRecoveryService` exposes:

- `listRecoverable()`: metadata-only recovery candidates (does not expose the large byte arrays).
- `recover(documentId)`: restores a `DocumentCore` from a checkpoint.
- `discard(documentId)`: removes one checkpoint.
- `discardAll()`: removes all stored checkpoints.

Recovery restores document content and object/page registries, but does not restore executable in-memory command instances. The recovered document is marked unsaved and starts with a fresh Undo/Redo history.

## Export validation

Call `core.validateForExport({ expectedPageCount })` before creating a download. It returns a defensive copy of the working bytes and validates the PDF header, non-empty page count, optional engine page-count agreement and output filename.

Export validation is a structural preflight only. A production export pipeline should additionally reopen the generated file in PDF.js/PDFium and run document-specific integrity checks before download.

## Autosave

Autosave is opt-in and requires a configured checkpoint provider. The web application uses `IndexedDbCheckpointStorage`; tests use `MemoryCheckpointStorage` or deterministic storage doubles. Autosave is debounced and does not persist intermediate transaction states.

Local checkpoints are stored in the current browser profile. They are not cloud backups and are not available on other devices.
