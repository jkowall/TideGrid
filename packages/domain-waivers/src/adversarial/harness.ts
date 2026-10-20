/**
 * Shared helpers for the G2.15 adversarial suites (Node only, integration
 * tests). Every call under test runs as tidegrid_app over real PostgreSQL
 * connections; the admin connection builds fixtures, makes time pass the ways
 * the database allows, and reads stored state. Nothing is mocked: bookings
 * come from the real checkout, participants from the booking module's own
 * command, and links from the messaging module's real delivery job. The one
 * stand-in is an email provider that wraps the fake provider and can hold one
 * message's send open, so a test can act while that email is in flight.
 *
 * All data is synthetic: names are invented, addresses end in .test.
 */
import { randomUUID } from "node:crypto";
import { createDb, inTenantTransaction, type TenantContext } from "@tidegrid/database";
import type { IntegrationDatabase } from "@tidegrid/database/testing";
import type { BookingHooks, ParticipantDetails } from "@tidegrid/domain-booking";
import {
  deliverTenantMessages,
  type EmailProvider,
  EmailProviderRejectedError,
  EmailProviderUnavailableError,
  FakeEmailProvider,
  type OutgoingEmail,
} from "@tidegrid/domain-messaging";
import postgres from "postgres";
import {
  getSigningView,
  type RedeemResult,
  redeemWaiverToken,
  type SignInput,
  type SignResult,
  signWaiver,
  type WaiverDeps,
  type WaiverSession,
} from "../index.ts";
import {
  type Booked,
  bookParty,
  FIXTURE_FROM,
  FIXTURE_LINK_ORIGIN,
  linkFor,
  nameParticipant,
  tokenOf,
  type WaiverFixture,
} from "../test-fixtures.ts";

export type Sql = ReturnType<typeof postgres>;
export type Runtime = ReturnType<typeof createDb>;
export type Db = Runtime["db"];

// Races ---------------------------------------------------------------------------------

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A promise one side opens and others wait on, with a value. */
export function gate<T = void>() {
  let open!: (value: T) => void;
  const opened = new Promise<T>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

/** Bound a wait, so a missing party fails the test instead of hanging it. */
export async function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms: ${what}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Releases every party at once when the last one arrives; fails instead of hanging. */
export function barrier(parties: number, timeoutMs = 60_000) {
  let arrived = 0;
  let open!: () => void;
  let fail!: (error: Error) => void;
  const opened = new Promise<void>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  opened.catch(() => {});
  const timer = setTimeout(
    () => fail(new Error(`barrier: ${arrived} of ${parties} parties arrived in ${timeoutMs} ms`)),
    timeoutMs,
  );
  opened.then(
    () => clearTimeout(timer),
    () => clearTimeout(timer),
  );
  return {
    arrive(): Promise<void> {
      arrived += 1;
      if (arrived === parties) open();
      return opened;
    },
  };
}

export type Outcome<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; constraint: string | null; message: string };

/** Resolve to the value or to the error's SQLSTATE and constraint; never throw. */
export async function settle<T>(p: Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await p };
  } catch (err) {
    const e = err as { code?: unknown; constraint_name?: unknown; message?: unknown };
    return {
      ok: false,
      code: typeof e.code === "string" ? e.code : "no-code",
      constraint: typeof e.constraint_name === "string" ? e.constraint_name : null,
      message: String(e.message ?? err),
    };
  }
}

/** "SQLSTATE:constraint" (or just the SQLSTATE) of a refused statement; "no-error" if it ran. */
export async function refusal(p: Promise<unknown>): Promise<string> {
  const settled = await settle(p);
  if (settled.ok) return "no-error";
  return settled.constraint ? `${settled.code}:${settled.constraint}` : settled.code;
}

// Connections and contexts --------------------------------------------------------------

export interface World {
  env: IntegrationDatabase;
  admin: Sql;
  runtime: Runtime;
  db: Db;
  /** A raw tidegrid_app connection, for statements the services would never issue. */
  app: Sql;
}

export function openWorld(env: IntegrationDatabase, runtimeMax = 12): World {
  const runtime = createDb(env.runtimeUrl, { max: runtimeMax });
  return {
    env,
    admin: postgres(env.adminUrl, { max: 4, onnotice: () => {} }),
    runtime,
    db: runtime.db,
    app: postgres(env.runtimeUrl, { max: 2, onnotice: () => {} }),
  };
}

export async function closeWorld(world: World | undefined): Promise<void> {
  if (!world) return;
  await world.app.end({ timeout: 5 });
  await world.runtime.sql.end({ timeout: 5 });
  await world.runtime.db.destroy();
  await world.admin.end({ timeout: 5 });
}

