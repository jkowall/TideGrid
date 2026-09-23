import { z } from "zod";

/**
 * Shared API contracts. Every request and response schema the API exposes is
 * defined here and reused by the Worker (validation and OpenAPI) and the web
 * clients (types). Money is integer cents; instants are RFC 3339 strings.
 */

export const apiVersion = "v1" as const;

export const HealthResponse = z
  .object({
    status: z.enum(["ok", "degraded"]),
    version: z.string().describe("Deployed build identifier"),
    environment: z.enum(["local", "preview", "staging", "production"]),
    database: z.enum(["ok", "error", "unconfigured"]),
    migrations: z
      .object({ applied: z.number().int().nonnegative(), latest: z.string().nullable() })
      .nullable(),
    time: z.string().datetime({ offset: true }),
  })
  .describe("Service health for synthetic checks; carries no tenant data");

export type HealthResponse = z.infer<typeof HealthResponse>;

export const ErrorResponse = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
  }),
});

export type ErrorResponse = z.infer<typeof ErrorResponse>;

// Identity and access ------------------------------------------------------------

/** Pilot roles from the product scope. The database CHECK constraint must match. */
export const StaffRole = z.enum(["owner", "booking_staff", "finance"]);
export type StaffRole = z.infer<typeof StaffRole>;

export const AuthMethod = z.enum(["access", "magic_link"]);
export type AuthMethod = z.infer<typeof AuthMethod>;

const Instant = z.iso.datetime({ offset: true });
const Uuid = z.uuid();
const EmailAddress = z.email().max(254);

export const Principal = z
  .object({
    userId: Uuid,
    email: EmailAddress,
    displayName: z.string(),
    authMethod: AuthMethod,
  })
  .describe("The authenticated staff identity. Carries no tenant authority by itself.");
export type Principal = z.infer<typeof Principal>;

export const Membership = z.object({
  tenantId: Uuid,
  tenantSlug: z.string(),
  tenantName: z.string(),
  role: StaffRole,
});
export type Membership = z.infer<typeof Membership>;

export const MeResponse = z.object({
  principal: Principal,
  memberships: z.array(Membership),
});
export type MeResponse = z.infer<typeof MeResponse>;

export const LoginLinkRequest = z.object({ email: EmailAddress });
export type LoginLinkRequest = z.infer<typeof LoginLinkRequest>;

export const LoginLinkResponse = z
  .object({
    status: z.literal("accepted"),
    devLink: z
      .url()
      .optional()
      .describe("Local development only; never present on a deployed environment"),
  })
  .describe("Returned for every address so the endpoint does not reveal which addresses exist");
export type LoginLinkResponse = z.infer<typeof LoginLinkResponse>;

/** 32 random bytes, base64url without padding. */
export const OpaqueToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const SessionCreateRequest = z.object({ token: OpaqueToken });
export type SessionCreateRequest = z.infer<typeof SessionCreateRequest>;

export const SessionResponse = z.object({ principal: Principal, expiresAt: Instant });
export type SessionResponse = z.infer<typeof SessionResponse>;

export const IdempotencyKey = z
  .string()
  .regex(/^[A-Za-z0-9_.:-]{8,255}$/)
  .describe("Client-generated; a UUID is recommended. Scoped by tenant, operation, and principal.");

export const StaffTenantParams = z.object({
  tenantId: z.string().describe("Tenant UUID; anything else answers 404"),
});

export const MembershipStatus = z.enum(["active", "disabled"]);

export const Member = z.object({
  userId: Uuid,
  email: EmailAddress,
  displayName: z.string(),
  role: StaffRole,
  status: MembershipStatus,
  createdAt: Instant,
});
export type Member = z.infer<typeof Member>;

export const MemberListResponse = z.object({ members: z.array(Member) });
export type MemberListResponse = z.infer<typeof MemberListResponse>;

export const MemberCreateRequest = z.object({
  email: EmailAddress,
  displayName: z.string().trim().min(1).max(120),
  role: StaffRole,
  reason: z.string().trim().min(1).max(500).describe("Recorded in the audit history"),
});
export type MemberCreateRequest = z.infer<typeof MemberCreateRequest>;

export const MemberResponse = z.object({ member: Member });
export type MemberResponse = z.infer<typeof MemberResponse>;

export const ActorType = z.enum(["staff", "guest", "system", "support"]);

export const AuditEvent = z.object({
  id: z.string().regex(/^\d+$/),
  occurredAt: Instant,
  actorType: ActorType,
  actorId: z.string().nullable(),
  requestId: z.string().nullable(),
  action: z.string(),
  subjectType: z.string(),
  subjectId: z.string(),
  reason: z.string().nullable(),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
});
export type AuditEvent = z.infer<typeof AuditEvent>;

export const AuditEventQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z
    .string()
    .regex(/^\d{1,18}$/)
    .optional()
    .describe("Return events with an id lower than this cursor"),
});

export const AuditEventListResponse = z.object({
  events: z.array(AuditEvent),
  nextBefore: z.string().nullable(),
});
export type AuditEventListResponse = z.infer<typeof AuditEventListResponse>;

export const PublicTenantResponse = z
  .object({ tenant: z.object({ slug: z.string(), name: z.string() }) })
  .describe("Public brand context for a verified hostname. Grants no permission.");
export type PublicTenantResponse = z.infer<typeof PublicTenantResponse>;
