import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  CancelBookingRequest,
  CancelBookingResponse,
  CancellationTermsResponse,
  CheckoutSessionParams,
  IdempotencyKey,
  type ManagedBooking,
  ManagedBookingResponse,
  ManageLinkAccepted,
  ManageLinkRenewRequest,
  ManageSessionCreateRequest,
  ManageSessionEndResponse,
  ManageSessionResponse,
  ParticipantInput,
  ParticipantPosition,
  ParticipantResponse,
} from "@tidegrid/contracts";
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  IdempotencyKeyMismatchError,
  inTenantTransaction,
  type JsonObject,
  requestHash,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import {
  BookingHookRefusal,
  type CancellationTerms,
  cancelBooking,
  checkoutSecretPattern,
  getManagedBooking,
  type ManagedBookingView,
  manageSession,
  openManageSession,
  openManageSessionFromCheckout,
  previewCancellation,
  putParticipant,
  renewManageLink,
  requestManageLink,
  settleRefund,
} from "@tidegrid/domain-booking";
import { type GuestSession, revokeGuestSession } from "@tidegrid/domain-messaging";
import type { Context } from "hono";
import { sql } from "kysely";
import { bookingHooksFor } from "../booking-hooks.ts";
import type { AppDeps, AppEnv } from "../context.ts";
import { getDb } from "../db.ts";
import { deliverAfterCommit } from "../email.ts";
import { ApiError } from "../errors.ts";
import { providerFor } from "../payments.ts";
import {
  guestContext,
  limitPublicCommand,
  resolvePublicTenant,
  withPublicTenant,
} from "../public-tenant.ts";
import { errorBody } from "./responses.ts";

const redeemPath = "/v1/public/booking-access";
const renewPath = "/v1/public/booking-access/renewals";
const fromCheckoutPath = "/v1/public/checkout-sessions/{checkoutSessionId}/manage-session";
const bookingPath = "/v1/public/manage/booking";
const participantPath = "/v1/public/manage/participants/{position}";
const cancellationPath = "/v1/public/manage/cancellation";
const linkEmailPath = "/v1/public/manage/link-email";
const endPath = "/v1/public/manage/session/end";

const sessionSecurity = [{ manageSession: [] }];

const sessionRequired = () =>
  new ApiError(
    401,
    "session_required",
    "Send the booking session as Authorization: Bearer <token>",
  );
const sessionExpired = () =>
  new ApiError(401, "session_expired", "This booking session has ended; open your link again");
const bookingGone = () => new ApiError(404, "booking_not_found", "No such booking at this address");

/** The session token from `Authorization: Bearer <token>`; never accepted in a URL. */
function bearer(c: Context<AppEnv>): string {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(c.req.header("authorization") ?? "");
  if (!match?.[1]) throw sessionRequired();
  return match[1];
}

function termsJson(t: CancellationTerms) {
  return {
    cancelable: t.cancelable,
    refusal: t.refusal,
    remedy: t.remedy,
    refundBp: t.refundBp,
    paidAmount: t.paidAmount,
    refundAmount: t.refundAmount,
    currency: t.currency,
    departsAt: t.departsAt,
    cutoffAt: t.cutoffAt,
    beforeCutoff: t.beforeCutoff,
    policyVersion: t.policyVersion,
    asOf: t.asOf,
  };
}

/** The guest's view of their booking, in the contract's shape: no provider reference, no ids but its own. */
function managedJson(view: ManagedBookingView): ManagedBooking {
  const b = view.booking;
  return {
    id: b.id,
    reference: b.reference,
    state: b.state,
    confirmedAt: b.confirmedAt,
    booker: b.booker,
    trip: b.trip,
    location: b.location,
    party: b.party,
    extras: b.extras,
    order: b.order,
    payment: {
      provider: b.payment.provider,
      state: b.payment.state,
      amount: b.payment.amount,
      currency: "USD",
    },
    refund: b.refund,
    cancellation: b.cancellation,
    policy: view.policy,
    participants: view.party,
    partyEditable: view.partyEditable,
    cancellationTerms: termsJson(view.cancellation),
  };
}

