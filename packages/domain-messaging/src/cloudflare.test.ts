import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EmailProviderRejectedError,
  EmailProviderUnavailableError,
  type OutgoingEmail,
  providerMessageIdPattern,
} from "./adapter.ts";
import {
  type CloudflareEmailBuilder,
  CloudflareEmailProvider,
  createCloudflareEmailProvider,
  type EmailProviderLog,
  normalizeCloudflareMessageId,
  type RecipientPolicy,
  type SendEmailBinding,
} from "./cloudflare.ts";
import {
  CLOUDFLARE_ERROR_CODES,
  type CloudflareEmailFixture,
  createCloudflareEmailFixture,
} from "./cloudflare-fixture.ts";
import {
  contractAddresses,
  describeEmailProviderContract,
  errorTexts,
} from "./provider.contract.ts";

const TENANT = "5a1f0c2e-7d3b-4e8a-9c61-2b4f8e0d7a13";
const GUEST = "Reef.Guest@Example.TEST";
const GUEST_NAME = "Marisol Synthetic-Guest";
const SUBJECT = "Your booking at Harbor Synthetic";
const FROM = "bookings@tidegrid.test";

const only = (...addresses: string[]): RecipientPolicy => ({
  kind: "only",
  addresses: new Set(addresses),
});

function outgoing(overrides: Partial<OutgoingEmail> = {}): OutgoingEmail {
  return {
    idempotencyKey: "0f6c1d2e-3a4b-4c5d-8e9f-a0b1c2d3e4f5",
    tenantId: TENANT,
    from: { email: FROM, name: "Harbor Synthetic" },
    replyTo: "hello@harbor-synthetic.test",
    to: { email: "reef.guest@example.test", name: GUEST_NAME },
    subject: SUBJECT,
    html: "<p>Hello</p>",
    text: "Hello",
    ...overrides,
  };
}

interface Harness {
  fixture: CloudflareEmailFixture;
  provider: CloudflareEmailProvider;
  logs: { event: string; attributes: Record<string, string | number | boolean> }[];
  calls: () => number;
}

