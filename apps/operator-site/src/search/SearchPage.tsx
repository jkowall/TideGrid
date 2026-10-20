import type { BookingSearchResult, Membership } from "@tidegrid/contracts";
import {
  Button,
  EmptyState,
  Icon,
  Notice,
  Skeleton,
  StatusBadge,
  TextField,
  VisuallyHidden,
} from "@tidegrid/design-system/components";
import { formatMoney, formatTripTime, todayIn, zoneCity } from "@tidegrid/design-system/format";
import { type FormEvent, type RefObject, useEffect, useId, useRef, useState } from "react";
import { bookingHref, bookingStates, dayText, guestsText, paymentCopy } from "../bookings/model.ts";
import { ReadFailed } from "../bookings/States.tsx";
import { focusIsLost } from "../focus.ts";
import type { ReadFailure } from "../http.ts";
import { ConsoleLink } from "../navigation.tsx";
import { type FocusOnArrival, PageHeader } from "../PageHeader.tsx";
import { canSeeGuests, roleNames } from "../roles.ts";
import { type SearchPage as Page, type SearchCriteria, searchBookings } from "./api.ts";
import {
  criteriaOf,
  type FieldProblems,
  firstSearchDate,
  lastSearchDate,
  recallSearch,
  rememberSearch,
  type SearchForm,
  sameCriteria,
  termsText,
} from "./model.ts";

/**
 * Booking search (G2.12c): every booking at the selected operator, by
 * reference, the booker's name or email, and departure dates. Owners and
 * booking staff search and see the booker; finance searches by reference and
 * date and sees the money, never a name: the API matches and sends nothing
 * else to that role.
 *
 * The terms never enter the address. The page keeps the last search in
 * memory for the tab (search/model.ts), so Back from a booking shows the
 * results again, and a reload starts afresh.
 */

type Load =
  | { kind: "idle" }
  | { kind: "loading" }
  /** `paged`: Show more bookings added to the first page, so the count says how many are shown. */
  | { kind: "ready"; page: Page; more: "idle" | "loading" | "failed"; paged?: boolean }
  /** `retrying`: "Try again" is working; the notice stays so focus stays on it. */
  | { kind: "failed"; reason: ReadFailure; failures: number; retrying: boolean };

const emptyForm: SearchForm = { text: "", from: "", to: "" };