interface SessionCommand {
  scope: string;
  key: string;
  route: string;
  params?: Record<string, string>;
  body: unknown;
}

/**
 * Run a guest request inside the booking session its bearer token names, for
 * the tenant the Origin resolves to, in one transaction. The session is
 * checked first, under the database clock; the actor is the session. A
 * command is rate limited per client address and tenant and, with an
 * Idempotency-Key, claims it under the session's own principal and stores
 * its response before commit.
 */
async function withManageSession<T extends JsonObject>(
  c: Context<AppEnv>,
  options: { idempotency?: SessionCommand; limit?: boolean },
  run: (trx: TenantTransaction, ctx: TenantContext, session: GuestSession) => Promise<T>,
): Promise<{ body: T; replayed: boolean; ctx: TenantContext; session: GuestSession }> {
  const tenantId = await resolvePublicTenant(c);
  const token = bearer(c);
  if (options.idempotency || options.limit) await limitPublicCommand(c, tenantId);
  const base = guestContext(c, tenantId);
  const idem = options.idempotency;
  const hash = idem
    ? await requestHash({
        method: c.req.method,
        route: idem.route,
        params: { ...idem.params, tenantId },
        body: idem.body,
      })
    : null;
  try {
    return await inTenantTransaction(getDb(c), base, async (trx) => {
      const session = await manageSession(trx, tenantId, token);
      if (!session) throw sessionExpired();
      const actor = `guest_session:${session.sessionId}`;
      // Record the session as the actor for the rows the database stamps.
      await sql`select set_config('app.actor_id', ${actor}, true)`.execute(trx);
      const ctx: TenantContext = { ...base, actorId: actor };
      const claim =
        idem && hash
          ? { scope: idem.scope, principal: actor, key: idem.key, requestHash: hash }
          : null;
      if (claim) {
        const claimed = await claimIdempotencyKey(trx, ctx, claim);
        if (claimed.kind === "replay") {
          return { body: claimed.body as T, replayed: true, ctx, session };
        }
      }
      const body = await run(trx, ctx, session);
      if (claim) await completeIdempotencyKey(trx, ctx, claim, { status: 200, body });
      return { body, replayed: false, ctx, session };
    });
  } catch (err) {
    if (err instanceof IdempotencyKeyMismatchError) {
      throw new ApiError(422, "idempotency_key_reused", err.message);
    }
    if (err instanceof BookingHookRefusal) throw new ApiError(409, err.code, err.message);
    throw err;
  }
}

async function managedBody(trx: TenantTransaction, tenantId: string, bookingId: string) {
  const view = await getManagedBooking(trx, tenantId, bookingId);
  if (!view) throw bookingGone();
  return managedJson(view);
}

/**
 * The guest's accountless management of a booking (lane 1, G2.11c): open a
 * session with the link the confirmation email carried, read the booking,
 * name its party, cancel within its policy, and ask for a new link.
 */
