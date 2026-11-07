import { useId } from 'react'

/** Labeled text input with hint, error and optional leading/trailing content. */
export function Input({
  label,
  hint,
  error,
  leadingIcon,
  trailing,
  id,
  className = '',
  inputClassName = '',
  wrapperClassName = '',
  required = false,
  disabled = false,
  ...props
}) {
  const generatedId = useId()
  const inputId = id || `earthix-input-${generatedId}`
  const hintId = hint ? `${inputId}-hint` : undefined
  const errorId = error ? `${inputId}-error` : undefined
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined

  return (
    <div className={['ex-field', wrapperClassName].filter(Boolean).join(' ')}>
      {label && (
        <label className="ex-field__label" htmlFor={inputId}>
          {label}
          {required && <span className="ex-field__required" aria-hidden="true"> *</span>}
        </label>
      )}
      <div className={[
        'ex-input-wrap',
        leadingIcon ? 'ex-input-wrap--leading' : '',
        trailing ? 'ex-input-wrap--trailing' : '',
        error ? 'ex-input-wrap--error' : '',
        disabled ? 'ex-input-wrap--disabled' : '',
        className,
      ].filter(Boolean).join(' ')}>
        {leadingIcon && <span className="ex-input-wrap__leading" aria-hidden="true">{leadingIcon}</span>}
        <input
          id={inputId}
          className={['ex-input', inputClassName].filter(Boolean).join(' ')}
          aria-invalid={Boolean(error)}
          aria-describedby={describedBy}
          aria-required={required || undefined}
          required={required}
          disabled={disabled}
          {...props}
        />
        {trailing && <span className="ex-input-wrap__trailing">{trailing}</span>}
      </div>
      {error ? <p className="ex-field__error" id={errorId} role="alert">{error}</p> : hint ? <p className="ex-field__hint" id={hintId}>{hint}</p> : null}
    </div>
  )
}

export default Input
