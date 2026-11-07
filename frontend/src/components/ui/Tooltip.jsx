import { cloneElement, isValidElement, useId } from 'react'

/** Lightweight CSS tooltip that opens on pointer hover and keyboard focus. */
export function Tooltip({ children, content, side = 'top', className = '' }) {
  const tooltipId = `earthix-tooltip-${useId()}`

  if (!content) return children

  const describedBy = isValidElement(children)
    ? [children.props['aria-describedby'], tooltipId].filter(Boolean).join(' ')
    : tooltipId
  const target = isValidElement(children)
    ? cloneElement(children, { 'aria-describedby': describedBy })
    : <span className="ex-tooltip__fallback-target" tabIndex={0} aria-describedby={tooltipId}>{children}</span>

  return (
    <span className={['ex-tooltip', `ex-tooltip--${side}`, className].filter(Boolean).join(' ')}>
      <span className="ex-tooltip__target">{target}</span>
      <span className="ex-tooltip__content" id={tooltipId} role="tooltip">
        {content}
      </span>
    </span>
  )
}

export default Tooltip
