import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { FaSpinner } from 'react-icons/fa'
import { blockViewGeometry } from './blockGeometry.js'
import { peekPreviewFont, previewFontFamily } from '../../engine/font-engine/previewFonts.js'
import './InlineTextEditor.css'

function sampleBackground(canvas, rect) {
  try {
    const context = canvas?.getContext('2d')
    if (!context || !canvas.width) return '#ffffff'
    const ratio = canvas.width / (parseFloat(canvas.style.width) || canvas.width)
    const margin = 3
    const x0 = Math.max(0, Math.floor((rect.left - margin) * ratio))
    const y0 = Math.max(0, Math.floor((rect.top - margin) * ratio))
    const x1 = Math.min(canvas.width - 1, Math.ceil((rect.left + rect.width + margin) * ratio))
    const y1 = Math.min(canvas.height - 1, Math.ceil((rect.top + rect.height + margin) * ratio))
    if (x1 <= x0 || y1 <= y0) return '#ffffff'
    // One readback of the area around the text; sample its border ring.
    const { data, width, height } = context.getImageData(x0, y0, x1 - x0 + 1, y1 - y0 + 1)
    const counts = new Map()
    const sample = (x, y) => {
      const offset = (y * width + x) * 4
      const color = [data[offset], data[offset + 1], data[offset + 2]]
      const key = color.map((value) => value >> 3).join(',')
      const entry = counts.get(key) || { count: 0, color }
      entry.count += 1
      counts.set(key, entry)
    }
    for (let step = 0; step <= 12; step += 1) {
      const x = Math.round(((width - 1) * step) / 12)
      sample(x, 0)
      sample(x, height - 1)
    }
    for (let step = 0; step <= 4; step += 1) {
      const y = Math.round(((height - 1) * step) / 4)
      sample(0, y)
      sample(width - 1, y)
    }
    const best = [...counts.values()].sort((a, b) => b.count - a.count)[0]
    return best ? `rgb(${best.color.join(',')})` : '#ffffff'
  } catch {
    return '#ffffff'
  }
}

function placeCaret(element, clickPoint) {
  const selection = globalThis.getSelection?.()
  if (!selection) return
  let range = null
  if (clickPoint) {
    if (document.caretPositionFromPoint) {
      const position = document.caretPositionFromPoint(clickPoint.clientX, clickPoint.clientY)
      if (position && element.contains(position.offsetNode)) {
        range = document.createRange()
        range.setStart(position.offsetNode, position.offset)
      }
    } else if (document.caretRangeFromPoint) {
      const candidate = document.caretRangeFromPoint(clickPoint.clientX, clickPoint.clientY)
      if (candidate && element.contains(candidate.startContainer)) range = candidate
    }
  }
  if (!range) {
    range = document.createRange()
    range.selectNodeContents(element)
    range.collapse(false)
  }
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
}

const readText = (element) => (element?.textContent || '').replace(/\u00a0/g, ' ').replace(/[\r\n]+/g, ' ')

/**
 * In-place text editor drawn exactly over the original PDF text. The original
 * glyphs are masked with the sampled page background while typing so only one
 * copy is ever visible; the PDF itself is rewritten when the edit is committed.
 */
