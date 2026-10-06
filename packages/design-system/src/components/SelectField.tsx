import { type Ref, type SelectHTMLAttributes, useId } from "react";
import { cx } from "./cx.ts";
import { Icon } from "./Icon.tsx";

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectFieldProps
  extends Omit<
    SelectHTMLAttributes<HTMLSelectElement>,
    "aria-invalid" | "aria-describedby" | "children" | "multiple"
  > {
  label: string;
  options: readonly SelectOption[];
  /** Guidance shown before the control and read with it. */
  hint?: string;
  /** Shown after the control with an icon, read with it, and marks it invalid. */
  error?: string | undefined;
  ref?: Ref<HTMLSelectElement>;
}

/**
 * A native select with a visible label: the platform picker on phones, the
 * keyboard behavior people expect everywhere, and a 44 px target.
 */
export function SelectField({
  label,
  options,
  hint,
  error,
  id,
  className,
  ref,
  ...rest
}: SelectFieldProps) {
  const generated = useId();
  const selectId = id ?? generated;
  const hintId = hint ? `${selectId}-hint` : undefined;
  const errorId = error ? `${selectId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ");
  return (
    <div className={cx("tg-field", className)}>
      <label className="tg-field__label" htmlFor={selectId}>
        {label}
      </label>
      {hint && (
        <p className="tg-field__hint" id={hintId}>
          {hint}
        </p>
      )}
      <div className="tg-select">
        <select
          ref={ref}
          id={selectId}
          className="tg-select__control"
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
          {...rest}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <Icon name="chevron-down" className="tg-select__chevron" />
      </div>
      {error && (
        <p className="tg-field__error" id={errorId}>
          <Icon name="x-octagon" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}
