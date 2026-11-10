import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { TEXT_PADDING, noteMessage } from '../../engine/page-objects/textLayout.js'
import { ObjectView } from './ObjectView.jsx'
import {
  applyBox, canRotate, inkBounds, isBoxObject, isLineShape, mergeLineRects, moveObject, newId, objectBounds, objectLabel,
  resizeBox, rotationFromPointer,
} from './objectFactory.js'
import { fitTextObject, layoutTextObject, textCss } from './textMeasure.js'

const BOX_HANDLES = [
  { id: 'nw', hx: -1, hy: -1 }, { id: 'n', hx: 0, hy: -1 }, { id: 'ne', hx: 1, hy: -1 }, { id: 'e', hx: 1, hy: 0 },
  { id: 'se', hx: 1, hy: 1 }, { id: 's', hx: 0, hy: 1 }, { id: 'sw', hx: -1, hy: 1 }, { id: 'w', hx: -1, hy: 0 },
]
const TEXT_HANDLES = BOX_HANDLES.filter((handle) => handle.hx !== 0)

function handlesFor(object) {
  if (!object || object.locked) return []
  if (object.type === 'text') return TEXT_HANDLES
  if (isBoxObject(object)) return BOX_HANDLES
  return []
}

function snapAngle(from, to) {
  const angle = Math.atan2(to.y - from.y, to.x - from.x)
  const step = Math.PI / 4
  const snapped = Math.round(angle / step) * step
  const length = Math.hypot(to.x - from.x, to.y - from.y)
  return { x: from.x + Math.cos(snapped) * length, y: from.y + Math.sin(snapped) * length }
}

/** Box of a text object as drawn (auto-width text grows with its content). */
function displayBox(object) {
  if (object.type === 'text') {
    const layout = layoutTextObject(object)
    return { x: object.x, y: object.y, width: layout.width, height: layout.height, rotation: object.rotation || 0 }
  }
  if (isLineShape(object) || object.type === 'highlight' || object.type === 'note') return { ...objectBounds(object), rotation: 0 }
  return { x: object.x, y: object.y, width: object.width, height: object.height, rotation: object.rotation || 0 }
}

function TextEditor({ object, scale, onCommit, onDraft }) {
  const ref = useRef(null)
  const doneRef = useRef(false)
  const layout = layoutTextObject(object)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    element.innerText = object.text || ''
    element.focus({ preventScroll: true })
    const selection = globalThis.getSelection?.()
    if (selection) {
      const range = document.createRange()
      range.selectNodeContents(element)
      if (object.text) range.collapse(false)
      selection.removeAllRanges()
      selection.addRange(range)
    }
    doneRef.current = false
    // Runs only when a different object starts editing.
  }, [object.id])

  const read = () => (ref.current?.innerText || '').replace(/\u00a0/g, ' ').replace(/\n$/, '')
  const finish = () => {
    if (doneRef.current) return
    doneRef.current = true
    onCommit(read())
  }
  const style = {
    left: `${object.x * scale}px`,
    top: `${object.y * scale}px`,
    width: object.autoWidth ? 'auto' : `${object.width * scale}px`,
    minWidth: `${Math.max(24, (object.fontSize || 12) * scale)}px`,
    minHeight: `${layout.lineBox * scale + TEXT_PADDING * 2 * scale}px`,
    padding: `${TEXT_PADDING * scale}px`,
    whiteSpace: object.autoWidth ? 'pre' : 'pre-wrap',
    textAlign: object.align || 'left',
    transform: object.rotation ? `rotate(${object.rotation}deg)` : undefined,
    transformOrigin: `${(layout.width * scale) / 2}px ${(layout.height * scale) / 2}px`,
    background: object.backgroundColor || 'transparent',
    opacity: object.opacity ?? 1,
    ...textCss(object, scale),
  }
  return (
    <div
      ref={ref}
      className="text-object-editor"
      style={style}
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      spellCheck
      role="textbox"
      aria-multiline="true"
      aria-label="Text box"
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Escape' || (event.key === 'Enter' && (event.ctrlKey || event.metaKey))) {
          event.preventDefault()
          ref.current?.blur()
        }
      }}
      onInput={() => onDraft?.(read())}
      onPaste={(event) => {
        event.preventDefault()
        const text = event.clipboardData?.getData('text/plain') || ''
        document.execCommand?.('insertText', false, text)
      }}
      onBlur={finish}
    />
  )
}

