import type { BookingDayTotals } from "@tidegrid/contracts";
import { Button, Icon, Notice, Skeleton } from "@tidegrid/design-system/components";
import { formatMoney, type LocalDate } from "@tidegrid/design-system/format";
import { useEffect, useId, useRef, useState } from "react";
import type { ReadFailure } from "../http.ts";
import { exportDay, loadDayTotals, type DayTotals as Totals } from "./day-api.ts";
import { guestsText, instantText } from "./model.ts";
import { canRetry, failureText } from "./States.tsx";

/**
 * A day's control totals and its CSV export (G2.12c), for every role. The
 * figures come from the ledger on the server, the same read the export's
 * total row comes from: gross, less discounts, plus fees and taxes, is what
 * guests were charged; less succeeded refunds, it is net.
 */

type Load =
  | { kind: "loading" }
  | { kind: "ready"; value: Totals }
  | { kind: "failed"; reason: ReadFailure; retrying: boolean };

type Export =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "saved"; fileName: string }
  | { kind: "failed"; reason: ReadFailure };

export function DayTotals({
  tenantId,
  tenantName,
  day,
  zone,
  seesGuests,
}: {
  tenantId: string;
  tenantName: string;
  day: LocalDate;
  /** The marina's zone, to say when the totals were read. */
  zone: string | undefined;
  seesGuests: boolean;
}) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [exported, setExported] = useState<Export>({ kind: "idle" });
  const retrying = useRef(false);
  const headingId = useId();
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  useEffect(() => {
    void attempt;
    const controller = new AbortController();
    const retry = retrying.current;
    retrying.current = false;
    setLoad((current) =>
      retry && current.kind === "failed" ? { ...current, retrying: true } : { kind: "loading" },
    );
    setExported({ kind: "idle" });
    void loadDayTotals(tenantId, day, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setLoad(
        result.kind === "ok"
          ? { kind: "ready", value: result.value }
          : { kind: "failed", reason: result.reason, retrying: false },
      );
    });
    return () => controller.abort();
  }, [tenantId, day, attempt]);

  const message: { tone: "done" | "failed"; text: string } | null =
    exported.kind === "saved"
      ? {
          tone: "done",
          text: `Exported ${exported.fileName}. ${
            seesGuests
              ? "It includes guests' names and emails, so keep it somewhere private."
              : "It has the money only, without guests' details."
          }`,
        }
      : exported.kind === "failed"
        ? {
            tone: "failed",
            text: `The CSV couldn't be prepared. ${
              exported.reason === "signed_out"
                ? "You're signed out. Sign in again, then export."
                : failureText(exported.reason, { noun: "the export", tenantName }).body
            }`,
          }
        : null;

  const runExport = async () => {
    if (exported.kind === "busy") return;
    setExported({ kind: "busy" });
    const result = await exportDay(tenantId, day);
    if (!live.current) return;
    setExported(
      result.kind === "saved"
        ? { kind: "saved", fileName: result.fileName }
        : { kind: "failed", reason: result.reason },
    );
  };

  return (
    <section className="bk-totals" aria-labelledby={headingId} aria-busy={load.kind === "loading"}>
      <div className="bk-totals__head">
        <h3 className="bk-totals__title" id={headingId}>
          Day totals
        </h3>
        <Button
          icon="download"
          busy={exported.kind === "busy"}
          busyLabel="Preparing CSV…"
          onClick={() => void runExport()}
        >
          Export CSV
        </Button>
      </div>
      {load.kind === "loading" && <TotalsSkeleton />}
      {load.kind === "failed" && (
        <Notice
          tone="error"
          className="bk-notice"
          title={failureText(load.reason, { noun: "the day's totals", tenantName }).title}
          actions={
            canRetry(load.reason) ? (
              <Button
                icon="refresh"
                busy={load.retrying}
                busyLabel="Trying again…"
                onClick={() => {
                  retrying.current = true;
                  setAttempt((n) => n + 1);
                }}
              >
                Try again
              </Button>
            ) : undefined
          }
        >
          <p>{failureText(load.reason, { noun: "the day's totals", tenantName }).body}</p>
        </Notice>
      )}
      {load.kind === "ready" && <Figures totals={load.value.totals} />}
      {load.kind === "ready" && (
        <p className="bk-totals__note">
          Every booking on the trips departing this day, from each booking's order and refunds
          {zone ? `, as of ${instantText(load.value.generatedAt, zone)}` : ""}.
          {load.value.totals.includedTax > 0 &&
            ` Prices include ${formatMoney(load.value.totals.includedTax)} in taxes.`}
          {load.value.totals.pendingRefunds.count > 0 &&
            ` ${pendingText(load.value.totals.pendingRefunds)} not counted until it settles.`}
        </p>
      )}
      {message && (
        <p className={`bk-totals__export bk-totals__export--${message.tone}`}>
          <Icon name={message.tone === "done" ? "check-circle" : "x-octagon"} />
          <span>{message.text}</span>
        </p>
      )}
      {/* Focus stays on Export CSV, so the outcome is said here (WCAG 4.1.3). */}
      <p className="tg-visually-hidden" role="status">
        {exported.kind === "busy" ? "Preparing the CSV…" : (message?.text ?? "")}
      </p>
    </section>
  );
}

function pendingText(pending: { count: number; amount: number }): string {
  return pending.count === 1
    ? `A refund of ${formatMoney(pending.amount)} is pending and`
    : `${pending.count} refunds of ${formatMoney(pending.amount)} in all are pending and`;
}

/**
 * The figures in the order the money is built: what was booked, then the
 * charge, then what was given back. Deductions read as minus amounts.
 */
function Figures({ totals: t }: { totals: BookingDayTotals }) {
  const rows: { label: string; value: string; kind?: "count" | "total" | "net" }[] = [
    { label: "Bookings", value: String(t.bookings), kind: "count" },
    { label: "Guests", value: guestsText(t.guests).replace(/ guests?$/, ""), kind: "count" },
    { label: "Gross", value: formatMoney(t.gross) },
    { label: "Discounts", value: formatMoney(-t.discounts) },
    { label: "Fees", value: formatMoney(t.fees) },
    { label: "Taxes", value: formatMoney(t.taxes) },
    { label: "Total charged", value: formatMoney(t.total), kind: "total" },
    { label: "Refunds", value: formatMoney(-t.refunds) },
    { label: "Net", value: formatMoney(t.net), kind: "net" },
  ];
  return (
    <dl className="bk-totals__grid">
      {rows.map((row) => (
        <div key={row.label} className={row.kind ? `bk-total bk-total--${row.kind}` : "bk-total"}>
          <dt>{row.label}</dt>
          <dd className={row.kind === "count" ? undefined : "bk-money"}>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function TotalsSkeleton() {
  return (
    <div className="bk-totals__grid" aria-hidden="true">
      {Array.from({ length: 9 }, (_, i) => (
        <div key={i} className="bk-total">
          <Skeleton variant="text" width="4rem" />
          <Skeleton width="5rem" height="1.5rem" />
        </div>
      ))}
    </div>
  );
}
