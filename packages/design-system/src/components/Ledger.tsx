import type { ReactNode } from "react";
import { cx } from "./cx.ts";

/**
 * - item: a line the total adds up.
 * - subtotal: a sum of the lines above it, set off by a rule.
 * - adjustment: a line that changes the sum, such as a discount.
 * - total: the amount that counts, emphasized.
 * - note: shown for information and not added, such as tax already included.
 */
export type LedgerRowKind = "item" | "subtotal" | "adjustment" | "total" | "note";

export interface LedgerRow {
  /** Stable key for the row. */
  id: string;
  label: ReactNode;
  /** Secondary text under the label, such as "2 × $45.00". */
  detail?: ReactNode;
  /** The amount as display text, from a money formatter. */
  amount: string;
  kind?: LedgerRowKind;
}

export interface LedgerProps {
  /** What the table lists, such as "Price in US dollars". */
  caption: ReactNode;
  /** Keep the caption for screen readers only, when a heading above already names the table. */
  hideCaption?: boolean;
  rows: readonly LedgerRow[];
  className?: string;
}

/**
 * Line items and their sums, as a table: each label is its row's header, so a
 * screen reader reads "Adult, 2 × $45.00, $90.00". Amounts line up in tabular
 * figures. The caller formats every amount; this component does no arithmetic.
 */
export function Ledger({ caption, hideCaption = false, rows, className }: LedgerProps) {
  return (
    <table className={cx("tg-ledger", className)}>
      <caption className={cx("tg-ledger__caption", hideCaption && "tg-visually-hidden")}>
        {caption}
      </caption>
      <tbody>
        {rows.map((row) => (
          <tr
            key={row.id}
            className={cx("tg-ledger__row", `tg-ledger__row--${row.kind ?? "item"}`)}
          >
            <th scope="row" className="tg-ledger__item">
              <span className="tg-ledger__label">{row.label}</span>
              {row.detail && <span className="tg-ledger__detail">{row.detail}</span>}
            </th>
            <td className="tg-ledger__amount">{row.amount}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
