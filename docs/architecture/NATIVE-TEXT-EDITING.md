# Earthix Native PDF Text Editing

Text is edited **inside the page content streams**. The original text-showing
operators (`Tj`, `TJ`, `'`, `"`) are rewritten in place, so there is never an
overlay or a duplicate copy of the text. Font, size, colour, rendering mode,
character spacing, horizontal scaling and transforms are inherited from the
original graphics state.

## User flow

1. Choose **Edit Text** in the toolbar. Every editable text block on the page gets a hover outline.
2. Click text. An in-place editor opens exactly over it, using the same font family, size, weight, style and colour.
   The original glyphs are masked with the sampled page background while typing, so only one copy is visible.
3. Press **Enter** (or click elsewhere) to save, **Esc** to cancel. The PDF is rewritten, verified, re-rendered and
   recorded as one Undo/Redo step. Locked blocks explain why they cannot be edited.

## Engine layout

| Module | Responsibility |
| --- | --- |
| `engine/pdf-parser/pdfSyntax.js` | Lossless PDF object parser/serializer (dicts, arrays, names, strings, refs). |
| `engine/pdf-parser/pdfStreams.js` | Tolerant Flate, LZW, ASCIIHex, ASCII85, RunLength decoding and PNG/TIFF predictors. |
| `engine/pdf-parser/pdfDocumentIndex.js` | Classic and stream xrefs, hybrid files, object streams, broken-xref reconstruction, page tree with inherited `Resources`. |
| `engine/pdf-parser/incrementalWriter.js` | Appends incremental updates in the same xref style as the file (repaired files get a full xref stream). |
| `engine/font-engine/pdfFontLoader.js` | Decodes Type0/Identity-H, TrueType, Type1, Type3 fonts: ToUnicode (token based), base encodings + `Differences`, glyph names, embedded-font cmaps, widths (incl. standard-14 AFM metrics). |
| `engine/content-stream/contentStream.js` | Content-stream interpreter: `q/Q` graphics-state stack, `cm`, text state, colours, `Tf` via ExtGState, Form XObjects, inline images, painted rules (table borders). Produces runs with exact geometry in user space. |
| `engine/content-stream/textBlocks.js` | Groups runs into editable blocks (same line, same style, word-sized gaps, not separated by a border). Overprinted duplicates (fake bold/shadow) become twins that are edited together. |
| `engine/font-engine/fallbackFonts.js`, `fontEmbedder.js` | Missing-glyph fallback: same font from the computer (Local Font Access), then a similar installed font, then a standard PDF font. Installed fonts are subset with fontkit and embedded as Type0/Identity-H with ToUnicode. |
| `services/nativePdfTextEditor.js` | `inspectNativePdfText`, `replaceNativeTextBlock` (and the compatible `replaceNativePdfText`). |
| `features/text-editor/InlineTextEditor.jsx` | The in-place editor. |

## How an edit is written

* A prefix/suffix diff keeps the original glyph codes and kerning of unchanged characters; only the changed middle is re-encoded.
* When every new character exists in the PDF font, the original font is reused (`Tj` → `TJ` with explicit glyph codes).
  Word spaces that the PDF drew by positioning (large negative `TJ` numbers) are recreated the same way.
* When a character is missing from an embedded subset font, the exact same installed font redraws the block if there
  is one. Otherwise only the missing letters borrow the closest font (`/EFn size Tf … TJ /Original size Tf` around them)
  and everything else stays in the original font. Indic text needs shaping, so it is still redrawn as a whole block.
* While typing, the inline editor uses the PDF's own embedded font. PDF.js converts every embedded type to a browser
  font; `engine/font-engine/previewFonts.js` rebuilds its character map so real letters reach the right glyphs.
* Fonts come from, in order: files the user added, fonts on this computer, the free library (`engine/font-engine/fontLibrary.js`,
  about 2,000 fonts listed in `public/fonts/catalog.json`, downloaded from jsDelivr only when needed). A font with the same name
  is used for the whole line. Otherwise the closest library font is chosen by comparing letter widths and shapes with the
  PDF's own letters, and only the missing letters use it. Offline, the older installed and standard fallbacks still apply.
  Rebuild the catalog with `npm run fonts:catalog`.
* Weights are numeric (100–900), read from the font name, then `/FontWeight`. Bold, italic or weight changes never swap
  a distinctive font for an unrelated one: if that style isn't installed, the text stays as it was.
* The rewritten operator keeps its original pen advance; text that followed it on the same line is moved by exactly the
  width difference. Movement stops at large gaps and at painted vertical rules, so other table cells and columns never
  move. If the new text overflows a cell/column or the paragraph's right margin, a warning is shown.
* The edited bytes are parsed again and the line is verified to read the new text before the edit is committed.

## Known limitations

* No paragraph re-wrap: a longer line is not wrapped onto the next line.
* Underlines, highlights and links do not move with shifted text.
* Hindi and other Indic scripts are edited by redrawing the whole block with an installed font of the same script
  (`engine/font-engine/indicText.js` restores typing order; `glyphRecovery.js` reads unlabelled conjunct glyphs from the
  same installed font). Without such a font (or without font access in Chrome/Edge) the edit is refused with a message.
  Arabic, Hebrew and Thai remain locked.
* Encrypted PDFs must be decrypted first. Vertical (Identity-V) text and fonts without any Unicode information are locked.
* Exact-font fallback needs Chrome or Edge with font access allowed for the site; otherwise a standard PDF font
  (Helvetica/Times/Courier, metric-compatible with Arial/Times New Roman/Courier New) is used and the user is told.

## Tests

`tests/font-engine/nativeTextBlockEditing.test.js` builds PDFs with pdf-lib (standard and subset TrueType fonts) and
hand-written content streams, then checks geometry, colour/size retention, same-line shifting, table cells, TJ word
spaces, `q/cm/Q`, overprinted duplicates, inherited resources, classic/stream xref output, subset fallback with an
installed font, repeated edits, and PDF.js text extraction of every result.
