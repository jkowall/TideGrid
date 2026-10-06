import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  WaiverLinkRedeemRequest,
  WaiverLinkRenewRequest,
  WaiverLinkRenewResponse,
  WaiverSessionOpenResponse,
  WaiverSessionResponse,
  type WaiverSigning,
  WaiverSignProblemsResponse,
  WaiverSignRequest,
} from "@tidegrid/contracts";
import type { JsonObject } from "@tidegrid/database";
import {
  getSigningView,
  loadEvidenceDocument,
  loadWaiverSession,
  type RedeemResult,
  redeemWaiverToken,
  renewWaiverLink,
  type SigningView,
  signWaiver,
  type WaiverSession,
  waiverSecretPattern,
} from "@tidegrid/domain-waivers";
import type { Context } from "hono";
import type { AppDeps, AppEnv } from "../context.ts";
import { ApiError } from "../errors.ts";
import { withPublicTenant } from "../public-tenant.ts";
import { pdfResponse, waiverDeps } from "../waivers.ts";
import { errorBody } from "./responses.ts";

const sessionsPath = "/v1/public/waiver-sessions";
const currentPath = "/v1/public/waiver-sessions/current";
const signaturePath = "/v1/public/waiver-sessions/current/signature";
const documentPath = "/v1/public/waiver-sessions/current/document";
const renewalPath = "/v1/public/waiver-links/renewal";

const bearerSecurity = [{ waiverSession: [] }];

const sessionInvalid = () =>
  new ApiError(
    401,
    "waiver_session_invalid",
    "This signing session has ended. Open the link in your email again, or ask for a new one",
  );

/**
 * The signing session's secret, from `Authorization: Bearer <secret>`. Never
 * accepted in a URL. Missing or malformed answers 401, as an unknown one does.
 */
function sessionSecret(c: Context<AppEnv>): string {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(c.req.header("authorization") ?? "");
  if (!match?.[1] || !waiverSecretPattern.test(match[1])) {
    throw new ApiError(
      401,
      "waiver_session_required",
      "Send the signing session's secret as Authorization: Bearer <secret>",
    );
  }
  return match[1];
}

/** What a client sends about itself, for the evidence: bounded, single-line. */
function signingMeta(c: Context<AppEnv>) {
  const agent = (c.req.header("user-agent") ?? "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the pattern exists to remove them.
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, 512);
  const ip = (c.req.header("cf-connecting-ip") ?? "").trim().slice(0, 64);
  return { sourceIp: ip || null, userAgent: agent || null };
}

export function signingJson(view: SigningView): WaiverSigning {
  return {
    state: view.state,
    operatorName: view.operatorName,
    trip: view.trip,
    participant: view.participant,
    signerRole: view.signerRole,
    waiver: view.waiver,
    consent: view.consent,
    sessionExpiresAt: view.sessionExpiresAt.toISOString(),
    signed: view.signed
      ? {
          signedAt: view.signed.signedAt.toISOString(),
          signerName: view.signed.signerName,
          signerRole: view.signed.signerRole,
          relationship: view.signed.relationship,
          documentSha256: view.signed.documentSha256,
        }
      : null,
  };
}

/** Why a link did not open, in words a guest can act on. */
function linkRefusal(result: Exclude<RedeemResult, { kind: "opened" }>): ApiError {
  switch (result.kind) {
    case "invalid":
      return new ApiError(404, "waiver_link_invalid", "This waiver link is not valid here");
    case "expired":
      return new ApiError(409, "waiver_link_expired", "This waiver link has expired");
    case "used":
      return new ApiError(409, "waiver_link_used", "This waiver link was already opened once");
    case "replaced":
      return new ApiError(
        409,
        "waiver_link_replaced",
        "A newer email replaced this link; use the link in the latest email",
      );
    case "closed":
      return closedRefusal(result.state);
  }
}

function closedRefusal(state: string): ApiError {
  if (state === "signed") {
    return new ApiError(409, "waiver_signed", "This waiver has already been signed");
  }
  if (state === "superseded") {
    return new ApiError(
      409,
      "waiver_superseded",
      "The operator updated this waiver; a new email has the current version",
    );
  }
  return new ApiError(409, "waiver_not_needed", "This waiver is no longer needed");
}

/**
 * The guest's side of waivers (G2.15). An email link's token, from the URL
 * fragment, opens a signing session with an explicit POST: no GET consumes
 * anything, so a mail scanner that follows the link changes nothing. The
 * session's secret then reads the waiver, signs it, and downloads the signed
 * PDF. Every route resolves the tenant from the verified Origin, as
 * /v1/public/trips does, so another operator's token or session finds nothing.
 */
