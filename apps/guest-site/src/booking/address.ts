/**
 * The booking page's address: `/book/<tripId>` with only non-sensitive state
 * in the query, so a reload or a shared link comes back to the same choice.
 *
 *   party=4          the party size chosen on the trips list, used once
 *   t.<code>=2       tickets of one type (shared seats)
 *   guests=6         guests aboard (private charter)
 *   a.<code>=1       a paid add-on
 *   step=details     details, pay, or status; the party step is the default
 *   quote=<uuid>     the quote the details step shows
 *
 * Never in the address: the booker's name or email, the promotion code, the
 * checkout secret, the payment's client secret, or the checkout's id.
 */

export type BookingStep = "party" | "details" | "pay" | "status";

const steps: readonly BookingStep[] = ["party", "details", "pay", "status"];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const itemCode = /^[a-z][a-z0-9_]{0,31}$/;
const bookPath = /^\/book\/([^/]+)\/?$/;

/** The most of anything the address may ask for; the API takes up to 500 guests. */
export const maxCount = 500;

export interface BookingAddress {
  tripId: string;
  /** The trips list's party size, before the guest chooses tickets here. */
  party: number | null;
  tickets: Record<string, number>;
  guests: number | null;
  addOns: Record<string, number>;
  step: BookingStep;
  quoteId: string | null;
}

export function isUuid(value: string): boolean {
  return uuid.test(value);
}

/** The trip a `/book/<tripId>` path names, or null for any other path. */
export function tripIdOf(pathname: string): string | null {
  const match = bookPath.exec(pathname);
  const id = match?.[1];
  return id && isUuid(id) ? id.toLowerCase() : null;
}

/** Where the trips list sends a guest to book: the trip, and the party they asked for. */
export function bookingHref(tripId: string, party?: number): string {
  const query = party && party > 1 ? `?party=${party}` : "";
  return `/book/${tripId}${query}`;
}

function count(value: string | null, min: number): number | null {
  if (value === null || !/^\d{1,3}$/.test(value)) return null;
  const n = Number(value);
  return n >= min && n <= maxCount ? n : null;
}

/** Read the query. Anything malformed is dropped, never trusted. */
export function readAddress(tripId: string, search: string): BookingAddress {
  const params = new URLSearchParams(search);
  const tickets: Record<string, number> = {};
  const addOns: Record<string, number> = {};
  for (const [name, value] of params) {
    const prefix = name.slice(0, 2);
    const code = name.slice(2);
    if ((prefix !== "t." && prefix !== "a.") || !itemCode.test(code)) continue;
    const n = count(value, 1);
    if (n === null) continue;
    if (prefix === "t.") tickets[code] = n;
    else addOns[code] = n;
  }
  const step = params.get("step");
  const quote = params.get("quote");
  return {
    tripId,
    party: count(params.get("party"), 1),
    tickets,
    guests: count(params.get("guests"), 1),
    addOns,
    step: steps.find((s) => s === step) ?? "party",
    quoteId: quote && isUuid(quote) ? quote.toLowerCase() : null,
  };
}

/** The booking page at its first step, keeping the party the address asked for. */
export function restartHref(address: BookingAddress): string {
  const params = new URLSearchParams();
  for (const [code, n] of Object.entries(address.tickets)) params.set(`t.${code}`, String(n));
  if (address.guests !== null) params.set("guests", String(address.guests));
  if (address.party !== null) params.set("party", String(address.party));
  for (const [code, n] of Object.entries(address.addOns)) params.set(`a.${code}`, String(n));
  const text = params.toString();
  return `/book/${address.tripId}${text ? `?${text}` : ""}`;
}

export interface AddressState {
  kind: "tickets" | "charter";
  tickets: Record<string, number>;
  guests: number;
  addOns: Record<string, number>;
  step: BookingStep;
  quoteId: string | null;
}

/** The query for the page's state: counts of zero and the party step are left out. */
export function writeAddress(state: AddressState): string {
  const params = new URLSearchParams();
  if (state.kind === "tickets") {
    for (const [code, n] of Object.entries(state.tickets))
      if (n > 0) params.set(`t.${code}`, String(n));
  } else {
    params.set("guests", String(state.guests));
  }
  for (const [code, n] of Object.entries(state.addOns))
    if (n > 0) params.set(`a.${code}`, String(n));
  if (state.step !== "party") params.set("step", state.step);
  if (state.quoteId && state.step === "details") params.set("quote", state.quoteId);
  const text = params.toString();
  return text ? `?${text}` : "";
}
