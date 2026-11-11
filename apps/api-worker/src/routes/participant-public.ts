import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  IdempotencyKey,
  OwnDetailsInput,
  type OwnDetailsResponse,
  OwnDetailsResponse as OwnDetailsResponseSchema,
  type ParticipantProfile,
  ParticipantProfileResponse,
  ParticipantSessionCreateRequest,
  ParticipantSessionEndResponse,
  ParticipantSessionResponse,
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
  getParticipantProfile,
  type InviteParticipantResult,
  openParticipantSession,
  type ParticipantProfileView,
  type ParticipantSession,
  participantSession,
  updateOwnDetails,
} from "@tidegrid/domain-booking";
import { revokeGuestSession } from "@tidegrid/domain-messaging";
import type { Context } from "hono";
import { sql } from "kysely";
import { bookingHooksFor } from "../booking-hooks.ts";
import type { AppDeps, AppEnv } from "../context.ts";
import { getDb } from "../db.ts";
import { deliverAfterCommit } from "../email.ts";
import { ApiError } from "../errors.ts";
import {
  guestContext,
  limitPublicCommand,
  resolvePublicTenant,
  withPublicTenant,
} from "../public-tenant.ts";
import { errorBody } from "./responses.ts";

/**
 * Participant invitations (W3-G2.11-rest, third part): the refusals the
 * booker's and staff's invitation routes share, and the invited
 * participant's own routes. A participant's session sees and corrects only
 * that participant's details; the database holds the same rule
 * (booking_participants_profile_session, migration 0036).
 */

const redeemPath = "/v1/public/participant-access";
const profilePath = "/v1/public/participant/profile";
const endPath = "/v1/public/participant/session/end";

const sessionSecurity = [{ participantSession: [] }];

/** A refused invitation as the API answers it, for the booker and staff alike. */
export function invitationRefusal(
  result: Exclude<InviteParticipantResult, { kind: "invited" }>,
  notFoundError: () => ApiError,
): ApiError {
  switch (result.kind) {
    case "booking_not_found":
      return notFoundError();
    case "booking_canceled":
      return new ApiError(409, "booking_canceled", "This booking was canceled");
    case "trip_departed":
      return new ApiError(409, "trip_departed", "This trip has departed");
    case "place_removed":
      return new ApiError(409, "place_removed", "That place was given up");
    case "position_out_of_range":
      return new ApiError(
        422,
        "position_out_of_range",
        `This party has ${result.partySize} places`,
      );
    case "place_not_named":
      return new ApiError(
        409,
        "participant_not_named",
        "Name the participant at this place, with their email, before inviting them",
      );
    case "no_address":
      return new ApiError(
        409,
        "participant_no_email",
        "This participant has no email of their own; add it before inviting them",
      );
    case "limit_reached":
      return new ApiError(
        429,
        "invitation_limit_reached",
        "Too many invitations today for this person or booking; try again tomorrow",
      );
  }
}

const sessionRequired = () =>
  new ApiError(
    401,
    "session_required",
    "Send the participant session as Authorization: Bearer <token>",
  );
const sessionExpired = () =>
  new ApiError(401, "session_expired", "This session has ended; open your invitation again");
const participantGone = () =>
  new ApiError(404, "participant_not_found", "You are no longer in this booking's party");

function bearer(c: Context<AppEnv>): string {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(c.req.header("authorization") ?? "");
  if (!match?.[1]) throw sessionRequired();
  return match[1];
}

function profileJson(view: ParticipantProfileView): ParticipantProfile {
  return JSON.parse(JSON.stringify(view)) as ParticipantProfile;
}

/**
 * Run a request in the participant session its bearer token names, for the
 * tenant the Origin resolves to, in one transaction, with the session as the
 * actor. As the booking session's wrapper: commands are rate limited and
 * claim their Idempotency-Key under the session's own principal.
 */
