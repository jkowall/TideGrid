/**
 * The generic dock QR (W3-G2.15-rest, owner decision 2026-11-13; migration
 * 0043). One QR code at the dock opens the guest site's dock page. A guest
 * types the booking code and the booker's last name; a match shows that
 * booking's own party, for a trip departing that day, and lets the guest
 * start a signing on their own phone with no email.
 *
 * - Every try is a `waiver_dock_lookups` row. The database counts misses per
 *   client address, per booking code, and per operator, and matches per
 *   client address, under advisory locks, and refuses a try past a limit.
 *   A miss never says why: an unknown code, another day's trip, a canceled
 *   booking, and a wrong name all answer the same.
 * - A match returns a 15-minute secret (only its hash is stored) and the
 *   party: first names and an initial, whether each person's waiver is
 *   signed, still to sign, or not needed, and who signs. No address, no
 *   ids, no delivery history.
 * - With the secret, the guest picks a person by position and gets a
 *   single-use 15-minute waiver link with no email, recorded as a
 *   `dock_lookup` start (0043), which opens the usual signing page. The
 *   evidence then records `dock_lookup` and the match method
 *   `booking_lookup`.
 *
 * Lock order: the request, then its links, as everywhere else.
 */
import type { TenantContext, TenantTransaction, WaiverSignerRole } from "@tidegrid/database";
import { recordAudit } from "@tidegrid/database";
import { sql } from "kysely";
import { issueCodeLink } from "./assisted.ts";
import { loadBookingContext, tripFacts } from "./booking.ts";
import { sha256Hex } from "./content.ts";
import { lockRequest } from "./delivery.ts";
import { cleanLine } from "./format.ts";
import { WAIVER_LINK_PATH } from "./links.ts";
import type { WaiverDeps } from "./ports.ts";
import { newWaiverSecret, waiverSecretPattern } from "./secrets.ts";
import { listBookingWaivers } from "./status.ts";

/** How long a matched lookup lists the party and starts signings (0043). */
export const DOCK_LOOKUP_TTL_MINUTES = 15;

/** Booking codes are 8 characters of Crockford's base32 (0007). */
const BOOKING_CODE = /^[0-9A-HJKMNP-TV-Z]{8}$/;

/**
 * A typed booking code as the database compares it: upper case, spaces and
 * dashes dropped, and Crockford's look-alikes folded (O to 0, I and L to 1).
 * Null when what is left is not 1 to 16 letters and digits.
 */
export function normalizeBookingCode(input: string): string | null {
  const key = input
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[\s\-_.]+/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  return /^[0-9A-Z]{1,16}$/.test(key) ? key : null;
}

/** A name compared for the dock: Unicode-normalized, accents dropped, lower case, words only. */
function nameWords(name: string): string[] {
  return name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter((w) => w.length > 0);
}

/**
 * Whether a typed last name is the booker's: the last word, or the last
 * words, of the booker's name, ignoring case, accents, and punctuation. One
 * letter is never enough.
 */
export function lastNameMatches(bookerName: string, typed: string): boolean {
  const booker = nameWords(bookerName);
  const last = nameWords(typed);
  if (last.length === 0 || last.join("").length < 2 || last.length >= booker.length) return false;
  const tail = booker.slice(booker.length - last.length);
  return tail.every((w, i) => w === last[i]);
}

/** How the dock shows a person: the first name and the last name's initial. */
export function dockDisplayName(name: string): string {
  const words = cleanLine(name)
    .split(" ")
    .filter((w) => w.length > 0);
  if (words.length <= 1) return words[0] ?? "";
  const lastWord = words[words.length - 1] ?? "";
  const initial = Array.from(lastWord)[0] ?? "";
  return `${words[0]} ${initial}.`;
}

export type DockPersonStatus = "signed" | "to_sign" | "not_needed" | "ask_crew";

export interface DockParty {
  trip: { name: string; when: string };
  expiresAt: Date;
  people: {
    position: number;
    name: string;
    minor: boolean;
    status: DockPersonStatus;
    /** Who signs, while it waits: the person, or a minor's parent or guardian. */
    signer: WaiverSignerRole | null;
  }[];
}

