import { type ReactNode, type RefObject, useEffect, useId, useLayoutEffect, useRef } from "react";
import { cx } from "./cx.ts";

export interface DialogProps {
  /** The dialog's name, as its heading. */
  title: ReactNode;
  /** Closes the dialog: Escape, or a dismiss button the caller renders. */
  onClose: () => void;
  /**
   * False while a request is in flight: Escape does nothing, so the person
   * sees how the request ended.
   */
  dismissible?: boolean;
  /** The element that takes focus when the dialog opens, such as its first field. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** `danger` marks a dialog that confirms something final. */
  tone?: "default" | "danger";
  /** The id of an element inside the dialog that describes it. */
  describedBy?: string;
  /** Body content. */
  children: ReactNode;
  /** The dialog's actions: one primary (or danger) action and a way back. */
  footer?: ReactNode;
  /**
   * True (the default): on close, focus returns to the element that had it
   * when the dialog opened. False: the caller moves focus itself, in an effect
   * that runs after the dialog is gone. Callers that know where the person
   * belongs, such as a list whose rows change after the action, pass false.
   * Safari does not focus a button on click, so "the element that had focus"
   * is not always the button that opened the dialog.
   */
  restoreFocus?: boolean;
  className?: string;
}

/**
 * A modal dialog on the native `<dialog>` element. Render it only while it is
 * open. `showModal` makes the rest of the page inert, keeps focus inside, and
 * sends Escape to `onClose`.
 *
 * Focus: the `initialFocus` element (or the first focusable element) takes
 * focus on open. On close, see `restoreFocus`.
 */
export function Dialog({
  title,
  onClose,
  dismissible = true,
  initialFocus,
  tone = "default",
  describedBy,
  children,
  footer,
  restoreFocus = true,
  className,
}: DialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const latest = useRef({ onClose, dismissible, restoreFocus });
  latest.current = { onClose, dismissible, restoreFocus };

  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (typeof element.showModal === "function") {
      if (!element.open) element.showModal();
    } else {
      // Environments without the modal API (jsdom, very old browsers).
      element.setAttribute("open", "");
    }
    const target =
      initialFocus?.current ??
      element.querySelector<HTMLElement>(
        "input, select, textarea, button, a[href], [tabindex]:not([tabindex='-1'])",
      );
    target?.focus();
    return () => {
      // Read before closing: the dialog is still in the document here.
      const active = document.activeElement;
      const inside = active !== null && element.contains(active);
      if (typeof element.close === "function" && element.open) element.close();
      else element.removeAttribute("open");
      if (!latest.current.restoreFocus) return;
      // Back to the opener, unless focus already moved somewhere outside.
      const lost = inside || !active || active === document.body || !active.isConnected;
      if (lost && opener?.isConnected) opener.focus();
    };
    // Mount only: the dialog opens once per render of it.
  }, []);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    // Escape fires "cancel". The caller owns the open state, so the native
    // close is always prevented and the caller decides.
    const onCancel = (event: Event) => {
      event.preventDefault();
      if (latest.current.dismissible) latest.current.onClose();
    };
    element.addEventListener("cancel", onCancel);
    return () => element.removeEventListener("cancel", onCancel);
  }, []);

  return (
    <dialog
      ref={dialog}
      className={cx("tg-dialog", tone === "danger" && "tg-dialog--danger", className)}
      aria-labelledby={titleId}
      aria-describedby={describedBy}
      // Keyboard fallback where the native cancel event is missing.
      onKeyDown={(event) => {
        if (event.key !== "Escape" || typeof dialog.current?.showModal === "function") return;
        event.preventDefault();
        if (latest.current.dismissible) latest.current.onClose();
      }}
    >
      <div className="tg-dialog__panel">
        <h2 id={titleId} className="tg-dialog__title">
          {title}
        </h2>
        <div className="tg-dialog__body">{children}</div>
        {footer && <div className="tg-dialog__footer">{footer}</div>}
      </div>
    </dialog>
  );
}