async function withParticipantSession<T extends JsonObject>(
  c: Context<AppEnv>,
  options: {
    idempotency?: { scope: string; key: string; route: string; body: unknown };
    limit?: boolean;
  },
  run: (trx: TenantTransaction, ctx: TenantContext, session: ParticipantSession) => Promise<T>,
): Promise<{ body: T; replayed: boolean; ctx: TenantContext }> {
  const tenantId = await resolvePublicTenant(c);
  const token = bearer(c);
  if (options.idempotency || options.limit) await limitPublicCommand(c, tenantId);
  const base = guestContext(c, tenantId);
  const idem = options.idempotency;
  const hash = idem
    ? await requestHash({
        method: c.req.method,
        route: idem.route,
        params: { tenantId },
        body: idem.body,
      })
    : null;
  try {
    return await inTenantTransaction(getDb(c), base, async (trx) => {
      const session = await participantSession(trx, tenantId, token);
      if (!session) throw sessionExpired();
      const actor = `guest_session:${session.sessionId}`;
      await sql`select set_config('app.actor_id', ${actor}, true)`.execute(trx);
      const ctx: TenantContext = { ...base, actorId: actor };
      const claim =
        idem && hash
          ? { scope: idem.scope, principal: actor, key: idem.key, requestHash: hash }
          : null;
      if (claim) {
        const claimed = await claimIdempotencyKey(trx, ctx, claim);
        if (claimed.kind === "replay") return { body: claimed.body as T, replayed: true, ctx };
      }
      const body = await run(trx, ctx, session);
      if (claim) await completeIdempotencyKey(trx, ctx, claim, { status: 200, body });
      return { body, replayed: false, ctx };
    });
  } catch (err) {
    if (err instanceof IdempotencyKeyMismatchError) {
      throw new ApiError(422, "idempotency_key_reused", err.message);
    }
    if (err instanceof BookingHookRefusal) throw new ApiError(409, err.code, err.message);
    // The database's own check that this session is live and its own (0036):
    // the booker ended it, or changed the participant, while this ran.
    const db = err as { code?: string; constraint_name?: string };
    if (db.code === "42501" && db.constraint_name === "booking_participants_profile_session") {
      throw sessionExpired();
    }
    throw err;
  }
}

