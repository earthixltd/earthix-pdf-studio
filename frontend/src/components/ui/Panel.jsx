/** Structured surface for inspector groups, settings sections and cards. */
export function Panel({
  title,
  description,
  actions,
  footer,
  children,
  as: Element = 'section',
  padding = 'md',
  className = '',
  bodyClassName = '',
}) {
  return (
    <Element className={['ex-panel', `ex-panel--padding-${padding}`, className].filter(Boolean).join(' ')}>
      {(title || description || actions) && (
        <header className="ex-panel__header">
          <div className="ex-panel__heading">
            {title && <h2 className="ex-panel__title">{title}</h2>}
            {description && <p className="ex-panel__description">{description}</p>}
          </div>
          {actions && <div className="ex-panel__actions">{actions}</div>}
        </header>
      )}
      <div className={['ex-panel__body', bodyClassName].filter(Boolean).join(' ')}>{children}</div>
      {footer && <footer className="ex-panel__footer">{footer}</footer>}
    </Element>
  )
}

export default Panel
