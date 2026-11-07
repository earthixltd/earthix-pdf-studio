import { useCallback, useEffect, useRef, useState } from 'react'
import { TextLayer } from 'pdfjs-dist'
import 'pdfjs-dist/web/pdf_viewer.css'
import { FaFilePdf, FaSpinner } from 'react-icons/fa'
import { calculatePdfZoom, clampPdfZoom } from './zoomMath.js'
import { applySearchHighlights } from './applySearchHighlights.js'
import './pdf-viewer.css'

const MAX_DEVICE_PIXEL_RATIO = 2


export function PdfPageViewer({
  session,
  pageIndex = 0,
  zoomMode = 'width',
  zoom = 1,
  searchQuery = '',
  searchItemIndexes = [],
  engineStatus = 'loading',
  onZoomChange,
  onTextSelected,
  onTextObjectClick,
  onRenderError,
}) {
  const viewportRef = useRef(null)
  const pageHostRef = useRef(null)
  const textLayerRef = useRef(null)
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 })
  const [renderState, setRenderState] = useState('idle')
  const [renderError, setRenderError] = useState('')
  const [pageScale, setPageScale] = useState(1)
  const [textMatchCount, setTextMatchCount] = useState(0)
  const searchQueryRef = useRef(searchQuery)
  const searchItemIndexesRef = useRef(searchItemIndexes)
  searchQueryRef.current = searchQuery
  searchItemIndexesRef.current = searchItemIndexes

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
    setRenderState('loading')
    setRenderError('')
    setTextMatchCount(0)
    textLayerRef.current = null
    pageHostRef.current.replaceChildren()

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

        const textLayerElement = document.createElement('div')
        textLayerElement.className = 'textLayer earthix-pdf-text-layer'
        textLayerElement.style.width = `${viewport.width}px`
        textLayerElement.style.height = `${viewport.height}px`
        textLayerElement.style.setProperty('--total-scale-factor', String(scale))
        textLayerElement.setAttribute('role', 'group')
        textLayerElement.setAttribute('aria-label', `Selectable text on page ${pageIndex + 1}`)

        pageHostRef.current.style.width = `${viewport.width}px`
        pageHostRef.current.style.height = `${viewport.height}px`
        pageHostRef.current.replaceChildren(canvas, textLayerElement)

        const textContent = await pageProxy.getTextContent({
          includeMarkedContent: false,
          disableNormalization: true,
        })
        if (cancelled) return

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
          onTextSelected?.(selectedText)
        }
        const textObjectClickHandler = (event) => {
          const target = event.target instanceof HTMLElement ? event.target.closest('span') : null
          if (!target || !textLayerElement.contains(target)) return
          const text = target.textContent?.replace(/\s+/g, ' ').trim() || ''
          if (text) onTextObjectClick?.({ pageIndex, text })
        }
        textLayerElement.addEventListener('mouseup', selectionHandler)
        textLayerElement.addEventListener('click', textObjectClickHandler)
        textLayerElement.__earthixTextObjectClickHandler = textObjectClickHandler

        setPageScale(scale)
        onZoomChange?.(scale)
        setRenderState('ready')
      } catch (error) {
        if (cancelled) return
        const message = error?.message || 'This PDF page could not be rendered.'
        setRenderError(message)
        setRenderState('error')
        onRenderError?.(error)
      }
    }

    void render()

    return () => {
      cancelled = true
      if (selectionHandler && pageHostRef.current) {
        const layer = pageHostRef.current.querySelector('.earthix-pdf-text-layer')
        layer?.removeEventListener('mouseup', selectionHandler)
        if (layer?.__earthixTextObjectClickHandler) {
          layer.removeEventListener('click', layer.__earthixTextObjectClickHandler)
          delete layer.__earthixTextObjectClickHandler
        }
      }
      textLayerRef.current = null
      textLayer?.cancel?.()
      pageProxy?.cleanup?.()
      pageHostRef.current?.replaceChildren()
    }
  }, [session, pageIndex, zoomMode, zoom, viewportSize.width, viewportSize.height, engineStatus, onRenderError, onTextSelected, onTextObjectClick, onZoomChange])

  useEffect(() => {
    if (!textLayerRef.current) return
    setTextMatchCount(applySearchHighlights(textLayerRef.current, searchQuery, searchItemIndexes))
  }, [searchQuery, searchItemIndexes])

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
        <div className="earthix-pdf-scroll-area">
          <div className="earthix-pdf-page" ref={pageHostRef} />
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
