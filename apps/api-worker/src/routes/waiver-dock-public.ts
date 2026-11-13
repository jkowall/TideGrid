import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import {
  DockLookupRequest,
  DockLookupResponse,
  type DockParty as DockPartyJson,
  DockSigningRequest,
  DockSigningResponse,
} from "@tidegrid/contracts";
import type { JsonObject } from "@tidegrid/database";
import { type DockParty, lookUpAtDock, startDockSigning } from "@tidegrid/domain-waivers";
import type { Context } from "hono";
import type { AppDeps, AppEnv } from "../context.ts";
import { ApiError } from "../errors.ts";
import { withPublicTenant } from "../public-tenant.ts";
import { waiverDeps } from "../waivers.ts";
import { errorBody } from "./responses.ts";

const lookupsPath = "/v1/public/waiver-dock/lookups";
const signingsPath = "/v1/public/waiver-dock/signings";

const lookupSecurity = [{ dockLookup: [] }];

const notFound = () =>
  new ApiError(
    404,
    "dock_lookup_not_found",
    "No booking departing today matches that code and last name. Check them, or ask the crew",
  );

const limited = () =>
  new ApiError(
    429,
    "dock_lookup_limited",
    "Too many tries. Ask the crew, who can open your waiver for you",
  );

const lookupEnded = () =>
  new ApiError(
    401,
    "dock_lookup_ended",
    "This lookup has ended. Enter your booking code and last name again",
  );

/** The matched lookup's secret, from `Authorization: Bearer <secret>`. Never in a URL. */
function lookupSecret(c: Context<AppEnv>): string {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(c.req.header("authorization") ?? "");
  if (!match?.[1]) throw lookupEnded();
  return match[1];
}

function partyJson(party: DockParty): DockPartyJson {
  return {
    trip: party.trip,
    expiresAt: party.expiresAt.toISOString(),
    people: party.people.map((p) => ({ ...p })),
  };
}

/**
 * The generic dock QR (W3-G2.15-rest, owner decision 2026-11-13; migration
 * 0043). A guest at the dock types the booking code and the booker's last
 * name; a match lists that booking's own party for a trip departing today,
 * and starts a signing on the guest's own phone.
 */
export function registerWaiverDockPublicRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  for (const path of [lookupsPath, signingsPath]) {
    app.use(path, async (c, next) => {
      await next();
      c.header("Cache-Control", "no-store");
      c.header("Vary", "Origin");
    });
  }

  app.openAPIRegistry.registerComponent("securitySchemes", "dockLookup", {
    type: "http",
    scheme: "bearer",
    description:
      "A matched dock lookup's secret: 43 base64url characters, from POST /v1/public/waiver-dock/lookups. It lasts 15 minutes",
  });

  const lookupRoute = createRoute({
    method: "post",
    path: lookupsPath,
    tags: ["public", "waivers"],
    summary: "Find today's booking at the dock by its code and the booker's last name",
    description: [
      "Resolves the browser Origin as /v1/public/trips does. A match needs a confirmed booking at this operator with that code, whose trip departs today in its own time zone and has not ended, and the booker's last name (the last word or words of the name on the booking, ignoring case, accents, and punctuation).",
      "A match returns a 15-minute secret and the party: first names with an initial, each person's waiver status, and who signs. No address, id, or delivery detail. Every miss answers the same 404, whatever the reason. Tries are counted by the database: 10 misses from one address in 15 minutes, 5 misses for one booking code in an hour from anywhere, or 300 at one operator in an hour hold further tries (429), as do 20 matches from one address in an hour. Also rate limited per client address and operator like other public commands.",
    ].join("\n\n"),
    request: {
      body: { required: true, content: { "application/json": { schema: DockLookupRequest } } },
    },
    responses: {
      201: {
        content: { "application/json": { schema: DockLookupResponse } },
        description: "The booking's party",
      },
      400: errorBody(
        "Request did not match the contract, or the code has characters a code never has (dock_code_invalid)",
      ),
      404: errorBody(
        "No operator at this address, or no booking departing today matches (dock_lookup_not_found)",
      ),
      429: errorBody(
        "Too many tries (dock_lookup_limited), or too many requests from this address (rate_limited)",
      ),
    },
  });

  app.openapi(lookupRoute, async (c) => {
    const input = c.req.valid("json");
    // A miss is recorded and committed, so it counts, then answered.
    const { body } = await withPublicTenant(c, { limit: true }, async (trx, ctx) => {
      const found = await lookUpAtDock(trx, ctx, input);
      if (found.kind !== "matched") return { kind: found.kind } as JsonObject;
      return {
        kind: "matched",
        response: { lookupSecret: found.secret, party: partyJson(found.party) },
      } as JsonObject;
    });
    switch (body.kind) {
      case "invalid":
        throw new ApiError(400, "dock_code_invalid", "A booking code has only letters and digits");
      case "limited":
        throw limited();
      case "not_found":
        throw notFound();
    }
    return c.json(body.response as DockLookupResponse, 201);
  });

  const signingRoute = createRoute({
    method: "post",
    path: signingsPath,
    tags: ["public", "waivers"],
    summary: "Start a signing at the dock for one person of a matched lookup's party",
    description:
      "Resolves the browser Origin and needs the lookup's secret as a bearer token. For a person whose waiver waits for a signature, issues a single-use 15-minute link with no email and returns the signing page's path with its token in the fragment; opening it is the usual explicit POST to /v1/public/waiver-sessions. A new start replaces the person's earlier unused code. The evidence records the dock lookup. A lookup starts at most 30 signings.",
    security: lookupSecurity,
    request: {
      body: { required: true, content: { "application/json": { schema: DockSigningRequest } } },
    },
    responses: {
      201: {
        content: { "application/json": { schema: DockSigningResponse } },
        description: "The signing page's path, for this phone only",
      },
      400: errorBody("Request did not match the contract"),
      401: errorBody(
        "No lookup secret, or the lookup ended: it lapsed, or its booking or trip no longer allows it (dock_lookup_ended)",
      ),
      404: errorBody("No operator at this address"),
      409: errorBody(
        "No one at that position, or their waiver no longer waits for a signature (dock_not_pending)",
      ),
      429: errorBody(
        "This lookup started as many signings as it may (dock_lookup_limited), or too many requests (rate_limited)",
      ),
    },
  });

  app.openapi(signingRoute, async (c) => {
    const secret = lookupSecret(c);
    const { position } = c.req.valid("json");
    const wdeps = waiverDeps(deps);
    const { body } = await withPublicTenant(c, { limit: true }, async (trx, ctx) => {
      const started = await startDockSigning(trx, ctx, wdeps, { secret, position });
      switch (started.kind) {
        case "lookup_ended":
          throw lookupEnded();
        case "not_pending":
          throw new ApiError(
            409,
            "dock_not_pending",
            "That person's waiver does not wait for a signature here. Ask the crew if something looks wrong",
          );
        case "limited":
          throw limited();
      }
      return { path: started.path, expiresAt: started.expiresAt.toISOString() } as JsonObject;
    });
    return c.json(body as DockSigningResponse, 201);
  });
}
