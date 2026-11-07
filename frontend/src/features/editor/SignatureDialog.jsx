import { useEffect, useRef, useState } from 'react'
import { FaPenNib, FaTimes, FaUpload } from 'react-icons/fa'
import { segmentsToSvg, strokeSegments } from '../../engine/page-objects/shapePaths.js'
import { importImageFile, renderTextImage } from './imageImport.js'

const STORAGE_KEY = 'earthix.signature.v1'
const SCRIPT_FONTS = [
  '"Segoe Script", "Brush Script MT", "Snell Roundhand", cursive',
  '"Lucida Handwriting", "Apple Chancery", cursive',
  '"Ink Free", "Bradley Hand", "Comic Sans MS", cursive',
  '"Freestyle Script", "Edwardian Script ITC", "Brush Script MT", cursive',
]
const INK_COLORS = ['#1B2333', '#1D3FB8', '#0E7090']

export function loadSavedSignature() {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) || 'null')
    return value && (value.kind === 'draw' || value.kind === 'type') ? value : null
  } catch {
    return null
  }
}

function saveSignature(value) {
  try { globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(value)) } catch { /* storage unavailable */ }
}

/** Normalise strokes into a box that starts at 0,0 and return its aspect ratio. */
function normaliseStrokes(strokes) {
  const points = strokes.flat()
  const minX = Math.min(...points.map((point) => point.x))
  const minY = Math.min(...points.map((point) => point.y))
  const maxX = Math.max(...points.map((point) => point.x))
  const maxY = Math.max(...points.map((point) => point.y))
  const width = Math.max(1, maxX - minX)
  const height = Math.max(1, maxY - minY)
  return { strokes: strokes.map((stroke) => stroke.map((point) => ({ x: point.x - minX, y: point.y - minY }))), width, height }
}

async function resultFromSaved(saved) {
  if (saved.kind === 'draw') return { kind: 'ink', ...normaliseStrokes(saved.strokes), color: saved.color }
  return { kind: 'image', ...(await renderTextImage(saved.text, { fontFamily: saved.font, color: saved.color })) }
}

function SavedPreview({ saved }) {
  if (saved.kind === 'type') return <span className="signature-choice" style={{ fontFamily: saved.font, color: saved.color, fontSize: 26, minHeight: 44, border: 0 }}>{saved.text}</span>
  const { strokes, width, height } = normaliseStrokes(saved.strokes)
  return (
    <svg viewBox={`-4 -4 ${width + 8} ${height + 8}`} aria-hidden="true">
      {strokes.map((stroke, index) => <path key={index} d={segmentsToSvg(strokeSegments(stroke))} fill="none" stroke={saved.color} strokeWidth={Math.max(1.5, width / 90)} strokeLinecap="round" strokeLinejoin="round" />)}
    </svg>
  )
}

