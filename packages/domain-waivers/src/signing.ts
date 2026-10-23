/**
 * The signing page's view and the signature itself. A session shows exactly
 * one request: its version's text, who signs, and, once signed, what was
 * recorded. Signing checks that the signer saw this version (its hash), made
 * every acknowledgment, consented to sign electronically, confirmed who they
 * are, and typed a signature (an adult's must match the booking's name for
 * them); then it writes the evidence, with the PDF of what was signed, and
 * marks the request signed, in one transaction.
 */
import {
  enqueueOutbox,
  type GuardianRelationship,
  isUuid,
  recordAudit,
  type TenantContext,
  type TenantTransaction,
  type WaiverRequestState,
  type WaiverSignerRole,
} from "@tidegrid/database";
import { sql } from "kysely";
import type { WaiverSession } from "./access.ts";
import { type BookingContext, loadBookingContext, tripFacts, tripIsOver } from "./booking.ts";
import { sha256Hex } from "./content.ts";
import { lockRequest } from "./delivery.ts";
import { cleanLine, comparableName, formatInstant } from "./format.ts";
import { closeRequestAccess } from "./links.ts";
import type { WaiverDeps, WaiverParticipant } from "./ports.ts";
import { maskEmail, RENDERING_VERSION, renderWaiverPdf } from "./render.ts";
import { loadTemplateVersion, type TemplateVersionText } from "./templates.ts";

/** The electronic-signature consent every signer accepts, recorded with the evidence. */
export const ESIGN_CONSENT = {
  version: "esign-v1",
  text: "I agree to sign this waiver electronically, and that my typed name is my signature.",
} as const;

// biome-ignore lint/suspicious/noControlCharactersInRegex: the pattern exists to reject them.
const controlChars = /[\u0000-\u001f\u007f]/;

export interface SignedSummary {
  evidenceId: string;
  signedAt: Date;
  signerName: string;
  signerRole: WaiverSignerRole;
  relationship: GuardianRelationship | null;
  documentSha256: string;
}

export interface SigningView {
  state: WaiverRequestState;
  operatorName: string;
  trip: ReturnType<typeof tripFacts>;
  /**
   * Who the waiver is for, and the name the signer types: the participant's
   * own, or a minor's parent or guardian's, as the booking gives them. Null
   * once the participant has left the booking.
   */
  participant: { name: string; minor: boolean; signerName: string | null } | null;
  signerRole: WaiverSignerRole;
  waiver: {
    title: string;
    version: number;
    body: string;
    acknowledgments: string[];
    contentSha256: string;
  };
  consent: { version: string; text: string };
  sessionExpiresAt: Date;
  signed: SignedSummary | null;
}

async function findParticipant(
  trx: TenantTransaction,
  tenantId: string,
  deps: WaiverDeps,
  bookingId: string,
  participantId: string,
): Promise<WaiverParticipant | null> {
  const all = await deps.participants.list(trx, tenantId, bookingId);
  return all.find((p) => p.id === participantId) ?? null;
}

async function loadSigned(
  trx: TenantTransaction,
  tenantId: string,
  requestId: string,
): Promise<
  (SignedSummary & { sessionId: string; participantName: string; minor: boolean }) | null
> {
  const row = await trx
    .selectFrom("waiver_evidence")
    .select([
      "id",
      "session_id",
      "signed_at",
      "signer_name",
      "signer_role",
      "guardian_relationship",
      "document_sha256",
      "participant_name",
      "participant_minor",
    ])
    .where("tenant_id", "=", tenantId)
    .where("request_id", "=", requestId)
    .executeTakeFirst();
  if (!row) return null;
  return {
    evidenceId: row.id,
    sessionId: row.session_id,
    signedAt: row.signed_at,
    signerName: row.signer_name,
    signerRole: row.signer_role,
    relationship: row.guardian_relationship,
    documentSha256: row.document_sha256,
    participantName: row.participant_name,
    minor: row.participant_minor,
  };
}

function viewOf(
  state: WaiverRequestState,
  session: WaiverSession,
  booking: BookingContext,
  version: TemplateVersionText,
  participant: SigningView["participant"],
  signed: SignedSummary | null,
): SigningView {
  return {
    state,
    operatorName: booking.operatorName,
    trip: tripFacts(booking),
    participant,
    signerRole: session.signerRole,
    waiver: {
      title: version.title,
      version: version.version,
      body: version.body,
      acknowledgments: version.acknowledgments,
      contentSha256: version.contentSha256,
    },
    consent: { ...ESIGN_CONSENT },
    sessionExpiresAt: session.expiresAt,
    signed,
  };
}

