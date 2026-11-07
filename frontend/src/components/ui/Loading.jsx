import { FiLoader } from 'react-icons/fi'

export function Loading({ label = 'Loading', size = 'md', inline = false, className = '' }) {
  return (
    <span
      className={['ex-loading', `ex-loading--${size}`, inline ? 'ex-loading--inline' : '', className].filter(Boolean).join(' ')}
      role="status"
      aria-live="polite"
    >
      <FiLoader className="ex-loading__spinner" aria-hidden="true" />
      <span className="ex-loading__label">{label}</span>
    </span>
  )
}

export default Loading
