import { type InputHTMLAttributes, type Ref, useId } from "react";
import { cx } from "./cx.ts";
import { Icon } from "./Icon.tsx";

export interface TextFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "aria-invalid" | "aria-describedby"> {
  label: string;
  /** Guidance shown before the input and read with it. */
  hint?: string;
  /** Shown after the input with an icon, read with it, and marks it invalid. */
  error?: string | undefined;
  /** The input element, for moving focus to a field that needs attention. */
  ref?: Ref<HTMLInputElement>;
}

export function TextField({ label, hint, error, id, className, ref, ...rest }: TextFieldProps) {
  const generated = useId();
  const inputId = id ?? generated;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ");
  return (
    <div className={cx("tg-field", className)}>
      <label className="tg-field__label" htmlFor={inputId}>
        {label}
      </label>
      {hint && (
        <p className="tg-field__hint" id={hintId}>
          {hint}
        </p>
      )}
      <input
        ref={ref}
        id={inputId}
        className="tg-field__input"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        {...rest}
      />
      {error && (
        <p className="tg-field__error" id={errorId}>
          <Icon name="x-octagon" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}
