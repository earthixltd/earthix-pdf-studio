> Historical archive: this file documents an earlier implementation. Current architecture and instructions are in the root README and `docs/architecture/` active documents. Do not use this file as the current implementation specification.

# Earthix PDF Studio: native text engine notes

## Architecture

- React + Vite + Tailwind provide the application UI.
- `pdfcanvas` and PDFium WebAssembly handle PDF viewing and non-native text/object tools.
- PDF.js renders the screen preview and page thumbnails.
- `src/services/nativePdfTextEditor.js` inspects and edits supported original PDF text operators directly in the source PDF content stream.
- `pdf-lib` remains available for page/document operations.
- No Python runtime, Python source, Python dependency or Python service is part of the project.

## Why this path is used

The previous UI overlay path could draw replacement text on top of the original glyphs. That did not remove the original text and could create duplicates in the viewer and exported file. The native editor now avoids the PDFCanvas `text-edit` fallback for existing text. It uses the Edit Text inspector to identify an original text run and rewrites the actual `Tj` / `TJ` operand in the PDF page content stream.

## Replacement process

1. Parse the newest classic xref table and its `/Prev` revisions.
2. Resolve the page tree and page content streams.
3. Read the page font resource, Type 0 `Identity-H` font, and `/ToUnicode` CMap.
4. Map replacement Unicode characters to existing 2-byte CIDs. Reject the operation if any character is missing.
5. Calculate glyph advances from the descendant font's `/W` and `/DW` metrics.
6. Replace the original `Tj` / `TJ` operand with a native CID hex string. For `TJ` runs, preserve the original total advance with a final numeric adjustment.
7. Deflate the updated content stream if required, update its direct `/Length`, and append an incremental xref/trailer revision that points back to the preceding revision.
8. Re-parse the output and verify that the new text exists and the selected original run no longer exists before the app accepts it.

The original embedded font resource, font size, colour, text matrix, page artwork and unrelated content are not rasterized or replaced. The original text bytes are removed from the updated page content stream, not covered by another object.

## Compatibility boundary

The current parser is deliberately limited to classical xref tables, unencrypted PDFs, direct stream lengths, plain/FlateDecode streams, accessible page resources, Type 0 Identity-H fonts with ToUnicode maps, and Tj/TJ text operands. It does not claim to support every normal PDF. It does not yet handle xref streams, compressed object streams, inherited page-tree resources, Form XObjects, annotations, AcroForm appearances, other font encodings, missing glyphs, RTL/ligature shaping, vertical writing or paragraph reflow. Unsupported character replacements are rejected rather than substituted with an overlay font.

## Regression verification with the supplied text-based PDF

The supplied 2-page IRCTC PDF was used locally as a temporary test fixture and is not included in this project archive. The following checks passed:

- Replace one `Tj` passenger-name run and one `TJ` paragraph run sequentially in the same document.
- Re-inspect the output: both old strings absent; both replacement strings present.
- `pdfinfo`: output remains a readable, unencrypted, 2-page PDF.
- `pdffonts`: original embedded subset Calibri font remains embedded.
- `pdftotext`: replacement strings remain selectable/searchable; the old strings are absent.
- Raster preview: each edited text appears once, with original font styling and baseline preserved. The `TJ` line advance is preserved using glyph metrics.
- An unsupported Hindi glyph is rejected before modification; no fallback overlay is generated.

A full Vite production build was not run in the authoring environment because the npm registry connection timed out. Run `npm install` followed by `npm run build` on a connected machine before release.

## Advance preservation and verification details

- For `Tj` strings, replacement is written as a `TJ` array with a trailing numeric adjustment computed from the original and replacement CID widths plus existing character/word spacing. This keeps the text cursor's original advance when the replacement length differs.
- For existing `TJ` arrays, embedded CID widths and original kerning adjustments are used to preserve the aggregate advance.
- Post-edit verification is tied to the selected content-stream object and the original operand's start offset. It checks that the replacement is present at that exact operator location. Identical text elsewhere on the same page no longer causes a false failure.
- An identical replacement is rejected as a no-op before any PDF bytes are changed.
- The optional CLI helper `scripts/verify-native-pdf-edit.js` allows testing one exact run against a local PDF without bundling or uploading that file.
