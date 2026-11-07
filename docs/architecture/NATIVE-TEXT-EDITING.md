# Earthix Native PDF Text Editing

## What this phase adds

- Native PDF text/font inspection for supported page content streams.
- Font metadata including resource name, subtype, encoding, embedded/subset status, ToUnicode coverage, basic style flags and width metrics.
- Per-text-run metadata including operator (`Tj` or `TJ`), point size, character/word spacing, horizontal scaling, text rise, rendering mode, position and supported device colour operators.
- Replacement glyph compatibility checks before enabling the Replace action.
- Deterministic PDF.js text-layer span matching. Exact matches are preferred; a unique partial match is accepted; ambiguous matches are rejected.
- `ReplaceNativeTextRunCommand`, which applies a verified content-stream replacement as one Document Core history command with Undo/Redo.
- A Font Inspector panel in the editor properties area.

## Native replacement behavior

The current editor path replaces the string operand of an existing page content-stream text-showing operator. For `Tj`, the replacement is written as a `TJ` array with a calculated final text adjustment so the original text advance is maintained. For `TJ`, the original operator is replaced with a new `TJ` array and a calculated final adjustment. The current font selection, text state, rendering mode, colour operators and text matrix surrounding the original operator are retained because the surrounding content stream is not rebuilt.

After replacement, the edited bytes are parsed again and the selected page/content-stream position is checked. Failed verification rejects the command before Document Core commits the updated bytes. The editor then opens the new byte snapshot in the viewer. Undo restores the previous byte snapshot; Redo restores the verified replacement snapshot.

## Font compatibility checks

A replacement is enabled only when the selected font encoding can be mapped safely and every replacement character is supported by the font resource. Identity-H fonts require a readable ToUnicode CMap and a matching embedded glyph/CID. WinAnsi simple fonts use the Windows-1252 byte mapping plus the PDF /Widths table; embedded subset fonts are restricted to codes with an available width/glyph entry. Missing characters are rejected. Non-embedded simple fonts can be edited with an explicit font-substitution warning because the actual font program is not present in the PDF. No fallback font or duplicate overlay is silently inserted.

Font metadata is diagnostic. PDF color spaces and text state are broader than the currently inspected device operators; the inspector currently reports DeviceGray, DeviceRGB and DeviceCMYK values when visible in the content stream. Complex graphics-state inheritance, patterns, ICCBased colors and nested Form XObjects are not comprehensively resolved by this inspector.

## Current parser limitations

The custom native text editor is intentionally conservative. It currently supports:

- Classic PDF cross-reference tables and cross-reference streams, including `/W`, `/Index`, `/Prev`, `/XRefStm`, FlateDecode, and PNG predictor rows 10–15. Compressed objects referenced by type-2 xref entries are read from `/ObjStm` streams using `/N` and `/First`.
- Page `/Contents` streams referenced directly or through a simple array.
- Direct stream `/Length` values.
- Unfiltered or `/FlateDecode` content streams.
- Font resource dictionaries that are directly available from the page resource dictionary.
- Type 0 / Identity-H font text runs with a readable ToUnicode CMap and supported replacement glyphs.
- Simple WinAnsi font text runs using Windows-1252 byte mapping and the PDF `/Widths` table for conservative subset-glyph checks.
- Existing text-showing operators `Tj` and `TJ`.

It does not yet support arbitrary encodings beyond the currently implemented WinAnsi and Identity-H paths, text inside nested Form XObjects, inherited resource dictionaries throughout every page-tree shape, indirect stream lengths, encrypted-document native replacement, arbitrary stream filter chains, vertical writing modes, marked-content text replacement, complex clipping/soft masks, or every possible font program format. The parser's text-state and colour inspector is not a complete PDF graphics-state interpreter.

This phase does not implement paragraph reflow. A replacement is kept at the original text object's position and advance; it does not automatically push neighboring content or re-layout a paragraph. If replacement glyphs are not present in the embedded subset font, the operation is rejected rather than silently substituting another font.

## Test coverage

The Node regression suite covers font capability assessment, exact/partial/ambiguous click matching, native replacement command history, export verification, viewer search and engine lifecycle, plus xref-stream parsing, PNG predictor decoding, compressed object streams, WinAnsi mapping and incremental replacement output. In addition, the user-provided two-page IRCTC sample PDF was tested locally without being added to the repository: an existing `Tj` passenger-name run and a long `TJ` paragraph run were replaced; the old strings were absent after replacement; new strings remained extractable; Undo/Redo restored the expected content; and the exported file reopened as a two-page PDF. The source PDF is private test input and is not included in this project archive.

## Uploaded 21-page PDF regression

The user-provided `What-is-a-computer-Network(1).pdf` uses PDF 1.5 cross-reference streams and compressed object streams. The editor now parses it and detects 1,558 native text runs across 21 pages. Regression replacements were made in a WinAnsi simple-font Tj run and a subset-font TJ run. The output reopened as a 21-page PDF, retained its unencrypted state, and `pdftotext` confirmed the original strings were replaced by “What is a computer Network!” and “Basic Networking Tutorials”. The original file is not bundled in the project archive.
