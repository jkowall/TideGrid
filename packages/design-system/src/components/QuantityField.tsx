import { type ReactNode, type Ref, useEffect, useId, useRef, useState } from "react";
import { cx } from "./cx.ts";
import { Icon } from "./Icon.tsx";

/** Where a new count came from: a button, or a keystroke in a count still being typed. */
export type QuantityChange = "step" | "typing";

export interface QuantityFieldProps {
  /** What is counted, as its visible label: "Adult", "Souvenir photo". */
  label: string;
  /** Read with the field, such as a price or a limit. */
  hint?: ReactNode;
  value: number;
  /** The fewest the minus button goes to. Defaults to 0. */
  min?: number;
  /**
   * The most the plus button goes to now. A typed count outside `min` and
   * `max` is still reported through `onChange`, so the caller can say what is
   * wrong beside what the person typed. The field never changes a typed count
   * by itself.
   */
  max: number;
  /**
   * Each new count, and where it came from. A count being typed passes
   * through others on its way ("12" passes 1), so a caller that adjusts
   * something else to the count waits for a step or for `onCommit`.
   */
  onChange: (value: number, how: QuantityChange) => void;
  /** The person left the field after typing in it: the count is final. */
  onCommit?: (value: number) => void;
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
  /** Marks the count invalid when its error is shown elsewhere, such as on its group. */
  invalid?: boolean;
  /** More ids that describe the input, such as its group's error. */
  describedBy?: string | undefined;
  /** Unavailable, for example while the page waits for a price. */
  disabled?: boolean;
  id?: string;
  /** The input's name, so a form can read every count as typed when it is sent. */
  name?: string;
  className?: string;
  /** The input, for moving focus to a field that needs attention. */
  ref?: Ref<HTMLInputElement>;
}

/** A count as typed: up to four digits. */
const typedCount = /^\d{1,4}$/;

/**
 * A count with minus and plus buttons around a number input. The buttons are
 * 44 px targets for touch and stay within `min` and `max`; the input takes
 * typing and the arrow keys; each button names what it does. A button at its
 * limit stays focusable and says it is unavailable, as Button does.
 *
 * Typing reports each whole number as it is typed, even one past a limit, so
 * the count shown is always the count the caller holds. An emptied field
 * counts as zero once the person leaves it.
 */
export function QuantityField({
  label,
  hint,
  value,
  min = 0,
  max,
  onChange,
  onCommit,
  decrementLabel,
  incrementLabel,
  describe,
  error,
  invalid = false,
  describedBy,
  disabled = false,
  id,
  name,
  className,
  ref,
}: QuantityFieldProps) {
  const generated = useId();
  const inputId = id ?? generated;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const described = [hintId, errorId, describedBy].filter(Boolean).join(" ");
  // What the person is typing, which may be empty for a moment.
  const [draft, setDraft] = useState(String(value));
  const [spoken, setSpoken] = useState("");
  // The person has typed since the field last settled; leaving it commits the count.
  const typed = useRef(false);

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const top = Math.max(min, max);
  const canDecrement = !disabled && value > min;
  const canIncrement = !disabled && value < top;

  const step = (by: -1 | 1) => {
    // One at a time from wherever the count is, even from a typed count past a limit.
    const next = by < 0 ? Math.max(min, value - 1) : Math.min(top, value + 1);
    if (next === value) return;
    onChange(next, "step");
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
          name={name}
          className="tg-field__input tg-quantity__input"
          type="number"
          inputMode="numeric"
          min={min}
          max={top}
          step={1}
          value={draft}
          disabled={disabled}
          aria-invalid={error || invalid ? true : undefined}
          aria-describedby={described || undefined}
          onChange={(event) => {
            const text = event.target.value;
            typed.current = true;
            setDraft(text);
            if (!typedCount.test(text)) return;
            const next = Number(text);
            if (next !== value) onChange(next, "typing");
          }}
          onBlur={() => {
            const wasTyped = typed.current;
            typed.current = false;
            // An emptied field means none. Anything typed stays as typed, in its plain form.
            let count = value;
            if (!typedCount.test(draft)) {
              if (draft.trim() === "") {
                count = 0;
                if (value !== 0) onChange(0, "typing");
              }
            }
            setDraft(String(count));
            if (wasTyped) onCommit?.(count);
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
