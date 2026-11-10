// Keeps drag-selection on the PDF text layer where the pointer actually is.
//
// Text-layer spans have gaps between them. Without a target under the pointer,
// browsers extend a selection to the end of the page. As in PDF.js's own
// viewer, a blank element is kept right after the selection's moving edge so
// the gaps resolve to that spot instead.

const layers = new Map()
let controller = null

function reset(end, layer) {
  layer.append(end)
  end.style.width = ''
  end.style.height = ''
  end.style.userSelect = ''
  layer.classList.remove('selecting')
}

const resetAll = () => layers.forEach(reset)

function startListening() {
  controller = new AbortController()
  const { signal } = controller
  let pointerDown = false
  let previousRange = null

  document.addEventListener('pointerdown', () => { pointerDown = true }, { signal })
  document.addEventListener('pointerup', () => { pointerDown = false; resetAll() }, { signal })
  window.addEventListener('blur', () => { pointerDown = false; resetAll() }, { signal })
  document.addEventListener('keyup', () => { if (!pointerDown) resetAll() }, { signal })
  document.addEventListener('selectionchange', () => {
    const selection = document.getSelection()
    if (!selection.rangeCount) { resetAll(); return }
    const range = selection.getRangeAt(0)
    for (const [layer, end] of layers) {
      if (range.intersectsNode(layer)) layer.classList.add('selecting')
      else reset(end, layer)
    }
    const movingStart = previousRange && (
      range.compareBoundaryPoints(Range.END_TO_END, previousRange) === 0 ||
      range.compareBoundaryPoints(Range.START_TO_END, previousRange) === 0
    )
    let anchor = movingStart ? range.startContainer : range.endContainer
    if (anchor.nodeType === Node.TEXT_NODE) anchor = anchor.parentNode
    if (!movingStart && range.endOffset === 0) {
      do {
        while (!anchor.previousSibling) {
          anchor = anchor.parentNode
          if (!anchor) return
        }
        anchor = anchor.previousSibling
      } while (!anchor.childNodes.length)
    }
    const layer = anchor.parentElement?.closest('.textLayer')
    const end = layers.get(layer)
    if (end) {
      end.style.width = layer.style.width
      end.style.height = layer.style.height
      end.style.userSelect = 'text'
      anchor.parentElement.insertBefore(end, movingStart ? anchor : anchor.nextSibling)
    }
    previousRange = range.cloneRange()
  }, { signal })
}

/** Turn on steady selection for a rendered text layer; returns a function to turn it off. */
export function keepSelectionSteady(layer) {
  const end = document.createElement('div')
  end.className = 'endOfContent'
  layer.append(end)
  const markSelecting = () => layer.classList.add('selecting')
  layer.addEventListener('mousedown', markSelecting)
  layers.set(layer, end)
  if (!controller) startListening()
  return () => {
    layer.removeEventListener('mousedown', markSelecting)
    layers.delete(layer)
    if (!layers.size) {
      controller?.abort()
      controller = null
    }
  }
}