export function registerManagePublicRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  for (const path of [redeemPath, `${redeemPath}/*`, "/v1/public/manage/*"]) {
    app.use(path, async (c, next) => {
      await next();
      c.header("Cache-Control", "no-store");
      c.header("Vary", "Origin");
    });
  }

  app.openAPIRegistry.registerComponent("securitySchemes", "manageSession", {
    type: "http",
    scheme: "bearer",
    description:
      "A booking session: 43 base64url characters from POST /v1/public/booking-access. It lasts an hour and is never accepted in a URL",
  });

  const redeemRoute = createRoute({
    method: "post",
    path: redeemPath,
    tags: ["public", "manage"],
    summary: "Open a booking with its management link",
    description: [
      "Resolves the browser Origin. Exchanges the token from a management link's URL fragment for a session bound to this operator, the booking, and its management. The link is used once, atomically: concurrent requests open one session, and the others answer 410 link_used. Only this POST uses a link; opening the page does not, so an email scanner's GET or a link preview cannot.",
      "A token of another operator, or none, answers the same 404. Rate limited per client address and operator.",
    ].join("\n\n"),
    request: {
      body: {
        required: true,
        content: { "application/json": { schema: ManageSessionCreateRequest } },
      },
    },
    responses: {
      201: {
        content: { "application/json": { schema: ManageSessionResponse } },
        description: "The session and the booking's reference",
      },
      400: errorBody("Request did not match the contract"),
      404: errorBody(
        "No active tenant hostname matches the origin, or no such link (link_not_found)",
      ),
      410: errorBody(
        "The link expired (link_expired), was used (link_used), was replaced by a newer email's link (link_superseded), or was revoked (link_revoked); ask for a new one",
      ),
      429: errorBody("Too many requests from this address for this operator (rate_limited)"),
    },
  });

  app.openapi(redeemRoute, async (c) => {
    const { token } = c.req.valid("json");
    const { body } = await withPublicTenant(c, { limit: true }, async (trx, ctx) => {
      const opened = await openManageSession(trx, ctx, { token });
      switch (opened.kind) {
        case "opened":
          return {
            session: { token: opened.session.token, expiresAt: opened.session.expiresAt },
            booking: { reference: opened.reference },
          };
        case "invalid":
          throw new ApiError(404, "link_not_found", "This link does not open a booking here");
        case "expired":
          throw new ApiError(410, "link_expired", "This link has expired; ask for a new one");
        case "used":
          throw new ApiError(410, "link_used", "This link was already used; ask for a new one");
        case "superseded":
          throw new ApiError(
            410,
            "link_superseded",
            "A newer email replaced this link; use the newest one, or ask for a new one",
          );
        case "revoked":
          throw new ApiError(410, "link_revoked", "This link no longer works; ask for a new one");
      }
    });
    return c.json(body as ManageSessionResponse, 201);
  });

  const renewRoute = createRoute({
    method: "post",
    path: renewPath,
    tags: ["public", "manage"],
    summary: "Email a new management link, from an old one",
    description:
      "Resolves the browser Origin. Takes an earlier management link's token, used, expired, or replaced, and emails a new link to the booker's address on file, never to one in the request. Answers 202 whatever the token names, so tokens cannot be probed. At most three link emails per booking an hour; rate limited per client address and operator.",
    request: {
      body: { required: true, content: { "application/json": { schema: ManageLinkRenewRequest } } },
    },
    responses: {
      202: {
        content: { "application/json": { schema: ManageLinkAccepted } },
        description: "Accepted; if the token names a booking, its booker gets a new link",
      },
      400: errorBody("Request did not match the contract"),
      404: errorBody("No active tenant hostname matches the origin"),
      429: errorBody("Too many requests from this address for this operator (rate_limited)"),
    },
  });

  app.openapi(renewRoute, async (c) => {
    const { token } = c.req.valid("json");
    const { ctx, body } = await withPublicTenant(c, { limit: true }, async (trx, txCtx) => {
      const renewed = await renewManageLink(trx, txCtx, {
        token,
        requestKey: c.get("requestId"),
      });
      return { enqueued: renewed.kind === "enqueued" };
    });
    if (body.enqueued) deliverAfterCommit(c, deps, ctx.tenantId);
    return c.json({ status: "accepted" as const }, 202);
  });

  const fromCheckoutRoute = createRoute({
    method: "post",
    path: fromCheckoutPath,
    tags: ["public", "manage"],
    summary: "Open the booking a checkout just made",
    description:
      "Resolves the browser Origin and needs the checkout's secret as a bearer token. Right after paying, within an hour of confirmation, opens a session for the checkout's own booking so the guest can name their party without waiting for the email. A wrong secret, another operator's checkout, and an unknown id answer the same 404.",
    security: [{ checkoutSecret: [] }],
    request: { params: CheckoutSessionParams },
    responses: {
      201: {
        content: { "application/json": { schema: ManageSessionResponse } },
        description: "The session and the booking's reference",
      },
      401: errorBody("No checkout secret, or a malformed one (checkout_secret_required)"),
      404: errorBody("No active tenant hostname matches the origin, or no such checkout"),
      409: errorBody("The checkout did not become a booking (checkout_not_confirmed)"),
      410: errorBody(
        "More than an hour since confirmation (manage_window_closed); use the email's link",
      ),
      429: errorBody("Too many requests from this address for this operator (rate_limited)"),
    },
  });

  app.openapi(fromCheckoutRoute, async (c) => {
    const { checkoutSessionId } = c.req.valid("param");
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(c.req.header("authorization") ?? "");
    const secret = match?.[1];
    if (!secret || !checkoutSecretPattern.test(secret)) {
      throw new ApiError(
        401,
        "checkout_secret_required",
        "Send the checkout's secret as Authorization: Bearer <secret>",
      );
    }
    const { body } = await withPublicTenant(c, { limit: true }, async (trx, ctx) => {
      const opened = await openManageSessionFromCheckout(trx, ctx, { checkoutSessionId, secret });
      switch (opened.kind) {
        case "opened":
          return {
            session: { token: opened.session.token, expiresAt: opened.session.expiresAt },
            booking: { reference: opened.reference },
          };
        case "not_found":
          throw new ApiError(404, "checkout_not_found", "No such checkout at this address");
        case "not_confirmed":
          throw new ApiError(
            409,
            "checkout_not_confirmed",
            "This checkout did not become a booking",
          );
        case "window_closed":
          throw new ApiError(
            410,
            "manage_window_closed",
            "Open your booking with the link in your confirmation email",
          );
      }
    });
    return c.json(body as ManageSessionResponse, 201);
  });

  const readRoute = createRoute({
    method: "get",
    path: bookingPath,
    tags: ["public", "manage"],
    summary: "The booking a session opens",
    description:
      "Resolves the browser Origin and needs the booking session as a bearer token. The booking, its receipt, its party, its policy, and what canceling now would do, with the booker's own details. An ended, revoked, or another operator's session answers 401 session_expired.",
    security: sessionSecurity,
    responses: {
      200: {
        content: { "application/json": { schema: ManagedBookingResponse } },
        description: "The booking",
      },
      401: errorBody("No session (session_required), or it has ended (session_expired)"),
      404: errorBody("No active tenant hostname matches the origin"),
    },
  });

  app.openapi(readRoute, async (c) => {
    const { body, session } = await withManageSession(c, {}, async (trx, ctx, s) => ({
      booking: await managedBody(trx, ctx.tenantId, s.bookingId),
    }));
    return c.json(
      { booking: body.booking as ManagedBooking, session: { expiresAt: session.expiresAt } },
      200,
    );
  });

  const participantRoute = createRoute({
    method: "put",
    path: participantPath,
    tags: ["public", "manage"],
    summary: "Name the participant at one place in the party",
    description:
      "Needs the booking session and an Idempotency-Key. Names the participant at a place from 1 to the party size, or corrects the one there; the same details again change nothing. A minor needs a guardian's name and email; an adult names none. Refused once the booking is canceled or its trip has departed.",
    security: sessionSecurity,
    request: {
      headers: z.object({ "idempotency-key": IdempotencyKey }),
      params: z.object({ position: ParticipantPosition }),
      body: { required: true, content: { "application/json": { schema: ParticipantInput } } },
    },
    responses: {
      200: {
        content: { "application/json": { schema: ParticipantResponse } },
        description: "The participant, and whether this request named the place first",
      },
      400: errorBody("Request did not match the contract"),
      401: errorBody("No session (session_required), or it has ended (session_expired)"),
      404: errorBody("No active tenant hostname matches the origin"),
      409: errorBody(
        "The booking is canceled (booking_canceled), its trip has departed (trip_departed), or the waiver module refused the change (its own code)",
      ),
      422: errorBody(
        "The place is past the party size (position_out_of_range), or idempotency_key_reused",
      ),
      429: errorBody("Too many requests from this address for this operator (rate_limited)"),
    },
  });

  app.openapi(participantRoute, async (c) => {
    const { position } = c.req.valid("param");
    const input = c.req.valid("json");
    const key = c.req.valid("header")["idempotency-key"];
    const { body, replayed, ctx } = await withManageSession(
      c,
      {
        idempotency: {
          scope: "public.manage.participants.put",
          key,
          route: participantPath,
          params: { position: String(position) },
          body: input,
        },
      },
      async (trx, ctx, session) => {
        const put = await putParticipant(
          trx,
          ctx,
          { bookingId: session.bookingId, position, details: input },
          bookingHooksFor(c.env, deps),
        );
        switch (put.kind) {
          case "created":
          case "updated":
          case "unchanged":
            return { participant: { ...put.participant }, created: put.kind === "created" };
          case "booking_not_found":
            throw bookingGone();
          case "booking_canceled":
            throw new ApiError(409, "booking_canceled", "This booking is canceled");
          case "trip_departed":
            throw new ApiError(409, "trip_departed", "This trip has departed");
          case "position_out_of_range":
            throw new ApiError(
              422,
              "position_out_of_range",
              `This party has ${put.partySize} place(s)`,
            );
        }
      },
    );
    if (replayed) c.header("Idempotent-Replayed", "true");
    // Waiver evidence (G2.15): naming or correcting a person can queue their
    // waiver email through the booking hooks; send it now, not at the sweep.
    else deliverAfterCommit(c, deps, ctx.tenantId);
    return c.json(body as ParticipantResponse, 200);
  });

  const termsRoute = createRoute({
    method: "get",
    path: cancellationPath,
    tags: ["public", "manage"],
    summary: "What canceling now would do",
    description:
      "Needs the booking session. The remedy the booking's own policy version gives now, on the server's clock: before the cutoff its before-cutoff remedy, at or after it its after-cutoff remedy, as a refund of part or all of what was paid, rounded half up to the cent. Shown before the guest confirms.",
    security: sessionSecurity,
    responses: {
      200: {
        content: { "application/json": { schema: CancellationTermsResponse } },
        description: "The terms now",
      },
      401: errorBody("No session (session_required), or it has ended (session_expired)"),
      404: errorBody("No active tenant hostname matches the origin"),
    },
  });

  app.openapi(termsRoute, async (c) => {
    const { body } = await withManageSession(c, {}, async (trx, ctx, session) => {
      const terms = await previewCancellation(trx, ctx.tenantId, session.bookingId);
      if (!terms) throw bookingGone();
      return { terms: termsJson(terms) };
    });
    return c.json(body as CancellationTermsResponse, 200);
  });

  const cancelRoute = createRoute({
    method: "post",
    path: cancellationPath,
    tags: ["public", "manage"],
    summary: "Cancel the booking within its policy",
    description: [
      "Needs the booking session and an Idempotency-Key, and the refund the guest was shown. In one transaction: the cancellation with the terms as applied, the booking canceled, the refund requested for the computed amount, the seats released back to sale, and the cancellation email queued. The refund is then sent through the payment provider; the guest sees its state on the booking.",
      "Once per booking: a repeat, with any key, answers 200 with the canceled booking. If canceling now gives another refund than the one sent (the cutoff passed in between), nothing changes and the answer is 409 cancellation_terms_changed: read the terms again.",
    ].join("\n\n"),
    security: sessionSecurity,
    request: {
      headers: z.object({ "idempotency-key": IdempotencyKey }),
      body: { required: true, content: { "application/json": { schema: CancelBookingRequest } } },
    },
    responses: {
      200: {
        content: { "application/json": { schema: CancelBookingResponse } },
        description: "The canceled booking",
      },
      400: errorBody("Request did not match the contract"),
      401: errorBody("No session (session_required), or it has ended (session_expired)"),
      404: errorBody("No active tenant hostname matches the origin"),
      409: errorBody(
        "The terms changed (cancellation_terms_changed), the trip has departed (trip_departed), or the policy gives credit here, which the operator issues (remedy_requires_operator)",
      ),
      422: errorBody("idempotency_key_reused"),
      429: errorBody("Too many requests from this address for this operator (rate_limited)"),
    },
  });

  app.openapi(cancelRoute, async (c) => {
    const input = c.req.valid("json");
    const key = c.req.valid("header")["idempotency-key"];
    let refundId: string | null = null;
    const { body, replayed, ctx } = await withManageSession(
      c,
      {
        idempotency: {
          scope: "public.manage.cancellation.create",
          key,
          route: cancellationPath,
          body: input,
        },
      },
      async (trx, txCtx, session) => {
        const canceled = await cancelBooking(
          trx,
          txCtx,
          { bookingId: session.bookingId, expectedRefundAmount: input.expectedRefundAmount },
          bookingHooksFor(c.env, deps),
        );
        switch (canceled.kind) {
          case "canceled":
            refundId = canceled.cancellation.refundId;
            break;
          case "already_canceled":
            break;
          case "not_found":
            throw bookingGone();
          case "trip_departed":
            throw new ApiError(
              409,
              "trip_departed",
              "This trip has departed; it can't be canceled now",
            );
          case "remedy_requires_operator":
            throw new ApiError(
              409,
              "remedy_requires_operator",
              "This booking's policy gives a credit now, which the operator issues; contact them to cancel",
            );
          case "terms_changed":
            throw new ApiError(
              409,
              "cancellation_terms_changed",
              `Canceling now refunds ${canceled.terms.refundAmount} cents; read the terms again`,
            );
        }
        return { booking: await managedBody(trx, txCtx.tenantId, session.bookingId) };
      },
    );
    if (replayed) c.header("Idempotent-Replayed", "true");
    // Committed. Send the refund now, outside any transaction; an unknown
    // outcome stays requested for the checkout sweep, which resends it with its key.
    let result = body as CancelBookingResponse;
    if (refundId) {
      const provider = providerFor(c, deps);
      if (provider) {
        try {
          await settleRefund(getDb(c), provider, ctx, refundId);
          const { body: fresh } = await withManageSession(c, {}, async (trx, txCtx, session) => ({
            booking: await managedBody(trx, txCtx.tenantId, session.bookingId),
          }));
          result = fresh as CancelBookingResponse;
        } catch {
          c.get("log").warn("cancellation_refund_pending", {
            "event.name": "cancellation_refund_pending",
            "tidegrid.tenant_id": ctx.tenantId,
          });
        }
      }
    }
    if (!replayed) deliverAfterCommit(c, deps, ctx.tenantId);
    return c.json(result, 200);
  });

  const linkEmailRoute = createRoute({
    method: "post",
    path: linkEmailPath,
    tags: ["public", "manage"],
    summary: "Email me a new link",
    description:
      "Needs the booking session. Emails a fresh management link to the booker's address on file; sending it replaces the links in earlier emails. At most three link emails per booking an hour.",
    security: sessionSecurity,
    responses: {
      202: {
        content: { "application/json": { schema: ManageLinkAccepted } },
        description: "Queued",
      },
      401: errorBody("No session (session_required), or it has ended (session_expired)"),
      404: errorBody("No active tenant hostname matches the origin"),
      429: errorBody(
        "Three link emails in the last hour (link_email_rate_limited), or too many requests (rate_limited)",
      ),
    },
  });

  app.openapi(linkEmailRoute, async (c) => {
    const { ctx } = await withManageSession(c, { limit: true }, async (trx, txCtx, session) => {
      const requested = await requestManageLink(trx, txCtx, {
        bookingId: session.bookingId,
        requestKey: c.get("requestId"),
      });
      if (requested.kind === "rate_limited") {
        throw new ApiError(
          429,
          "link_email_rate_limited",
          "We sent three links in the last hour; check your email, or try again later",
        );
      }
      if (requested.kind === "not_found") throw bookingGone();
      return { status: "accepted" };
    });
    deliverAfterCommit(c, deps, ctx.tenantId);
    return c.json({ status: "accepted" as const }, 202);
  });

  const endRoute = createRoute({
    method: "post",
    path: endPath,
    tags: ["public", "manage"],
    summary: "End the booking session",
    description: "Needs the booking session. Ends it now, as signing out does.",
    security: sessionSecurity,
    responses: {
      200: {
        content: { "application/json": { schema: ManageSessionEndResponse } },
        description: "Ended",
      },
      401: errorBody("No session (session_required), or it has ended (session_expired)"),
      404: errorBody("No active tenant hostname matches the origin"),
    },
  });

  app.openapi(endRoute, async (c) => {
    await withManageSession(c, { limit: true }, async (trx, ctx, session) => {
      await revokeGuestSession(trx, ctx, session.sessionId);
      return { ended: true };
    });
    return c.json({ ended: true as const }, 200);
  });
}
