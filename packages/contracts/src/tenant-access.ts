import { z } from "zod";

/**
 * Tenant access remainder (W3-G2.2b, without managed OIDC and MFA):
 * invitations, enabling and disabling a member, TideGrid support access, the
 * tenant data export, and the account deletion request.
 *
 * - Adding a member creates an invitation (no email is sent yet). The invited
 *   person signs in to the console and accepts or declines it there; until
 *   then they have no access. An invitation lasts seven days, and an owner
 *   can renew it.
 * - Disabling a member ends their access here at once. When it was their
 *   last active membership, their sessions are revoked too.
 * - Support access is granted by an owner to one TideGrid support agent, for
 *   a reason and at most four hours (coordinator default D1). It is read-only
 *   and masked by default; every request it makes is in the audit history.
 * - Export and the deletion request are owners' alone. Nothing is deleted by
 *   a request: TideGrid follows up and deletes as a separate operation.
 */

const Uuid = z.uuid();
const Instant = z.iso.datetime({ offset: true });
const EmailAddress = z
  .email()
  .max(254)
  .regex(/^[\x21-\x7e]+$/, "Addresses must be ASCII");
const Reason = z
  .string()
  .trim()
  .min(1)
  .max(500)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the pattern exists to reject them.
  .regex(/^[^\u0000-\u001f\u007f]*$/, "Control characters are not allowed")
  .describe("Recorded in the audit history");

// Members ----------------------------------------------------------------------------

export const MemberParams = z.object({
  tenantId: z.string().describe("Tenant UUID; anything else answers 404"),
  userId: z.string().describe("The member's user id; anything else answers 404"),
});

export const MemberStatusRequest = z.object({
  status: z
    .enum(["active", "disabled"])
    .describe(
      "active enables a member who accepted, or sends a fresh invitation to one who never did; disabled ends access here at once, and signs the person out when it was their last active membership",
    ),
  reason: Reason,
});
export type MemberStatusRequest = z.infer<typeof MemberStatusRequest>;

// Invitations ------------------------------------------------------------------------

export const Invitation = z.object({
  tenantId: Uuid,
  tenantSlug: z.string(),
  tenantName: z.string(),
  role: z.enum(["owner", "booking_staff", "finance"]),
  invitedAt: Instant,
  expiresAt: Instant,
});
export type Invitation = z.infer<typeof Invitation>;

export const InvitationListResponse = z.object({ invitations: z.array(Invitation) });
export type InvitationListResponse = z.infer<typeof InvitationListResponse>;

export const InvitationParams = z.object({
  tenantId: z.string().describe("Tenant UUID; anything else answers 404"),
});

export const InvitationResponse = z.object({
  tenantId: Uuid,
  status: z
    .enum(["active", "disabled"])
    .describe("active after accepting, disabled after declining"),
});
export type InvitationResponse = z.infer<typeof InvitationResponse>;

// Support access ------------------------------------------------------------------------

export const SupportGrantCreateRequest = z.object({
  agentEmail: EmailAddress.describe("The TideGrid support agent's sign-in address"),
  reason: Reason,
  minutes: z
    .number()
    .int()
    .min(15)
    .max(240)
    .describe("How long the grant lasts: 15 minutes to 4 hours"),
  revealPersonalData: z
    .boolean()
    .default(false)
    .describe(
      "False (the default) keeps bookers' names and emails and the staff list hidden from support",
    ),
});
export type SupportGrantCreateRequest = z.infer<typeof SupportGrantCreateRequest>;

export const SupportGrantState = z.enum(["open", "expired", "revoked"]);

export const SupportGrant = z.object({
  id: Uuid,
  agentEmail: z.string(),
  reason: z.string(),
  revealPersonalData: z.boolean(),
  grantedBy: Uuid,
  grantedAt: Instant,
  expiresAt: Instant,
  revokedAt: Instant.nullable(),
  revokedBy: Uuid.nullable(),
  state: SupportGrantState,
});
export type SupportGrant = z.infer<typeof SupportGrant>;

export const SupportGrantResponse = z.object({ grant: SupportGrant });
export type SupportGrantResponse = z.infer<typeof SupportGrantResponse>;

export const SupportGrantListResponse = z.object({ grants: z.array(SupportGrant) });
export type SupportGrantListResponse = z.infer<typeof SupportGrantListResponse>;

export const SupportGrantParams = z.object({
  tenantId: z.string().describe("Tenant UUID; anything else answers 404"),
  grantId: z.string().describe("Grant UUID; anything else answers 404"),
});

export const SupportGrantRevokeRequest = z.object({ reason: Reason });
export type SupportGrantRevokeRequest = z.infer<typeof SupportGrantRevokeRequest>;

// Data export ----------------------------------------------------------------------------

export const TenantExportSection = z.object({
  rows: z.array(z.record(z.string(), z.unknown())),
  truncated: z.boolean().describe("True when the section reached its row limit"),
});

export const TenantExportResponse = z
  .object({
    format: z.literal("tidegrid.tenant-export.v1"),
    exportedAt: Instant,
    tenant: z.object({ id: Uuid, slug: z.string(), name: z.string() }),
    rowLimit: z.number().int().positive(),
    sections: z.record(z.string(), TenantExportSection),
  })
  .describe(
    "The tenant's own records as JSON, one section per table. Secrets, token hashes, and provider keys are left out.",
  );
export type TenantExportResponse = z.infer<typeof TenantExportResponse>;

// Account deletion request ------------------------------------------------------------------

export const DeletionRequestCreateRequest = z.object({
  reason: Reason,
  confirmSlug: z.string().max(40).describe("The tenant's slug, typed again to confirm"),
});
export type DeletionRequestCreateRequest = z.infer<typeof DeletionRequestCreateRequest>;

export const DeletionRequestWithdrawRequest = z.object({ reason: Reason });
export type DeletionRequestWithdrawRequest = z.infer<typeof DeletionRequestWithdrawRequest>;

export const DeletionRequest = z.object({
  id: Uuid,
  state: z.enum(["requested", "withdrawn"]),
  reason: z.string(),
  requestedBy: Uuid,
  requestedAt: Instant,
  withdrawnBy: Uuid.nullable(),
  withdrawnAt: Instant.nullable(),
});
export type DeletionRequest = z.infer<typeof DeletionRequest>;

export const DeletionRequestResponse = z.object({
  request: DeletionRequest.nullable().describe("The open request, or null when there is none"),
});
export type DeletionRequestResponse = z.infer<typeof DeletionRequestResponse>;
