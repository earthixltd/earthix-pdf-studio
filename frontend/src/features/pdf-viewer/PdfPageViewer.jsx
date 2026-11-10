import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { TextLayer } from 'pdfjs-dist'
import 'pdfjs-dist/web/pdf_viewer.css'
import { FaFilePdf, FaSpinner } from 'react-icons/fa'
import { calculatePdfZoom, clampPdfZoom } from './zoomMath.js'
import { applySearchHighlights } from './applySearchHighlights.js'
import { InlineTextEditor } from '../text-editor/InlineTextEditor.jsx'
import { viewportRect } from '../text-editor/blockGeometry.js'
import { warmPreviewFonts } from '../../engine/font-engine/previewFonts.js'
import './pdf-viewer.css'

const MAX_DEVICE_PIXEL_RATIO = 2

function hitRect(block, viewport) {
  const rect = viewportRect(viewport, block.bbox)
  const pad = 1
  return { left: rect.left - pad, top: rect.top - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }
}

export function PdfPageViewer({
  session,
  pageIndex = 0,
  zoomMode = 'width',
  zoom = 1,
  searchQuery = '',
  searchItemIndexes = [],
  editMode = false,
  textBlocks = [],
  activeBlock = null,
  activeClickPoint = null,
  editBusy = false,
  onBlockActivate,
  onBlockCommit,
  onBlockCancel,
  onDraftChange,
  onPageRendered,
  onZoomChange,
  onTextSelected,
  onRenderError,
  renderOverlay,
  textLayerActive = true,
  selectedBlockKey = null,
  onPinchZoom,
  scrollRestoreRef = null,
  onScrollChange,
}) {
  const viewportRef = useRef(null)
  const pageHostRef = useRef(null)
  const textLayerRef = useRef(null)
  const canvasRef = useRef(null)
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 })
  const [renderState, setRenderState] = useState('idle')
  const [renderError, setRenderError] = useState('')
  const [pageScale, setPageScale] = useState(1)
  const [pageViewport, setPageViewport] = useState(null)
  const [renderedPageIndex, setRenderedPageIndex] = useState(null)
  const [textMatchCount, setTextMatchCount] = useState(0)
  const searchQueryRef = useRef(searchQuery)
  const searchItemIndexesRef = useRef(searchItemIndexes)
  const onPageRenderedRef = useRef(onPageRendered)
  searchQueryRef.current = searchQuery
  searchItemIndexesRef.current = searchItemIndexes
  onPageRenderedRef.current = onPageRendered
  // Latest callbacks, kept out of the render effect so that unrelated app
  // updates (selecting an item, typing) never redraw the page.
  const callbacksRef = useRef({})
  callbacksRef.current = { onZoomChange, onTextSelected, onRenderError }
  const scrollAreaRef = useRef(null)
  const lastPageRef = useRef(null)

  const measureViewport = useCallback(() => {
    const element = viewportRef.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    const nextSize = { width: Math.floor(rect.width), height: Math.floor(rect.height) }
    setViewportSize((previous) => (
      previous.width === nextSize.width && previous.height === nextSize.height ? previous : nextSize
    ))
  }, [])

  useEffect(() => {
    measureViewport()
    const element = viewportRef.current
    if (!element || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(measureViewport)
    observer.observe(element)
    return () => observer.disconnect()
  }, [measureViewport])

  useEffect(() => {
    if (!session || !pageHostRef.current || viewportSize.width < 1 || viewportSize.height < 1) return undefined

    let cancelled = false
    let textLayer = null
    let pageProxy = null
    let selectionHandler = null
    let textLayerElement = null
    setRenderState('loading')
    setRenderError('')
    setTextMatchCount(0)
    textLayerRef.current = null

    // The previous rendering stays visible until the new one is ready, so a
    // text edit never flashes an empty page.
    const render = async () => {
      try {
        pageProxy = await session.pdfJsDocument.getPage(pageIndex + 1)
        if (cancelled) return

        const unitViewport = pageProxy.getViewport({ scale: 1 })
        const scale = calculatePdfZoom({
          mode: zoomMode,
          containerWidth: viewportSize.width,
          containerHeight: viewportSize.height,
          pageWidth: unitViewport.width,
          pageHeight: unitViewport.height,
          manualZoom: zoom,
        })
        const viewport = pageProxy.getViewport({ scale })
        const canvas = document.createElement('canvas')
        const dpr = Math.min(globalThis.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO)

        await session.renderPage(pageIndex, canvas, { scale, dpr })
        if (cancelled || !pageHostRef.current) return

        canvas.className = 'earthix-pdf-canvas'
        canvas.style.width = `${viewport.width}px`
        canvas.style.height = `${viewport.height}px`
        canvas.setAttribute('role', 'img')
        canvas.setAttribute('aria-label', `Rendered PDF page ${pageIndex + 1}`)

        textLayerElement = document.createElement('div')
        textLayerElement.className = 'textLayer earthix-pdf-text-layer'
        textLayerElement.style.width = `${viewport.width}px`
        textLayerElement.style.height = `${viewport.height}px`
        textLayerElement.style.setProperty('--total-scale-factor', String(scale))
        textLayerElement.setAttribute('role', 'group')
        textLayerElement.setAttribute('aria-label', `Selectable text on page ${pageIndex + 1}`)

        // Show the page right away; the selectable text layer follows.
        pageHostRef.current.style.width = `${viewport.width}px`
        pageHostRef.current.style.height = `${viewport.height}px`
        pageHostRef.current.replaceChildren(canvas, textLayerElement)
        canvasRef.current = canvas
        setPageScale(scale)
        setPageViewport(viewport)
        setRenderedPageIndex(pageIndex)
        callbacksRef.current.onZoomChange?.(scale)
        setRenderState('ready')
        onPageRenderedRef.current?.(pageIndex)

        const area = scrollAreaRef.current
        if (area && scrollRestoreRef?.current) {
          const saved = scrollRestoreRef.current
          scrollRestoreRef.current = null
          area.scrollTop = saved.top || 0
          area.scrollLeft = saved.left || 0
        } else if (area && lastPageRef.current !== null && lastPageRef.current !== pageIndex) {
          area.scrollTop = 0
        }
        lastPageRef.current = pageIndex

        const textContent = await pageProxy.getTextContent({
          includeMarkedContent: false,
          disableNormalization: true,
        })
        if (cancelled || !pageHostRef.current) return

        textLayer = new TextLayer({
          textContentSource: textContent,
          container: textLayerElement,
          viewport,
        })
        textLayerRef.current = textLayer
        await textLayer.render()
        if (cancelled) return

        const matches = applySearchHighlights(textLayer, searchQueryRef.current, searchItemIndexesRef.current)
        setTextMatchCount(matches)
        selectionHandler = () => {
          const selectedText = globalThis.getSelection?.()?.toString()?.trim() || ''
          callbacksRef.current.onTextSelected?.(selectedText)
        }
        textLayerElement.addEventListener('mouseup', selectionHandler)
      } catch (error) {
        if (cancelled) return
        const message = error?.message || 'This PDF page could not be rendered.'
        setRenderError(message)
        setRenderState('error')
        callbacksRef.current.onRenderError?.(error)
      }
    }

    void render()

    return () => {
      cancelled = true
      if (selectionHandler && textLayerElement) textLayerElement.removeEventListener('mouseup', selectionHandler)
      textLayerRef.current = null
      textLayer?.cancel?.()
      pageProxy?.cleanup?.()
    }
    // `zoom` only matters in manual mode; fit modes report it back after drawing.
  }, [session, pageIndex, zoomMode, zoomMode === 'manual' ? zoom : null, viewportSize.width, viewportSize.height])

  // Pinch (touch) and Ctrl+scroll (trackpad pinch) zoom the PDF, not the whole app,
  // so toolbars and selection handles keep their size.
  const pinchZoomRef = useRef(onPinchZoom)
  pinchZoomRef.current = onPinchZoom
  useEffect(() => {
    const element = viewportRef.current
    if (!element) return undefined
    let wheelFactor = 1
    let wheelTimer = null
    const onWheel = (event) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      wheelFactor *= Math.exp(-event.deltaY * 0.0045)
      window.clearTimeout(wheelTimer)
      wheelTimer = window.setTimeout(() => {
        const factor = wheelFactor
        wheelFactor = 1
        if (Math.abs(factor - 1) > 0.01) pinchZoomRef.current?.(factor)
      }, 90)
    }
    const touches = new Map()
    let startDistance = 0
    let page = null
    const distance = () => {
      const [a, b] = [...touches.values()]
      return Math.hypot(a.x - b.x, a.y - b.y)
    }
    const onPointerDown = (event) => {
      if (event.pointerType !== 'touch') return
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (touches.size === 2) {
        startDistance = distance()
        page = element.querySelector('.earthix-pdf-page')
        if (page) page.style.transformOrigin = 'center top'
      }
    }
    const onPointerMove = (event) => {
      if (!touches.has(event.pointerId)) return
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (touches.size === 2 && startDistance > 0 && page) {
        const ratio = Math.max(0.4, Math.min(3, distance() / startDistance))
        page.style.transform = `scale(${ratio})`
      }
    }
    const onPointerUp = (event) => {
      if (!touches.has(event.pointerId)) return
      if (touches.size === 2 && startDistance > 0) {
        const ratio = distance() / startDistance
        if (page) page.style.transform = ''
        if (Math.abs(ratio - 1) > 0.04) pinchZoomRef.current?.(Math.max(0.4, Math.min(3, ratio)))
        startDistance = 0
        page = null
      }
      touches.delete(event.pointerId)
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    element.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('pointermove', onPointerMove, true)
    window.addEventListener('pointerup', onPointerUp, true)
    window.addEventListener('pointercancel', onPointerUp, true)
    return () => {
      window.clearTimeout(wheelTimer)
      element.removeEventListener('wheel', onWheel)
      element.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('pointermove', onPointerMove, true)
      window.removeEventListener('pointerup', onPointerUp, true)
      window.removeEventListener('pointercancel', onPointerUp, true)
    }
  }, [])

  useEffect(() => {
    if (session) return
    pageHostRef.current?.replaceChildren()
    canvasRef.current = null
    setPageViewport(null)
    setRenderedPageIndex(null)
  }, [session])

  useEffect(() => {
    if (!textLayerRef.current) return
    setTextMatchCount(applySearchHighlights(textLayerRef.current, searchQuery, searchItemIndexes))
  }, [searchQuery, searchItemIndexes])

  const pageBlocks = useMemo(() => textBlocks.filter((block) => block.pageIndex === pageIndex), [textBlocks, pageIndex])
  const showEditLayer = editMode && pageViewport && renderedPageIndex === pageIndex && renderState !== 'error'

  // Once the page is on screen, quietly get its real fonts ready for typing.
  useEffect(() => {
    if (!showEditLayer || !session || !pageBlocks.length) return undefined
    const timer = window.setTimeout(() => { void warmPreviewFonts(session, pageBlocks) }, 150)
    return () => window.clearTimeout(timer)
  }, [showEditLayer, session, pageBlocks])
  const editorBlock = activeBlock && activeBlock.pageIndex === pageIndex ? activeBlock : null

  return (
    <div className="earthix-pdf-viewer" ref={viewportRef} role="region" aria-label="PDF viewer" aria-busy={renderState === 'loading'}>
      {!session && (
        <div className="earthix-viewer-empty">
          <span><FaFilePdf /></span>
          <strong>No PDF opened</strong>
          <small>Choose a PDF to view its pages.</small>
        </div>
      )}
      {session && (
        <div
          className="earthix-pdf-scroll-area"
          ref={scrollAreaRef}
          onScroll={(event) => onScrollChange?.({ top: event.currentTarget.scrollTop, left: event.currentTarget.scrollLeft })}
        >
          <div
            className={`earthix-pdf-page ${editMode ? 'is-editing' : ''} ${editBusy ? 'is-busy' : ''} ${textLayerActive ? '' : 'text-layer-off'}`}
            style={pageViewport ? { width: `${pageViewport.width}px`, height: `${pageViewport.height}px` } : undefined}
          >
            <div className="earthix-pdf-surface" ref={pageHostRef} />
            {showEditLayer && (
              <div className="earthix-edit-layer" aria-label="Editable PDF text">
                {pageBlocks.map((block) => {
                  if (editorBlock && editorBlock.key === block.key) return null
                  const rect = hitRect(block, pageViewport)
                  return (
                    <div
                      key={block.key}
                      className={`earthix-text-hit ${block.editable ? '' : 'is-locked'} ${block.key === selectedBlockKey ? 'is-selected' : ''}`}
                      style={{ left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` }}
                      title={block.editable ? 'Click to edit this text' : block.reason}
                      onMouseDown={(event) => {
                        if (event.button !== 0) return
                        onBlockActivate?.(block, { clientX: event.clientX, clientY: event.clientY }, event)
                      }}
                    />
                  )
                })}
                {editorBlock && (
                  <InlineTextEditor
                    key={editorBlock.key}
                    session={session}
                    block={editorBlock}
                    viewport={pageViewport}
                    canvas={canvasRef.current}
                    clickPoint={activeClickPoint}
                    busy={editBusy}
                    onCommit={(text) => onBlockCommit?.(editorBlock, text)}
                    onCancel={() => onBlockCancel?.(editorBlock)}
                    onDraftChange={onDraftChange}
                  />
                )}
              </div>
            )}
            {pageViewport && renderedPageIndex === pageIndex && renderState !== 'error' && renderOverlay?.({ viewport: pageViewport, scale: pageScale, canvas: canvasRef.current, pageIndex })}
          </div>
        </div>
      )}
      {session && renderState === 'loading' && (
        <div className="earthix-viewer-status" role="status">
          <FaSpinner className="spin" />
          <span>Rendering page {pageIndex + 1}…</span>
        </div>
      )}
      {session && renderState === 'error' && (
        <div className="earthix-viewer-error" role="alert">
          <FaFilePdf />
          <strong>Page could not be rendered</strong>
          <span>{renderError}</span>
        </div>
      )}
      {session && renderState === 'ready' && searchQuery.trim() && textMatchCount > 0 && (
        <div className="earthix-viewer-search-count" role="status">{textMatchCount} text run(s) highlighted</div>
      )}
      {session && renderState === 'ready' && (
        <span className="earthix-viewer-zoom-status" aria-live="polite">{Math.round(clampPdfZoom(pageScale) * 100)}%</span>
      )}
    </div>
  )
}
