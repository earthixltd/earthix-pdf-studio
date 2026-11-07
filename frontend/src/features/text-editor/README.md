# Text Editor Feature

This feature currently provides original-PDF text-run selection, font inspection and native text replacement.

- `findNativeRunForText.js` maps a clicked PDF.js text-layer span to one native PDF content-stream text run. Ambiguous matches are rejected.
- `FontInspectorPanel.jsx` displays font resource and selected-run properties, plus replacement glyph compatibility.
- The main application uses `ReplaceNativeTextRunCommand` so verified replacements participate in Document Core Undo/Redo and saved-state tracking.

Replacement currently targets supported Identity-H text-showing operators (`Tj` and `TJ`) in page content streams. See `docs/architecture/NATIVE-TEXT-EDITING.md` for parser boundaries and limitations.
