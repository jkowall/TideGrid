import { type ReactNode, type RefObject, useId, useLayoutEffect, useRef } from "react";
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

const focusable = "input, select, textarea, button, a[href], [tabindex]:not([tabindex='-1'])";

/**
 * A modal dialog on the native `<dialog>` element. Render it only while it is
 * open. `showModal` makes the rest of the page inert, keeps focus inside, and
 * sends Escape to `onClose`.
 *
 * The caller owns the open state. While the dialog is not dismissible, close
 * requests are refused: `closedby="none"` where the engine supports it, and
 * elsewhere the dialog opens again if the browser closes it anyway. A busy
 * dialog therefore stays on screen until its request ends.
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
  const latest = useRef({ onClose, dismissible, restoreFocus, initialFocus });
  latest.current = { onClose, dismissible, restoreFocus, initialFocus };

  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let mounted = true;
    let closeAsked = false;
    const show = () => {
      if (typeof element.showModal === "function") {
        if (!element.open) element.showModal();
      } else {
        // Environments without the modal API (jsdom, very old browsers).
        element.setAttribute("open", "");
      }
    };
    const focusFirst = () => {
      const target =
        latest.current.initialFocus?.current ?? element.querySelector<HTMLElement>(focusable);
      target?.focus();
    };
    const askToClose = () => {
      if (closeAsked) return;
      closeAsked = true;
      latest.current.onClose();
    };
    // The browser can close a modal dialog by itself: a close request the page
    // may not cancel, such as a second Escape without user activation, in an
    // engine without `closedby`. React still renders the dialog, so put things
    // right: a dismissible dialog asks the caller to close it, and a busy one
    // opens again. A task later, not a microtask: the close must have happened.
    const settle = () => {
      if (!mounted || element.open) return;
      if (latest.current.dismissible) {
        askToClose();
        return;
      }
      show();
      focusFirst();
    };
    // Escape fires "cancel". The caller owns the open state, so the native
    // close is prevented whenever the browser allows it, and the caller decides.
    const onCancel = (event: Event) => {
      if (!event.cancelable) {
        window.setTimeout(settle, 0);
        return;
      }
      event.preventDefault();
      if (latest.current.dismissible) askToClose();
    };
    const onNativeClose = () => window.setTimeout(settle, 0);
    element.addEventListener("cancel", onCancel);
    element.addEventListener("close", onNativeClose);
    show();
    focusFirst();
    return () => {
      mounted = false;
      element.removeEventListener("cancel", onCancel);
      element.removeEventListener("close", onNativeClose);
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

  return (
    <dialog
      ref={dialog}
      className={cx("tg-dialog", tone === "danger" && "tg-dialog--danger", className)}
      aria-labelledby={titleId}
      aria-describedby={describedBy}
      // While the caller is busy, the browser ignores Escape and other close
      // requests altogether. Engines without `closedby` rely on settle above.
      closedby={dismissible ? "closerequest" : "none"}
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
