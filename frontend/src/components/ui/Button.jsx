import { FiLoader } from 'react-icons/fi'

const VARIANTS = ['primary', 'secondary', 'outline', 'ghost', 'danger']
const SIZES = ['sm', 'md', 'lg']

/** Accessible button primitive with consistent Earthix variants. */
export function Button({
  children,
  variant = 'primary',
  size = 'md',
  type = 'button',
  loading = false,
  disabled = false,
  fullWidth = false,
  leftIcon,
  rightIcon,
  className = '',
  ...props
}) {
  const safeVariant = VARIANTS.includes(variant) ? variant : 'primary'
  const safeSize = SIZES.includes(size) ? size : 'md'
  const isDisabled = disabled || loading

  return (
    <button
      className={[
        'ex-button',
        `ex-button--${safeVariant}`,
        `ex-button--${safeSize}`,
        fullWidth ? 'ex-button--full' : '',
        loading ? 'ex-button--loading' : '',
        className,
      ].filter(Boolean).join(' ')}
      type={type}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <FiLoader className="ex-button__spinner" aria-hidden="true" /> : leftIcon ? <span className="ex-button__icon" aria-hidden="true">{leftIcon}</span> : null}
      {children != null && <span className="ex-button__label">{children}</span>}
      {!loading && rightIcon && <span className="ex-button__icon" aria-hidden="true">{rightIcon}</span>}
    </button>
  )
}

export default Button