/** What the session's signer sees. */
export async function getSigningView(
  trx: TenantTransaction,
  tenantId: string,
  deps: WaiverDeps,
  session: WaiverSession,
): Promise<SigningView> {
  const request = await trx
    .selectFrom("waiver_requests")
    .select(["state", "template_id", "template_version"])
    .where("tenant_id", "=", tenantId)
    .where("id", "=", session.requestId)
    .executeTakeFirstOrThrow();
  const booking = await loadBookingContext(trx, tenantId, session.bookingId);
  if (!booking) throw new Error("a session's booking was not found");
  const version = await loadTemplateVersion(
    trx,
    tenantId,
    request.template_id,
    request.template_version,
  );
  if (!version) throw new Error("a request's version was not found");
  const signed = await loadSigned(trx, tenantId, session.requestId);
  let participant: SigningView["participant"] = null;
  if (signed) {
    participant = {
      name: signed.participantName,
      minor: signed.minor,
      signerName: signed.signerName,
    };
  } else {
    const current = await findParticipant(
      trx,
      tenantId,
      deps,
      session.bookingId,
      session.participantId,
    );
    if (current) {
      participant = {
        name: current.name,
        minor: current.minor,
        signerName: expectedSigner(current, session.signerRole),
      };
    }
  }
  return viewOf(request.state, session, booking, version, participant, signed);
}

export interface SignInput {
  /** The hash of the version the signer was shown. */
  contentSha256: string;
  /** One per acknowledgment of the version, in order; every one true. */
  acknowledgments: boolean[];
  /** Consent to sign electronically. */
  consent: boolean;
  /** "I am <participant>", or "I am the parent or legal guardian of <minor>". */
  confirmIdentity: boolean;
  /** The typed signature: the signer's full name. */
  signature: string;
  /** A guardian's declared relationship to the minor; null for a participant. */
  relationship: GuardianRelationship | null;
}

export type SignField =
  | "acknowledgments"
  | "consent"
  | "confirmIdentity"
  | "signature"
  | "relationship";

export interface SignProblem {
  field: SignField;
  code: string;
  message: string;
}

export type SignResult =
  | { kind: "signed"; view: SigningView }
  /** This session signed it already: the same evidence, unchanged. */
  | { kind: "already_signed"; view: SigningView }
  /** Signed through another link, superseded, or no longer required. */
  | { kind: "not_pending"; state: WaiverRequestState }
  /** The signer was shown other text than the request's version. */
  | { kind: "content_changed" }
  /** The participant's details changed in a way that changes who must sign. */
  | { kind: "participant_changed" }
  /**
   * The session ended while this signature waited for the request: an
   * address correction, a withdrawal, or its hour ran out.
   */
  | { kind: "session_ended" }
  /** The trip ended while the session was open: a waiver is signed before its trip ends. */
  | { kind: "trip_over" }
  | { kind: "invalid"; problems: SignProblem[] };

/**
 * The name the booking gives the person who signs: the participant, or a
 * minor's parent or guardian. A typed signature must match it.
 */
export function expectedSigner(
  participant: WaiverParticipant,
  role: WaiverSignerRole,
): string | null {
  return role === "guardian" ? participant.guardianName : participant.name;
}

function validate(
  input: SignInput,
  version: TemplateVersionText,
  participant: WaiverParticipant,
  role: WaiverSignerRole,
): { problems: SignProblem[]; signature: string } {
  const problems: SignProblem[] = [];
  if (
    input.acknowledgments.length !== version.acknowledgments.length ||
    !input.acknowledgments.every((a) => a === true)
  ) {
    problems.push({
      field: "acknowledgments",
      code: "required",
      message: "Check every acknowledgment to sign",
    });
  }
  if (input.consent !== true) {
    problems.push({
      field: "consent",
      code: "required",
      message: "Agree to sign electronically to continue",
    });
  }
  if (input.confirmIdentity !== true) {
    problems.push({
      field: "confirmIdentity",
      code: "required",
      message:
        role === "guardian"
          ? `Confirm that you are the parent or legal guardian of ${participant.name}`
          : `Confirm that you are ${participant.name}`,
    });
  }
  const signature = cleanLine(input.signature);
  const expected = expectedSigner(participant, role);
  if (signature.length < 2 || signature.length > 120 || !/\p{L}/u.test(signature)) {
    problems.push({ field: "signature", code: "required", message: "Type your full name to sign" });
  } else if (controlChars.test(signature)) {
    problems.push({ field: "signature", code: "invalid", message: "Type your name as plain text" });
  } else if (expected !== null && comparableName(signature) !== comparableName(expected)) {
    problems.push({
      field: "signature",
      code: "does_not_match",
      message: `Type your name as it appears on this booking: ${expected}`,
    });
  }
  if (role === "guardian" && input.relationship === null) {
    problems.push({
      field: "relationship",
      code: "required",
      message: "Choose whether you are the parent or the legal guardian",
    });
  }
  if (role === "participant" && input.relationship !== null) {
    problems.push({
      field: "relationship",
      code: "not_applicable",
      message: "Only a parent or guardian signing for a minor gives a relationship",
    });
  }
  return { problems, signature };
}

