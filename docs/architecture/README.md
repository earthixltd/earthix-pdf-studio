# Earthix PDF Studio architecture

## Step 1 baseline

- `frontend/` contains the React + Vite application.
- `frontend/src/engine/` is reserved for engine adapters and document-core modules.
- `frontend/src/features/` is reserved for product features.
- `backend/` is a placeholder for a later Node.js + Express + MongoDB phase.
- The existing v7 UI and native text replacement service have been copied without feature rewrites.

## Planned hybrid engine responsibilities

- PDF.js: page rendering, text-layer information and search support.
- PDFium WebAssembly: low-level PDF document and page-object operations.
- pdf-lib: PDF creation and supported page/document transformations.
- QPDF: later structural, encryption and linearization operations after license and browser/runtime review.
- Tesseract.js: later OCR for scanned documents.
- Earthix modules: document sessions, commands/history, font inspection, native text editing orchestration, export validation.

No engine implementation is added in this setup step.
