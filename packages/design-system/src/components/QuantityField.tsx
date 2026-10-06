import { type ReactNode, type Ref, useEffect, useId, useState } from "react";
import { cx } from "./cx.ts";
import { Icon } from "./Icon.tsx";

export interface QuantityFieldProps {
  /** What is counted, as its visible label: "Adult", "Souvenir photo". */
  label: string;
  /** Read with the field, such as a price or a limit. */
  hint?: ReactNode;
  value: number;
  /** The fewest allowed. Defaults to 0. */
  min?: number;
  /** The most allowed now. A count above it is lowered by the caller. */
  max: number;
  onChange: (value: number) => void;
  /** The minus button's name, such as "Remove an adult". */
  decrementLabel: string;
  /** The plus button's name, such as "Add an adult". */
  incrementLabel: string;
  /**
   * Said after a button changes the count, such as "2 adults". A person on
   * the button hears nothing else, because focus stays on the button.
   */
  describe?: (value: number) => string;
  /** Shown after the control with an icon, read with it, and marks it invalid. */
  error?: string | undefined;
  /** Unavailable, for example while the page waits for a price. */
  disabled?: boolean;
  id?: string;
  className?: string;
  /** The input, for moving focus to a field that needs attention. */
  ref?: Ref<HTMLInputElement>;
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/**
 * A count with minus and plus buttons around a number input. The buttons are
 * 44 px targets for touch; the input takes typing and the arrow keys; each
 * button names what it does. A button at its limit stays focusable and says
 * it is unavailable, as Button does.
 */
export function QuantityField({
  label,
  hint,
  value,
  min = 0,
  max,
  onChange,
  decrementLabel,
  incrementLabel,
  describe,
  error,
  disabled = false,
  id,
  className,
  ref,
}: QuantityFieldProps) {
  const generated = useId();
  const inputId = id ?? generated;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ");
  // What the person is typing, which may be empty or out of range for a moment.
  const [draft, setDraft] = useState(String(value));
  const [spoken, setSpoken] = useState("");

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const top = Math.max(min, max);
  const canDecrement = !disabled && value > min;
  const canIncrement = !disabled && value < top;

  const step = (by: number) => {
    const next = clamp(value + by, min, top);
    if (next === value) return;
    onChange(next);
    setSpoken(describe ? describe(next) : `${label}: ${next}`);
  };

  return (
    <div className={cx("tg-field", "tg-quantity", className)}>
      <div className="tg-quantity__text">
        <label className="tg-field__label" htmlFor={inputId}>
          {label}
        </label>
        {hint && (
          <p className="tg-field__hint" id={hintId}>
            {hint}
          </p>
        )}
      </div>
      <div className="tg-quantity__control">
        <button
          type="button"
          className="tg-quantity__step"
          aria-label={decrementLabel}
          aria-controls={inputId}
          aria-disabled={canDecrement ? undefined : true}
          onClick={() => {
            if (canDecrement) step(-1);
          }}
        >
          <Icon name="minus" />
        </button>
        <input
          ref={ref}
          id={inputId}
          className="tg-field__input tg-quantity__input"
          type="number"
          inputMode="numeric"
          min={min}
          max={top}
          step={1}
          value={draft}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
          onChange={(event) => {
            const text = event.target.value;
            setDraft(text);
            if (!/^\d+$/.test(text)) return;
            const next = Number(text);
            if (next >= min && next <= top && next !== value) onChange(next);
          }}
          onBlur={() => {
            // Whatever was typed, the field settles on a count it allows.
            const typed = /^\d+$/.test(draft) ? Number(draft) : value;
            const next = clamp(typed, min, top);
            if (next !== value) onChange(next);
            setDraft(String(next));
          }}
        />
        <button
          type="button"
          className="tg-quantity__step"
          aria-label={incrementLabel}
          aria-controls={inputId}
          aria-disabled={canIncrement ? undefined : true}
          onClick={() => {
            if (canIncrement) step(1);
          }}
        >
          <Icon name="plus" />
        </button>
      </div>
      <span className="tg-visually-hidden" aria-live="polite">
        {spoken}
      </span>
      {error && (
        <p className="tg-field__error" id={errorId}>
          <Icon name="x-octagon" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}