export type DockLookupResult =
  | { kind: "matched"; secret: string; party: DockParty }
  /** No such booking today, or the name did not match; always the same. */
  | { kind: "not_found" }
  /** Too many tries: from this address, for this code, or at this operator. */
  | { kind: "limited" }
  /** The code is not letters and digits. Nothing is counted. */
  | { kind: "invalid" };

interface DockLookup {
  id: string;
  bookingId: string;
  expiresAt: Date;
}

async function refusal(
  trx: TenantTransaction,
  referenceKey: string,
  matched: boolean,
): Promise<string | null> {
  const { rows } = await sql<{ refusal: string | null }>`
    select app.waiver_dock_refusal(${referenceKey}, ${matched}) as refusal`.execute(trx);
  return rows[0]?.refusal ?? null;
}

/**
 * Try a booking code and last name at the dock, as a guest. The try is
 * recorded either way, and the caller commits it: a miss is an answer, not
 * an error.
 */
export async function lookUpAtDock(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: { bookingCode: string; lastName: string },
): Promise<DockLookupResult> {
  if (ctx.actorType !== "guest") throw new Error("the dock lookup is a guest's");
  const referenceKey = normalizeBookingCode(input.bookingCode);
  if (!referenceKey) return { kind: "invalid" };
  if (await refusal(trx, referenceKey, false)) return { kind: "limited" };

  let bookingId: string | null = null;
  if (BOOKING_CODE.test(referenceKey)) {
    const { rows } = await sql<{ id: string; booker_name: string }>`
      select b.id, cs.booker_name
        from bookings b
        join checkout_sessions cs on cs.tenant_id = b.tenant_id and cs.id = b.checkout_session_id
        join scheduled_trips t on t.tenant_id = b.tenant_id and t.id = b.trip_id
       where b.tenant_id = ${ctx.tenantId} and b.reference = ${referenceKey}
         and b.state = 'confirmed' and t.ends_at > now()
         and (t.starts_at at time zone t.time_zone)::date = (now() at time zone t.time_zone)::date
       `.execute(trx);
    const found = rows[0];
    if (found && lastNameMatches(found.booker_name, input.lastName)) bookingId = found.id;
  }
  if (bookingId === null) {
    await sql`insert into waiver_dock_lookups (tenant_id, reference_key, matched)
              values (${ctx.tenantId}, ${referenceKey}, false)`.execute(trx);
    return { kind: "not_found" };
  }
  if (await refusal(trx, referenceKey, true)) return { kind: "limited" };
  const secret = newWaiverSecret();
  const { rows } = await sql<{ id: string; expires_at: Date }>`
    insert into waiver_dock_lookups (tenant_id, reference_key, matched, booking_id, secret_hash)
    values (${ctx.tenantId}, ${referenceKey}, true, ${bookingId}, ${await dockSecretHash(secret)})
    returning id, expires_at`.execute(trx);
  const lookup = rows[0];
  if (!lookup?.expires_at) throw new Error("a matched dock lookup has no expiry");
  await recordAudit(trx, ctx, {
    action: "waiver_dock.matched",
    subjectType: "booking",
    subjectId: bookingId,
    after: { lookupId: lookup.id },
  });
  const party = await dockParty(trx, ctx.tenantId, {
    id: lookup.id,
    bookingId,
    expiresAt: new Date(lookup.expires_at),
  });
  if (!party) throw new Error("a matched dock lookup's booking was not found");
  return { kind: "matched", secret, party };
}

/** The stored form of a dock lookup's secret, under its own purpose label. */
function dockSecretHash(secret: string): Promise<string> {
  if (!waiverSecretPattern.test(secret)) {
    throw new TypeError("a dock lookup secret is 43 base64url characters");
  }
  return sha256Hex(`waiver-dock:${secret}`);
}

/**
 * The matched lookup a secret names in this tenant, while it lasts, its
 * booking is confirmed, and its trip has not ended. Null otherwise.
 */
