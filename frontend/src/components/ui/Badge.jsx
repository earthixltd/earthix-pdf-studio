const VARIANTS = ['neutral', 'brand', 'success', 'warning', 'danger', 'info']

export function Badge({ children, variant = 'neutral', dot = false, className = '', ...props }) {
  const safeVariant = VARIANTS.includes(variant) ? variant : 'neutral'

  return (
    <span className={['ex-badge', `ex-badge--${safeVariant}`, className].filter(Boolean).join(' ')} {...props}>
      {dot && <span className="ex-badge__dot" aria-hidden="true" />}
      {children}
    </span>
  )
}

export default Badge
