# Earthix Frontend

React 19 + Vite 8 + Tailwind CSS 4 frontend for Earthix PDF Studio.

## Scripts

Run from the repository root:

- `npm run dev` — start Vite.
- `npm run lint` — run ESLint.
- `npm run build` — create the production build.
- `npm run prepare:assets` — copy local PDF.js/PDFium worker and WASM assets.

## PDF viewer

The main viewer uses the shared document session from `src/engine`. PDF.js renders the page and supplies selectable text; PDFium renders the page when its WebAssembly worker is ready. When PDFium is unavailable, the viewer continues with PDF.js.

- `src/features/pdf-viewer/PdfPageViewer.jsx` — current page and selectable text layer.
- `src/features/pdf-viewer/PdfPageThumbnail.jsx` — lazy page thumbnails.
- `src/features/pdf-viewer/searchPdfDocument.js` — text search across pages and text runs.
- `src/features/pdf-viewer/applySearchHighlights.js` — maps search results to visible text-layer runs and clears stale highlights.
- `src/features/pdf-viewer/zoomMath.js` — fit and bounded zoom calculations.

The render canvas is a preview only. The original PDF byte buffer is retained by the document session for export. Scanned/image-only PDFs do not produce text search results until OCR is implemented.

Keep copied public assets in sync with the exact versions in this package. Engine API details are documented in `src/engine/README.md`.