/**
 * Sign the session's request. Locks the request first; a second submission
 * from the same session returns the evidence it already made.
 */
export async function signWaiver(
  trx: TenantTransaction,
  ctx: TenantContext,
  deps: WaiverDeps,
  session: WaiverSession,
  input: SignInput,
  meta: { sourceIp: string | null; userAgent: string | null },
): Promise<SignResult> {
  const request = await lockRequest(trx, ctx.tenantId, session.requestId);
  if (!request) throw new Error("a session's request was not found");
  if (request.state === "signed") {
    const signed = await loadSigned(trx, ctx.tenantId, request.id);
    if (signed?.sessionId === session.id) {
      return {
        kind: "already_signed",
        view: await getSigningView(trx, ctx.tenantId, deps, session),
      };
    }
    return { kind: "not_pending", state: request.state };
  }
  if (request.state !== "pending") return { kind: "not_pending", state: request.state };
  // The caller found the session open before the request's lock; a change
  // that committed while this waited (an address correction revokes the old
  // address's sessions under the same lock) is visible now.
  const { rows: open } = await sql<{ open: boolean }>`
    select (revoked_at is null and expires_at > now()) as open
      from waiver_signing_sessions
     where tenant_id = ${ctx.tenantId} and id = ${session.id}`.execute(trx);
  if (!open[0]?.open) return { kind: "session_ended" };
  if (await tripIsOver(trx, ctx.tenantId, request.booking_id)) return { kind: "trip_over" };
  const version = await loadTemplateVersion(
    trx,
    ctx.tenantId,
    request.template_id,
    request.template_version,
  );
  if (!version) throw new Error("a request's version was not found");
  if (input.contentSha256 !== version.contentSha256) return { kind: "content_changed" };
  const booking = await loadBookingContext(trx, ctx.tenantId, request.booking_id);
  if (!booking) throw new Error("a request's booking was not found");
  const participant = await findParticipant(
    trx,
    ctx.tenantId,
    deps,
    request.booking_id,
    request.participant_id,
  );
  if (!participant) return { kind: "not_pending", state: request.state };
  if ((request.required_signer === "guardian") !== participant.minor) {
    return { kind: "participant_changed" };
  }
  const { problems, signature } = validate(input, version, participant, request.required_signer);
  if (problems.length > 0) return { kind: "invalid", problems };

  // The address the session's link was emailed to: the link names its
  // message, and the message its delivery generation.
  const { rows } = await sql<{ now: Date; recipient_email: string }>`
    select now() as now, d.recipient_email
      from waiver_signing_sessions s
      join guest_access_links l on l.tenant_id = s.tenant_id and l.id = s.access_link_id
      join waiver_deliveries d on d.tenant_id = s.tenant_id and d.message_id = l.message_id
     where s.tenant_id = ${ctx.tenantId} and s.id = ${session.id}`.execute(trx);
  const facts = rows[0];
  if (!facts) throw new Error("a session's delivery was not found");
  const signedAt = facts.now;
  const evidenceId = crypto.randomUUID();
  const signerName = expectedSigner(participant, request.required_signer) ?? signature;
  const relationship = request.required_signer === "guardian" ? input.relationship : null;
  const document = renderWaiverPdf({
    operatorName: booking.operatorName,
    title: version.title,
    version: version.version,
    contentSha256: version.contentSha256,
    body: version.body,
    acknowledgments: version.acknowledgments,
    trip: tripFacts(booking),
    participant: { name: participant.name, minor: participant.minor },
    signer: { role: request.required_signer, name: signerName, relationship },
    signatureText: signature,
    consentText: ESIGN_CONSENT.text,
    signedAt,
    signedAtLocal: formatInstant(signedAt, booking.timeZone),
    evidenceId,
    requestId: request.id,
    recipientMasked: maskEmail(facts.recipient_email),
    sourceIp: meta.sourceIp,
    userAgent: meta.userAgent,
  });
  const documentSha256 = await sha256Hex(document);
  await trx
    .insertInto("waiver_evidence")
    .values({
      id: evidenceId,
      tenant_id: ctx.tenantId,
      request_id: request.id,
      booking_id: request.booking_id,
      participant_id: request.participant_id,
      session_id: session.id,
      template_id: version.templateId,
      template_version: version.version,
      content_sha256: version.contentSha256,
      rendering_version: RENDERING_VERSION,
      participant_name: participant.name,
      participant_minor: participant.minor,
      signer_role: request.required_signer,
      signer_name: signerName,
      guardian_relationship: relationship,
      signature_method: "typed_name",
      signature_text: signature,
      acknowledgments: version.acknowledgments,
      consent_version: ESIGN_CONSENT.version,
      consent_text: ESIGN_CONSENT.text,
      access_method: "email_link",
      recipient_email: facts.recipient_email,
      match_method: "signer_confirmed",
      source_ip: meta.sourceIp,
      user_agent: meta.userAgent,
      document,
      document_sha256: documentSha256,
    })
    .execute();
  await sql`
    update waiver_requests set state = 'signed'
     where tenant_id = ${ctx.tenantId} and id = ${request.id}`.execute(trx);
  // Every other link and session to this waiver stops working, and no queued
  // email goes out; the signer's own session stays open for the signed copy.
  await closeRequestAccess(trx, ctx, request, {
    link: "completed",
    session: "completed",
    keepSession: session.id,
  });
  await recordAudit(trx, ctx, {
    action: "waiver_request.signed",
    subjectType: "waiver_request",
    subjectId: request.id,
    before: { state: "pending" },
    after: {
      state: "signed",
      evidenceId,
      sessionId: session.id,
      templateId: version.templateId,
      templateVersion: version.version,
      contentSha256: version.contentSha256,
      documentSha256,
      signerRole: request.required_signer,
    },
  });
  await enqueueOutbox(trx, ctx, {
    topic: "waiver.signed",
    aggregateType: "waiver_request",
    aggregateId: request.id,
    payload: {
      requestId: request.id,
      evidenceId,
      bookingId: request.booking_id,
      participantId: request.participant_id,
      templateId: version.templateId,
      templateVersion: version.version,
    },
  });
  return {
    kind: "signed",
    view: viewOf(
      "signed",
      session,
      booking,
      version,
      { name: participant.name, minor: participant.minor, signerName },
      {
        evidenceId,
        signedAt,
        signerName,
        signerRole: request.required_signer,
        relationship,
        documentSha256,
      },
    ),
  };
}

