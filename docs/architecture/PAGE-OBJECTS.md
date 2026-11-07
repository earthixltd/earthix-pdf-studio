# Earthix Page Objects (added text, images, markup)

Items added in the editor live in the Document Core object registry while you work, so moving or restyling them is instant and fully undoable. They are written into the PDF only when it leaves the editor (export, split, organize, optimize).

## Coordinates

Objects are stored in **view space**: PDF points at 100 % zoom, origin at the top-left of the page as displayed (after `/Rotate` and the crop box). `engine/page-objects/pageGeometry.js` reproduces PDF.js's viewport transform so the writer can map view space back to user space exactly.

## Object types

| Type | Key fields |
| --- | --- |
| `text` | `text`, `fontFamily`, `fontSource` (`standard`/`local`), `fontSize`, `color`, `bold`, `italic`, `underline`, `strike`, `align`, `lineHeight`, `autoWidth`, `backgroundColor` |
| `image` | `data` (JPEG/PNG bytes), `format`, `assetId`, `pixelWidth`, `pixelHeight` |
| `shape` | `shape` (`rect`/`ellipse`/`line`/`arrow`), `strokeColor`, `strokeWidth`, `fillColor`, `dashed`, `points` (lines), `whiteout` |
| `ink` | `strokes`, `color`, `strokeWidth`, `signature` |
| `highlight` | `kind` (`highlight`/`underline`/`strikeout`), `rects`, `color`, `opacity`, `comment` |
| `note` | `text`, `color` |

All boxes also have `x`, `y`, `width`, `height`, `rotation`, `opacity` and `z`.

## Writing (`objectWriter.js`)

* Text, images, shapes and drawings go into one extra content stream per page, wrapped as `[q] + original contents + [Q + objects]`, so text stays searchable and every viewer shows it. Standard fonts use the base-14 fonts; installed fonts are subset and embedded (Type0/Identity-H with ToUnicode).
* Highlights, underlines, strike-outs and notes become standard annotations with appearance streams.
* Unless flattened, the page gets `/EarthixLayer << /Model (JSON) /Pre /Post /Annots >>`.
* Text layout (`textLayout.js`) is shared by the screen preview and the writer, so line breaks, alignment and baselines match.

## Reading (`objectReader.js`)

On open, pages with a valid `/EarthixLayer` have the extra streams and annotations removed and their objects restored to the registry. If the page rotation or crop changed since writing, objects are remapped. Pages altered by other software are left as they are.

## Editing original content

`services/nativePdfTextEditor.js` adds `restyleNativeTextBlock` (font, size, colour, bold, italic for existing text; following words on the line move to fit; the previous colour is restored exactly afterwards) and `editPageImage` (move, resize, rotate, replace, opacity, delete for images drawn directly by the page). Images inside reusable Form XObjects are locked.

## Text inside pictures

`features/editor/imageText.js` renders the image area sharply, reads it with Tesseract (worker, cores and English/Hindi data are served from `public/tesseract/`, copied by `npm run prepare:assets`), and for a chosen line builds two objects: an `image` cover (`imageTextPatch: true`) painted with `engine/page-objects/imageTextEdit.js` (`inpaintBox`) and a `text` object with the colour, weight and size from `measureTextStyle` / `estimateFontSize`, placed on the detected baseline. Both are written like any other added item.

## Known limitations

* Added text in Hindi and other complex scripts needs an installed font that covers it (for example Nirmala UI); shaping is done by fontkit and verified in tests. Existing Hindi text in a PDF is still locked for editing.
* Whiteout hides content but does not remove it from the file.
* Existing text cannot yet be moved to another position.
* Text in pictures: the font family is matched as Helvetica (change it in the panel); busy or photographic backgrounds are smoothed rather than perfectly rebuilt.
