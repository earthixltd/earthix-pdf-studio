# Earthix PDF Engine Foundation

## Runtime responsibilities

- **PDF.js adapter** (`frontend/src/engine/pdfjs/pdfJsAdapter.js`): opens PDF bytes, provides page metadata, renders pages to HTML canvas, and extracts selectable/searchable text content.
- **PDFium adapter** (`frontend/src/engine/pdfium/pdfiumAdapter.js`): manages a module worker and PDFium document sessions. It exposes page metadata and bitmap rendering without blocking the React main thread.
- **PDFium worker** (`frontend/src/workers/pdfium.worker.js`): initializes the local PDFium WASM binary, calls `PDFiumExt_Init()`, loads documents, renders pages, and owns all PDFium pointers and allocations.
- **Document session loader** (`frontend/src/engine/document-core/openDocumentSession.js`): opens the same byte snapshot in both engines, compares page counts, and reports a degraded PDFium state without discarding a PDF.js-openable document.
- **Engine errors** (`frontend/src/engine/engineErrors.js`): normalizes engine failures into stable error codes and user-readable messages.

## Asset layout

The npm postinstall script copies required runtime assets into `frontend/public`:

```text
frontend/public/
├── pdfjs/
│   ├── pdf.worker.mjs
│   ├── cmaps/
│   ├── standard_fonts/
│   ├── wasm/
│   ├── iccs/
│   └── image_decoders/
└── pdfium/
    └── pdfium.wasm
```

The paths match the locked `pdfjs-dist@6.5.438` package layout and `@embedpdf/pdfium@2.15.1`. Required worker/WASM assets fail the postinstall script when missing. Optional support resources are copied when available.

## Document lifecycle

1. `openDocumentSession()` opens a byte copy in PDF.js and starts PDFium initialization in the background.
2. PDF.js makes the document usable immediately; the viewer does not wait for PDFium WASM startup.
3. PDF.js supplies text content and the selectable text layer. PDFium renders pages when its worker is ready; PDF.js remains the viewer fallback if PDFium is unavailable or a page render fails.
4. PDFium page count is checked against PDF.js. A mismatch closes PDFium and keeps PDF.js available in a degraded state.
5. Replacing the active document session closes the previous PDFium document and PDF.js loading task.
6. On app unmount, the active document session and worker are disposed.

## PDFium memory ownership

The worker owns the PDFium module, PDF memory buffer, document pointer, page pointers, bitmap pointers and pixel buffers. Every page and bitmap is released in `finally` blocks. Pixel data is copied out of WASM memory before being transferred to the main thread. The main thread never receives a raw PDFium pointer.

## Scope

The foundation covers loading, metadata, rendering, selectable text, worker isolation, errors, fallback behavior and cleanup. Native text replacement and font inspection are documented separately in `NATIVE-TEXT-EDITING.md`. Page, image, annotation, form, signature and OCR modules are later feature phases.