export function registerWaiverPublicRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  for (const path of [sessionsPath, "/v1/public/waiver-sessions/*", renewalPath]) {
    app.use(path, async (c, next) => {
      await next();
      c.header("Cache-Control", "no-store");
      c.header("Vary", "Origin");
    });
  }

  app.openAPIRegistry.registerComponent("securitySchemes", "waiverSession", {
    type: "http",
    scheme: "bearer",
    description:
      "A waiver signing session's secret: 43 base64url characters, from POST /v1/public/waiver-sessions",
  });

  const openRoute = createRoute({
    method: "post",
    path: sessionsPath,
    tags: ["public", "waivers"],
    summary: "Open a waiver signing session with an email link's token",
    description: [
      "Resolves the browser Origin as /v1/public/trips does. Takes the token from the email link's fragment, in the body, and consumes it: a link opens one session, once. The session is bound to this operator, the booking, the participant, the waiver request, and the purpose of signing, for the signer the request requires (the participant, or a minor's parent or guardian), and lasts an hour.",
      "Returns the session's secret, for `Authorization: Bearer`, and the waiver as the signer sees it. Only the SHA-256 of the token and of the secret are stored. Rate limited per client address and operator like other public commands.",
    ].join("\n\n"),
    request: {
      body: {
        required: true,
        content: { "application/json": { schema: WaiverLinkRedeemRequest } },
      },
    },
    responses: {
      201: {
        content: { "application/json": { schema: WaiverSessionOpenResponse } },
        description: "The session and the waiver",
      },
      400: errorBody("Request did not match the contract"),
      404: errorBody("No operator at this address, or no such link here (waiver_link_invalid)"),
      409: errorBody(
        "The link expired (waiver_link_expired), was already opened (waiver_link_used), or a newer email replaced it (waiver_link_replaced); or the waiver was signed (waiver_signed), replaced by a newer version (waiver_superseded), or is no longer needed (waiver_not_needed)",
      ),
      429: errorBody("Too many requests from this address for this operator (rate_limited)"),
    },
  });

  app.openapi(openRoute, async (c) => {
    const { token } = c.req.valid("json");
    const wdeps = waiverDeps(c.env, deps);
    const { body } = await withPublicTenant(c, { limit: true }, async (trx, ctx) => {
      const opened = await redeemWaiverToken(trx, ctx, { token });
      if (opened.kind !== "opened") throw linkRefusal(opened);
      const view = await getSigningView(trx, ctx.tenantId, wdeps, opened.session);
      return { sessionSecret: opened.secret, waiver: signingJson(view) } as JsonObject;
    });
    return c.json(body as WaiverSessionOpenResponse, 201);
  });

  /** The open session for this request's bearer secret, in the Origin's tenant. */
  async function openSession(
    trx: Parameters<Parameters<typeof withPublicTenant>[2]>[0],
    tenantId: string,
    secret: string,
  ): Promise<WaiverSession> {
    const session = await loadWaiverSession(trx, tenantId, secret);
    if (!session) throw sessionInvalid();
    return session;
  }

  const readRoute = createRoute({
    method: "get",
    path: currentPath,
    tags: ["public", "waivers"],
    summary: "The waiver of the current signing session",
    description:
      "Resolves the browser Origin and needs the session's secret as a bearer token. The waiver's text and version hash, the trip, who signs, and, once signed, what was recorded. An unknown, expired, or revoked session, or another operator's, answers 401.",
    security: bearerSecurity,
    responses: {
      200: {
        content: { "application/json": { schema: WaiverSessionResponse } },
        description: "The waiver",
      },
      401: errorBody(
        "No session secret (waiver_session_required), or no open session (waiver_session_invalid)",
      ),
      404: errorBody("No operator at this address"),
    },
  });

  app.openapi(readRoute, async (c) => {
    const secret = sessionSecret(c);
    const wdeps = waiverDeps(c.env, deps);
    const { body } = await withPublicTenant(c, {}, async (trx, ctx) => {
      const session = await openSession(trx, ctx.tenantId, secret);
      return { waiver: signingJson(await getSigningView(trx, ctx.tenantId, wdeps, session)) };
    });
    return c.json(body as WaiverSessionResponse, 200);
  });

  const signRoute = createRoute({
    method: "post",
    path: signaturePath,
    tags: ["public", "waivers"],
    summary: "Sign the current session's waiver",
    description: [
      "Resolves the browser Origin and needs the session's secret as a bearer token. The signer sends the version hash they were shown, every acknowledgment as true, consent to sign electronically, confirmation of who they are, and their typed signature: the name the booking gives them (a minor's parent or guardian types their own, and declares whether they are the parent or the legal guardian).",
      "Writes the evidence, with the PDF of what was signed and its SHA-256, and marks the request signed, in one transaction; any other link to this waiver stops working. Sending it again from the same session returns the same evidence with 200. Evidence never changes afterwards. Rate limited like other public commands.",
    ].join("\n\n"),
    security: bearerSecurity,
    request: {
      body: { required: true, content: { "application/json": { schema: WaiverSignRequest } } },
    },
    responses: {
      200: {
        content: { "application/json": { schema: WaiverSessionResponse } },
        description: "Already signed in this session: the same evidence",
      },
      201: {
        content: { "application/json": { schema: WaiverSessionResponse } },
        description: "Signed",
      },
      400: errorBody("Request did not match the contract"),
      401: errorBody("No session secret, or no open session"),
      404: errorBody("No operator at this address"),
      409: errorBody(
        "The waiver changed since it was shown (waiver_changed), was signed through another link (waiver_signed), was replaced by a newer version (waiver_superseded), is no longer needed (waiver_not_needed), or the participant's details changed who signs (waiver_participant_changed)",
      ),
      422: {
        content: { "application/json": { schema: WaiverSignProblemsResponse } },
        description: "Something to fix first, field by field (signature_invalid)",
      },
      429: errorBody("Too many requests from this address for this operator (rate_limited)"),
    },
  });

  app.openapi(signRoute, async (c) => {
    const secret = sessionSecret(c);
    const input = c.req.valid("json");
    const wdeps = waiverDeps(c.env, deps);
    const meta = signingMeta(c);
    let outcome:
      | { kind: "signed" | "already_signed"; waiver: WaiverSigning }
      | { kind: "invalid"; problems: WaiverSignProblemsResponse["problems"] }
      | undefined;
    // A refusal to fix writes nothing, so the transaction commits empty and
    // the answer is built outside it.
    await withPublicTenant(c, { limit: true }, async (trx, ctx) => {
      const session = await openSession(trx, ctx.tenantId, secret);
      const signed = await signWaiver(trx, ctx, wdeps, session, input, meta);
      switch (signed.kind) {
        case "signed":
        case "already_signed":
          outcome = { kind: signed.kind, waiver: signingJson(signed.view) };
          return {};
        case "invalid":
          outcome = { kind: "invalid", problems: signed.problems };
          return {};
        case "content_changed":
          throw new ApiError(
            409,
            "waiver_changed",
            "This waiver changed since it was shown; read it again before signing",
          );
        case "participant_changed":
          throw new ApiError(
            409,
            "waiver_participant_changed",
            "The booking's details for this person changed; a new email has the waiver to sign",
          );
        case "not_pending":
          throw closedRefusal(signed.state);
      }
    });
    if (!outcome) throw new Error("signing produced no outcome");
    if (outcome.kind === "invalid") {
      return c.json(
        {
          error: {
            code: "signature_invalid" as const,
            message: "Fix the fields below to sign",
            requestId: c.get("requestId"),
          },
          problems: outcome.problems,
        },
        422,
      );
    }
    return c.json({ waiver: outcome.waiver }, outcome.kind === "signed" ? 201 : 200);
  });

  const documentRoute = createRoute({
    method: "get",
    path: documentPath,
    tags: ["public", "waivers"],
    summary: "The signed PDF of the current session's waiver",
    description:
      "Resolves the browser Origin and needs the session's secret as a bearer token. The PDF exactly as recorded with the evidence, once signed.",
    security: bearerSecurity,
    responses: {
      200: {
        content: { "application/pdf": { schema: z.string().openapi({ format: "binary" }) } },
        description: "The signed PDF",
      },
      401: errorBody("No session secret, or no open session"),
      404: errorBody("No operator at this address, or not signed yet (waiver_document_not_found)"),
    },
  });

  app.openapi(documentRoute, async (c) => {
    const secret = sessionSecret(c);
    let doc: { reference: string; bytes: Uint8Array<ArrayBuffer> } | undefined;
    await withPublicTenant(c, {}, async (trx, ctx) => {
      const session = await openSession(trx, ctx.tenantId, secret);
      const found = await loadEvidenceDocument(trx, ctx.tenantId, { requestId: session.requestId });
      if (!found) {
        throw new ApiError(404, "waiver_document_not_found", "This waiver is not signed yet");
      }
      doc = { reference: found.bookingReference, bytes: new Uint8Array(found.document) };
      return {};
    });
    if (!doc) throw new Error("the document read produced nothing");
    return pdfResponse(c, doc.bytes, `waiver-${doc.reference}.pdf`);
  });

  const renewRoute = createRoute({
    method: "post",
    path: renewalPath,
    tags: ["public", "waivers"],
    summary: "Ask for a new waiver link",
    description:
      "Resolves the browser Origin. For the newest link of a waiver that still needs a signature (expired, already opened, or replaced), sends a new email to the address the booking has now, within the usual resend limits. Answers 202 whatever happened, so the answer says nothing about the link. Rate limited like other public commands.",
    request: {
      body: { required: true, content: { "application/json": { schema: WaiverLinkRenewRequest } } },
    },
    responses: {
      202: {
        content: { "application/json": { schema: WaiverLinkRenewResponse } },
        description: "Accepted",
      },
      400: errorBody("Request did not match the contract"),
      404: errorBody("No operator at this address"),
      429: errorBody("Too many requests from this address for this operator (rate_limited)"),
    },
  });

  app.openapi(renewRoute, async (c) => {
    const { token } = c.req.valid("json");
    const wdeps = waiverDeps(c.env, deps);
    await withPublicTenant(c, { limit: true }, async (trx, ctx) => {
      await renewWaiverLink(trx, ctx, wdeps, { token });
      return {};
    });
    return c.json({ status: "accepted" as const }, 202);
  });
}