export function SignatureDialog({ onCancel, onConfirm }) {
  const saved = loadSavedSignature()
  const [tab, setTab] = useState('draw')
  const [color, setColor] = useState(INK_COLORS[0])
  const [strokes, setStrokes] = useState([])
  const [name, setName] = useState('')
  const [font, setFont] = useState(SCRIPT_FONTS[0])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const canvasRef = useRef(null)
  const currentRef = useRef(null)
  const fileRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ratio = globalThis.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    canvas.width = Math.round(rect.width * ratio)
    canvas.height = Math.round(rect.height * ratio)
    const context = canvas.getContext('2d')
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.clearRect(0, 0, rect.width, rect.height)
    context.lineCap = 'round'
    context.lineJoin = 'round'
    context.lineWidth = 2.6
    context.strokeStyle = color
    for (const stroke of strokes) {
      const path = new Path2D(segmentsToSvg(strokeSegments(stroke)))
      context.stroke(path)
    }
  }, [strokes, color, tab])

  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const point = (event) => {
    const rect = canvasRef.current.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  const confirm = async () => {
    setError('')
    setBusy(true)
    try {
      if (tab === 'draw') {
        if (!strokes.length) throw new Error('Draw your signature first.')
        const value = { kind: 'draw', strokes, color }
        saveSignature(value)
        onConfirm(await resultFromSaved(value))
      } else if (tab === 'type') {
        if (!name.trim()) throw new Error('Type your name first.')
        const value = { kind: 'type', text: name.trim(), font, color }
        saveSignature(value)
        onConfirm(await resultFromSaved(value))
      }
    } catch (caught) {
      setError(caught.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) onCancel() }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Signature">
        <div className="dialog-head">
          <h2>Your signature</h2>
          <button type="button" className="icon-btn sm" onClick={onCancel} aria-label="Close"><FaTimes /></button>
        </div>
        <div className="dialog-body">
          {saved && (
            <div className="field">
              <label>Saved on this device</label>
              <div className="signature-saved">
                <SavedPreview saved={saved} />
                <button type="button" className="btn btn-primary btn-sm" style={{ marginLeft: 'auto' }} onClick={async () => onConfirm(await resultFromSaved(saved))}>Use this</button>
              </div>
            </div>
          )}
          <div className="segmented" style={{ marginBottom: 14 }}>
            <button type="button" className={tab === 'draw' ? 'active' : ''} onClick={() => setTab('draw')}><FaPenNib /> Draw</button>
            <button type="button" className={tab === 'type' ? 'active' : ''} onClick={() => setTab('type')}>Aa Type</button>
            <button type="button" className={tab === 'upload' ? 'active' : ''} onClick={() => setTab('upload')}><FaUpload /> Upload</button>
          </div>
          {tab !== 'upload' && (
            <div className="swatches" style={{ marginBottom: 12 }}>
              {INK_COLORS.map((value) => <button key={value} type="button" className={`swatch ${color === value ? 'active' : ''}`} style={{ background: value }} aria-label={value} onClick={() => setColor(value)} />)}
            </div>
          )}
          {tab === 'draw' && (
            <>
              <div
                className="signature-pad"
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture?.(event.pointerId)
                  currentRef.current = [point(event)]
                  setStrokes((value) => [...value, currentRef.current])
                }}
                onPointerMove={(event) => {
                  if (!currentRef.current) return
                  currentRef.current = [...currentRef.current, point(event)]
                  const stroke = currentRef.current
                  setStrokes((value) => [...value.slice(0, -1), stroke])
                }}
                onPointerUp={() => { currentRef.current = null }}
                onPointerCancel={() => { currentRef.current = null }}
              >
                <canvas ref={canvasRef} />
                <span className="baseline" />
                {!strokes.length && <span className="placeholder">Sign here with your mouse, pen or finger</span>}
              </div>
              <div className="button-row" style={{ marginTop: 10 }}>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setStrokes((value) => value.slice(0, -1))} disabled={!strokes.length}>Undo stroke</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setStrokes([])} disabled={!strokes.length}>Clear</button>
              </div>
            </>
          )}
          {tab === 'type' && (
            <div className="signature-typed">
              <input className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder="Type your full name" autoFocus onKeyDown={(event) => event.stopPropagation()} />
              {SCRIPT_FONTS.map((value) => (
                <button key={value} type="button" className={`signature-choice ${font === value ? 'active' : ''}`} style={{ fontFamily: value, color }} onClick={() => setFont(value)}>
                  {name.trim() || 'Your Name'}
                </button>
              ))}
            </div>
          )}
          {tab === 'upload' && (
            <div className="welcome-card" style={{ padding: 24, boxShadow: 'none' }}>
              <p style={{ margin: '0 0 14px' }}>Upload a photo or scan of your signature. A PNG with a transparent background looks best.</p>
              <input ref={fileRef} type="file" accept="image/*" hidden onChange={async (event) => {
                const file = event.target.files?.[0]
                if (!file) return
                try { onConfirm({ kind: 'image', ...(await importImageFile(file)) }) } catch (caught) { setError(caught.message) }
              }} />
              <button type="button" className="btn btn-primary" onClick={() => fileRef.current?.click()}><FaUpload /> Choose image</button>
            </div>
          )}
          {error && <p className="notice error" style={{ marginTop: 12 }}>{error}</p>}
        </div>
        {tab !== 'upload' && (
          <div className="dialog-foot">
            <button type="button" className="btn btn-secondary" onClick={onCancel}>Cancel</button>
            <button type="button" className="btn btn-primary" onClick={() => void confirm()} disabled={busy}>Place signature</button>
          </div>
        )}
      </div>
    </div>
  )
}
