# PDF Viewer Feature

## Components

- `PdfPageViewer`: renders one page into a canvas and overlays PDF.js TextLayer for selecting/copying original text.
- `PdfPageThumbnail`: lazy-renders page thumbnails as they approach the visible sidebar viewport.

## Utilities

- `zoomMath.js`: computes fit-width, fit-page and bounded manual zoom.
- `searchPdfDocument.js`: searches PDF.js text content across pages. It maps search matches back to PDF.js text-item indexes so the viewer can highlight affected runs.
- `applySearchHighlights.js`: applies and clears run-level highlight classes without changing PDF text.

## Coordinate/rendering contract

All page layout is expressed in PDF points transformed through the PDF.js viewport. The main canvas and text layer use the same page viewport and scale. PDFium pixel buffers are display bitmaps only; they are not used as the editable/export source.

## Search behavior

Search is case-insensitive and runs asynchronously with debounce and AbortSignal cancellation. It can match phrases across adjacent PDF.js text items when text item geometry indicates a space or line boundary. Highlights cover intersecting text runs and are cleared when the query is changed or removed. Search is not OCR and does not detect text present only in page images.

## Cleanup

On page/session changes, the viewer cancels its TextLayer, removes selection handlers, cleans the PDF.js page and clears the render host. Thumbnail observers disconnect, temporary render canvases are released, and stale thumbnail bitmaps are cleared when the document session changes.