function harness(
  options: { recipients?: RecipientPolicy; timeoutMs?: number; environment?: string } = {},
): Harness {
  const fixture = createCloudflareEmailFixture({
    allowedSenderAddresses: [FROM],
    tenantId: TENANT,
  });
  const logs: Harness["logs"] = [];
  const log: EmailProviderLog = (event, attributes) => logs.push({ event, attributes });
  const provider = createCloudflareEmailProvider({
    binding: fixture.binding,
    recipients: options.recipients ?? only("reef.guest@example.test"),
    environment: options.environment ?? "local",
    timeoutMs: options.timeoutMs ?? 50,
    log,
  });
  return { fixture, provider, logs, calls: () => fixture.sends.length };
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

const PERSONAL = [
  GUEST,
  "reef.guest@example.test",
  GUEST_NAME,
  SUBJECT,
  TENANT,
  "Harbor Synthetic",
];

function expectNoPersonalData(error: unknown, logs: Harness["logs"]): void {
  const texts = [...errorTexts(error), JSON.stringify(logs)];
  for (const text of texts) {
    for (const secret of PERSONAL) expect(text.toLowerCase()).not.toContain(secret.toLowerCase());
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// No path of the adapter may reach the network.
let fetchSpy: ReturnType<typeof vi.fn>;
let consoleSpies: ReturnType<typeof vi.spyOn>[];
beforeEach(() => {
  fetchSpy = vi.fn(() => Promise.reject(new Error("fetch is not allowed in these tests")));
  vi.stubGlobal("fetch", fetchSpy);
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
    vi.spyOn(console, m),
  );
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  for (const spy of consoleSpies) {
    for (const call of spy.mock.calls) {
      const text = call.map((a: unknown) => String(a)).join(" ");
      for (const secret of PERSONAL) expect(text.toLowerCase()).not.toContain(secret.toLowerCase());
    }
    spy.mockRestore();
  }
  vi.unstubAllGlobals();
});

describeEmailProviderContract("cloudflare over the recorded fixture", () => {
  const run = crypto.randomUUID().slice(0, 8);
  const addresses = contractAddresses(run);
  const fixture = createCloudflareEmailFixture({ tenantId: TENANT });
  const provider = createCloudflareEmailProvider({
    binding: fixture.binding,
    recipients: only(addresses.ok, addresses.bounce, addresses.failOnce),
    environment: "local",
  });
  return { provider, tenantId: TENANT, run };
});

describe("the Cloudflare email adapter: mapping", () => {
  it("declares itself not deduplicating, with its send bound", () => {
    const { provider } = harness({ timeoutMs: 1234 });
    expect(provider.name).toBe("cloudflare");
    expect(provider.deduplicates).toBe(false);
    expect(provider.sendTimeoutMs).toBe(1234);
  });

  it("maps the port onto the builder exactly, with only the two TideGrid headers", async () => {
    const { provider, fixture } = harness();
    const sent = await provider.send(outgoing());
    expect(sent.providerMessageId).toMatch(providerMessageIdPattern);
    expect(fixture.sends).toHaveLength(1);
    const expected: CloudflareEmailBuilder = {
      from: { email: FROM, name: "Harbor Synthetic" },
      to: { email: "reef.guest@example.test", name: GUEST_NAME },
      subject: SUBJECT,
      html: "<p>Hello</p>",
      text: "Hello",
      replyTo: "hello@harbor-synthetic.test",
      headers: {
        "X-TideGrid-Message-Id": "0f6c1d2e-3a4b-4c5d-8e9f-a0b1c2d3e4f5",
        "Auto-Submitted": "auto-generated",
      },
    };
    expect(fixture.sends[0]?.builder).toStrictEqual(expected);
    // The tenant id is metadata only: it is in no field of the builder.
    expect(JSON.stringify(fixture.sends[0]?.builder)).not.toContain(TENANT);
  });

  it("sends a nameless recipient as a bare address and leaves out a null reply-to", async () => {
    const { provider, fixture } = harness();
    await provider.send(
      outgoing({ to: { email: "reef.guest@example.test", name: null }, replyTo: null }),
    );
    const builder = fixture.sends[0]?.builder;
    expect(builder?.to).toBe("reef.guest@example.test");
    expect(builder && "replyTo" in builder).toBe(false);
  });

  it("refuses a key that is not header-safe, with no provider call", async () => {
    const { provider, calls } = harness();
    for (const key of ["", "a\r\nBcc: someone@example.test", "x".repeat(201), "a b"]) {
      const error = await caught(provider.send(outgoing({ idempotencyKey: key })));
      expect(error).toBeInstanceOf(EmailProviderRejectedError);
      expect((error as EmailProviderRejectedError).code).toBe("invalid_message");
    }
    expect(calls()).toBe(0);
  });
});

/** The policy table, pinned row by row, independent of the adapter's own table. */
const TABLE: [string, "rejected" | "unavailable", string, "not_sent" | "unknown" | null, string][] =
  [
    ["E_VALIDATION_ERROR", "rejected", "invalid_message", null, "message"],
    ["E_FIELD_MISSING", "rejected", "invalid_message", null, "message"],
    ["E_TOO_MANY_RECIPIENTS", "rejected", "invalid_message", null, "message"],
    ["E_TOO_MANY_ATTACHMENTS", "rejected", "invalid_message", null, "message"],
    ["E_CONTENT_TOO_LARGE", "rejected", "invalid_message", null, "message"],
    ["E_HEADER_NOT_ALLOWED", "rejected", "invalid_message", null, "message"],
    ["E_HEADER_USE_API_FIELD", "rejected", "invalid_message", null, "message"],
    ["E_HEADER_VALUE_INVALID", "rejected", "invalid_message", null, "message"],
    ["E_HEADER_VALUE_TOO_LONG", "rejected", "invalid_message", null, "message"],
    ["E_HEADER_NAME_INVALID", "rejected", "invalid_message", null, "message"],
    ["E_HEADERS_TOO_LARGE", "rejected", "invalid_message", null, "message"],
    ["E_HEADERS_TOO_MANY", "rejected", "invalid_message", null, "message"],
    ["E_RECIPIENT_SUPPRESSED", "rejected", "recipient_suppressed", null, "message"],
    ["E_RECIPIENT_NOT_ALLOWED", "rejected", "recipient_not_allowed", null, "message"],
    // Cloudflare rate-limits per account, domain, and recipient with one code, so it is a
    // message-scope retry, not an account fault (review note fidelity F2).
    ["E_RATE_LIMIT_EXCEEDED", "unavailable", "provider_rate_limited", "not_sent", "message"],
    ["E_DAILY_LIMIT_EXCEEDED", "unavailable", "provider_quota_exceeded", "not_sent", "account"],
    ["E_SENDER_NOT_VERIFIED", "unavailable", "sender_not_verified", "not_sent", "account"],
    ["E_SENDER_DOMAIN_NOT_AVAILABLE", "unavailable", "sender_not_verified", "not_sent", "account"],
    ["E_ACCOUNT_SUSPENDED", "unavailable", "provider_account_suspended", "not_sent", "account"],
    ["E_DELIVERY_FAILED", "unavailable", "provider_unavailable", "unknown", "message"],
    ["E_INTERNAL_SERVER_ERROR", "unavailable", "provider_unavailable", "unknown", "message"],
  ];

describe("the Cloudflare email adapter: errors", () => {
  it("pins every one of the 21 documented codes", () => {
    expect(TABLE.map((r) => r[0]).sort()).toEqual([...CLOUDFLARE_ERROR_CODES].sort());
    expect(TABLE).toHaveLength(21);
  });

  for (const [cfCode, kind, code, outcome, scope] of TABLE) {
    it(`maps ${cfCode} to ${kind} ${code}, with no personal data`, async () => {
      const h = harness();
      h.fixture.failNext(cfCode);
      const error = await caught(h.provider.send(outgoing()));
      if (kind === "rejected") {
        expect(error).toBeInstanceOf(EmailProviderRejectedError);
        expect((error as EmailProviderRejectedError).code).toBe(code);
      } else {
        expect(error).toBeInstanceOf(EmailProviderUnavailableError);
        expect(error).toMatchObject({ code, outcome, scope });
      }
      expect((error as Error).cause).toBeUndefined();
      expectNoPersonalData(error, h.logs);
      expect(h.logs).toContainEqual({
        event: "email_provider_error",
        attributes: {
          "event.name": "email_provider_error",
          "error.type": cfCode,
          "tidegrid.email.message_id": "0f6c1d2e-3a4b-4c5d-8e9f-a0b1c2d3e4f5",
        },
      });
    });
  }

  const ambiguous: [string, unknown][] = [
    ["an unknown code", Object.assign(new Error(`E_NEW_THING for ${GUEST}`), { code: "E_NEW" })],
    ["an Error with no code", new Error(`connection reset sending to ${GUEST} about ${SUBJECT}`)],
    ["a prefix-only code", Object.assign(new Error(GUEST), { code: "E_HEADER_SOMETHING" })],
    ["a string", `failed for ${GUEST} ${GUEST_NAME} ${TENANT}`],
    ["null", null],
    ["an object with a numeric code", { code: 500, message: GUEST }],
    [
      "an object whose code getter throws",
      Object.defineProperty({}, "code", {
        get() {
          throw new Error(GUEST);
        },
      }),
    ],
  ];
  for (const [label, value] of ambiguous) {
    it(`treats ${label} as an unknown outcome`, async () => {
      const h = harness();
      h.fixture.throwNext(value);
      const error = await caught(h.provider.send(outgoing()));
      expect(error).toBeInstanceOf(EmailProviderUnavailableError);
      expect(error).toMatchObject({
        code: "provider_unavailable",
        outcome: "unknown",
        scope: "message",
      });
      expectNoPersonalData(error, h.logs);
      expect(h.logs.at(-1)?.attributes["error.type"]).toBe("unknown");
    });
  }

  it("treats a synchronous throw from the binding as an unknown outcome", async () => {
    const binding: SendEmailBinding = {
      send: () => {
        throw Object.assign(new Error(`sync ${GUEST}`), { code: "E_INTERNAL_SERVER_ERROR" });
      },
    };
    const provider = createCloudflareEmailProvider({
      binding,
      recipients: only("reef.guest@example.test"),
      environment: "local",
    });
    const error = await caught(provider.send(outgoing()));
    expect(error).toMatchObject({ code: "provider_unavailable", outcome: "unknown" });
    expectNoPersonalData(error, []);
  });

  it("times out a send that never answers, as an unknown outcome", async () => {
    const h = harness({ timeoutMs: 20 });
    h.fixture.hangNext();
    const started = Date.now();
    const error = await caught(h.provider.send(outgoing()));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(error).toBeInstanceOf(EmailProviderUnavailableError);
    expect(error).toMatchObject({ code: "provider_unavailable", outcome: "unknown" });
    expect(h.logs.map((l) => l.event)).toEqual(["email_send_timeout"]);
    expectNoPersonalData(error, h.logs);
  });

  it("swallows a rejection that arrives after the timeout, logging its code only", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const h = harness({ timeoutMs: 15 });
      h.fixture.rejectLate("E_DELIVERY_FAILED", 40);
      const error = await caught(h.provider.send(outgoing()));
      expect(error).toMatchObject({ code: "provider_unavailable", outcome: "unknown" });
      await sleep(80);
      expect(unhandled).toEqual([]);
      expect(h.logs.at(-1)).toEqual({
        event: "email_send_late_reject",
        attributes: { "event.name": "email_send_late_reject", "error.type": "E_DELIVERY_FAILED" },
      });
      expectNoPersonalData(error, h.logs);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("logs an acceptance that arrives after the timeout with the normalized provider id, the join key", async () => {
    for (const late of ["0101018f7d0c4d9a-msg-latelate", "{an odd late id}"]) {
      const h = harness({ timeoutMs: 15 });
      h.fixture.answerId(late);
      h.fixture.acceptLate(40);
      const error = await caught(h.provider.send(outgoing()));
      expect(error).toMatchObject({ outcome: "unknown" });
      await sleep(80);
      const entry = h.logs.find((l) => l.event === "email_send_late_accept");
      expect(entry?.attributes).toEqual({
        "event.name": "email_send_late_accept",
        "tidegrid.email.message_id": "0f6c1d2e-3a4b-4c5d-8e9f-a0b1c2d3e4f5",
        "tidegrid.email.provider_message_id": (await normalizeCloudflareMessageId(late)).id,
      });
      expectNoPersonalData(error, h.logs);
    }
  });
});

describe("the Cloudflare email adapter: control characters", () => {
  const bad = ["\r", "\n", "\r\n", "\u0000", "\t", "\u007f", "\u0085"];
  it("refuses a control character in a display name or the subject, with no provider call", async () => {
    for (const c of bad) {
      for (const email of [
        outgoing({ to: { email: "reef.guest@example.test", name: `Evil${c}Bcc: x@example.test` } }),
        outgoing({ from: { email: FROM, name: `Harbor${c}X-Inj: 1` } }),
        outgoing({ subject: `Hello${c}X-Inj: 1` }),
      ]) {
        const h = harness();
        const error = await caught(h.provider.send(email));
        expect(error).toBeInstanceOf(EmailProviderRejectedError);
        expect((error as EmailProviderRejectedError).code).toBe("invalid_message");
        expect(h.calls()).toBe(0);
      }
    }
  });

  it("refuses a sender, recipient, or reply-to that is not one address, with no provider call", async () => {
    for (const email of [
      outgoing({ replyTo: "hello@harbor.test\r\nBcc: x@example.test" }),
      outgoing({ replyTo: "two@at@example.test" }),
      outgoing({ replyTo: "not an address" }),
      outgoing({ from: { email: "bookings@tidegrid.test\nBcc: x@y.test", name: "Harbor" } }),
    ]) {
      const h = harness();
      const error = await caught(h.provider.send(email));
      expect((error as EmailProviderRejectedError).code).toBe("invalid_message");
      expect(h.calls()).toBe(0);
    }
    const open = harness({ recipients: { kind: "any" }, environment: "production" });
    const error = await caught(
      open.provider.send(outgoing({ to: { email: "a\r\n@example.test", name: null } })),
    );
    expect((error as EmailProviderRejectedError).code).toBe("invalid_message");
    expect(open.calls()).toBe(0);
  });

  it("still sends ordinary punctuation and non-ASCII names", async () => {
    const h = harness();
    await h.provider.send(
      outgoing({
        to: { email: "reef.guest@example.test", name: "Zoë O'Brien-Núñez, Jr." },
        subject: "Your booking: Sat 9:00 (2 guests), confirmed & paid",
      }),
    );
    expect(h.calls()).toBe(1);
  });
});

describe("the Cloudflare email adapter: provider ids", () => {
  it("keeps an id that fits the message table", async () => {
    const h = harness();
    h.fixture.answerId("0101018f7d0c4d9a-msg-deadbeef");
    const sent = await h.provider.send(outgoing());
    expect(sent.providerMessageId).toBe("0101018f7d0c4d9a-msg-deadbeef");
    expect(h.logs).toEqual([]);
  });

  it("normalizes a long id, or one with spaces or braces, deterministically", async () => {
    for (const odd of ["x".repeat(300), "id with spaces", "{braced-id}", "ab"]) {
      const h = harness();
      h.fixture.answerId(odd);
      const sent = await h.provider.send(outgoing());
      expect(sent.providerMessageId).toMatch(/^cfh_[0-9a-f]{40}$/);
      expect(sent.providerMessageId).toMatch(providerMessageIdPattern);
      expect(sent.providerMessageId).toBe((await normalizeCloudflareMessageId(odd)).id);
      expect(h.logs.map((l) => l.event)).toEqual(["email_provider_id_normalized"]);
      expect(JSON.stringify(h.logs)).not.toContain(odd);
    }
    expect(await normalizeCloudflareMessageId("id with spaces")).toEqual(
      await normalizeCloudflareMessageId("id with spaces"),
    );
  });

  it("never throws after an acceptance, even with no id", async () => {
    for (const result of [{}, { messageId: "" }, { messageId: 42 }, null]) {
      const binding = { send: async () => result } as unknown as SendEmailBinding;
      const provider = createCloudflareEmailProvider({
        binding,
        recipients: only("reef.guest@example.test"),
        environment: "local",
      });
      const sent = await provider.send(outgoing());
      expect(sent.providerMessageId).toBe("cf_no_id.0f6c1d2e-3a4b-4c5d-8e9f-a0b1c2d3e4f5");
      expect(sent.providerMessageId).toMatch(providerMessageIdPattern);
    }
  });
});

describe("the Cloudflare email adapter: the recipient fence", () => {
  it("refuses a recipient off the allowlist with no provider call", async () => {
    const h = harness({ recipients: only("someone.else@example.test") });
    const error = await caught(h.provider.send(outgoing()));
    expect(error).toBeInstanceOf(EmailProviderRejectedError);
    expect((error as EmailProviderRejectedError).code).toBe("recipient_not_allowed");
    expect(h.calls()).toBe(0);
    expectNoPersonalData(error, h.logs);
  });

  it("compares lowercased and trimmed, on both sides", async () => {
    const h = harness({ recipients: only("  REEF.Guest@example.test ") });
    await h.provider.send(outgoing({ to: { email: `  ${GUEST}\t`, name: null } }));
    expect(h.fixture.sends[0]?.builder.to).toBe("reef.guest@example.test");
    const other = await caught(
      h.provider.send(outgoing({ to: { email: "reef.guest@example.test.evil", name: null } })),
    );
    expect((other as EmailProviderRejectedError).code).toBe("recipient_not_allowed");
    expect(h.calls()).toBe(1);
  });

  it("refuses an empty allowlist's every recipient", async () => {
    const h = harness({ recipients: only() });
    const error = await caught(h.provider.send(outgoing()));
    expect((error as EmailProviderRejectedError).code).toBe("recipient_not_allowed");
    expect(h.calls()).toBe(0);
  });

  it("sends to anyone only in production", async () => {
    const h = harness({ recipients: { kind: "any" }, environment: "production" });
    await h.provider.send(outgoing({ to: { email: "anyone@example.test", name: null } }));
    expect(h.calls()).toBe(1);
  });
});

describe("the Cloudflare email adapter: construction", () => {
  const fixture = createCloudflareEmailFixture();
  const base = {
    binding: fixture.binding,
    recipients: only("a@example.test"),
    environment: "local",
  };

  it("refuses a missing binding", () => {
    expect(() => createCloudflareEmailProvider({ ...base, binding: undefined })).toThrow(TypeError);
    expect(() =>
      createCloudflareEmailProvider({
        ...base,
        binding: {} as unknown as SendEmailBinding,
      }),
    ).toThrow(TypeError);
  });

  it("refuses unrestricted recipients outside production", () => {
    for (const environment of ["local", "preview", "staging", "", "Production"]) {
      expect(() =>
        createCloudflareEmailProvider({ ...base, recipients: { kind: "any" }, environment }),
      ).toThrow(TypeError);
    }
    expect(
      createCloudflareEmailProvider({
        ...base,
        recipients: { kind: "any" },
        environment: "production",
      }),
    ).toBeInstanceOf(CloudflareEmailProvider);
  });

  it("refuses a missing policy and an entry that is not one address", () => {
    expect(() =>
      createCloudflareEmailProvider({
        ...base,
        recipients: undefined as unknown as RecipientPolicy,
      }),
    ).toThrow(TypeError);
    for (const bad of ["no-at-sign", "a@b@example.test", "a b@example.test", "@example.test"]) {
      expect(() => createCloudflareEmailProvider({ ...base, recipients: only(bad) })).toThrow(
        TypeError,
      );
    }
  });

  it("refuses a timeout outside 1 to 60000 ms", () => {
    for (const timeoutMs of [0, -1, 1.5, 60_001, Number.NaN]) {
      expect(() => createCloudflareEmailProvider({ ...base, timeoutMs })).toThrow(RangeError);
    }
  });
});

describe("the recorded fixture", () => {
  const builder = (overrides: Partial<CloudflareEmailBuilder> = {}): CloudflareEmailBuilder => ({
    from: { email: FROM, name: "Harbor" },
    to: "reef.guest@example.test",
    subject: "Hi",
    html: "<p>Hi</p>",
    text: "Hi",
    headers: {},
    ...overrides,
  });
  async function codeOf(b: CloudflareEmailBuilder, allowed: string[] = [FROM]) {
    const fixture = createCloudflareEmailFixture({ allowedSenderAddresses: allowed });
    try {
      await fixture.binding.send(b);
      return null;
    } catch (error) {
      return (error as { code?: string }).code ?? "none";
    }
  }

  it("enforces the header rules", async () => {
    expect(await codeOf(builder({ headers: { "X-Anything_1": "v" } }))).toBeNull();
    expect(await codeOf(builder({ headers: { "Auto-Submitted": "auto-generated" } }))).toBeNull();
    for (const name of ["Subject", "From", "To", "Reply-To", "bcc"]) {
      expect(await codeOf(builder({ headers: { [name]: "v" } }))).toBe("E_HEADER_USE_API_FIELD");
    }
    expect(await codeOf(builder({ headers: { "Message-ID": "<x@y>" } }))).toBe(
      "E_HEADER_NOT_ALLOWED",
    );
    expect(await codeOf(builder({ headers: { "ARC-Seal": "v" } }))).toBe("E_HEADER_NOT_ALLOWED");
    expect(await codeOf(builder({ headers: { "List-Unknown": "v" } }))).toBe(
      "E_HEADER_NOT_ALLOWED",
    );
    expect(await codeOf(builder({ headers: { "X-Bad Name": "v" } }))).toBe("E_HEADER_NAME_INVALID");
    expect(await codeOf(builder({ headers: { "X-A": "line\r\nbreak" } }))).toBe(
      "E_HEADER_VALUE_INVALID",
    );
    expect(await codeOf(builder({ headers: { "X-A": "v".repeat(2049) } }))).toBe(
      "E_HEADER_VALUE_TOO_LONG",
    );
    const many: Record<string, string> = {};
    for (let i = 0; i < 9; i++) many[`X-Big-${i}`] = "v".repeat(2000);
    expect(await codeOf(builder({ headers: many }))).toBe("E_HEADERS_TOO_LARGE");
  });

  it("enforces the sender, subject, and size limits", async () => {
    expect(await codeOf(builder(), ["other@tidegrid.test"])).toBe("E_SENDER_NOT_VERIFIED");
    expect(await codeOf(builder({ subject: "s".repeat(999) }))).toBe("E_VALIDATION_ERROR");
    expect(await codeOf(builder({ subject: "s".repeat(998) }))).toBeNull();
    expect(await codeOf(builder({ html: "h".repeat(5 * 1024 * 1024) }))).toBe(
      "E_CONTENT_TOO_LARGE",
    );
    const fifty = Array.from({ length: 51 }, (_, i) => `g${i}@example.test`);
    expect(await codeOf(builder({ to: fifty as unknown as string }))).toBe("E_TOO_MANY_RECIPIENTS");
  });

  it("answers the documented result shape, and every scripted code with an Error", async () => {
    const fixture = createCloudflareEmailFixture({ tenantId: TENANT });
    const result = await fixture.binding.send(builder());
    expect(Object.keys(result)).toEqual(["messageId"]);
    // The shape of the event-subscriptions examples; what send() returns is unverified.
    expect(result.messageId).toMatch(/^[0-9a-f]{16}-msg-[0-9a-f]{16}$/);
    for (const code of CLOUDFLARE_ERROR_CODES) {
      fixture.failNext(code);
      const error = await caught(fixture.binding.send(builder()));
      expect(error).toBeInstanceOf(Error);
      expect((error as { code?: string }).code).toBe(code);
      // A careless provider's message: the fixture puts personal data in it.
      expect((error as Error).message).toContain("reef.guest@example.test");
      expect((error as Error).message).toContain(TENANT);
    }
  });

  it("maps +bounce and +fail-once like the fake", async () => {
    expect(await codeOf(builder({ to: "x+bounce@example.test" }))).toBe("E_RECIPIENT_SUPPRESSED");
    const fixture = createCloudflareEmailFixture();
    const flaky = builder({ to: "x+fail-once@example.test" });
    expect(await caught(fixture.binding.send(flaky))).toMatchObject({
      code: "E_RATE_LIMIT_EXCEEDED",
    });
    expect((await fixture.binding.send(flaky)).messageId).toMatch(/-msg-/);
  });
});
