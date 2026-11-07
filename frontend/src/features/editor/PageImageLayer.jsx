import { useEffect, useRef, useState } from 'react'
import { resizeBox } from './objectFactory.js'

const HANDLES = [
  { id: 'nw', hx: -1, hy: -1 }, { id: 'n', hx: 0, hy: -1 }, { id: 'ne', hx: 1, hy: -1 }, { id: 'e', hx: 1, hy: 0 },
  { id: 'se', hx: 1, hy: 1 }, { id: 's', hx: 0, hy: 1 }, { id: 'sw', hx: -1, hy: 1 }, { id: 'w', hx: -1, hy: 0 },
]

function cropCanvas(canvas, rect, scale) {
  try {
    if (!canvas?.width) return ''
    const ratio = canvas.width / (parseFloat(canvas.style.width) || canvas.width)
    const sx = Math.max(0, Math.floor(rect.x * scale * ratio))
    const sy = Math.max(0, Math.floor(rect.y * scale * ratio))
    const sw = Math.min(canvas.width - sx, Math.ceil(rect.width * scale * ratio))
    const sh = Math.min(canvas.height - sy, Math.ceil(rect.height * scale * ratio))
    if (sw < 1 || sh < 1) return ''
    const crop = document.createElement('canvas')
    crop.width = sw
    crop.height = sh
    crop.getContext('2d').drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh)
    return crop.toDataURL('image/png')
  } catch {
    return ''
  }
}

const px = (rect, scale) => ({ left: `${rect.x * scale}px`, top: `${rect.y * scale}px`, width: `${rect.width * scale}px`, height: `${rect.height * scale}px` })

/** Pictures that are part of the original PDF page (Edit tool). */
export function PageImageLayer({ images, scale, canvas, selectedKey, busy, onSelect, onTransform }) {
  const rootRef = useRef(null)
  const dragRef = useRef(null)
  const [draft, setDraft] = useState(null)
  const [pending, setPending] = useState(null)
  const draftRef = useRef(null)

  useEffect(() => { setPending(null) }, [images])

  const toView = (event) => {
    const rect = rootRef.current.getBoundingClientRect()
    return { x: (event.clientX - rect.left) / scale, y: (event.clientY - rect.top) / scale }
  }

  const begin = (event, image, handle = null) => {
    if (event.button !== 0 && event.pointerType === 'mouse') return
    event.stopPropagation()
    event.preventDefault()
    onSelect(image)
    if (!image.editable || busy) return
    dragRef.current = { image, handle, start: toView(event), moved: false, ghost: null, pointerId: event.pointerId }
    const move = (moveEvent) => {
      const drag = dragRef.current
      if (!drag || moveEvent.pointerId !== drag.pointerId) return
      const point = toView(moveEvent)
      const dx = point.x - drag.start.x
      const dy = point.y - drag.start.y
      if (!drag.moved && Math.hypot(dx, dy) * scale < 3) return
      if (!drag.moved) drag.ghost = cropCanvas(canvas, drag.image.viewRect, scale)
      drag.moved = true
      const from = drag.image.viewRect
      const rect = drag.handle
        ? resizeBox({ ...from, rotation: 0 }, drag.handle.hx, drag.handle.hy, dx, dy, { keepAspect: !moveEvent.shiftKey, minSize: 4 })
        : { ...from, x: from.x + dx, y: from.y + dy }
      draftRef.current = { key: drag.image.key, rect, ghost: drag.ghost }
      setDraft(draftRef.current)
    }
    const up = (upEvent) => {
      if (upEvent.pointerId !== event.pointerId) return
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      const drag = dragRef.current
      dragRef.current = null
      const result = draftRef.current
      draftRef.current = null
      setDraft(null)
      if (drag?.moved && result && upEvent.type !== 'pointercancel') {
        setPending({ ...result, from: drag.image.viewRect })
        onTransform(drag.image, result.rect)
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  const preview = draft || pending
  const previewImage = preview ? images.find((image) => image.key === preview.key) : null

  return (
    <div ref={rootRef} className={`page-image-layer ${busy ? 'is-busy' : ''}`}>
      {images.map((image) => (
        <div
          key={image.key}
          className={`page-image-hit ${image.key === selectedKey ? 'is-selected' : ''} ${image.editable ? '' : 'is-locked'}`}
          style={px(image.viewRect, scale)}
          title={image.editable ? 'Drag to move · use the corners to resize' : image.reason}
          onPointerDown={(event) => begin(event, image)}
        />
      ))}
      {previewImage && (
        <>
          <div className="page-image-mask" style={px(pending?.from || previewImage.viewRect, scale)} />
          {preview.ghost && <img className="page-image-ghost" src={preview.ghost} alt="" style={px(preview.rect, scale)} />}
        </>
      )}
      {images.filter((image) => image.key === selectedKey).map((image) => {
        const rect = draft?.key === image.key ? draft.rect : pending?.key === image.key ? pending.rect : image.viewRect
        return (
          <div key={`frame-${image.key}`} className={`selection-frame image-frame ${image.editable ? '' : 'is-locked'}`} style={px(rect, scale)}>
            {image.editable && <div className="frame-body" onPointerDown={(event) => begin(event, image)} />}
            {image.editable && !busy && HANDLES.filter((handle) => (rect.height * scale < 26 ? handle.hy === 0 : true) && (rect.width * scale < 26 ? handle.hx === 0 : true)).map((handle) => (
              <span key={handle.id} className={`frame-handle h-${handle.id}`} onPointerDown={(event) => begin(event, image, handle)} />
            ))}
          </div>
        )
      })}
    </div>
  )
}
