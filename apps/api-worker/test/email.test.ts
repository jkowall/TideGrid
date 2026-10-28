import { env } from "cloudflare:test";
import type { CloudflareEmailBuilder, SendEmailBinding } from "@tidegrid/domain-messaging";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AFTER_COMMIT_BUDGET_MS,
  afterCommitDeliveryOptions,
  CLOUDFLARE_SEND_TIMEOUT_MS,
  deliversAfterCommit,
  deliverySettings,
  emailProvider,
  emailSettings,
  fakeEmailProvider,
  parseAllowedRecipients,
} from "../src/email.ts";
import type { Bindings } from "../src/env.ts";

const base = env as unknown as Bindings;
const db = () => {
  throw new Error("no database in these tests");
};

/** An inline stand-in for the send_email binding; it records and never sends. */
function stub() {
  const sends: CloudflareEmailBuilder[] = [];
  const binding = {
    send: async (builder: CloudflareEmailBuilder) => {
      sends.push(builder);
      return { messageId: "<StubStubStubStubStubStubStubStubStub@tidegrid.test>" };
    },
  };
  return { binding: binding as unknown as SendEmail, sends };
}

const synthetic = "owner.inbox@example.test";

/** Cloudflare settings; an override of undefined removes that binding. */
function cloudflare(overrides: { [K in keyof Bindings]?: Bindings[K] | undefined } = {}): Bindings {
  const out: Record<string, unknown> = {
    ...base,
    ENVIRONMENT: "preview",
    EMAIL_PROVIDER: "cloudflare",
    EMAIL: stub().binding,
    EMAIL_ALLOWED_RECIPIENTS: synthetic,
    ...overrides,
  };
  for (const [key, value] of Object.entries(out)) if (value === undefined) delete out[key];
  return out as unknown as Bindings;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("email provider selection (G2.16a)", () => {
  it("is off unless a provider is named, and the test environment names none", () => {
    expect(base.EMAIL_PROVIDER).toBeUndefined();
    expect(base.EMAIL).toBeUndefined();
    expect(emailSettings({ ...base })).toEqual({ kind: "off", reason: "unset" });
    expect(emailProvider({ ...base }, db)).toBeNull();
  });

  it("accepts the fake only in local development and never beside an EMAIL binding", () => {
    const local = { ...base, ENVIRONMENT: "local" as const, EMAIL_PROVIDER: "fake" };
    expect(emailSettings(local)).toMatchObject({ kind: "fake" });
    expect(emailProvider(local, db)?.name).toBe("fake");
    for (const environment of ["preview", "staging", "production"] as const) {
      const deployed = { ...local, ENVIRONMENT: environment };
      expect(emailSettings(deployed)).toEqual({ kind: "refused", reason: "fake_outside_local" });
      expect(emailProvider(deployed, db)).toBeNull();
      expect(fakeEmailProvider(deployed, db)).toBeNull();
    }
    for (const environment of ["local", "preview", "production"] as const) {
      const beside = { ...local, ENVIRONMENT: environment, EMAIL: stub().binding };
      expect(emailSettings(beside)).toEqual({ kind: "refused", reason: "fake_with_binding" });
      expect(emailProvider(beside, db)).toBeNull();
    }
  });

  it("is off without the binding", () => {
    for (const environment of ["local", "preview", "production"] as const) {
      const settings = cloudflare({ ENVIRONMENT: environment, EMAIL: undefined });
      expect(emailSettings(settings)).toEqual({ kind: "off", reason: "binding_missing" });
      expect(emailProvider(settings, db)).toBeNull();
    }
  });

  it("is off outside production when the allowlist parses to nothing", () => {
    for (const environment of ["local", "preview", "staging"] as const) {
      for (const value of [undefined, "", " ", ",", " , ", ",,\t,"]) {
        const settings = cloudflare({ ENVIRONMENT: environment, EMAIL_ALLOWED_RECIPIENTS: value });
        expect(emailSettings(settings), `${environment} ${JSON.stringify(value)}`).toEqual({
          kind: "off",
          reason: "allowlist_missing",
        });
        expect(emailProvider(settings, db)).toBeNull();
      }
    }
  });

  it("refuses an allowlist entry that is not one address, in every environment", () => {
    for (const environment of ["local", "preview", "production"] as const) {
      for (const value of [
        "not-an-address",
        `${synthetic},a@b@example.test`,
        "two words@example.test",
        `${synthetic}; other@example.test`,
        "@example.test",
      ]) {
        const settings = cloudflare({ ENVIRONMENT: environment, EMAIL_ALLOWED_RECIPIENTS: value });
        expect(emailSettings(settings), value).toEqual({
          kind: "refused",
          reason: "allowlist_invalid",
        });
        expect(emailProvider(settings, db)).toBeNull();
      }
    }
  });

  it("normalizes mixed-case and padded entries", () => {
    expect(parseAllowedRecipients("  Owner.Inbox@Example.TEST , second@example.test,")).toEqual(
      new Set([synthetic, "second@example.test"]),
    );
    expect(
      emailSettings(cloudflare({ EMAIL_ALLOWED_RECIPIENTS: " OWNER.inbox@example.test " })),
    ).toMatchObject({
      kind: "cloudflare",
      recipients: { kind: "only", addresses: new Set([synthetic]) },
    });
  });

  it("builds the adapter with a binding and a valid allowlist, fenced to it", async () => {
    const { binding, sends } = stub();
    const settings = cloudflare({ EMAIL: binding });
    expect(emailSettings(settings)).toEqual({
      kind: "cloudflare",
      fromAddress: "bookings@tidegrid.us",
      guestLinkOrigin: "https://{slug}.book.tidegrid.us",
      recipients: { kind: "only", addresses: new Set([synthetic]) },
    });
    const provider = emailProvider(settings, db);
    expect(provider).toMatchObject({
      name: "cloudflare",
      deduplicates: false,
      sendTimeoutMs: CLOUDFLARE_SEND_TIMEOUT_MS,
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const email = {
      idempotencyKey: "0f6c1d2e-3a4b-4c5d-8e9f-a0b1c2d3e4f5",
      tenantId: "5a1f0c2e-7d3b-4e8a-9c61-2b4f8e0d7a13",
      from: { email: "bookings@tidegrid.us", name: "Harbor Synthetic" },
      replyTo: null,
      to: { email: "Owner.Inbox@example.test", name: null },
      subject: "Synthetic",
      html: "<p>Synthetic</p>",
      text: "Synthetic",
    };
    await expect(provider?.send(email)).resolves.toEqual({
      providerMessageId: "<StubStubStubStubStubStubStubStubStub@tidegrid.test>",
    });
    await expect(
      provider?.send({ ...email, to: { email: "someone@example.test", name: null } }),
    ).rejects.toMatchObject({ code: "recipient_not_allowed" });
    expect(sends).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends to anyone in production only when no allowlist is set", () => {
    const open = cloudflare({ ENVIRONMENT: "production", EMAIL_ALLOWED_RECIPIENTS: undefined });
    expect(emailSettings(open)).toMatchObject({ kind: "cloudflare", recipients: { kind: "any" } });
    expect(emailProvider(open, db)?.name).toBe("cloudflare");
    const fenced = cloudflare({ ENVIRONMENT: "production" });
    expect(emailSettings(fenced)).toMatchObject({ recipients: { kind: "only" } });
  });

  it("refuses an unknown provider name", () => {
    for (const name of ["stripe", "Cloudflare", "FAKE", "resend"]) {
      expect(emailSettings({ ...base, EMAIL_PROVIDER: name })).toEqual({
        kind: "refused",
        reason: "unknown_provider",
      });
    }
  });

  it("keeps the mailbox to the fake", () => {
    expect(fakeEmailProvider(cloudflare(), db)).toBeNull();
    expect(fakeEmailProvider(cloudflare({ ENVIRONMENT: "local" }), db)).toBeNull();
  });
});

describe("after-commit delivery (G2.16a)", () => {
  it("runs for the fake and for Cloudflare, and not when email is off", () => {
    expect(deliversAfterCommit(cloudflare(), {})).toBe(true);
    expect(deliversAfterCommit({ ...base, ENVIRONMENT: "local", EMAIL_PROVIDER: "fake" }, {})).toBe(
      true,
    );
    expect(deliversAfterCommit({ ...base }, {})).toBe(false);
    expect(deliversAfterCommit(cloudflare({ EMAIL_ALLOWED_RECIPIENTS: "" }), {})).toBe(false);
    expect(deliversAfterCommit(cloudflare(), { deliverEmailAfterCommit: false })).toBe(false);
  });

  it("passes a deadline inside the waitUntil budget", () => {
    const settings = cloudflare();
    const provider = emailProvider(settings, db);
    if (!provider) throw new Error("no provider");
    const options = afterCommitDeliveryOptions(settings, provider, "req-1", 1_000_000, undefined);
    expect(options).toMatchObject({
      provider,
      limit: 10,
      deadline: 1_000_000 + AFTER_COMMIT_BUDGET_MS,
      fromAddress: "bookings@tidegrid.us",
      environment: "preview",
    });
    // The last claim leaves room for one send and the margin before 30 s.
    expect(AFTER_COMMIT_BUDGET_MS).toBeLessThanOrEqual(30_000 - 2_000 - CLOUDFLARE_SEND_TIMEOUT_MS);
    expect(deliverySettings(settings)).toEqual({
      fromAddress: "bookings@tidegrid.us",
      guestLinkOrigin: "https://{slug}.book.tidegrid.us",
      environment: "preview",
    });
  });
});

/**
 * Type-only: the generated `SendEmail` fits the adapter's binding type, and a
 * builder the binding could not take would not. Never called.
 */
export function bindingTypes(binding: SendEmail): void {
  const fits: SendEmailBinding = binding;
  type Drifted = Omit<CloudflareEmailBuilder, "from"> & {
    from: { email: string; name: string | null };
  };
  // @ts-expect-error a nullable sender name is not an EmailAddress
  const drifted: { send: (b: Drifted) => Promise<{ messageId: string }> } = binding;
  void fits;
  void drifted;
}
