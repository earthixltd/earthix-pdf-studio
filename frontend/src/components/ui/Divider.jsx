export function Divider({ orientation = 'horizontal', label, className = '' }) {
  if (label) {
    return (
      <div className={['ex-divider-with-label', className].filter(Boolean).join(' ')}>
        <span className="ex-divider-with-label__line" aria-hidden="true" />
        <span className="ex-divider-with-label__text">{label}</span>
        <span className="ex-divider-with-label__line" aria-hidden="true" />
      </div>
    )
  }

  return (
    <div
      className={['ex-divider', `ex-divider--${orientation}`, className].filter(Boolean).join(' ')}
      role="separator"
      aria-orientation={orientation}
    />
  )
}

export default Divider
