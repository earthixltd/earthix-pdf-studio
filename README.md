# Earthix PDF Studio

A browser-first PDF editor built with React, Vite, Tailwind CSS, PDF.js and PDFium WebAssembly. The architecture uses open-source foundations and Earthix-developed modules. No Python runtime or paid commercial PDF SDK is required.

## Requirements

- Node.js 20.19+ or 22.12+
- npm 10+

## Development

From the repository root:

```bash
npm install
npm run dev
```

The root post-install hook copies version-matched PDF.js and PDFium worker/WASM assets into `frontend/public`. All runtime PDF assets are self-hosted.

## Validation

```bash
npm test
npm run test:engine
npm run test:viewer
npm run test:document-core
npm run lint
npm run build
```

## Development progress

- STEP 1: Project setup, npm workspaces and project architecture.
- STEP 2: Global design system and design tokens.
- STEP 3: Reusable accessible UI primitives.
- STEP 4: PDF.js/PDFium WebAssembly engine foundation, workers, asset preparation, sessions, fallback, memory conversion and lifecycle cleanup.
- STEP 5: Viewer workspace with PDF import, page rendering, lazy thumbnails, page navigation, zoom/fit controls, selectable text layer and document-wide text search.
- STEP 6: Document Core with immutable source bytes, working document state, stable page/object registries, command history, atomic transactions, reliable dirty-state tracking, IndexedDB checkpoints and recovery service.
- STEP 7: Native text/font inspection, glyph compatibility checks, deterministic PDF.js text-span selection, Font Inspector UI and undoable native text replacement commands.

## Viewer behavior and limitations

- PDF.js renders the page and supplies the selectable text layer. PDFium renders pages when its WASM worker is available; PDF.js remains the viewer fallback if PDFium initialization or rendering fails.
- The preview canvas is only a display surface. The source PDF bytes remain the export source; viewing does not flatten or rewrite the document.
- Search scans text extracted by PDF.js, including matches spanning adjacent text runs when their geometry indicates a word gap. Search is not OCR: image-only scanned pages require the OCR phase.
- Text selection is for copying/reading. Existing-object text replacement is a separate editing feature and only supports PDF structures accepted by the native text editor.
- Search highlights whole text runs intersecting a match, rather than applying character-level annotation to every glyph.

## Document Core behavior

- `DocumentCore` owns original/working PDF bytes, page and object registries, command history, savepoint identity, autosave status and export validation.
- `core.execute(command)` commits a reversible command. `core.transact(label, callback)` groups commands into one atomic Undo/Redo item.
- Dirty state uses unique state tokens, not only a numeric history cursor. Branching after Undo cannot accidentally match an earlier saved cursor.
- Autosave checkpoints use schema v2 and preserve the original source bytes independently of the working bytes. Schema v1 checkpoints remain backward-compatible.
- `DocumentRecoveryService` lists metadata-only recovery candidates, restores a checkpoint or discards it. Recovery restores content but starts a fresh Undo/Redo history because executable command instances are not persisted.
- IndexedDB checkpoints are local to the current browser profile; they are not cloud backups.

## Native text editing

See `docs/architecture/NATIVE-TEXT-EDITING.md` for the editing pipeline, font checks and supported PDF structures. Native replacement is conservative but now supports classic cross-reference tables, cross-reference streams (including FlateDecode with PNG predictors), compressed object streams, direct page content streams, and both WinAnsi simple fonts and supported Identity-H fonts with readable ToUnicode maps. Embedded subset fonts are limited to glyphs actually present in the subset. Unsupported or ambiguous text is rejected without adding an overlay. Paragraph reflow and text inside nested Form XObjects are not yet supported.

## Testing

The Node.js regression suite currently contains 102 tests across engine lifecycle, PDFium fallback, memory conversion, viewer search/zoom, Document Core commands, font capability checks, native text-span matching, xref streams, PNG predictors, compressed object streams and incremental native replacement. Run `npm test`.

The full Vite production build and real browser/WASM execution require installing npm dependencies locally. They were not verified during this build session because the npm registry connection previously timed out.

## Privacy

PDF viewing, search and the current native text replacement path run locally in the browser. This project does not upload opened PDF files to a remote service.