export function SearchPage({
  membership,
  focusHeading,
}: { membership: Membership } & FocusOnArrival) {
  const { tenantId, tenantName, role } = membership;
  const seesGuests = canSeeGuests(role);
  const recalled = useRef(recallSearch(tenantId));
  const [form, setForm] = useState<SearchForm>(() => recalled.current ?? emptyForm);
  const [problems, setProblems] = useState<FieldProblems>({});
  /** A refused search's first problem, said once: focus may already be in its field. */
  const [problemSaid, setProblemSaid] = useState("");
  const [criteria, setCriteria] = useState<SearchCriteria | null>(null);
  const [load, setLoad] = useState<Load>({ kind: "idle" });
  const [attempt, setAttempt] = useState(0);
  const retryRequested = useRef(false);
  const textField = useRef<HTMLInputElement>(null);
  const fromField = useRef<HTMLInputElement>(null);
  const toField = useRef<HTMLInputElement>(null);
  const resultsHeading = useRef<HTMLHeadingElement>(null);
  const pageHeading = useRef<HTMLHeadingElement>(null);
  /** The last page took Show more bookings with it: its first booking takes focus. */
  const focusResultId = useRef<string | null>(null);
  const focusResultsOnLoad = useRef(false);

  // A search remembered for this operator runs again when the page opens.
  useEffect(() => {
    const form = recalled.current;
    if (!form) return;
    const asked = criteriaOf(form, seesGuests);
    if (asked.kind === "ok") setCriteria(asked.criteria);
  }, [seesGuests]);

  useEffect(() => {
    void attempt;
    if (!criteria) return;
    const controller = new AbortController();
    const retry = retryRequested.current;
    retryRequested.current = false;
    setLoad((current) =>
      retry && current.kind === "failed" ? { ...current, retrying: true } : { kind: "loading" },
    );
    void searchBookings(tenantId, criteria, {}, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      focusResultsOnLoad.current = retry;
      if (result.kind === "ok") {
        setLoad({ kind: "ready", page: result.value, more: "idle" });
        return;
      }
      setLoad((current) => ({
        kind: "failed",
        reason: result.reason,
        failures: current.kind === "failed" ? current.failures + 1 : 1,
        retrying: false,
      }));
    });
    return () => controller.abort();
  }, [tenantId, criteria, attempt]);

  // A control that went away with the change hands focus on: to the first
  // booking of a last page, or after Try again to the results' heading, or
  // to the page's heading when nothing matched.
  useEffect(() => {
    if (load.kind === "loading" || load.kind === "idle") return;
    if (load.kind === "failed" && load.retrying) return;
    const first = load.kind === "ready" ? focusResultId.current : null;
    focusResultId.current = null;
    const toHeading = focusResultsOnLoad.current;
    focusResultsOnLoad.current = false;
    if ((first === null && !toHeading) || !focusIsLost()) return;
    const link = first ? document.querySelector<HTMLElement>(`[data-result="${first}"]`) : null;
    (link ?? resultsHeading.current ?? pageHeading.current)?.focus();
  }, [load]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const asked = criteriaOf(form, seesGuests);
    if (asked.kind === "invalid") {
      setProblems(asked.problems);
      setProblemSaid(asked.problems.text ?? asked.problems.from ?? asked.problems.to ?? "");
      // The results, or the search on its way, belong to terms the form no longer holds.
      setCriteria(null);
      setLoad({ kind: "idle" });
      const first = asked.problems.text ? textField : asked.problems.from ? fromField : toField;
      first.current?.focus();
      return;
    }
    // The search on its way already asks this. New terms replace it: the
    // effect's cleanup cancels the old request, so its answer never shows.
    if (load.kind === "loading" && sameCriteria(criteria, asked.criteria)) return;
    setProblems({});
    setProblemSaid("");
    rememberSearch(tenantId, form);
    setCriteria(asked.criteria);
    // The same search again reads afresh.
    setAttempt((n) => n + 1);
  };

  const clear = () => {
    setForm(emptyForm);
    setProblems({});
    setProblemSaid("");
    setCriteria(null);
    setLoad({ kind: "idle" });
    rememberSearch(tenantId, emptyForm);
    textField.current?.focus();
  };

  const loadMore = () => {
    if (load.kind !== "ready" || !load.page.nextAfter || !criteria) return;
    const after = load.page.nextAfter;
    setLoad({ ...load, more: "loading" });
    void searchBookings(tenantId, criteria, { after }).then((result) => {
      setLoad((current) => {
        if (current.kind !== "ready" || current.page.nextAfter !== after) return current;
        if (result.kind !== "ok") return { ...current, more: "failed" };
        if (result.value.nextAfter === null) {
          focusResultId.current = result.value.results[0]?.id ?? "";
        }
        return {
          kind: "ready",
          more: "idle",
          paged: true,
          page: { ...result.value, results: [...current.page.results, ...result.value.results] },
        };
      });
    });
  };

  const change = (field: keyof SearchForm) => (value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
    if (problems[field]) setProblems((current) => ({ ...current, [field]: undefined }));
    if (problemSaid) setProblemSaid("");
  };

  const hasInput = Boolean(form.text || form.from || form.to);
  const typed = criteriaOf(form, seesGuests);
  // Busy only for the terms on their way: changed terms can be searched at once.
  const searching =
    load.kind === "loading" && typed.kind === "ok" && sameCriteria(criteria, typed.criteria);
  // Until the person signs in again, Sign in again is the page's one primary action.
  const signedOut = load.kind === "failed" && load.reason === "signed_out";
  const announcement = problemSaid
    ? problemSaid
    : load.kind === "loading"
      ? "Searching bookings…"
      : load.kind === "ready"
        ? load.paged
          ? shownText(load.page.results.length, load.page.total)
          : foundText(load.page.total)
        : "";

  return (
    <>
      <PageHeader
        eyebrow={tenantName}
        title="Search bookings"
        focusHeading={focusHeading}
        headingRef={pageHeading}
      />
      <div className="bs">
        <ConsoleLink href="/bookings" className="bd-back tap-target">
          <Icon name="arrow-left" />
          <span>Bookings by day</span>
        </ConsoleLink>

        <search className="bs-form" aria-label="Search bookings">
          <form onSubmit={submit} noValidate>
            <TextField
              ref={textField}
              label={seesGuests ? "Name, email, or booking reference" : "Booking reference"}
              hint={
                seesGuests
                  ? "Part of the booker's name or email, or the start of a reference"
                  : "The start of a reference, such as QKG6"
              }
              name="q"
              value={form.text}
              error={problems.text}
              autoComplete="off"
              spellCheck={false}
              maxLength={120}
              onChange={(e) => change("text")(e.target.value)}
            />
            <fieldset className="bs-dates">
              <legend className="tg-field__label">Departure dates</legend>
              <TextField
                ref={fromField}
                label="From"
                type="date"
                name="from"
                min={firstSearchDate}
                max={lastSearchDate}
                value={form.from}
                error={problems.from}
                onChange={(e) => change("from")(e.target.value)}
              />
              <TextField
                ref={toField}
                label="To"
                type="date"
                name="to"
                min={firstSearchDate}
                max={lastSearchDate}
                value={form.to}
                error={problems.to}
                onChange={(e) => change("to")(e.target.value)}
              />
            </fieldset>
            <div className="bs-actions">
              <Button
                type="submit"
                variant={signedOut ? "secondary" : "primary"}
                icon="search"
                busy={searching}
                busyLabel="Searching…"
              >
                Search
              </Button>
              {hasInput && (
                <Button variant="ghost" onClick={clear}>
                  Clear
                </Button>
              )}
            </div>
          </form>
        </search>

        {!seesGuests && (
          <p className="bk-note">
            <Icon name="eye-off" />
            <span>
              Your role, {roleNames[role]}, searches by booking reference and departure date.
              Guests' names and contact details aren't searched or shown.
            </span>
          </p>
        )}

        <p className="tg-visually-hidden" role="status">
          {announcement}
        </p>

        {load.kind === "idle" && (
          <EmptyState
            icon="search"
            title={seesGuests ? "Find any booking" : "Find a booking by reference or date"}
          >
            <p>
              {seesGuests
                ? `Search every booking at ${tenantName}, on any day, by the guest's name or email, a reference, or the dates they travel.`
                : `Search every booking at ${tenantName}, on any day, by its reference or the dates it departs.`}
            </p>
          </EmptyState>
        )}
        {load.kind === "loading" && <ResultsSkeleton />}
        {/* The API refused the search as asked: the form is right above. */}
        {load.kind === "failed" && load.reason === "rejected" && (
          <Notice tone="error" className="bk-notice" title="The search couldn't be run">
            <p>Check the text and the dates above, then search again.</p>
          </Notice>
        )}
        {load.kind === "failed" && load.reason !== "rejected" && (
          <ReadFailed
            className="bk-notice"
            reason={load.reason}
            noun="the search"
            tenantName={tenantName}
            failures={load.failures}
            retrying={load.retrying}
            onRetry={() => {
              retryRequested.current = true;
              setAttempt((n) => n + 1);
            }}
          />
        )}
        {load.kind === "ready" && criteria && (
          <Results
            page={load.page}
            terms={termsText(criteria)}
            seesGuests={seesGuests}
            more={load.more}
            onMore={loadMore}
            headingRef={resultsHeading}
          />
        )}
      </div>
    </>
  );
}

