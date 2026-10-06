import { type InputHTMLAttributes, type ReactNode, type Ref, useId } from "react";
import { cx } from "./cx.ts";
import { Icon } from "./Icon.tsx";

export interface CheckboxFieldProps
  extends Omit<
    InputHTMLAttributes<HTMLInputElement>,
    "type" | "aria-invalid" | "aria-describedby" | "children"
  > {
  /** What checking the box means, in the person's words: "I accept the cancellation policy". */
  label: ReactNode;
  /** Shown after the box and read with it. */
  hint?: ReactNode;
  /** Shown after the box with an icon, read with it, and marks it invalid. */
  error?: string | undefined;
  /** The input, for moving focus to it when it needs attention. */
  ref?: Ref<HTMLInputElement>;
}

/**
 * A native checkbox inside its label, so the whole row, at least 44 px tall,
 * is the target. The box takes the surface's action color.
 */
export function CheckboxField({
  label,
  hint,
  error,
  id,
  className,
  ref,
  ...rest
}: CheckboxFieldProps) {
  const generated = useId();
  const inputId = id ?? generated;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ");
  return (
    <div className={cx("tg-check", className)}>
      <label className="tg-check__row" htmlFor={inputId}>
        <input
          ref={ref}
          id={inputId}
          type="checkbox"
          className="tg-check__box"
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
          {...rest}
        />
        <span className="tg-check__label">{label}</span>
      </label>
      {hint && (
        <p className="tg-field__hint" id={hintId}>
          {hint}
        </p>
      )}
      {error && (
        <p className="tg-field__error" id={errorId}>
          <Icon name="x-octagon" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}
