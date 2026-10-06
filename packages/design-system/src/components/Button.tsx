import {
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  type MouseEvent,
  type ReactNode,
  type Ref,
  useCallback,
  useLayoutEffect,
  useRef,
} from "react";
import { cx } from "./cx.ts";
import { Icon, type IconName } from "./Icon.tsx";

/**
 * `danger` confirms an action that cannot be undone, such as canceling a trip.
 * It is that screen's one primary action, so it never sits beside a primary.
 */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

interface CommonProps {
  /** One primary per screen. Secondary is the default. */
  variant?: ButtonVariant;
  /** Full width, for narrow forms and phone layouts. */
  block?: boolean;
  icon?: IconName;
  /** Where the icon sits: before the label (default) or after it, as on "Next". */
  iconPosition?: "start" | "end";
  children: ReactNode;
}

export interface ButtonProps
  extends CommonProps,
    Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "disabled"> {
  /**
   * Working on a request. The button keeps focus, its colors, and at least its
   * width at rest, so a shorter busy label never moves the buttons beside it.
   * It announces itself as busy and ignores further presses.
   */
  busy?: boolean;
  /** Replaces the label while busy, for example "Sending…". */
  busyLabel?: string;
  /**
   * Unavailable. Rendered with aria-disabled rather than the disabled
   * attribute, so keyboard and screen reader users can still find it.
   */
  disabled?: boolean;
  /** The button element, for moving focus to it. */
  ref?: Ref<HTMLButtonElement>;
}

export function Button({
  variant = "secondary",
  block = false,
  icon,
  iconPosition = "start",
  busy = false,
  busyLabel,
  disabled = false,
  className,
  children,
  onClick,
  type = "button",
  ref,
  ...rest
}: ButtonProps) {
  const inactive = busy || disabled;
  const own = useRef<HTMLButtonElement | null>(null);
  const restWidth = useRef(0);
  // At rest, remember the width; while busy, keep at least that width. Set
  // through the CSSOM, which the guest CSP allows; no style attribute.
  useLayoutEffect(() => {
    const element = own.current;
    if (!element) return;
    if (busy) {
      if (restWidth.current > 0) element.style.minWidth = `${restWidth.current}px`;
      return;
    }
    element.style.minWidth = "";
    restWidth.current = element.getBoundingClientRect().width;
  });
  const setRef = useCallback(
    (node: HTMLButtonElement | null) => {
      own.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (inactive) {
      event.preventDefault();
      return;
    }
    onClick?.(event);
  };
  return (
    <button
      ref={setRef}
      type={type}
      className={cx("tg-button", `tg-button--${variant}`, block && "tg-button--block", className)}
      aria-busy={busy || undefined}
      aria-disabled={inactive || undefined}
      onClick={handleClick}
      {...rest}
    >
      {busy ? (
        <span className="tg-spinner" aria-hidden="true" />
      ) : (
        icon && iconPosition === "start" && <Icon name={icon} />
      )}
      <span>{busy && busyLabel ? busyLabel : children}</span>
      {!busy && icon && iconPosition === "end" && <Icon name={icon} />}
    </button>
  );
}

export interface ButtonLinkProps
  extends CommonProps,
    Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "children"> {
  href: string;
  /** The link element, for moving focus to it. */
  ref?: Ref<HTMLAnchorElement>;
}

/** A link that looks like a button, for navigation such as tel: and mailto:. */
export function ButtonLink({
  variant = "secondary",
  block = false,
  icon,
  iconPosition = "start",
  className,
  children,
  ref,
  ...rest
}: ButtonLinkProps) {
  return (
    <a
      ref={ref}
      className={cx("tg-button", `tg-button--${variant}`, block && "tg-button--block", className)}
      {...rest}
    >
      {icon && iconPosition === "start" && <Icon name={icon} />}
      <span>{children}</span>
      {icon && iconPosition === "end" && <Icon name={icon} />}
    </a>
  );
}