export function guestCtx(tenantId: string): TenantContext {
  return {
    tenantId,
    actorType: "guest",
    actorId: null,
    requestId: `adv-guest-${randomUUID()}`,
    sourceIp: "198.51.100.7",
  };
}

export function systemCtx(tenantId: string, actorId = "waiver-adversary"): TenantContext {
  return { tenantId, actorType: "system", actorId, requestId: `adv-${randomUUID()}` };
}

/**
 * Run statements as tidegrid_app inside one transaction bound to a tenant, the
 * way a Worker's transaction is, but without any service in between.
 */
export function asApp<T>(world: World, tenantId: string, fn: (tx: Sql) => Promise<T>): Promise<T> {
  return world.app.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${tenantId}, true),
                    set_config('app.actor_type', 'system', true),
                    set_config('app.actor_id', 'waiver-adversary', true)`;
    return fn(tx as unknown as Sql);
  }) as Promise<T>;
}

/** Thrown to roll a transaction back after checking that its statements ran. */
export class Rollback extends Error {
  constructor() {
    super("rolled back on purpose");
    this.name = "Rollback";
  }
}

// Bookings, links, sessions, signatures -------------------------------------------------

/** Hands out each fixture trip once. */
export function trips(tenant: WaiverFixture) {
  let next = 0;
  return () => {
    const id = tenant.trips.shared[next++];
    if (!id) throw new Error(`out of fixture trips for ${tenant.slug}`);
    return id;
  };
}

export function book(
  world: World,
  tenant: WaiverFixture,
  tripId: string,
  party: number,
  hooks: BookingHooks,
): Promise<Booked> {
  return bookParty(world.admin, world.db, tenant, tripId, party, hooks);
}

export async function name(
  world: World,
  tenantId: string,
  bookingId: string,
  position: number,
  details: ParticipantDetails,
  hooks: BookingHooks,
): Promise<string> {
  const put = await nameParticipant(world.db, tenantId, bookingId, position, details, hooks);
  return put.participant.id;
}

export async function liveRequest(admin: Sql, bookingId: string, participantId: string) {
  const rows = await admin<{ id: string; state: string; required_signer: string; v: number }[]>`
    select id, state, required_signer, template_version as v from public.waiver_requests
     where booking_id = ${bookingId} and participant_id = ${participantId}
       and state in ('pending', 'signed')`;
  if (rows.length !== 1) {
    throw new Error(`expected one live request, found ${rows.length}`);
  }
  const [row] = rows;
  if (!row) throw new Error("no live request");
  return row;
}

export function redeem(world: World, tenantId: string, token: string): Promise<RedeemResult> {
  const ctx = guestCtx(tenantId);
  return inTenantTransaction(world.db, ctx, (trx) => redeemWaiverToken(trx, ctx, { token }));
}

/** Deliver the tenant's mail, read the newest generation's link, and open it. */
export async function openFor(
  world: World,
  tenantId: string,
  requestId: string,
): Promise<{ session: WaiverSession; secret: string; token: string }> {
  const { token } = await linkFor(world.admin, world.db, tenantId, requestId);
  const opened = await redeem(world, tenantId, token);
  if (opened.kind !== "opened") throw new Error(`redeem: ${JSON.stringify(opened)}`);
  return { session: opened.session, secret: opened.secret, token };
}

/** The input a careful signer would send, from what the session shows, with overrides. */
export async function signingInput(
  world: World,
  tenantId: string,
  deps: WaiverDeps,
  session: WaiverSession,
  overrides: Partial<SignInput> = {},
): Promise<SignInput> {
  const view = await inTenantTransaction(world.db, guestCtx(tenantId), (trx) =>
    getSigningView(trx, tenantId, deps, session),
  );
  return {
    contentSha256: view.waiver.contentSha256,
    acknowledgments: view.waiver.acknowledgments.map(() => true),
    consent: true,
    confirmIdentity: true,
    signature: view.participant?.signerName ?? "",
    relationship: view.signerRole === "guardian" ? "parent" : null,
    ...overrides,
  };
}

export function signAs(
  world: World,
  tenantId: string,
  deps: WaiverDeps,
  session: WaiverSession,
  input: SignInput,
): Promise<SignResult> {
  const ctx = guestCtx(tenantId);
  return inTenantTransaction(world.db, ctx, (trx) =>
    signWaiver(trx, ctx, deps, session, input, {
      sourceIp: "198.51.100.7",
      userAgent: "waiver-adversary",
    }),
  );
}

export async function sign(
  world: World,
  tenantId: string,
  deps: WaiverDeps,
  session: WaiverSession,
  overrides: Partial<SignInput> = {},
): Promise<SignResult> {
  const input = await signingInput(world, tenantId, deps, session, overrides);
  return signAs(world, tenantId, deps, session, input);
}

/**
 * Make ten minutes pass for a request's sends: move its deliveries' times
 * back, with the append-only guard off for that statement only, as the core
 * suite does. Admin only.
 */
export async function ageDeliveries(admin: Sql, requestId: string, minutes = 11): Promise<void> {
  await admin.begin(async (tx) => {
    await tx`alter table public.waiver_deliveries disable trigger waiver_deliveries_append_only`;
    await tx`update public.waiver_deliveries
                set created_at = created_at - make_interval(mins => ${minutes}),
                    send_after = send_after - make_interval(mins => ${minutes})
              where request_id = ${requestId}`;
    await tx`alter table public.waiver_deliveries enable trigger waiver_deliveries_append_only`;
  });
}

// Email ----------------------------------------------------------------------------------

export function fakeMail(db: Db): FakeEmailProvider {
  return new FakeEmailProvider({ db, environment: "local" });
}

export function deliverWith(db: Db, tenantId: string, provider: EmailProvider) {
  return deliverTenantMessages(db, tenantId, {
    provider,
    fromAddress: FIXTURE_FROM,
    guestLinkOrigin: FIXTURE_LINK_ORIGIN,
    runId: `adv-run-${randomUUID()}`,
    limit: 500,
  });
}

/** The waiver token in an email's plain text, or null. */
export function tokenInText(text: string): string | null {
  const link = /https:\/\/[^\s"<]+\/waiver#t=[A-Za-z0-9_-]{43}/.exec(text)?.[0];
  return link ? tokenOf(link) : null;
}

/** The token in the email the fake provider accepted for one message, or null if none was. */
export async function tokenOfMessage(
  world: World,
  tenantId: string,
  messageId: string,
): Promise<string | null> {
  const [row] = await world.admin<{ provider_message_id: string | null }[]>`
    select provider_message_id from public.email_messages where id = ${messageId}`;
  if (!row?.provider_message_id) return null;
  const mail = await fakeMail(world.db).getMailboxMessage(tenantId, row.provider_message_id);
  return mail ? tokenInText(mail.text) : null;
}

export type HeldAction = "deliver" | "unavailable" | "rejected";

/**
 * The fake provider, except that the first send of one message waits until
 * the test decides what the provider answers. `held` resolves with that email
 * (and the token its link carries) once the delivery job has claimed the
 * message, issued its link, committed, and called the provider.
 */
export function holdingProvider(db: Db, messageId: string) {
  const inner = fakeMail(db);
  const held = gate<{ email: OutgoingEmail; token: string | null }>();
  const decision = gate<HeldAction>();
  let holding = true;
  const provider: EmailProvider = {
    name: "fake",
    async send(email) {
      if (holding && email.idempotencyKey === messageId) {
        holding = false;
        held.open({ email, token: tokenInText(email.text) });
        const action = await decision.opened;
        if (action === "unavailable") throw new EmailProviderUnavailableError();
        if (action === "rejected") throw new EmailProviderRejectedError("bounced");
      }
      return inner.send(email);
    },
  };
  return { provider, held: held.opened, decide: decision.open };
}

/** The message of a request's delivery generation. */
export async function messageOf(admin: Sql, requestId: string, generation: number) {
  const [row] = await admin<{ id: string; state: string; to_email: string }[]>`
    select m.id, m.state, m.to_email
      from public.waiver_deliveries d
      join public.email_messages m on m.tenant_id = d.tenant_id and m.id = d.message_id
     where d.request_id = ${requestId} and d.generation = ${generation}`;
  if (!row) throw new Error(`no generation ${generation} for ${requestId}`);
  return row;
}

// Privacy ---------------------------------------------------------------------------------

/**
 * Which of the given strings appear, case-insensitively, anywhere in the
 * tenant's audit and outbox rows that waiver actions wrote.
 */
export async function personalDataInWaiverRecords(
  admin: Sql,
  tenantId: string,
  needles: readonly string[],
): Promise<{ rows: number; found: string[] }> {
  const audit = await admin<{ row: string }[]>`
    select row_to_json(a)::text as row from public.audit_events a
     where a.tenant_id = ${tenantId}
       and (a.action like 'waiver%' or a.subject_type like 'waiver%')`;
  const outbox = await admin<{ row: string }[]>`
    select row_to_json(o)::text as row from public.outbox_events o
     where o.tenant_id = ${tenantId}
       and (o.topic like 'waiver.%' or o.aggregate_type like 'waiver%')`;
  const text = [...audit, ...outbox].map((r) => r.row.toLowerCase());
  const found = needles.filter((n) => text.some((t) => t.includes(n.toLowerCase())));
  return { rows: text.length, found };
}

export const uniqueEmail = (label: string) =>
  `${label}.${randomUUID().slice(0, 8)}@example.test`.toLowerCase();
