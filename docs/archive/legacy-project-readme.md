> Historical archive: this file documents an earlier implementation. Current architecture and instructions are in the root README and `docs/architecture/` active documents. Do not use this file as the current implementation specification.

# Earthix PDF Studio

Earthix PDF Studio is a local-first React + Vite PDF editor. Its normal viewer and page/object tools use `pdfcanvas`, PDFium WebAssembly, PDF.js and `pdf-lib`. Existing text replacement uses an Earthix browser-side native PDF content-stream editor. No Python runtime or backend service is required.

## Native existing-text replacement

The Edit Text panel reads existing text operators from the original PDF and, for supported documents, rewrites the selected text operand inside the original page content stream. It does **not** add a React text overlay, white patch or duplicate text object. The update is saved as an incremental PDF revision, preserving the original page objects, embedded font resources, vector artwork and other untouched content.

The editor supports this native replacement path when the PDF has:

- A classic PDF cross-reference (`xref`) table, not an xref stream.
- An unencrypted document.
- Page content streams that are uncompressed or use `FlateDecode` with a direct `/Length`.
- Page-level font resources available directly on the page or through a referenced resource dictionary.
- A Type 0 font using `Identity-H` encoding and a readable `/ToUnicode` CMap.
- Text represented by `Tj` or `TJ` operators.
- Every replacement character present in the selected embedded font's ToUnicode/CID map.

For `TJ` text, the editor reads the font's `/W` and `/DW` metrics and preserves the original text advance using a final text adjustment. It keeps the original font resource, font size, colour, text matrix, character spacing and other surrounding text state. The replacement characters must already exist in that embedded font subset. If a character is missing, the operation is rejected before the PDF is changed. No fallback font or overlay is silently inserted.

## Known compatibility limits

Native replacement is intentionally conservative. It currently rejects or does not fully support:

- Xref streams and compressed object streams.
- Encrypted PDFs.
- PDFs where the relevant page resources are inherited only from an ancestor page-tree node.
- Indirect stream `/Length` values or stream filters other than plain data / `FlateDecode`.
- Non-Identity-H fonts, Type 3 fonts, simple fonts, malformed/missing ToUnicode maps, and replacement characters outside the embedded font subset.
- Text stored in Form XObjects, annotations, AcroForm appearances, or content that is not represented by a supported `Tj` / `TJ` operator.
- Complex RTL shaping, ligatures, vertical writing, and line reflow. The editor changes a selected text run; it does not reflow an entire paragraph like a word processor.

A PDF may be text-based yet still be unsupported by this specific native editing path. PDF.js canvas rendering is only the visual preview; it does not convert the source PDF into an image. Scanned/image-only pages need OCR before they can contain editable text.

## How to edit existing text

1. Open a normal text-based PDF.
2. Choose **Edit Text** in the top toolbar.
3. Search for the original text in the Properties panel, or select a detected text run in the page when the viewer exposes it.
4. Enter replacement text and choose **Replace original PDF text**.
5. The app reloads the updated original PDF bytes and verifies that the previous text is gone and the replacement is present before it accepts the edit.
6. Choose **Save** to download the modified PDF.

Edits are applied one at a time against the latest PDF revision. If other canvas/object changes are pending, the app asks you to export and reopen before native text editing so it does not overwrite those separate changes.

## Requirements

- Node.js 20.19.x or Node.js 22.12.0+.
- npm.
- A modern browser with WebAssembly, `CompressionStream` and `DecompressionStream` support.

Python is not used or required.

## Start on Windows

1. Extract the project folder.
2. Double-click `START_EARTHIX_PDF_STUDIO.bat`.
3. On first run, npm installs dependencies and copies the PDF.js worker, PDFium WASM, CMaps, standard fonts and font assets into `public/`.
4. Open `http://localhost:5173` if it does not open automatically.

## Start manually

```bash
npm install
npm run dev
```

## Production build

```bash
npm run build
npm run preview
```

## License notes

The project uses `pdfcanvas` (MIT), `@embedpdf/pdfium` (check the installed package license), PDF.js (Apache-2.0) and `pdf-lib` (MIT). Third-party licenses continue to apply to their respective packages. The Earthix native text-stream editor is project code and uses browser-standard Compression/Decompression Streams.

## Test native text replacement from the command line

You can test a specific PDF run without launching the UI:

```bash
node scripts/verify-native-pdf-edit.js "input.pdf" "Exact original text" "Replacement text"
```

The script writes a `*.native-edited.pdf` copy beside the source file. You can also pass an explicit output path as the fourth argument. It verifies that the replacement exists at the selected page/content-stream position before writing the output. The source PDF is never overwritten.

Both `Tj` and `TJ` source operators are supported. A `Tj` replacement is emitted as a `TJ` array with a calculated final adjustment so the text cursor retains its original advance. Existing `TJ` kerning/spacing is folded into an equivalent final adjustment. The replacement string keeps the original PDF text state and embedded font resource. This preserves the text's font styling and start position; it does not automatically shrink longer replacement text or reflow a paragraph.
