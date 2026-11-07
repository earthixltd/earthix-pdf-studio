/** Compact icon-only button. An accessible label is required by design. */
export function IconButton({
  icon,
  ariaLabel,
  variant = 'ghost',
  size = 'md',
  className = '',
  disabled = false,
  type = 'button',
  ...props
}) {
  if (!ariaLabel) {
    throw new Error('IconButton requires an ariaLabel prop.')
  }

  return (
    <button
      className={['ex-icon-button', `ex-icon-button--${variant}`, `ex-icon-button--${size}`, className].filter(Boolean).join(' ')}
      type={type}
      aria-label={ariaLabel}
      title={ariaLabel}
      disabled={disabled}
      {...props}
    >
      <span aria-hidden="true">{icon}</span>
    </button>
  )
}

export default IconButton
