import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.ts";
import type { Bindings } from "../src/env.ts";
import { markConsoleGateway } from "../src/gateway.ts";

// The resend route's order (G2.16b) in the Workers runtime, with no database:
// authentication, membership, permission, and the idempotency claim or replay
// come first, then the booking, then the email switch, and only then the
// service. The modules that would reach the database are replaced by
// recorders, so the test reads the order from `state.log`; each run's
// transaction commits or rolls back as the real one would. The same order
// over a real database is in
// test-integration/booking-email-resend.integration.test.ts.

const state = vi.hoisted(() => ({
  /** The signed-in person's role in the tenant, or null for no membership. */
  role: "owner" as "owner" | "booking_staff" | "finance" | null,
  /** A stored answer for the key, or null for a new key. */
  replay: null as null | { status: number; body: Record<string, unknown> },
  bookingExists: true,
  log: [] as string[],
}));

const principal = {
  userId: "33333333-3333-4333-8333-333333333333",
  email: "synthetic.owner@example.test",
  displayName: "Synthetic Owner",
  authMethod: "access" as const,
};

vi.mock("../src/auth/principal.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/auth/principal.ts")>();
  return {
    ...real,
    requirePrincipal: async (...args: Parameters<typeof real.requirePrincipal>) => {
      state.log.push("authenticate");
      // A request without the test's marker goes through the real check: anonymous is 401.
      if (args[0].req.header("x-test-staff") === "1") return principal;
      return real.requirePrincipal(...args);
    },
  };
});

vi.mock("../src/db.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/db.ts")>();
  return { ...real, getDb: () => ({}) as never };
});

/** A query builder that answers the route's booking lookup and records it. */
function fakeTrx(): unknown {
  const chain: unknown = new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === "then") return undefined;
        if (prop === "executeTakeFirst") {
          return async () => {
            state.log.push("booking");
            return state.bookingExists ? { id: "found" } : undefined;
          };
        }
        return () => chain;
      },
    },
  );
  return chain;
}

vi.mock("@tidegrid/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@tidegrid/database")>();
  return {
    ...real,
    inTenantTransaction: async (
      _db: unknown,
      _ctx: unknown,
      fn: (trx: unknown) => Promise<unknown>,
    ) => {
      state.log.push("begin");
      try {
        const out = await fn(fakeTrx());
        state.log.push("commit");
        return out;
      } catch (error) {
        state.log.push("rollback");
        throw error;
      }
    },
    claimIdempotencyKey: async () => {
      state.log.push("claim");
      return state.replay ? { kind: "replay", ...state.replay } : { kind: "new" };
    },
    completeIdempotencyKey: async () => {
      state.log.push("store");
    },
  };
});

vi.mock("@tidegrid/domain-identity", async (importOriginal) => {
  const real = await importOriginal<typeof import("@tidegrid/domain-identity")>();
  return {
    ...real,
    loadStaffTenantAccess: async () => {
      state.log.push("membership");
      return state.role
        ? {
            tenant: { id: tenant, slug: "synthetic", name: "Synthetic", status: "active" },
            role: state.role,
          }
        : null;
    },
  };
});

vi.mock("@tidegrid/domain-booking", async (importOriginal) => {
  const real = await importOriginal<typeof import("@tidegrid/domain-booking")>();
  return {
    ...real,
    resendBookingEmail: async () => {
      state.log.push("resend");
      return {
        kind: "queued",
        messageId: "44444444-4444-4444-8444-444444444444",
        generation: 1,
        queuedAt: new Date("2026-11-04T19:03:00.000Z"),
        canceledMessageIds: [],
      };
    },
  };
});

const tenant = "11111111-1111-4111-8111-111111111111";
const booking = "22222222-2222-4222-8222-222222222222";
const path = `/v1/staff/tenants/${tenant}/bookings/${booking}/emails/resend`;
const app = createApp({ deliverEmailAfterCommit: false });

/** A stand-in for the send_email binding; nothing here sends. */
const binding = { send: async () => ({ messageId: "0101018f7d0c4d9a-msg-unit0001" }) };

function bindings(overrides: Record<string, unknown> = {}): Bindings {
  const out: Record<string, unknown> = {
    ...(env as unknown as Bindings),
    STAFF_ORIGINS: "https://console.test",
    ...overrides,
  };
  for (const [key, value] of Object.entries(out)) if (value === undefined) delete out[key];
  return markConsoleGateway(out as unknown as Bindings);
}

