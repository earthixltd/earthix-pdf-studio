# Earthix PDF Engine API

```js
import { createPdfEngine } from './engine/index.js'

const engine = createPdfEngine()
const bytes = new Uint8Array(await file.arrayBuffer())
const session = await engine.openDocument(bytes, {
  fileName: file.name,
  onProgress: ({ loaded, total }) => {
    // Update the loading indicator.
  },
})

const pageInfo = await session.getPageInfo(0)
await session.renderPage(0, canvas, { scale: 1.25 })
const text = await session.getTextContent(0)

// Close a document when it is no longer displayed.
await session.close()

// Dispose the shared PDFium worker when the editor application unmounts.
await engine.dispose()
```

`session.engineStatus` is `loading`, `ready`, `degraded` or `closed`. PDF.js opens first so viewing can begin while PDFium initializes in the background. In `degraded` mode, PDF.js viewing remains available, but PDFium operations must not be assumed to work. `session.pdfiumReady` resolves when PDFium initialization/opening finishes, and `session.pdfiumError` contains the latest PDFium failure.
