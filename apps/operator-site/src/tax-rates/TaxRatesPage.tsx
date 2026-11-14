import type { Membership, TaxRate } from "@tidegrid/contracts";
import {
  Button,
  CheckboxField,
  Dialog,
  EmptyState,
  Notice,
  SelectField,
  Skeleton,
  StatusBadge,
  TextField,
} from "@tidegrid/design-system/components";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { canRetry, ReadFailed } from "../bookings/States.tsx";
import { newIdempotencyKey } from "../calendar/api.ts";
import { focusIsLost } from "../focus.ts";
import type { ReadFailure } from "../http.ts";
import { type FocusOnArrival, PageHeader } from "../PageHeader.tsx";
import { canManageTaxRates, roleNames } from "../roles.ts";
import {
  addTaxRate,
  changeTaxRate,
  loadTaxRates,
  type TaxRatesPage as Page,
  type RateLocation,
  type SaveFailure,
} from "./api.ts";
import {
  appliesAt,
  chargedAs,
  type Field,
  formProblems,
  nameLimit,
  percentOf,
  ppmOf,
  reasonLimit,
} from "./model.ts";
import "../links/links.css";

/**
 * Tax rates (W3-G2.5-TAX staff screens): the operator's tax rates, each for
 * every location or one, added to prices or included in them. Every role
 * reads the list; owners add a rate and change it, with a reason, which the
 * API keeps as the rate's next version. Quotes and bookings already made keep
 * the version they used. TideGrid applies what the operator enters.
 */

export const taxRatesPath = "/tax-rates";

type Load =
  | { kind: "loading" }
  | { kind: "ready"; page: Page }
  | { kind: "failed"; reason: ReadFailure; failures: number; retrying: boolean };

const addButtonId = "tax-add";
const rowId = (id: string) => `tax-${id}`;

