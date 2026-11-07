# Changelog

## 0.2.0 — In-place text editing that keeps the original look

- Click text on the page and type: an in-place editor opens over the original text (same font, size, weight, style, colour); Enter saves, Esc cancels. The side-panel replace form is replaced by a block list that opens the same editor.
- Edits rewrite the original content-stream operators — no overlay, no duplicate text. Overprinted copies (fake bold / shadow) are updated together.
- Words after the edit on the same line move by exactly the width change, so longer text no longer overlaps and shorter text leaves no gap. Table cells and other columns stay put (painted borders are detected); overflow past a border or margin is reported.
- Characters missing from an embedded subset font are drawn with the same font installed on the computer (Chrome/Edge Local Font Access), then a similar installed font, then a standard PDF font. Fallback fonts are subset and embedded with a ToUnicode map, so the text stays searchable.
- New PDF engine modules: lossless object parser/serializer, tolerant stream filters (Flate, LZW, ASCII85, ASCIIHex, RunLength), broken-xref repair, inherited page resources, full graphics-state interpreter (q/Q, cm, colours, Form XObjects, inline images), multi-object incremental writer.
- Font decoding now covers Type1/TrueType/Type3 base encodings with Differences and glyph names, standard-14 metrics, and embedded-font cmaps when ToUnicode is missing. Hindi/complex-script and unmappable text is locked with a clear reason instead of being corrupted.
- 12 new regression tests (124 total).

## Step 7 compatibility fix — XRef streams and simple fonts

- Added PDF cross-reference stream parsing, including `/W`, `/Index`, `/Prev`, `/XRefStm`, FlateDecode and PNG predictor rows.
- Added compressed object stream (`/ObjStm`) lookup for type-2 xref entries.
- Added incremental revision writing for files whose latest xref section is a stream, with a sanitized classic trailer and `/Prev` chaining.
- Added WinAnsi/Windows-1252 byte-to-Unicode mapping and simple-font `/Widths` table inspection.
- Embedded subset-font replacements are restricted to available glyph codes; unsupported glyphs are rejected without an overlay.
- Added regression tests for xref streams, PNG predictors, compressed objects, WinAnsi replacement and reopened incremental output.
- Tested the user-provided 21-page PDF: parser detects 1,558 native text runs; WinAnsi Tj and subset-font TJ replacements exported, reopened and remained searchable. The original file is not bundled.
- Full regression suite: 102/102 Node tests passed. Browser/WASM and Vite production build remain unverified because npm dependencies could not be installed in this environment.

## Step 7 — Native Text Editing and Font Inspection

- Added font resource metadata for base font names, descriptors, subtype, encoding, embedding, subset status, ToUnicode mapping, glyph coverage, font flags and width metrics.
- Added selected text-run metadata for size, character/word spacing, horizontal scale, rise, rendering mode, position and supported device color operators.
- Added replacement glyph checks; missing glyphs and unsupported encodings are blocked without overlay fallback.
- Added deterministic click-to-native-run matching with exact, unique partial and ambiguous-result handling.
- Added Font Inspector UI and connected it to the native text replacement panel.
- Added `ReplaceNativeTextRunCommand` integration so native PDF replacement is an undoable Document Core operation.
- Re-opened and re-inspected the resulting PDF before updating the visible viewer session.
- Added tests for clicked-text matching, including ambiguous and unsupported matches.
- Verified `Tj` and long `TJ` replacement on the user-provided two-page test PDF, including searchable output, old-text removal, Undo/Redo and page-count validation. The source PDF was not bundled.

## Step 6 — Document Core

