import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { FiX } from "react-icons/fi";
import { IconButton } from "./IconButton.jsx";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Accessible modal with Escape handling, focus trapping and body scroll lock. */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
  closeOnOverlay = true,
  closeLabel = "Close dialog",
  ariaLabel = "Dialog",
  className = "",
}) {
  const dialogRef = useRef(null);
  const titleId = `earthix-modal-title-${useId()}`;
  const descriptionId = `earthix-modal-description-${useId()}`;

  useEffect(() => {
    if (!open) return undefined;

    const previouslyFocused = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const focusInitialElement = () => {
      const initial = dialogRef.current?.querySelector(
        '[data-autofocus], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      (initial || dialogRef.current)?.focus();
    };
    focusInitialElement();

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose?.();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [
        ...dialogRef.current.querySelectorAll(FOCUSABLE_SELECTOR),
      ];
      if (!focusable.length) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="ex-modal-backdrop"
      onMouseDown={(event) => {
        if (closeOnOverlay && event.target === event.currentTarget) onClose?.();
      }}
    >
      <section
        className={["ex-modal", `ex-modal--${size}`, className]
          .filter(Boolean)
          .join(" ")}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : ariaLabel}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        ref={dialogRef}
      >
        <header className="ex-modal__header">
          <div className="ex-modal__heading">
            {title && (
              <h2 className="ex-modal__title" id={titleId}>
                {title}
              </h2>
            )}
            {description && (
              <p className="ex-modal__description" id={descriptionId}>
                {description}
              </p>
            )}
          </div>
          <IconButton icon={<FiX />} ariaLabel={closeLabel} onClick={onClose} />
        </header>
        <div className="ex-modal__body">{children}</div>
        {footer && <footer className="ex-modal__footer">{footer}</footer>}
      </section>
    </div>,
    document.body,
  );
}

export default Modal;