## XRef-stream compatibility update

This release includes support for the uploaded linearized PDF 1.5 structure that previously produced `unsupported xref stream format` in older Earthix builds. The native inspection path handles:

- A linearized first-section `startxref 0` marker by resolving the final valid `startxref` entry.
- Multiple cross-reference revisions connected through `/Prev`.
- Cross-reference streams with variable `/W` field widths, including `[1 3 1]`.
- Sparse `/Index` ranges.
- Flate-compressed xref streams with PNG predictor rows.
- Compressed indirect objects stored in `/ObjStm` streams.
- Mixed `WinAnsiEncoding` and supported `Identity-H` font resources.

### Diagnose a PDF before editing

From the project root, run:

```bash
npm run diagnose:pdf -- "C:\\path\\to\\document.pdf"
```

The diagnostic prints the PDF version, linearization marker, `startxref` offsets, xref/object-stream counts, page count, font encodings and supported native text-run count. It does not modify or upload the supplied PDF.

The uploaded `What-is-a-computer-Network(1).pdf` was inspected with this release: 21 pages, 2 xref-stream objects, 25 object-stream objects, 10 font resources and 1,558 replaceable native text runs. A test replacement was exported and reopened; the replaced text remained searchable. The source PDF itself is intentionally not included in this project archive.

If the same error persists after updating, fully extract this ZIP into a **new folder** rather than merging files over an older project, then run `npm install` and restart the Vite server. Old dev-server processes can keep serving stale source.

### Compatibility boundary

This update addresses the supplied linearized PDF 1.5/xref-stream case. It does not claim every PDF variant is editable. Password-protected files must be unlocked; unsupported stream filters, unusual font encodings, nested Form XObjects, malformed files and missing subset glyphs can still require additional support. PDFs that fail native inspection remain viewable through PDF.js when PDF.js itself accepts them, but native text editing must not fall back to duplicate overlays.

## STEP 8 - Workspace navigation and page management

The sidebar now contains only the `WORKSPACE` group. The `YOUR FILES` group and Cloud card are removed.

- **Home:** local dashboard, open PDF, merge PDFs, and recent files from the current browser session.
- **Edit PDF:** returns to the PDF viewer and native text tools.
- **Merge PDF:** select at least two PDFs; the merged result opens in the editor.
- **Split PDF:** select a continuous start/end page range and export it as a new PDF.
- **Organize Pages:** drag/drop or move pages, rotate, delete, append a blank page, then apply the plan.
- **Optimize PDF:** exports an optimized copy using pdf-lib object streams.

Page organizer implementation lives in `frontend/src/features/page-manager/`. The page plan is validated before export and committed to Document Core as a single undoable PDF-bytes command. PDF catalog-level structures that pdf-lib does not preserve (for example some forms, outlines, attachments, and certain annotation data) may not survive page-copy operations; this tool should be used on a copy when those structures are important.

Run `npm test` to execute the regression suite. The STEP 8 suite includes page plan creation, reorder, rotation, deletion guard, blank page insertion, empty-plan rejection, and removal detection.

## STEP 8 - Workspace navigation and page management

The sidebar now contains only the `WORKSPACE` group. The `YOUR FILES` group and Cloud card are removed.

- **Home:** local dashboard, open PDF, merge PDFs, and recent files from the current browser session.
- **Edit PDF:** returns to the PDF viewer and native text tools.
- **Merge PDF:** select at least two PDFs; the merged result opens in the editor.
- **Split PDF:** select a continuous start/end page range and export it as a new PDF.
- **Organize Pages:** drag/drop or move pages, rotate, delete, append a blank page, then apply the plan.
- **Optimize PDF:** exports an optimized copy using pdf-lib object streams.

Page organizer implementation lives in `frontend/src/features/page-manager/`. The page plan is validated before export and committed to Document Core as a single undoable PDF-bytes command. PDF catalog-level structures that pdf-lib does not preserve (for example some forms, outlines, attachments, and certain annotation data) may not survive page-copy operations; this tool should be used on a copy when those structures are important.

Run `npm test` to execute the regression suite. The STEP 8 suite includes page plan creation, reorder, rotation, deletion guard, blank page insertion, empty-plan rejection, and removal detection.
