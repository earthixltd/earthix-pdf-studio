# Changelog

## 0.3.0 — Full editing toolkit and a new responsive design

- New tools: Select, Edit PDF, Add text, Image, Highlight (also underline and strikethrough), Draw, Shapes (rectangle, ellipse, line, arrow), Comment, Sign and Whiteout, each with a keyboard shortcut.
- Every added item can be moved, resized, rotated, duplicated, reordered and deleted, with undo/redo. A context-aware Properties panel sets font, size, colour, bold/italic/underline/strikethrough, alignment, line spacing, background, outline, fill, line width, opacity, rotation and exact position.
- Existing PDF text can now be restyled (font family, size, colour, bold, italic) inside the PDF; text after it on the same line moves to fit. Existing page images can be moved, resized, rotated, replaced, faded or deleted.
- Export writes added text, images, shapes and drawings as normal page content (searchable, visible in every viewer) and highlights/comments as standard PDF annotations. An /EarthixLayer keeps them adjustable when the file is reopened in Earthix; "Download flattened PDF" merges them permanently. Split, Organize and Optimize keep added items.
- Signatures can be drawn, typed or uploaded and are remembered on this device.
- New Deep Blue design with light and dark themes, Inter typography, slim navigation rail, Pages/Search/Items panel, and layouts for laptops, tablets (drawers) and phones (bottom tool dock and properties sheet, touch-friendly handles).
- **Save** writes the changes straight into the opened PDF file (Chrome/Edge; other browsers download it, or ask where to save). **Export** still downloads a copy, and the menu has the flattened copy and Print. Ctrl+S saves.
- "Optimize" is now **Compress** (download a smaller copy to share).
- Phones: the properties sheet opens as a small bar so the page stays usable while editing; tap it to show all options. The page counter no longer wraps, tool hints wrap, and messages appear at the top.
- Text boxes in Hindi and other complex scripts are shaped correctly with an installed font (fontkit now gets `regenerator-runtime`). Touch drags are more robust.
- All lint errors fixed (including the older ones in CommandManager and the page planner).
- **Existing Hindi text can now be edited.** Text read in visual glyph order is shown in typing order, and edits are redrawn with an installed font that has the same script (exact match when the PDF's font, e.g. Nirmala UI, is installed). Letters that a PDF left unlabelled (common in Chrome/Edge prints) are read back from the same installed font after font access is allowed. Arabic, Hebrew and Thai stay locked.
- Fixed the PDFium renderer failing to start ("expected magic word … found <!do"): the worker was fetching `[object Object]` instead of the wasm file.
- **Refresh keeps your work.** The open PDF, every edit, added items, page, zoom and scroll position are kept in this browser and come back after a refresh or restart. Undo history starts fresh after a refresh. The new × on the file name closes the PDF and clears it from the browser.
- **Much faster opening.** Pages are drawn by PDFium straight away instead of PDF.js first and PDFium again; unrelated app updates no longer redraw the page; thumbnails and text analysis wait for the first page; PDF.js reuses one worker; the renderers load before a file is chosen.
- New look: Earthix logo, teal colour, light theme only, no shadows.
- Removed things that added nothing: dark mode, the document info and shortcuts panels, font details, Home filler cards, repeating tool hints (now shown once), unused components and assets.
- **Fixed pages sometimes showing garbled, blank, recoloured or missing content** after opening, editing or saving: the PDFium renderer freed the PDF's memory right after loading while it still read from it. The buffer now lives until the document closes (with a runtime regression test). Added content streams also start on a new line so every viewer separates them correctly.
- **Edit text inside pictures.** Select an image and choose "Edit text": the text is read on this device (OCR for English and Hindi, no upload), each line gets a box, and tapping one lets you retype it. The old letters are painted over with the surrounding background, and the new text keeps the measured colour, weight, size and baseline. Clearing the text removes it from the picture; deleting the edited text brings the original back.
- Pinch and Ctrl+scroll now zoom the PDF only, so selection handles keep their size; thin items show fewer handles so they no longer pile up.
- Friendlier, shorter messages everywhere (toasts, warnings, hints and panel notes).
- New in-app "sweet" popups replace the browser's plain boxes: PDF password, first save into a file, reading Hindi with your fonts, flattened download and deleting an original image. The browser's own permission check for saving appears only once per file.
- Fixed the custom colour picker (it reset before the colour could be applied, e.g. for Whiteout).
- Cleaner welcome card: the tool list now sits under the heading; the page bar is hidden until a PDF is open.
- `npm run dev:phone` / `START_ON_PHONE.bat` serve the editor on the local Wi-Fi for testing on a phone.
- **Every font keeps its look.** While typing, the text now shows in the PDF's own font for all embedded types (TrueType, CFF, Type 1, CID). A letter the font doesn't have borrows the closest font on its own; the rest of the line stays as it was.
- **Weight control.** A Weight dropdown (Thin to Black) lists the weights a font really has on this computer, for PDF text, new text and added text boxes. Fallbacks now pick the nearest weight. Bold or italic on a font with no such style leaves the text unchanged instead of swapping the font.
- Fixed large lines failing to save when a small number sat just before them.
- **Comments** save by themselves while you type. A comment stays an icon in its chosen colour, and clicking it shows the message. Exported comments carry only your words, with no author name. Empty comments add nothing to the PDF.
- **Font library.** About 2,000 free fonts are now used automatically: a PDF's font with the same name is matched exactly, and for any other font the closest one is picked by comparing the shapes of the letters. Fonts download only when needed; only the font's name goes over the internet.
- **Upload a font** from the Font list (.ttf or .otf). Added fonts are remembered in this browser and used whenever a PDF needs them.
- **Free fonts in the Font list:** Abril Fatface, Antic Didone, Bebas Neue, Bodoni Moda, Cinzel, Cormorant Garamond, Josefin Sans, League Spartan, Libre Bodoni, Montserrat, Oswald, Playfair Display, Prata and Tenor Sans, for PDF text and text boxes.
- Bold, italic or a weight a font doesn't have now uses the closest-looking font, with a short message, instead of being refused.
- Faster: the browser's font permission popup no longer holds up an edit, slow font downloads can't stall one, and `START_EARTHIX_PDF_STUDIO.bat` now runs the built app instead of development mode.
- Words that design tools draw several times over (Canva effects) now edit as one line, and every copy changes together.
- **Recent files** on Home now lists every PDF opened here and survives a refresh; each entry can be reopened or removed.
- Fixed the main button in popups being invisible until hovered, and selection handles are now teal so they show on any background.
- Fixed Highlight and text selection jumping across the page when the pointer passed over blank space.
- Fixed added text disappearing when you clicked elsewhere on the page.
- Home now fills the whole window, the logo is smaller, and the sidebar's Open is now Upload.
- New engine modules in `engine/page-objects/` (page geometry, text layout, image codecs, object writer and reader) and 19 new tests, with 8 tests for removed code dropped (165 total).

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