/**
 * Objects added in the editor for one page: drawing, selection, moving,
 * resizing, rotating and creating new objects with the active tool.
 */
export function ObjectLayer({
  pageIndex, scale, pageWidth, pageHeight, objects, tool, settings, selectedId, editingObject, busy = false, fontVersion = 0,
  onSelect, onChange, onCreate, onInkStroke, onStartText, onTextCommit, onTextDraft, onPlaceSignature,
}) {
  const rootRef = useRef(null)
  const dragRef = useRef(null)
  const lastTapRef = useRef({ id: null, time: 0 })
  const [draft, setDraftState] = useState(null)
  const draftRef = useRef(null)
  const setDraft = useCallback((value) => { draftRef.current = value; setDraftState(value) }, [])
  const handlersRef = useRef({})
  const [creation, setCreation] = useState(null)

  const interactiveObjects = tool === 'select' || tool === 'edit'
  // A comment's icon keeps a usable size even on a huge page viewed zoomed out.
  const noteZoom = Math.max(1, 1 / scale)
  const creating = ['text', 'draw', 'shape', 'note', 'signature', 'whiteout'].includes(tool)

  const toView = useCallback((event) => {
    const rect = rootRef.current.getBoundingClientRect()
    return { x: (event.clientX - rect.left) / scale, y: (event.clientY - rect.top) / scale }
  }, [scale])

  const sorted = useMemo(() => [...objects].sort((a, b) => (a.z ?? 0) - (b.z ?? 0)), [objects])
  const displayed = useMemo(() => sorted.map((object) => (draft && draft.id === object.id ? draft : object)), [sorted, draft])
  const selected = displayed.find((object) => object.id === selectedId) || null

  // Clear an unfinished drag if the selection changes underneath it.
  useEffect(() => { if (draft && draft.id !== selectedId) setDraft(null) }, [selectedId, draft, setDraft])

  // Highlight tool: turn a text selection (or a dragged box) into a highlight.
  useEffect(() => {
    if (tool !== 'highlight') return undefined
    const page = rootRef.current?.parentElement
    if (!page) return undefined
    let start = null
    const down = (event) => {
      if (event.button !== 0 || event.target.closest?.('.object-node, .selection-frame')) return
      start = { point: toView(event), time: Date.now() }
    }
    const up = (event) => {
      if (!start) return
      const begin = start
      start = null
      const selection = globalThis.getSelection?.()
      const textLayer = page.querySelector('.textLayer')
      if (selection && !selection.isCollapsed && selection.rangeCount && textLayer && selection.containsNode(textLayer, true)) {
        const range = selection.getRangeAt(0)
        const bounds = rootRef.current.getBoundingClientRect()
        const rects = [...range.getClientRects()]
          .map((rect) => ({ x: (rect.left - bounds.left) / scale, y: (rect.top - bounds.top) / scale, width: rect.width / scale, height: rect.height / scale }))
          .filter((rect) => rect.width < pageWidth * 0.98 && rect.height < pageHeight * 0.3 && rect.x > -5 && rect.y > -5)
        const merged = mergeLineRects(rects)
        const text = selection.toString().trim()
        selection.removeAllRanges()
        if (merged.length) {
          onCreate({ id: newId('highlight'), type: 'highlight', pageIndex, ...settings.highlight, rects: merged, text, ...objectBounds({ type: 'highlight', rects: merged }) }, 'Highlight text')
          return
        }
      }
      const end = toView(event)
      const box = { x: Math.min(begin.point.x, end.x), y: Math.min(begin.point.y, end.y), width: Math.abs(end.x - begin.point.x), height: Math.abs(end.y - begin.point.y) }
      if (box.width > 4 && box.height > 4) {
        onCreate({ id: newId('highlight'), type: 'highlight', pageIndex, ...settings.highlight, rects: [box], text: '', ...box }, 'Highlight area')
      }
    }
    page.addEventListener('pointerdown', down)
    window.addEventListener('pointerup', up)
    return () => {
      page.removeEventListener('pointerdown', down)
      window.removeEventListener('pointerup', up)
    }
  }, [tool, toView, scale, pageWidth, pageHeight, pageIndex, settings.highlight, onCreate])

  // ---------------------------------------------------------------------------
  // Selecting and transforming existing objects
  // ---------------------------------------------------------------------------

  const beginDrag = (event, info) => {
    event.stopPropagation()
    event.preventDefault()
    dragRef.current = { ...info, pointerId: event.pointerId, start: toView(event), moved: false }
    const move = (moveEvent) => handlersRef.current.move?.(moveEvent)
    const up = (upEvent) => {
      if (upEvent.pointerId !== info.pointerId && upEvent.pointerId !== event.pointerId) return
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      handlersRef.current.end?.(upEvent)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  // A click elsewhere finishes the text being typed, and that text is saved.
  const finishTyping = () => {
    if (!editingObject) return false
    const active = document.activeElement
    if (active?.classList?.contains('text-object-editor')) active.blur()
    return true
  }

  const onObjectPointerDown = (event, object) => {
    if (event.button !== 0 && event.pointerType === 'mouse') return
    finishTyping()
    const now = Date.now()
    const isDoubleTap = lastTapRef.current.id === object.id && now - lastTapRef.current.time < 350 && event.pointerType !== 'mouse'
    lastTapRef.current = { id: object.id, time: now }
    onSelect(object.id)
    if (isDoubleTap && object.type === 'text') { onStartText(object); return }
    if (object.locked || busy) { event.stopPropagation(); return }
    beginDrag(event, { mode: 'move', object })
  }

  const onObjectDoubleClick = (event, object) => {
    event.stopPropagation()
    if (object.type === 'text') onStartText(object)
  }

  const onHandlePointerDown = (event, handle) => {
    if (!selected) return
    beginDrag(event, { mode: 'resize', handle, object: selected, box: displayBox(selected) })
  }

  const onRotatePointerDown = (event) => {
    if (!selected) return
    beginDrag(event, { mode: 'rotate', object: selected, box: displayBox(selected) })
  }

  const onEndpointPointerDown = (event, index) => {
    if (!selected) return
    beginDrag(event, { mode: 'endpoint', index, object: selected })
  }

  const onDragMove = (event) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const point = toView(event)
    const dx = point.x - drag.start.x
    const dy = point.y - drag.start.y
    if (!drag.moved && Math.hypot(dx, dy) * scale < 2) return
    drag.moved = true
    const object = drag.object
    if (drag.mode === 'move') {
      setDraft(moveObject(object, dx, dy))
    } else if (drag.mode === 'resize') {
      const { hx, hy } = drag.handle
      if (object.type === 'text') {
        if (hy === 0) {
          const box = resizeBox(drag.box, hx, 0, dx, dy, { minSize: Math.max(20, (object.fontSize || 12) * 1.5) })
          setDraft(fitTextObject({ ...object, autoWidth: false, x: box.x, y: box.y, width: box.width }))
        } else {
          const box = resizeBox(drag.box, hx, hy, dx, dy, { keepAspect: true, minSize: 8 })
          const factor = box.height / drag.box.height
          const fontSize = Math.max(4, Math.round((object.fontSize || 12) * factor * 2) / 2)
          const next = fitTextObject({ ...object, fontSize, width: object.autoWidth ? object.width : Math.max(20, drag.box.width * factor) })
          setDraft({ ...next, x: box.x, y: box.y })
        }
      } else {
        const keepAspect = object.type === 'image' ? !event.shiftKey : event.shiftKey
        const box = resizeBox(drag.box, hx, hy, dx, dy, { keepAspect, minSize: 4 })
        setDraft(applyBox(object, box))
      }
    } else if (drag.mode === 'rotate') {
      setDraft({ ...object, rotation: rotationFromPointer(drag.box, point, event.shiftKey) })
    } else if (drag.mode === 'endpoint') {
      const points = [...object.points]
      const other = points[1 - drag.index]
      points[drag.index] = event.shiftKey ? snapAngle(other, point) : point
      setDraft({ ...object, points, ...objectBounds({ ...object, points }) })
    }
  }

  const onDragEnd = (event) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    const next = draftRef.current
    setDraft(null)
    if (!drag.moved || !next) return
    const label = { move: 'Move', resize: 'Resize', rotate: 'Rotate', endpoint: 'Adjust line' }[drag.mode] || 'Change'
    onChange(next, `${label} ${objectLabel(next).toLowerCase()}`)
  }

  handlersRef.current = { move: onDragMove, end: onDragEnd }

  // ---------------------------------------------------------------------------
  // Creating objects
  // ---------------------------------------------------------------------------

  const onSurfacePointerDown = (event) => {
    if (event.button !== 0 && event.pointerType === 'mouse') return
    if (busy) return
    if (finishTyping()) return
    const point = toView(event)
    if (tool === 'text') {
      event.preventDefault()
      const size = settings.text.fontSize || 14
      onStartText({
        id: newId('text'), type: 'text', pageIndex, ...settings.text, text: '', autoWidth: true,
        x: Math.max(0, point.x - TEXT_PADDING), y: Math.max(0, point.y - size * 0.75), width: 40, height: size * 1.25, rotation: 0, opacity: 1, isNew: true,
      })
      return
    }
    if (tool === 'note') {
      event.preventDefault()
      onCreate({ id: newId('note'), type: 'note', pageIndex, color: settings.note.color, text: '', x: point.x - 10 * noteZoom, y: point.y - 10 * noteZoom, width: 20, height: 20 }, 'Add comment')
      return
    }
    if (tool === 'signature') {
      event.preventDefault()
      onPlaceSignature?.(point)
      return
    }
    event.preventDefault()
    try { event.currentTarget.setPointerCapture?.(event.pointerId) } catch { /* pointer already gone */ }
    if (tool === 'draw') setCreation({ kind: 'ink', pointerId: event.pointerId, points: [point] })
    else setCreation({ kind: tool === 'whiteout' ? 'whiteout' : settings.shape.shape, pointerId: event.pointerId, start: point, end: point })
  }

  const onSurfacePointerMove = (event) => {
    if (!creation || creation.pointerId !== event.pointerId) return
    const point = toView(event)
    if (creation.kind === 'ink') {
      const last = creation.points.at(-1)
      if (Math.hypot(point.x - last.x, point.y - last.y) < 0.8 / Math.max(scale, 0.25)) return
      setCreation({ ...creation, points: [...creation.points, point] })
    } else {
      let end = point
      if (event.shiftKey) {
        if (creation.kind === 'line' || creation.kind === 'arrow') end = snapAngle(creation.start, point)
        else {
          const size = Math.max(Math.abs(point.x - creation.start.x), Math.abs(point.y - creation.start.y))
          end = { x: creation.start.x + Math.sign(point.x - creation.start.x || 1) * size, y: creation.start.y + Math.sign(point.y - creation.start.y || 1) * size }
        }
      }
      setCreation({ ...creation, end })
    }
  }

  const onSurfacePointerUp = (event) => {
    if (!creation || creation.pointerId !== event.pointerId) return
    try { event.currentTarget.releasePointerCapture?.(event.pointerId) } catch { /* pointer already gone */ }
    const done = creation
    setCreation(null)
    if (done.kind === 'ink') {
      if (done.points.length) onInkStroke(done.points)
      return
    }
    const object = creationObject(done, true)
    if (object) onCreate(object, done.kind === 'whiteout' ? 'Add whiteout' : `Add ${objectLabel(object).toLowerCase()}`)
  }

  function creationObject(state, finalize = false) {
    const { kind, start, end } = state
    const shapeSettings = settings.shape
    if (kind === 'line' || kind === 'arrow') {
      let to = end
      if (finalize && Math.hypot(end.x - start.x, end.y - start.y) < 4) to = { x: start.x + 120, y: start.y }
      const points = [start, to]
      return { id: newId('shape'), type: 'shape', shape: kind, pageIndex, strokeColor: shapeSettings.strokeColor || '#1B2333', strokeWidth: shapeSettings.strokeWidth || 2, dashed: shapeSettings.dashed, opacity: shapeSettings.opacity ?? 1, points, rotation: 0, ...objectBounds({ type: 'shape', shape: kind, points, strokeWidth: shapeSettings.strokeWidth }) }
    }
    let box = { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) }
    if (finalize && box.width < 4 && box.height < 4) box = kind === 'whiteout' ? { x: start.x, y: start.y, width: 120, height: 28 } : { x: start.x, y: start.y, width: 120, height: 80 }
    if (kind === 'whiteout') {
      return { id: newId('whiteout'), type: 'shape', shape: 'rect', whiteout: true, pageIndex, ...box, rotation: 0, strokeColor: null, strokeWidth: 0, fillColor: '#FFFFFF', opacity: 1 }
    }
    return { id: newId('shape'), type: 'shape', shape: kind, pageIndex, ...box, rotation: 0, strokeColor: shapeSettings.strokeColor, strokeWidth: shapeSettings.strokeWidth, fillColor: shapeSettings.fillColor, dashed: shapeSettings.dashed, opacity: shapeSettings.opacity ?? 1 }
  }

  const creationPreview = creation
    ? creation.kind === 'ink'
      ? { id: 'ink-preview', type: 'ink', strokes: [creation.points], color: settings.draw.color, strokeWidth: settings.draw.width, opacity: settings.draw.opacity, ...inkBounds([creation.points], settings.draw.width) }
      : creationObject(creation)
    : null

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const frameBox = selected && !editingObject
    ? { ...displayBox(selected), ...(selected.type === 'note' ? { width: 20 * noteZoom, height: 20 * noteZoom } : {}) }
    : null
  // Thin items (lines of text, rules) get fewer handles so they never pile up.
  const handles = handlesFor(selected).filter((handle) => {
    if (!frameBox) return true
    const widthPx = frameBox.width * scale
    const heightPx = frameBox.height * scale
    if (heightPx < 26 && widthPx < 26) return handle.id === 'se'
    if (heightPx < 26) return handle.hy === 0
    if (widthPx < 26) return handle.hx === 0
    return true
  })
  const showRotate = selected && canRotate(selected) && !selected.locked
  const editing = editingObject && editingObject.pageIndex === pageIndex ? editingObject : null

  // Clicking a comment's icon shows its message beside the icon, inside the page.
  // It is sized for the screen, so it stays readable at any zoom.
  const message = selected?.type === 'note' ? noteMessage(selected) : null
  const messageScale = 1.15
  let messageLeft = 0
  let messageTop = 0
  if (message) {
    const iconLeft = selected.x * scale
    const right = iconLeft + 20 * noteZoom * scale + 6
    const width = message.width * messageScale
    messageLeft = right + width <= pageWidth * scale ? right : Math.max(0, iconLeft - 6 - width)
    messageTop = Math.max(0, Math.min(selected.y * scale, pageHeight * scale - message.height * messageScale))
  }

  return (
    <div ref={rootRef} className={`object-layer ${creating ? 'is-creating' : ''} tool-${tool}`}>
      <svg className="object-svg" viewBox={`0 0 ${pageWidth} ${pageHeight}`} width={pageWidth * scale} height={pageHeight * scale} aria-hidden="true">
        {displayed.map((object) => (
          <ObjectView
            key={object.id}
            object={object}
            interactive={interactiveObjects && !busy && !object.imageTextPatch}
            version={fontVersion}
            hideText={editing?.id === object.id}
            noteZoom={noteZoom}
            onPointerDown={onObjectPointerDown}
            onDoubleClick={onObjectDoubleClick}
          />
        ))}
        {creationPreview && <ObjectView object={creationPreview} interactive={false} />}
      </svg>

      {creating && (
        <div
          className={`create-surface cursor-${tool}`}
          onPointerDown={onSurfacePointerDown}
          onPointerMove={onSurfacePointerMove}
          onPointerUp={onSurfacePointerUp}
          onPointerCancel={() => setCreation(null)}
        />
      )}

      {frameBox && (
        <div
          className={`selection-frame ${selected.locked ? 'is-locked' : ''} type-${selected.type}`}
          style={{
            left: `${frameBox.x * scale}px`,
            top: `${frameBox.y * scale}px`,
            width: `${frameBox.width * scale}px`,
            height: `${frameBox.height * scale}px`,
            transform: frameBox.rotation ? `rotate(${frameBox.rotation}deg)` : undefined,
          }}
        >
          {interactiveObjects && !isLineShape(selected) && (
            <div className="frame-body" onPointerDown={(event) => onObjectPointerDown(event, selected)} onDoubleClick={(event) => onObjectDoubleClick(event, selected)} />
          )}
          {interactiveObjects && handles.map((handle) => (
            <span
              key={handle.id}
              className={`frame-handle h-${handle.id}`}
              onPointerDown={(event) => onHandlePointerDown(event, handle)}
            />
          ))}
          {interactiveObjects && showRotate && (
            <span className="frame-rotate" onPointerDown={onRotatePointerDown} title="Rotate (Shift snaps to 15°)" />
          )}
        </div>
      )}

      {message && (
        <div
          className="note-message"
          style={{
            left: `${messageLeft}px`,
            top: `${messageTop}px`,
            width: `${message.width * messageScale}px`,
            minHeight: `${message.height * messageScale}px`,
            padding: `${message.padding * messageScale}px`,
            fontSize: `${message.fontSize * messageScale}px`,
            lineHeight: message.lineHeight,
            color: message.color,
            background: message.background,
          }}
        >{message.text}</div>
      )}

      {selected && isLineShape(selected) && interactiveObjects && !selected.locked && selected.points.map((point, index) => (
        <span
          key={index}
          className="endpoint-handle"
          style={{ left: `${point.x * scale}px`, top: `${point.y * scale}px` }}
          onPointerDown={(event) => onEndpointPointerDown(event, index)}
        />
      ))}
      {selected && isLineShape(selected) && interactiveObjects && (
        <svg className="object-drag-proxy" viewBox={`0 0 ${pageWidth} ${pageHeight}`} width={pageWidth * scale} height={pageHeight * scale}>
          <line
            x1={selected.points[0].x} y1={selected.points[0].y} x2={selected.points[1].x} y2={selected.points[1].y}
            strokeWidth={Math.max(12, (selected.strokeWidth || 2) + 10)}
            onPointerDown={(event) => onObjectPointerDown(event, selected)}
          />
        </svg>
      )}

      {editing && (
        <TextEditor
          key={editing.id}
          object={editing}
          scale={scale}
          onDraft={onTextDraft}
          onCommit={(text) => onTextCommit(editing, text)}
        />
      )}
    </div>
  )
}