function foundText(total: number): string {
  if (total === 0) return "No bookings match.";
  return total === 1 ? "1 booking found." : `${total} bookings found.`;
}

/** After Show more bookings: how many of the search's bookings the list now holds. */
function shownText(shown: number, total: number): string {
  return `Showing ${shown} of ${total} ${total === 1 ? "booking" : "bookings"}.`;
}

function Results({
  page,
  terms,
  seesGuests,
  more,
  onMore,
  headingRef,
}: {
  page: Page;
  /** What was searched, in words: the field may hold other terms by now. */
  terms: string;
  seesGuests: boolean;
  more: "idle" | "loading" | "failed";
  onMore: () => void;
  headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  const headingId = useId();
  if (page.total === 0) {
    return (
      <EmptyState icon="search" title="No bookings match">
        <p>
          {terms}{" "}
          {seesGuests
            ? "Check the spelling, try part of the name or email, or widen the dates."
            : "Check the reference with the guest, or widen the dates."}
        </p>
      </EmptyState>
    );
  }
  return (
    <section className="bs-results" aria-labelledby={headingId}>
      <h2 className="bs-results__title" id={headingId} ref={headingRef} tabIndex={-1}>
        {page.total === 1 ? "1 booking" : `${page.total} bookings`}
      </h2>
      <p className="bs-results__terms">{terms}</p>
      <ul className="bs-list">
        {page.results.map((result) => (
          <ResultItem key={result.id} result={result} seesGuests={seesGuests} />
        ))}
      </ul>
      {page.nextAfter && (
        <div className="bk-more">
          {more === "failed" && (
            <Notice tone="error" className="bk-notice" title="More bookings didn't load">
              <p>Check your connection, then try again.</p>
            </Notice>
          )}
          <Button busy={more === "loading"} busyLabel="Loading more…" onClick={onMore}>
            {more === "failed" ? "Try again" : "Show more bookings"}
          </Button>
        </div>
      )}
    </section>
  );
}

function ResultItem({ result, seesGuests }: { result: BookingSearchResult; seesGuests: boolean }) {
  const { trip } = result;
  const payment = paymentCopy(result.payment);
  const state = bookingStates[result.state];
  const today = todayIn(trip.timeZone);
  const time = formatTripTime(trip.localStartTime, trip.startsAt, trip.timeZone);
  return (
    <li className="bs-item">
      <ConsoleLink
        href={bookingHref(result.id)}
        className="bk-row__ref bs-item__ref tap-target"
        data-result={result.id}
      >
        <VisuallyHidden>Booking </VisuallyHidden>
        {result.reference}
      </ConsoleLink>
      <p className="bs-item__trip">
        <span className="bs-item__when">
          {dayText(trip.localDate, "medium", today)}, {time}
        </span>{" "}
        <span className="bs-item__product">{trip.productName}</span>
        <span className="bs-item__meta">
          {trip.boatName}, {zoneCity(trip.timeZone)} time
        </span>
      </p>
      <dl className="bs-item__facts">
        {seesGuests && (
          <div className="bk-fact bs-item__booker">
            <dt className="bk-fact__label">Booker</dt>
            <dd>
              {result.booker ? (
                <>
                  {result.booker.name}
                  <span className="bk-fact__detail bs-item__email">{result.booker.email}</span>
                </>
              ) : (
                "Not given"
              )}
            </dd>
          </div>
        )}
        <div className="bk-fact">
          <dt className="bk-fact__label">Party</dt>
          <dd>{guestsText(result.guests)}</dd>
        </div>
        <div className="bk-fact">
          <dt className="bk-fact__label">Total</dt>
          <dd className="bk-money">{formatMoney(result.total, result.currency)}</dd>
        </div>
        <div className="bk-fact bs-item__status">
          <dt className="bk-fact__label">Status</dt>
          <dd className="bk-badges">
            <StatusBadge tone={payment.tone} icon={payment.icon}>
              {payment.label}
            </StatusBadge>
            <StatusBadge tone={state.tone} icon={state.icon}>
              {state.label}
            </StatusBadge>
          </dd>
        </div>
      </dl>
    </li>
  );
}

function ResultsSkeleton() {
  return (
    <div className="bs-list bs-list--skeleton" aria-hidden="true">
      {Array.from({ length: 3 }, (_, i) => (
        <div key={i} className="bs-item">
          <Skeleton width="7rem" height="1.25rem" />
          <Skeleton variant="text" width="min(24rem, 85%)" />
          <Skeleton variant="text" width="min(18rem, 70%)" />
        </div>
      ))}
    </div>
  );
}