- Hardened command execution, Undo and Redo with compensation when a command fails part-way through.
- Made multi-command transactions atomic: intermediate events and autosave requests are buffered until commit; failed transactions roll back in reverse order.
- Replaced numeric-history-index dirty tracking with unique state identity tokens, fixing false-clean state after branching from an Undo point.
- Added safe command-history metadata for UI consumers.
- Upgraded autosave checkpoints to schema v2, preserving immutable source bytes separately from working bytes and retaining the original filename.
- Kept schema v1 checkpoint recovery backward-compatible.
- Added `DocumentRecoveryService` for listing, recovering and discarding local recovery candidates.
- Hardened page and object registries with stable page IDs, validation, reordering, bounds checks and atomic restore.
- Preserved page/object registry instance identity when document content is restored.
- Added regression tests for failed command compensation, atomic transactions, dirty-state branching, recovery, object/page validation and autosave transaction isolation.

## Step 5 — PDF Viewer

- Integrated PDF.js rendering and text selection with the PDFium-backed engine session.
- Added page navigation, thumbnails, zoom controls, document search and search highlights.

## XRef compatibility hotfix

- Added a Node-based `diagnose:pdf` command for local PDF compatibility reports.
- Added regression coverage for five-byte `/W [1 3 1]` xref stream entries.
- Added regression coverage for a leading `startxref 0` marker before the final xref offset.
- Verified the supplied linearized PDF 1.5 file with two xref-stream objects, `/Prev` chain, and compressed object streams.
- Verified 21-page native text inspection and a searchable native text replacement after export/reopen.
- The source PDF is not bundled in the project.

## 0.1.2 - STEP 8 Workspace and Page Manager

- Removed the entire `YOUR FILES` sidebar group and the Earthix Cloud promotional card from the sidebar.
- Made the `WORKSPACE` navigation stateful: Home, Edit PDF, Split PDF, Organize Pages, Merge PDF, and Optimize PDF now route to their corresponding workflows.
- Added a Home dashboard with local-session recent files and quick actions to open or merge PDFs.
- Reworked Merge PDF so two or more selected PDFs can be merged without first opening a document.
- Replaced browser prompt-based splitting with a page-range workspace and direct PDF export.
- Added a page organizer with drag-and-drop reorder, move up/down, rotate left/right, delete, and blank-page insertion.
- Added a page-plan builder that applies the final page sequence through pdf-lib and commits the result as one Document Core history command.
- Added page-plan validation and regression tests, including protection against deleting the final page and detection of deleting the last source page.
- Kept the PDF editor toolbar visible only in the Edit PDF workspace to prevent unrelated controls appearing on Home and tool screens.

### Verification

- 112 Node.js tests pass, including 7 new page-manager tests.
- App.jsx and WorkspacePanels.jsx JSX syntax transpilation checks pass using the installed TypeScript compiler.
- Full Vite build was not run because dependencies are not installed in this environment and npm offline cache does not contain the pinned PDFium package.

## 0.1.2 - STEP 8 Workspace and Page Manager

- Removed the entire `YOUR FILES` sidebar group and the Earthix Cloud promotional card from the sidebar.
- Made the `WORKSPACE` navigation stateful: Home, Edit PDF, Split PDF, Organize Pages, Merge PDF, and Optimize PDF now route to their corresponding workflows.
- Added a Home dashboard with local-session recent files and quick actions to open or merge PDFs.
- Reworked Merge PDF so two or more selected PDFs can be merged without first opening a document.
- Replaced browser prompt-based splitting with a page-range workspace and direct PDF export.
- Added a page organizer with drag-and-drop reorder, move up/down, rotate left/right, delete, and blank-page insertion.
- Added a page-plan builder that applies the final page sequence through pdf-lib and commits the result as one Document Core history command.
- Added page-plan validation and regression tests, including protection against deleting the final page and detection of deleting the last source page.
- Kept the PDF editor toolbar visible only in the Edit PDF workspace to prevent unrelated controls appearing on Home and tool screens.

### Verification

- 112 Node.js tests pass, including 7 new page-manager tests.
- App.jsx and WorkspacePanels.jsx JSX syntax transpilation checks pass using the installed TypeScript compiler.
- Full Vite build was not run because dependencies are not installed in this environment and npm offline cache does not contain the pinned PDFium package.
