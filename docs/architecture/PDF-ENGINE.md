# Earthix PDF Engine

## Responsibilities

- `PdfJsAdapter` owns PDF.js loading tasks, PDF page access, text extraction and the viewer fallback. It is dynamically imported when the first document opens.
- `PdfiumAdapter` owns a module Web Worker and maps request/response messages to document sessions. It is dynamically imported when the first document opens.
- `pdfium.worker.js` owns the PDFium WASM instance, document pointers, page pointers and render bitmaps. WASM pointers never cross to the main thread.
- `openDocumentSession` coordinates both engines, validates page counts and falls back to PDF.js when PDFium is unavailable or a PDFium page operation fails.
- `bitmapToRgba` converts PDFium's native bitmap formats and scanline stride into browser `ImageData` pixels.
- `copy-pdf-assets.js` copies the version-matched worker, CMaps, fonts, ICC profiles, image-decoder module, PDF.js WASM and PDFium WASM to same-origin public paths.

## Opening and rendering

1. `validatePdfInput` accepts `Uint8Array`, `ArrayBuffer` or another typed-array view, validates the `%PDF-` header and enforces the configured input-size guard.
2. PDF.js and PDFium receive isolated copies of the original bytes.
3. PDF.js is required for a session. PDFium may be unavailable; in that case the session enters `degraded` status while viewer functions remain available.
4. `openDocumentSession` returns after PDF.js has opened. PDFium initializes in the background.
5. If both engines open the file, page counts must match. If they do not, PDFium is closed and PDF.js remains available.
6. PDFium renders inside its worker. If a PDFium render fails, the session retries that page through PDF.js.

## Memory and lifecycle

- The PDF input buffer and optional null-terminated UTF-8 password are allocated in WASM memory for `FPDF_LoadMemDocument`. The worker passes the password pointer (or `0` for no password), then frees both allocations after the synchronous load call.
- Every loaded PDFium page and bitmap is released in `finally` blocks.
- PDF.js `PDFDocumentLoadingTask` is retained and destroyed when the document session closes.
- `PdfiumAdapter.dispose()` closes open sessions, rejects pending requests, removes listeners and terminates the worker.
- Worker requests have a timeout so a lost response cannot leave a promise pending forever.

## Editing layers

- PDF.js renders page content and exposes its selectable text layer. That layer is a viewer interaction surface, not the document source of truth.
- `DocumentCore` owns original/working bytes, page/object registries, commands, history and recovery state.
- `ReplaceNativeTextRunCommand` uses the Earthix native text-stream editor and stores verified replacement bytes as one reversible Document Core command.
- The current native text editor has conservative structure and font limits. Read `NATIVE-TEXT-EDITING.md` before expanding it; do not silently use an overlay when an original text object cannot be replaced.

## Self-hosted assets

Run `npm install` from the repository root. The root `postinstall` invokes `frontend/scripts/copy-pdf-assets.js` and copies version-locked PDF.js/PDFium assets into `frontend/public/`. Production runtime does not depend on a third-party CDN for these engine assets.