/** Every setting under which email is off or refused, as src/email.ts decides it. */
const offSettings: [string, Record<string, unknown>][] = [
  ["unset", { EMAIL_PROVIDER: undefined }],
  ["cloudflare without its binding", { EMAIL_PROVIDER: "cloudflare", ENVIRONMENT: "preview" }],
  [
    "cloudflare with an empty allowlist",
    { EMAIL_PROVIDER: "cloudflare", EMAIL: binding, ENVIRONMENT: "preview" },
  ],
  ["the fake outside local", { EMAIL_PROVIDER: "fake", ENVIRONMENT: "preview" }],
  ["the fake beside a binding", { EMAIL_PROVIDER: "fake", EMAIL: binding }],
  [
    "an allowlist entry that is not an address",
    {
      EMAIL_PROVIDER: "cloudflare",
      EMAIL: binding,
      EMAIL_ALLOWED_RECIPIENTS: "not-an-address",
      ENVIRONMENT: "preview",
    },
  ],
  [
    "a sender that is not an address",
    { EMAIL_PROVIDER: "fake", EMAIL_FROM_ADDRESS: "bookings at example" },
  ],
  ["an unknown provider", { EMAIL_PROVIDER: "carrier-pigeon" }],
];

async function post(
  options: { staff?: boolean; key?: string; settings?: Record<string, unknown> } = {},
) {
  const headers = new Headers({
    origin: "https://console.test",
    "content-type": "application/json",
    "idempotency-key": options.key ?? "unit-key-0001",
  });
  if (options.staff !== false) headers.set("x-test-staff", "1");
  const res = await app.request(
    `http://localhost${path}`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "confirmation", reason: "delivery_unknown" }),
    },
    bindings(options.settings ?? {}),
    createExecutionContext(),
  );
  const body = (await res.json()) as { error?: { code: string } } & Record<string, unknown>;
  return {
    status: res.status,
    code: body.error?.code ?? null,
    body,
    replayed: res.headers.get("idempotent-replayed"),
  };
}

beforeEach(() => {
  state.role = "owner";
  state.replay = null;
  state.bookingExists = true;
  state.log = [];
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("the resend route's order (G2.16b)", () => {
  it.each(offSettings)("asks for a session before saying email is off: %s", async (_name, s) => {
    const res = await post({ staff: false, settings: s });
    expect([res.status, res.code]).toEqual([401, "unauthenticated"]);
    expect(state.log).toEqual(["authenticate"]);
  });

  it.each(offSettings)(
    "hides the tenant from a non-member before email is off: %s",
    async (_n, s) => {
      state.role = null;
      const res = await post({ settings: s });
      expect([res.status, res.code]).toEqual([404, "tenant_not_found"]);
      expect(state.log).toEqual(["authenticate", "begin", "membership", "rollback"]);
    },
  );

  it.each(offSettings)("refuses finance before email is off: %s", async (_name, s) => {
    state.role = "finance";
    const res = await post({ settings: s });
    expect([res.status, res.code]).toEqual([403, "forbidden"]);
    expect(state.log).toEqual(["authenticate", "begin", "membership", "rollback"]);
  });

  it.each(offSettings)("answers an unknown booking before email is off: %s", async (_name, s) => {
    state.bookingExists = false;
    const res = await post({ settings: s });
    expect([res.status, res.code]).toEqual([404, "booking_not_found"]);
    expect(state.log).toEqual([
      "authenticate",
      "begin",
      "membership",
      "claim",
      "booking",
      "rollback",
    ]);
  });

  it.each(offSettings)(
    "answers booking_email_off, rolls the claim back, and never reaches the service: %s",
    async (_name, s) => {
      state.role = "booking_staff";
      const res = await post({ settings: s });
      expect([res.status, res.code]).toEqual([409, "booking_email_off"]);
      // The claim is inside the rolled-back transaction: no key is stored.
      expect(state.log).toEqual([
        "authenticate",
        "begin",
        "membership",
        "claim",
        "booking",
        "rollback",
      ]);
    },
  );

  it.each(offSettings)("replays a key that succeeded, with email off: %s", async (_name, s) => {
    const stored = {
      message: {
        id: "44444444-4444-4444-8444-444444444444",
        generation: 1,
        queuedAt: "2026-11-04T19:03:00.000Z",
      },
    };
    state.replay = { status: 201, body: stored };
    const res = await post({ settings: s });
    expect(res.status).toBe(201);
    expect(res.replayed).toBe("true");
    expect(res.body).toEqual(stored);
    expect(state.log).toEqual(["authenticate", "begin", "membership", "claim", "commit"]);
  });

  it("replays a stored refusal as the same 409, with email off", async () => {
    state.replay = {
      status: 201,
      body: {
        refusal: { code: "booking_email_too_soon", message: "Sent again under 10 minutes ago" },
      },
    };
    const res = await post({ settings: { EMAIL_PROVIDER: undefined } });
    expect([res.status, res.code, res.replayed]).toEqual([409, "booking_email_too_soon", "true"]);
    expect(state.log).not.toContain("resend");
  });

  it("with email on, reaches the service after the booking and stores the answer", async () => {
    const res = await post({ settings: { EMAIL_PROVIDER: "fake" } });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      message: {
        id: "44444444-4444-4444-8444-444444444444",
        generation: 1,
        queuedAt: "2026-11-04T19:03:00.000Z",
      },
    });
    expect(state.log).toEqual([
      "authenticate",
      "begin",
      "membership",
      "claim",
      "booking",
      "resend",
      "store",
      "commit",
    ]);
  });
});