export function InlineTextEditor({ session, block, viewport, canvas, clickPoint, busy = false, onCommit, onCancel, onDraftChange }) {
  const elementRef = useRef(null)
  const finishedRef = useRef(false)
  const geometry = useMemo(() => blockViewGeometry(block, viewport), [block, viewport])
  const background = useMemo(() => sampleBackground(canvas, geometry.rect), [canvas, geometry])
  const [previewFamily, setPreviewFamily] = useState(() => peekPreviewFont(block))
  const [baselineFix, setBaselineFix] = useState(0)

  useEffect(() => {
    let active = true
    void previewFontFamily(session, block).then((family) => { if (active) setPreviewFamily(family) }).catch(() => undefined)
    return () => { active = false }
  }, [session, block])

  useLayoutEffect(() => {
    const element = elementRef.current
    if (!element) return
    element.textContent = block.text
    element.focus({ preventScroll: true })
    placeCaret(element, clickPoint)
    finishedRef.current = false
  }, [block, clickPoint])

  useEffect(() => {
    if (!busy) finishedRef.current = false
  }, [busy])

  // Every font sits differently in its line box; put its baseline exactly on the PDF's.
  useLayoutEffect(() => {
    const element = elementRef.current
    if (!element) return
    const marker = document.createElement('span')
    marker.style.cssText = 'display:inline-block;width:0;height:0'
    element.appendChild(marker)
    setBaselineFix(geometry.ascentPx - (marker.offsetTop + marker.offsetHeight))
    marker.remove()
  }, [geometry, previewFamily])

  const finish = (commit) => {
    if (finishedRef.current || busy) return
    finishedRef.current = true
    const text = readText(elementRef.current)
    if (commit && text !== block.text) onCommit?.(text)
    else onCancel?.()
  }

  const handleKeyDown = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      finish(true)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      finish(false)
    } else if (event.key === 'Tab') {
      event.preventDefault()
      finish(true)
    }
    event.stopPropagation()
  }

  const handlePaste = (event) => {
    event.preventDefault()
    const text = (event.clipboardData?.getData('text/plain') || '').replace(/[\r\n\t]+/g, ' ')
    if (!document.execCommand?.('insertText', false, text)) {
      const selection = globalThis.getSelection()
      if (!selection?.rangeCount) return
      const range = selection.getRangeAt(0)
      range.deleteContents()
      range.insertNode(document.createTextNode(text))
      range.collapse(false)
    }
    onDraftChange?.(readText(elementRef.current))
  }

  // A copy printed slightly off to the side thickens the letters; an exact copy does not.
  const fakeBold = block.twinBlocks?.some((twin) => Math.abs(twin.startPoint.x - block.startPoint.x) + Math.abs(twin.startPoint.y - block.startPoint.y) > 0.01)
  const style = {
    left: `${geometry.origin.x}px`,
    top: `${geometry.origin.y}px`,
    transform: `rotate(${geometry.angle}deg) translateY(${baselineFix - geometry.ascentPx}px)${geometry.horizontalScale !== 1 ? ` scaleX(${geometry.horizontalScale})` : ''}`,
    height: `${geometry.heightPx}px`,
    lineHeight: `${geometry.heightPx}px`,
    minWidth: `${geometry.widthPx}px`,
    fontSize: `${geometry.fontPx}px`,
    // The PDF's own font already carries its weight and slant, so the browser must not add more.
    fontFamily: previewFamily ? `"${previewFamily}", ${block.cssFontStack}` : block.cssFontStack,
    fontWeight: previewFamily ? (fakeBold ? 700 : 400) : block.fontWeight,
    fontStyle: previewFamily ? 'normal' : block.fontStyle,
    letterSpacing: geometry.letterSpacingPx ? `${geometry.letterSpacingPx}px` : undefined,
    color: block.fillColor || '#000000',
    backgroundColor: background,
    boxShadow: `0 0 0 1px ${background}`,
  }

  return (
    <>
      <div
        ref={elementRef}
        className={`earthix-inline-editor ${busy ? 'is-busy' : ''}`}
        style={style}
        contentEditable={!busy}
        suppressContentEditableWarning
        spellCheck={false}
        role="textbox"
        aria-label="Edit PDF text"
        onKeyDown={handleKeyDown}
        onBlur={() => finish(true)}
        onPaste={handlePaste}
        onDrop={(event) => event.preventDefault()}
        onInput={() => onDraftChange?.(readText(elementRef.current))}
      />
      {busy && (
        <span className="earthix-inline-editor-status" style={{ left: `${geometry.rect.left}px`, top: `${geometry.rect.top + geometry.rect.height + 6}px` }}>
          <FaSpinner className="spin" /> Saving into PDF…
        </span>
      )}
    </>
  )
}
