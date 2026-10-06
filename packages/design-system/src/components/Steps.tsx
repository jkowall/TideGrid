import { cx } from "./cx.ts";
import { Icon } from "./Icon.tsx";

export interface StepsProps {
  /** The steps' names, in order: "Party", "Details", "Payment". */
  steps: readonly string[];
  /** The current step's index. Steps before it are done; none are links. */
  current: number;
  /** Names the list for screen readers, such as "Booking steps". */
  label: string;
  className?: string;
}

/**
 * Where a person is in a short sequence. Each step shows its number or a
 * check and its name, so progress never rests on color alone; the current
 * step carries `aria-current="step"`, and a done step says so in words.
 */
export function Steps({ steps, current, label, className }: StepsProps) {
  return (
    <ol className={cx("tg-steps", className)} aria-label={label}>
      {steps.map((name, index) => {
        const state = index < current ? "done" : index === current ? "current" : "upcoming";
        return (
          <li
            key={name}
            className={cx("tg-steps__step", `tg-steps__step--${state}`)}
            aria-current={state === "current" ? "step" : undefined}
          >
            <span className="tg-steps__marker" aria-hidden="true">
              {state === "done" ? <Icon name="check" /> : index + 1}
            </span>
            <span className="tg-steps__name">
              {name}
              {state === "done" && <span className="tg-visually-hidden">, done</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