export function TaxRatesPage({
  membership,
  focusHeading,
}: { membership: Membership } & FocusOnArrival) {
  const { tenantId, tenantName, role } = membership;
  const manage = canManageTaxRates(role);
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const retryRequested = useRef(false);
  const focusHeadingOnLoad = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const [editing, setEditing] = useState<TaxRate | "new" | null>(null);
  const [said, setSaid] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  /** After a save, the rate's row takes focus. */
  const focusAfter = useRef<string | null>(null);

  useEffect(() => {
    void attempt;
    const controller = new AbortController();
    const retry = retryRequested.current;
    retryRequested.current = false;
    setLoad((current) => {
      if (current.kind === "ready") return current;
      return retry && current.kind === "failed"
        ? { ...current, retrying: true }
        : { kind: "loading" };
    });
    void loadTaxRates(tenantId, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setRefreshing(false);
      focusHeadingOnLoad.current = retry && (result.kind === "ok" || !canRetry(result.reason));
      if (result.kind === "ok") return setLoad({ kind: "ready", page: result.value });
      setLoad((current) => ({
        kind: "failed",
        reason: result.reason,
        failures: current.kind === "failed" ? current.failures + 1 : 1,
        retrying: false,
      }));
    });
    return () => controller.abort();
  }, [tenantId, attempt]);

  useEffect(() => {
    if (load.kind === "loading") return;
    const target = focusAfter.current;
    focusAfter.current = null;
    if (target) {
      const element = document.getElementById(target);
      element?.focus();
      if (!element || document.activeElement !== element) heading.current?.focus();
      return;
    }
    if (!focusHeadingOnLoad.current) return;
    focusHeadingOnLoad.current = false;
    if (focusIsLost()) heading.current?.focus();
  }, [load]);

  /** After a save, read the list again, so it shows the API's order and every owner's changes. */
  const put = (rate: TaxRate, message: string) => {
    focusAfter.current = rowId(rate.id);
    setSaid(message);
    retryRequested.current = false;
    setRefreshing(true);
    setAttempt((n) => n + 1);
  };

  const header = (
    <PageHeader
      eyebrow={tenantName}
      title="Tax rates"
      focusHeading={focusHeading}
      headingRef={heading}
    />
  );

  if (load.kind === "loading") {
    return (
      <>
        {header}
        <div className="links-skeleton" aria-hidden="true">
          <Skeleton variant="text" width="min(30rem, 90%)" />
          <Skeleton variant="text" width="min(22rem, 70%)" />
        </div>
      </>
    );
  }
  if (load.kind === "failed") {
    return (
      <>
        {header}
        <ReadFailed
          reason={load.reason}
          noun="the tax rates"
          tenantName={tenantName}
          failures={load.failures}
          retrying={load.retrying}
          onRetry={() => {
            retryRequested.current = true;
            setAttempt((n) => n + 1);
          }}
        />
      </>
    );
  }

  const { rates, locations, locationsLoaded } = load.page;
  const active = rates.filter((r) => r.active);
  const retired = rates.filter((r) => !r.active);
  const canEdit = manage && locationsLoaded;

  return (
    <>
      {header}
      <p className="links-lede">
        The taxes on {tenantName}'s trips, for every location or only for trips that leave from one.
        TideGrid applies the rates entered here and doesn't give tax advice. A change applies to new
        bookings; bookings already made keep the rate they were made with.
      </p>
      {manage ? (
        <div className="links-actions">
          <Button
            id={addButtonId}
            variant="primary"
            icon="plus"
            disabled={!locationsLoaded || refreshing}
            onClick={() => setEditing("new")}
          >
            Add a tax rate
          </Button>
        </div>
      ) : (
        <p className="links-hint">
          Only owners change tax rates. Your role, {roleNames[role]}, can see them.
        </p>
      )}
      <p className="tg-visually-hidden" role="status">
        {said}
      </p>
      {manage && !locationsLoaded && (
        <Notice tone="warning" title="The locations didn't load">
          <p>
            The rates show, but they can't be added or changed until the page loads the locations.
            Reload the page to try again.
          </p>
        </Notice>
      )}

      {active.length === 0 ? (
        <EmptyState icon="receipt" title="No tax rates in use">
          <p>
            {manage
              ? "Without a rate, bookings carry no tax. Add one if your trips are taxed."
              : `When an owner of ${tenantName} adds a tax rate, it shows here.`}
          </p>
        </EmptyState>
      ) : (
        <ul className="links-list" aria-label="Tax rates in use">
          {active.map((rate) => (
            <li key={rate.id} className="console-card links-item">
              <RateSummary rate={rate} />
              {canEdit && (
                <div className="links-item__actions">
                  <Button
                    icon="pencil"
                    disabled={refreshing}
                    onClick={() => setEditing(rate)}
                    aria-describedby={rowId(rate.id)}
                  >
                    Change <span className="tg-visually-hidden">{rate.name}</span>
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {retired.length > 0 && (
        <details className="links-archived">
          <summary>Retired rates ({retired.length}), which new bookings don't use</summary>
          <ul className="links-list">
            {retired.map((rate) => (
              <li key={rate.id} className="console-card links-item links-item--archived">
                <RateSummary rate={rate} />
                {canEdit && (
                  <div className="links-item__actions">
                    <Button
                      icon="pencil"
                      disabled={refreshing}
                      onClick={() => setEditing(rate)}
                      aria-describedby={rowId(rate.id)}
                    >
                      Change <span className="tg-visually-hidden">{rate.name}</span>
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

      {editing && (
        <RateDialog
          tenantId={tenantId}
          rate={editing === "new" ? null : editing}
          locations={locations}
          onClose={(stale) => {
            const from = editing === "new" ? addButtonId : rowId(editing.id);
            setEditing(null);
            if (stale) {
              // The rate may have changed, or been saved with no answer: read
              // the list again, so a second try doesn't add it twice.
              focusAfter.current = from;
              setRefreshing(true);
              setAttempt((n) => n + 1);
              return;
            }
            requestAnimationFrame(() => document.getElementById(from)?.focus());
          }}
          onSaved={(rate, added) => {
            const was = editing === "new" ? null : editing;
            setEditing(null);
            put(
              rate,
              added
                ? `Added ${rate.name}.`
                : was?.active && !rate.active
                  ? `Retired ${rate.name}. New bookings don't use it.`
                  : !was?.active && rate.active
                    ? `${rate.name} is in use again.`
                    : `Saved ${rate.name}.`,
            );
          }}
        />
      )}
    </>
  );
}

function RateSummary({ rate }: { rate: TaxRate }) {
  const changed = new Date(rate.changedAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  return (
    <div className="links-item__main" id={rowId(rate.id)} tabIndex={-1}>
      <p className="links-item__title">
        {rate.name}
        {!rate.active && (
          <>
            {" "}
            <StatusBadge tone="neutral">Retired</StatusBadge>
          </>
        )}
      </p>
      <p>{chargedAs(rate)}</p>
      <p className="links-item__meta">Applies at: {appliesAt(rate)}</p>
      <p className="links-item__note">
        Version {rate.version}, changed {changed}: {rate.reason}
      </p>
    </div>
  );
}

const saveProblems: Record<SaveFailure, string> = {
  signed_out: "You're signed out. Sign in again, then save the rate.",
  forbidden: "Only owners change tax rates.",
  suspended: "While this operator is suspended, tax rates can't change.",
  no_access: "You no longer have access to this operator. Ask one of its owners.",
  not_found: "This rate isn't here any more. Close this to see the rates as they are now.",
  rejected: "That rate couldn't be saved. Check the name, the percentage, and the reason.",
  unreadable:
    "TideGrid sent an answer this console can't read, so it isn't known whether this was saved. Close this to see the rates as they are now, or send it again: the same change is applied only once.",
  unreachable:
    "TideGrid didn't answer, so it isn't known whether this was saved. Check your connection and send it again: the same change is applied only once.",
  unavailable:
    "TideGrid didn't answer properly, so it isn't known whether this was saved. Send it again in a moment: the same change is applied only once.",
  key_reused: "The rate changed while it was being sent. Save again.",
  rate_changed:
    "Someone changed this rate after you opened it, so nothing was saved. Close this, check the rate as it is now, then change it again.",
  unknown_location:
    "That location isn't this operator's any more. Close this to see the locations as they are now.",
};

const everyLocation = "";

/** After these, the page reads the list again when the dialog closes. */
const staleAfter: ReadonlySet<SaveFailure> = new Set([
  "unreadable",
  "unreachable",
  "unavailable",
  "not_found",
  "unknown_location",
  "rate_changed",
]);

function RateDialog({
  tenantId,
  rate,
  locations,
  onClose,
  onSaved,
}: {
  tenantId: string;
  rate: TaxRate | null;
  locations: RateLocation[];
  /** `stale`: the list may be out of date, so the page reads it again. */
  onClose: (stale: boolean) => void;
  onSaved: (rate: TaxRate, added: boolean) => void;
}) {
  const [name, setName] = useState(rate?.name ?? "");
  const [percent, setPercent] = useState(rate ? percentOf(rate.ratePpm) : "");
  const [inclusive, setInclusive] = useState(rate?.inclusive ?? false);
  const [locationId, setLocationId] = useState(rate?.locationId ?? everyLocation);
  const [active, setActive] = useState(rate?.active ?? true);
  const [reason, setReason] = useState("");
  const [shown, setShown] = useState<Partial<Record<Field, string>>>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const key = useRef<{ body: string; key: string } | null>(null);
  const stale = useRef(false);
  const first = useRef<HTMLInputElement>(null);
  const formId = useId();

  // Active locations, and the rate's own location even if it was archived since.
  const options = [
    { value: everyLocation, label: "Every location" },
    ...locations
      .filter((l) => !l.archived || l.id === rate?.locationId)
      .map((l) => ({ value: l.id, label: l.archived ? `${l.name} (archived)` : l.name })),
    ...(rate?.locationId && !locations.some((l) => l.id === rate.locationId)
      ? [{ value: rate.locationId, label: appliesAt(rate) }]
      : []),
  ];

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const problems = formProblems({ name, rate: percent, reason });
    setShown(problems);
    setProblem(undefined);
    const firstProblem = (["name", "rate", "reason"] as const).find((k) => problems[k]);
    if (firstProblem) {
      document.getElementById(`${formId}-${firstProblem}`)?.focus();
      return;
    }
    const base = {
      name: name.trim(),
      ratePpm: ppmOf(percent) ?? 0,
      inclusive,
      locationId: locationId === everyLocation ? null : locationId,
      reason: reason.trim(),
    };
    const input = rate ? { ...base, active, expectedVersion: rate.version } : base;
    const body = JSON.stringify(input);
    if (key.current?.body !== body) key.current = { body, key: newIdempotencyKey() };
    setBusy(true);
    const result = rate
      ? await changeTaxRate(
          tenantId,
          rate.id,
          { ...base, active, expectedVersion: rate.version },
          key.current.key,
        )
      : await addTaxRate(tenantId, base, key.current.key);
    setBusy(false);
    if (result.kind === "saved") return onSaved(result.rate, rate === null);
    if (result.reason === "key_reused") key.current = null;
    if (staleAfter.has(result.reason)) stale.current = true;
    setProblem(saveProblems[result.reason]);
  };

  return (
    <Dialog
      title={rate ? `Change ${rate.name}` : "Add a tax rate"}
      onClose={() => onClose(stale.current)}
      dismissible={!busy}
      initialFocus={first}
      restoreFocus={false}
      className="links-dialog"
      footer={
        <>
          <Button onClick={() => onClose(stale.current)} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={formId}
            variant="primary"
            icon="check"
            busy={busy}
            busyLabel="Saving…"
          >
            {rate ? "Save changes" : "Add rate"}
          </Button>
        </>
      }
    >
      <form id={formId} className="links-form" onSubmit={(e) => void submit(e)} noValidate>
        {problem && (
          <Notice tone="error" title="The rate wasn't saved">
            <p>{problem}</p>
          </Notice>
        )}
        {rate && (
          <p className="links-hint">
            Saving makes version {rate.version + 1}. Bookings already made keep the version they
            used.
          </p>
        )}
        <TextField
          ref={first}
          id={`${formId}-name`}
          label="Name"
          hint={`As staff and receipts show it, such as "State sales tax". At most ${nameLimit} characters.`}
          value={name}
          maxLength={nameLimit * 2}
          autoComplete="off"
          error={shown.name}
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
        />
        <TextField
          id={`${formId}-rate`}
          label="Rate (%)"
          hint="A percentage with up to four decimal places, such as 6.25."
          inputMode="decimal"
          value={percent}
          autoComplete="off"
          error={shown.rate}
          disabled={busy}
          onChange={(e) => setPercent(e.target.value)}
        />
        <CheckboxField
          label="Prices already include this tax"
          hint="Leave this off when the tax is added on top of the price."
          checked={inclusive}
          disabled={busy}
          onChange={(e) => setInclusive(e.target.checked)}
        />
        <SelectField
          label="Applies at"
          hint="Every location, or only trips that leave from one."
          options={options}
          value={locationId}
          disabled={busy}
          onChange={(e) => setLocationId(e.target.value)}
        />
        {rate && (
          <CheckboxField
            label={rate.active ? "Retire this rate" : "Use this rate again"}
            hint={
              rate.active
                ? "New bookings stop using it. You can use it again later."
                : "New bookings start using it again."
            }
            checked={rate.active ? !active : active}
            disabled={busy}
            onChange={(e) => setActive(rate.active ? !e.target.checked : e.target.checked)}
          />
        )}
        <TextField
          id={`${formId}-reason`}
          label="Reason"
          hint={`Kept with the rate for the record, such as "County rate from January 1". At most ${reasonLimit} characters.`}
          value={reason}
          autoComplete="off"
          error={shown.reason}
          disabled={busy}
          onChange={(e) => setReason(e.target.value)}
        />
      </form>
    </Dialog>
  );
}