export async function loadDockLookup(
  trx: TenantTransaction,
  tenantId: string,
  secret: string,
): Promise<DockLookup | null> {
  if (!waiverSecretPattern.test(secret)) return null;
  const { rows } = await sql<{ id: string; booking_id: string; expires_at: Date }>`
    select k.id, k.booking_id, k.expires_at
      from waiver_dock_lookups k
      join bookings b on b.tenant_id = k.tenant_id and b.id = k.booking_id
      join scheduled_trips t on t.tenant_id = b.tenant_id and t.id = b.trip_id
     where k.tenant_id = ${tenantId} and k.secret_hash = ${await dockSecretHash(secret)}
       and k.matched and k.expires_at > now()
       and b.state = 'confirmed' and t.ends_at > now()`.execute(trx);
  const row = rows[0];
  return row
    ? { id: row.id, bookingId: row.booking_id, expiresAt: new Date(row.expires_at) }
    : null;
}

/** The party as the dock shows it. */
export async function dockParty(
  trx: TenantTransaction,
  tenantId: string,
  lookup: DockLookup,
): Promise<DockParty | null> {
  const booking = await loadBookingContext(trx, tenantId, lookup.bookingId);
  const waivers = await listBookingWaivers(trx, tenantId, lookup.bookingId);
  if (!booking || !waivers) return null;
  const trip = tripFacts(booking);
  return {
    trip: { name: trip.name, when: trip.when },
    expiresAt: lookup.expiresAt,
    people: waivers.participants.map((p) => {
      const pending = p.request?.state === "pending";
      const status: DockPersonStatus =
        p.status === "signed"
          ? "signed"
          : p.status === "not_needed"
            ? "not_needed"
            : pending
              ? "to_sign"
              : "ask_crew";
      return {
        position: p.position,
        name: dockDisplayName(p.name),
        minor: p.minor,
        status,
        signer: pending ? (p.request?.requiredSigner ?? null) : null,
      };
    }),
  };
}

export type DockSigningResult =
  | { kind: "issued"; path: string; expiresAt: Date }
  /** The lookup lapsed, or its booking or trip no longer allows it: look up again. */
  | { kind: "lookup_ended" }
  /** No one at that position, or their waiver no longer waits for a signature. */
  | { kind: "not_pending" }
  /** This lookup started as many signings as it may. */
  | { kind: "limited" };

/** Start a signing for the person at `position` of a matched lookup's party. */
export async function startDockSigning(
  trx: TenantTransaction,
  ctx: TenantContext,
  deps: WaiverDeps,
  input: { secret: string; position: number },
): Promise<DockSigningResult> {
  if (ctx.actorType !== "guest") throw new Error("a dock signing is started by the guest");
  const lookup = await loadDockLookup(trx, ctx.tenantId, input.secret);
  if (!lookup) return { kind: "lookup_ended" };
  const waivers = await listBookingWaivers(trx, ctx.tenantId, lookup.bookingId);
  const person = waivers?.participants.find((p) => p.position === input.position);
  const requestId = person?.request?.state === "pending" ? person.request.id : null;
  if (!person || !requestId) return { kind: "not_pending" };
  const request = await lockRequest(trx, ctx.tenantId, requestId);
  if (
    request?.state !== "pending" ||
    request.booking_id !== lookup.bookingId ||
    request.participant_id !== person.participantId
  ) {
    return { kind: "not_pending" };
  }
  const participant = (await deps.participants.list(trx, ctx.tenantId, request.booking_id)).find(
    (p) => p.id === request.participant_id,
  );
  if (!participant || (request.required_signer === "guardian") !== participant.minor) {
    return { kind: "not_pending" };
  }
  const { rows: started } = await sql<{ n: number }>`
    select count(*)::int as n from waiver_assisted_links
     where tenant_id = ${ctx.tenantId} and dock_lookup_id = ${lookup.id}`.execute(trx);
  if ((started[0]?.n ?? 0) >= 30) return { kind: "limited" };
  const link = await issueCodeLink(trx, ctx, request, {
    mode: "dock_lookup",
    dockLookupId: lookup.id,
  });
  await recordAudit(trx, ctx, {
    action: "waiver_access.dock_started",
    subjectType: "waiver_request",
    subjectId: request.id,
    after: { linkId: link.id, lookupId: lookup.id },
  });
  return {
    kind: "issued",
    path: `${WAIVER_LINK_PATH}#t=${link.token}`,
    expiresAt: link.expiresAt,
  };
}
