import { useEffect, useRef, useState } from 'react'
import { FaFilePdf, FaSpinner } from 'react-icons/fa'

export function PdfPageThumbnail({ session, pageIndex, active = false, onClick }) {
  const buttonRef = useRef(null)
  const canvasRef = useRef(null)
  const [status, setStatus] = useState('idle')

  useEffect(() => {
    if (!session || !buttonRef.current || !canvasRef.current) return undefined

    let cancelled = false
    let started = false
    let observer
    const visibleCanvas = canvasRef.current
    visibleCanvas.width = 0
    visibleCanvas.height = 0
    setStatus('idle')

    const render = async () => {
      if (started || cancelled || !visibleCanvas) return
      started = true
      setStatus('loading')
      const renderCanvas = document.createElement('canvas')

      try {
        const pageInfo = await session.getPageInfo(pageIndex)
        if (cancelled) return
        const scale = Math.min(0.22, 112 / Math.max(1, pageInfo.width))
        await session.renderPage(pageIndex, renderCanvas, { scale, dpr: 1 })
        if (cancelled || !canvasRef.current) return

        visibleCanvas.width = renderCanvas.width
        visibleCanvas.height = renderCanvas.height
        const context = visibleCanvas.getContext('2d', { alpha: false })
        if (!context) throw new Error('The browser could not create a thumbnail canvas context.')
        context.drawImage(renderCanvas, 0, 0)
        setStatus('ready')
      } catch {
        if (!cancelled) setStatus('error')
      } finally {
        renderCanvas.width = 0
        renderCanvas.height = 0
      }
    }

    if (typeof IntersectionObserver === 'undefined') {
      void render()
    } else {
      observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void render()
          observer?.disconnect()
        }
      }, {
        root: buttonRef.current.closest('.pages-list'),
        rootMargin: '100px 0px',
      })
      observer.observe(buttonRef.current)
    }

    return () => {
      cancelled = true
      observer?.disconnect()
      visibleCanvas.width = 0
      visibleCanvas.height = 0
    }
  }, [session, pageIndex])

  return (
    <button
      ref={buttonRef}
      type="button"
      className={`page-thumb ${active ? 'active' : ''}`}
      onClick={onClick}
      aria-label={`Go to page ${pageIndex + 1}`}
      aria-current={active ? 'page' : undefined}
    >
      <span className="page-thumb-preview">
        <canvas ref={canvasRef} className="earthix-thumbnail-canvas" aria-hidden="true" />
        {status === 'loading' && <FaSpinner className="thumbnail-spinner spin" aria-label="Rendering thumbnail" />}
        {status === 'error' && <FaFilePdf className="thumbnail-error-icon" aria-label="Thumbnail unavailable" />}
        {status === 'idle' && <span className="thumb-placeholder"><i /><i /><i /><i /></span>}
      </span>
      <small>{pageIndex + 1}</small>
    </button>
  )
}
