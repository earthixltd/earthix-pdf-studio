import { useEffect, useRef, useState } from 'react'
import { FaCheck, FaExclamation, FaFont, FaLayerGroup, FaLock, FaQuestion, FaSave, FaTimes, FaTrashAlt } from 'react-icons/fa'
import './sweet-dialog.css'

// A friendly, animated in-app popup (in the style of SweetAlert) used instead
// of the browser's plain prompt/confirm boxes. Call `showDialog(options)`
// anywhere; it resolves with { confirmed, value }.

const ICONS = {
  question: FaQuestion,
  success: FaCheck,
  warning: FaExclamation,
  error: FaTimes,
  lock: FaLock,
  font: FaFont,
  save: FaSave,
  layers: FaLayerGroup,
  delete: FaTrashAlt,
}

let enqueue = null
const pending = []

export function showDialog(options) {
  return new Promise((resolve) => {
    const request = { ...options, resolve, id: Math.random().toString(36).slice(2) }
    if (enqueue) enqueue(request)
    else pending.push(request)
  })
}

export function SweetDialogHost() {
  const [queue, setQueue] = useState([])
  const [value, setValue] = useState('')
  const inputRef = useRef(null)
  const confirmRef = useRef(null)
  const current = queue[0] || null

  useEffect(() => {
    enqueue = (request) => setQueue((items) => [...items, request])
    if (pending.length) setQueue((items) => [...items, ...pending.splice(0)])
    return () => { enqueue = null }
  }, [])

  useEffect(() => {
    if (!current) return undefined
    setValue(current.input?.value || '')
    const timer = window.setTimeout(() => (current.input ? inputRef.current : confirmRef.current)?.focus(), 60)
    return () => window.clearTimeout(timer)
  }, [current])

  const close = (confirmed) => {
    if (!current) return
    current.resolve({ confirmed, value: confirmed ? value : null })
    setQueue((items) => items.slice(1))
  }

  useEffect(() => {
    if (!current) return undefined
    const onKey = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(false) }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  if (!current) return null
  const Icon = ICONS[current.icon] || FaQuestion
  const tone = current.tone || ({ success: 'success', warning: 'warning', error: 'error', delete: 'error' }[current.icon] || 'accent')
  return (
    <div className="sweet-backdrop" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget && current.cancelText !== null) close(false) }}>
      <form
        key={current.id}
        className="sweet-card"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`sweet-title-${current.id}`}
        onSubmit={(event) => { event.preventDefault(); close(true) }}
      >
        <span className={`sweet-icon tone-${tone}`}><Icon /></span>
        <h2 id={`sweet-title-${current.id}`}>{current.title}</h2>
        {current.text && <p>{current.text}</p>}
        {current.input && (
          <input
            ref={inputRef}
            className="sweet-input"
            type={current.input.type || 'text'}
            placeholder={current.input.placeholder || ''}
            value={value}
            autoComplete={current.input.type === 'password' ? 'current-password' : 'off'}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => event.stopPropagation()}
          />
        )}
        <div className="sweet-actions">
          {current.cancelText !== null && (
            <button type="button" className="sweet-button secondary" onClick={() => close(false)}>{current.cancelText || 'Cancel'}</button>
          )}
          <button ref={confirmRef} type="submit" className={`sweet-button ${tone === 'error' ? 'danger' : 'primary'}`} disabled={current.input?.required && !value}>
            {current.confirmText || 'OK'}
          </button>
        </div>
      </form>
    </div>
  )
}
