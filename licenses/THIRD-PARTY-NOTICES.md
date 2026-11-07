# Third-party notices

This file will be expanded before public distribution. Record the exact installed version, license text, copyright notices, and any bundled binary/WASM notices for each dependency.

Current direct dependencies are listed in `frontend/package.json`.

## PDF engine packages used by Step 4

| Package | Version | License note |
|---|---:|---|
| pdfjs-dist | 6.5.438 | Apache-2.0. The package also contains separately licensed decoder, WASM and font assets; retain the notices supplied in the package. |
| @embedpdf/pdfium | 2.15.1 | JavaScript wrapper: MIT. Bundled PDFium WebAssembly: Apache-2.0. PDFium and its bundled third-party components carry their own notices. |

This is an implementation inventory, not the final distribution license audit. Before public distribution, generate the full dependency notice set from the installed lockfile and retain each bundled asset's license/attribution files.
