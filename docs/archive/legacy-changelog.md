> Historical archive: this file documents an earlier implementation. Current architecture and instructions are in the root README and `docs/architecture/` active documents. Do not use this file as the current implementation specification.

# Changelog

## 7.0.0
- Added native text-stream replacement for embedded Identity-H Type 0 subset fonts with ToUnicode maps.
- Replaced original Tj and TJ operands instead of creating overlay text objects.
- Promoted replacement Tj strings to TJ arrays with calculated text adjustment so the original text advance is preserved.
- Preserved TJ paragraph advance using embedded CID glyph widths plus existing character/word spacing.
- Scoped post-edit validation to the selected content-stream operator offset, so identical text elsewhere does not cause false failures.
- Rejected no-op replacements and unsupported replacement glyphs before modifying the PDF.
- Added a Node.js CLI regression helper for testing native text replacements on a user's own PDF.
- Added round-trip verification with the supplied 2-page text-based IRCTC PDF; the sample PDF is not included in this project.

## 6.0.0
- Replaced the PDFCanvas existing-text overlay/fallback path with an Earthix native PDF content-stream text replacement service.
- Added parsing for classic xref tables, page trees, FlateDecode page streams, Identity-H Type 0 fonts and ToUnicode CMaps.
- Added native Tj/TJ replacement using existing embedded font CIDs.
- Added CID glyph-width calculations from /W and /DW; TJ and Tj run advance is preserved with a final text adjustment.
- Added incremental PDF revision export so untouched page objects, embedded fonts and vector artwork remain intact.
- Added preflight rejection for unsupported glyphs and encrypted PDFs instead of inserting a fallback overlay.
- Added post-edit verification that the old text is absent at the selected operator position and replacement text is present.
- No Python runtime, source files, packages or service are used.

## 5.0.0
- Introduced the PDFium-backed PDF editing workspace with native text-edit integration.

## 4.2.0
- Open imported PDFs in the Edit Text tool and finalize editor state before export.

## 4.1.0
- Lock inspector formatting controls while selecting original PDF text.

## 4.0.0
- Introduced the first PDFium-backed PDF editing workspace.
