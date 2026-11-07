import { useEffect, useId, useRef, useState } from 'react'
import { FiChevronDown, FiCheck } from 'react-icons/fi'

/** Accessible action menu. Items: { label, onSelect, icon, disabled, danger, checked, href, separator }. */
export function Dropdown({
  label = 'Actions',
  triggerIcon,
  items = [],
  align = 'end',
  variant = 'outline',
  size = 'md',
  disabled = false,
  className = '',
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)
  const triggerRef = useRef(null)
  const menuRef = useRef(null)
  const menuId = `earthix-menu-${useId()}`

  useEffect(() => {
    if (!open) return undefined

    const handlePointerDown = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false)
    }
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
        return
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const menuItems = [...(menuRef.current?.querySelectorAll('[role="menuitem"]:not(:disabled)') || [])]
        if (!menuItems.length) return
        event.preventDefault()
        const currentIndex = menuItems.indexOf(document.activeElement)
        const delta = event.key === 'ArrowDown' ? 1 : -1
        const nextIndex = currentIndex < 0 ? (delta > 0 ? 0 : menuItems.length - 1) : (currentIndex + delta + menuItems.length) % menuItems.length
        menuItems[nextIndex]?.focus()
      }
      if (event.key === 'Home' || event.key === 'End') {
        const menuItems = [...(menuRef.current?.querySelectorAll('[role="menuitem"]') || [])]
        event.preventDefault()
        ;(event.key === 'Home' ? menuItems[0] : menuItems.at(-1))?.focus()
      }
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    menuRef.current?.querySelector('[role="menuitem"]:not(:disabled)')?.focus()

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  const closeAfterAction = (item) => {
    if (item.disabled || item.separator) return
    item.onSelect?.()
    setOpen(false)
    triggerRef.current?.focus()
  }

  return (
    <div
      className={['ex-dropdown', className].filter(Boolean).join(' ')}
      ref={rootRef}
      onBlur={(event) => {
        if (!rootRef.current?.contains(event.relatedTarget)) setOpen(false)
      }}
    >
      <button
        ref={triggerRef}
        className={`ex-button ex-button--${variant} ex-button--${size} ex-dropdown__trigger`}
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((current) => !current)}
      >
        {triggerIcon && <span className="ex-button__icon" aria-hidden="true">{triggerIcon}</span>}
        <span className="ex-button__label">{label}</span>
        <FiChevronDown className={`ex-dropdown__chevron ${open ? 'is-open' : ''}`} aria-hidden="true" />
      </button>
      {open && (
        <div className={`ex-dropdown__menu ex-dropdown__menu--${align}`} id={menuId} role="menu" ref={menuRef}>
          {items.map((item, index) => {
            if (item.separator) return <div className="ex-dropdown__separator" role="separator" key={item.id || `separator-${index}`} />
            const content = (
              <>
                {item.icon && <span className="ex-dropdown__item-icon" aria-hidden="true">{item.icon}</span>}
                <span className="ex-dropdown__item-label">{item.label}</span>
                {item.checked && <FiCheck className="ex-dropdown__check" aria-hidden="true" />}
              </>
            )
            const itemClass = ['ex-dropdown__item', item.danger ? 'ex-dropdown__item--danger' : ''].filter(Boolean).join(' ')
            if (item.href && !item.disabled) {
              return (
                <a
                  className={itemClass}
                  href={item.href}
                  key={item.id || item.label || index}
                  role="menuitem"
                  tabIndex={-1}
                  onClick={() => setOpen(false)}
                  target={item.target}
                  rel={item.target === '_blank' ? 'noreferrer' : undefined}
                >
                  {content}
                </a>
              )
            }
            return (
              <button
                className={itemClass}
                type="button"
                key={item.id || item.label || index}
                role="menuitem"
                tabIndex={-1}
                disabled={item.disabled}
                onClick={() => closeAfterAction(item)}
              >
                {content}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default Dropdown