/**
 * A stored PDF whose bytes no longer hash to the SHA-256 recorded beside
 * them. It is never served; the API answers 500 and logs this error's name.
 */
export class WaiverDocumentMismatchError extends Error {
  constructor(readonly evidenceId: string) {
    super(`waiver evidence ${evidenceId}: the stored PDF does not match its recorded SHA-256`);
    this.name = "WaiverDocumentMismatchError";
  }
}

/**
 * The signed PDF, for the session that signed it or for staff; null otherwise.
 * The bytes are hashed again on every read and must match the recorded
 * SHA-256, or it throws WaiverDocumentMismatchError.
 */
export async function loadEvidenceDocument(
  trx: TenantTransaction,
  tenantId: string,
  filter: { requestId: string } | { evidenceId: string },
): Promise<{
  evidenceId: string;
  bookingReference: string;
  document: Uint8Array;
  sha256: string;
} | null> {
  const id = "requestId" in filter ? filter.requestId : filter.evidenceId;
  if (!isUuid(id)) return null;
  const { rows } = await sql<{
    id: string;
    reference: string;
    document: Uint8Array;
    document_sha256: string;
  }>`
    select e.id, b.reference, e.document, e.document_sha256
      from waiver_evidence e
      join bookings b on b.tenant_id = e.tenant_id and b.id = e.booking_id
     where e.tenant_id = ${tenantId}
       and ${"requestId" in filter ? sql`e.request_id = ${filter.requestId}` : sql`e.id = ${filter.evidenceId}`}`.execute(
    trx,
  );
  const row = rows[0];
  if (!row) return null;
  const document = new Uint8Array(row.document);
  if ((await sha256Hex(document)) !== row.document_sha256) {
    throw new WaiverDocumentMismatchError(row.id);
  }
  return {
    evidenceId: row.id,
    bookingReference: row.reference,
    document,
    sha256: row.document_sha256,
  };
}