export function registerParticipantPublicRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  for (const path of [redeemPath, "/v1/public/participant/*"]) {
    app.use(path, async (c, next) => {
      await next();
      c.header("Cache-Control", "no-store");
      c.header("Vary", "Origin");
    });
  }

  app.openAPIRegistry.registerComponent("securitySchemes", "participantSession", {
    type: "http",
    scheme: "bearer",
    description:
      "A participant session: 43 base64url characters from POST /v1/public/participant-access. It lasts an hour, sees only that participant, and is never accepted in a URL",
  });

  const redeemRoute = createRoute({
    method: "post",
    path: redeemPath,
    tags: ["public", "participant"],
    summary: "Open your own details with an invitation's link",
    description: [
      "Resolves the browser Origin. Exchanges the token from an invitation link's URL fragment for a session bound to this operator, the booking, and that one participant. The link is used once, atomically; only this POST uses it, so an email scanner's GET or a link preview cannot.",
      "A token of another operator, or of another kind of link, answers the same 404. A good link whose booking was canceled, whose trip has left, or whose participant was removed is used up and answers 410 invitation_closed. Rate limited per client address and operator.",
    ].join("\n\n"),
    request: {
      body: {
        required: true,
        content: { "application/json": { schema: ParticipantSessionCreateRequest } },
      },
    },
    responses: {
      201: {
        content: { "application/json": { schema: ParticipantSessionResponse } },
        description: "The session",
      },
      400: errorBody("Request did not match the contract"),
      404: errorBody(
        "No active tenant hostname matches the origin, or no such link (link_not_found)",
      ),
      410: errorBody(
        "The link expired (link_expired), was used (link_used), was replaced by a newer invitation (link_superseded), or was revoked (link_revoked); or the booking, trip, or place no longer takes changes (invitation_closed). Ask the booker for a new invitation",
      ),
      429: errorBody("Too many requests from this address for this operator (rate_limited)"),
    },
  });

  app.openapi(redeemRoute, async (c) => {
    const { token } = c.req.valid("json");
    const { body } = await withPublicTenant(c, { limit: true }, async (trx, ctx) => {
      const opened = await openParticipantSession(trx, ctx, { token });
      switch (opened.kind) {
        case "opened":
          return {
            session: { token: opened.session.token, expiresAt: opened.session.expiresAt },
          };
        case "invalid":
          throw new ApiError(404, "link_not_found", "This link does not open anything here");
        case "expired":
          throw new ApiError(410, "link_expired", "This link has expired; ask for a new one");
        case "used":
          throw new ApiError(410, "link_used", "This link was already used; ask for a new one");
        case "superseded":
          throw new ApiError(
            410,
            "link_superseded",
            "A newer invitation replaced this link; use the newest one",
          );
        case "revoked":
          throw new ApiError(410, "link_revoked", "This link no longer works; ask for a new one");
        case "closed":
          // The link is used up, so this must commit: answer after the transaction.
          return { closed: true };
      }
    });
    if ("closed" in body) {
      throw new ApiError(
        410,
        "invitation_closed",
        "This booking no longer takes changes to your details",
      );
    }
    return c.json(body as ParticipantSessionResponse, 201);
  });

  const readRoute = createRoute({
    method: "get",
    path: profilePath,
    tags: ["public", "participant"],
    summary: "Your own details and the trip",
    description:
      "Needs the participant session. That participant's details, the trip, and where to meet; never the rest of the party, the booker's contact details, or the payment.",
    security: sessionSecurity,
    responses: {
      200: {
        content: { "application/json": { schema: ParticipantProfileResponse } },
        description: "Your details",
      },
      401: errorBody("No session (session_required), or it has ended (session_expired)"),
      404: errorBody(
        "No active tenant hostname matches the origin, or you were removed from the party (participant_not_found)",
      ),
    },
  });

  app.openapi(readRoute, async (c) => {
    const { body } = await withParticipantSession(c, {}, async (trx, ctx, session) => {
      const view = await getParticipantProfile(trx, ctx.tenantId, session);
      if (!view) throw participantGone();
      return { profile: profileJson(view) };
    });
    return c.json(body as ParticipantProfileResponse, 200);
  });

  const updateRoute = createRoute({
    method: "put",
    path: profilePath,
    tags: ["public", "participant"],
    summary: "Correct your own details",
    description: [
      "Needs the participant session and an Idempotency-Key. Replaces your name and email, or a minor's name and their guardian's name and email. Whether you are a minor stays as the booker gave it: a minor sends a guardian, an adult none.",
      "Changing the email your invitation went to ends your other invitation links and sessions; this one stays open. A waiver request follows the new address, as when the booker changes it. Not once the booking is canceled or the trip has left.",
    ].join("\n\n"),
    security: sessionSecurity,
    request: {
      headers: z.object({ "idempotency-key": IdempotencyKey }),
      body: { required: true, content: { "application/json": { schema: OwnDetailsInput } } },
    },
    responses: {
      200: {
        content: { "application/json": { schema: OwnDetailsResponseSchema } },
        description: "Your details now",
      },
      400: errorBody("Request did not match the contract"),
      401: errorBody("No session (session_required), or it has ended (session_expired)"),
      404: errorBody(
        "No active tenant hostname matches the origin, or you were removed from the party (participant_not_found)",
      ),
      409: errorBody(
        "The booking was canceled (booking_canceled), or its trip has departed (trip_departed)",
      ),
      422: errorBody(
        "A minor needs a guardian and an adult names none (guardian_mismatch), or idempotency_key_reused",
      ),
      429: errorBody("Too many requests from this address for this operator (rate_limited)"),
    },
  });

  app.openapi(updateRoute, async (c) => {
    const input = c.req.valid("json");
    const key = c.req.valid("header")["idempotency-key"];
    let changed = false;
    const { body, replayed, ctx } = await withParticipantSession(
      c,
      {
        idempotency: {
          scope: "public.participant.profile.update",
          key,
          route: profilePath,
          body: input,
        },
      },
      async (trx, txCtx, session) => {
        const result = await updateOwnDetails(
          trx,
          txCtx,
          session,
          {
            name: input.name,
            email: input.email ?? null,
            guardian: input.guardian ?? null,
          },
          bookingHooksFor(c.env, deps),
        );
        switch (result.kind) {
          case "updated":
          case "unchanged":
            break;
          case "participant_not_found":
          case "booking_not_found":
          case "place_removed":
            throw participantGone();
          case "booking_canceled":
            throw new ApiError(409, "booking_canceled", "This booking was canceled");
          case "trip_departed":
            throw new ApiError(409, "trip_departed", "This trip has departed");
          case "details_invalid":
            throw new ApiError(
              422,
              "guardian_mismatch",
              "A minor's details name a guardian, and an adult's name none",
            );
        }
        changed = result.kind === "updated";
        const view = await getParticipantProfile(trx, txCtx.tenantId, session);
        if (!view) throw participantGone();
        return { profile: profileJson(view), changed } satisfies OwnDetailsResponse;
      },
    );
    if (replayed) c.header("Idempotent-Replayed", "true");
    // A changed address may queue a waiver request for it.
    if (changed) deliverAfterCommit(c, deps, ctx.tenantId);
    return c.json(body as OwnDetailsResponse, 200);
  });

  const endRoute = createRoute({
    method: "post",
    path: endPath,
    tags: ["public", "participant"],
    summary: "Close your session",
    description: "Needs the participant session. Ends it now; the invitation's link stays used.",
    security: sessionSecurity,
    responses: {
      200: {
        content: { "application/json": { schema: ParticipantSessionEndResponse } },
        description: "Ended",
      },
      401: errorBody("No session (session_required), or it has ended (session_expired)"),
      404: errorBody("No active tenant hostname matches the origin"),
    },
  });

  app.openapi(endRoute, async (c) => {
    await withParticipantSession(c, { limit: true }, async (trx, ctx, session) => {
      await revokeGuestSession(trx, ctx, session.sessionId);
      return { ended: true as const };
    });
    return c.json({ ended: true as const }, 200);
  });
}
