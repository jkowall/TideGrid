/**
 * Booking email over the Cloudflare email adapter: the review notes of
 * 2026-10-28 on G2.16a, each written to fail first on the earlier code.
 *
 * - Independent F2: a throw before the provider is ever called is a known
 *   "not sent", so it retries as `send_error` even on a provider that does
 *   not deduplicate. The only step before the send is filling the link into
 *   the bodies; this file makes it throw once, through a partial mock of the
 *   messaging package's render module.
 * - Security S2: a provider that does not say it deduplicates is treated as
 *   one that does not, so a new provider fails safe.
 * - Fidelity F2: Cloudflare rate-limits per account, domain, and recipient
 *   with one code, so a rate limit retries its message and does not stop the
 *   tenant's run as an account-level fault.
 */
import { createDb } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import { tripAllocator } from "@tidegrid/domain-inventory/testing";
import {
  type CloudflareEmailBuilder,
  createCloudflareEmailProvider,
  type EmailProvider,
  EmailProviderUnavailableError,
  FakeEmailProvider,
  type SendEmailBinding,
} from "@tidegrid/domain-messaging";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { type CheckoutFixture, createCheckoutFixture, fakeProvider } from "../test-fixtures.ts";
import {
  addLocalHostname,
  book,
  deliverMail,
  makeDue,
  messagesOf,
  type SelfServiceWorld,
} from "./self-service-harness.ts";

const state = vi.hoisted(() => ({ failFill: false }));

vi.mock("../../../domain-messaging/src/render.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../domain-messaging/src/render.ts")>();
  return {
    ...original,
    fillLinkSlot: (...args: Parameters<typeof original.fillLinkSlot>) => {
      if (state.failFill) {
        state.failFill = false;
        throw new TypeError("a failure before any send");
      }
      return original.fillLinkSlot(...args);
    },
  };
});

const env = inject("integrationDb");

interface Recorder {
  binding: SendEmailBinding;
  sends: CloudflareEmailBuilder[];
  failNext(code: string): void;
}

function recorder(): Recorder {
  const sends: CloudflareEmailBuilder[] = [];
  const faults: string[] = [];
  let n = 0;
  return {
    sends,
    failNext: (code) => faults.push(code),
    binding: {
      send: async (builder) => {
        sends.push(structuredClone(builder));
        const code = faults.shift();
        if (code)
          throw Object.assign(new Error(`${code} for ${JSON.stringify(builder.to)}`), { code });
        n += 1;
        return { messageId: `0101018f7d0c4d9a-msg-${String(n).padStart(8, "0")}` };
      },
    },
  };
}

describe.skipIf(!env)("booking email over the Cloudflare adapter: review notes (G2.16a)", () => {
  let world: SelfServiceWorld;
  let runtime: ReturnType<typeof createDb>;
  let trips: ReturnType<typeof tripAllocator>;
  let count = 0;
  const bookers: string[] = [];

  function booker() {
    count += 1;
    const email = `cf.review.${count}.${Date.now().toString(36)}@example.test`;
    bookers.push(email);
    return { name: `Synthetic CF Review ${count}`, email };
  }

  /** The adapter, fenced to every booker so far: build it after booking. */
  function cloudflare(rec: Recorder): EmailProvider {
    return createCloudflareEmailProvider({
      binding: rec.binding,
      recipients: { kind: "only", addresses: new Set(bookers) },
      environment: "local",
    });
  }

  const callsFor = (rec: Recorder, messageId: string) =>
    rec.sends.filter((b) => b.headers["X-TideGrid-Message-Id"] === messageId).length;

  /** A tenant of its own per case, so no other case's mail is due. */
  async function tenant(label: string): Promise<CheckoutFixture> {
    const t = await createCheckoutFixture(world.admin, runtime.db, label, { days: 30 });
    await addLocalHostname(world.admin, t);
    trips = tripAllocator(t);
    return t;
  }

  beforeAll(async () => {
    if (!env) return;
    const admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 6 });
    world = {
      admin,
      db: runtime.db,
      payments: fakeProvider(runtime.db),
      mail: new FakeEmailProvider({ db: runtime.db, environment: "local" }),
    };
  });

  afterAll(async () => {
    await runtime?.end();
    await world?.admin.end({ timeout: 5 });
  });

  it("retries a throw before any send as send_error, though the provider does not deduplicate (F2)", async () => {
    const T = await tenant("cf-rev-presend");
    const b = await book(world, T, trips.shared(), 1, { booker: booker() });
    const rec = recorder();
    const errors: string[] = [];
    state.failFill = true;
    await deliverMail(world, T.id, cloudflare(rec), {
      onSendError: (messageId) => errors.push(messageId),
    });
    const [confirmation] = await messagesOf(world.admin, b.bookingId);
    if (!confirmation) throw new Error("setup: no confirmation");
    expect(errors).toEqual([confirmation.id]);
    expect(confirmation).toMatchObject({
      state: "queued",
      attempts: 1,
      last_error_code: "send_error",
    });
    expect(rec.sends).toHaveLength(0);
    await makeDue(world.admin, confirmation.id);
    await deliverMail(world, T.id, cloudflare(rec));
    const [after] = await messagesOf(world.admin, b.bookingId);
    expect(after).toMatchObject({ state: "sent", attempts: 2 });
    expect(callsFor(rec, confirmation.id)).toBe(1);
  });

  it("treats a provider that does not say it deduplicates as one that does not (S2)", async () => {
    const T = await tenant("cf-rev-unset");
    const b = await book(world, T, trips.shared(), 1, { booker: booker() });
    let calls = 0;
    const silent: EmailProvider = {
      name: "cloudflare",
      send: async () => {
        calls += 1;
        throw new EmailProviderUnavailableError();
      },
    };
    await deliverMail(world, T.id, silent);
    const [confirmation] = await messagesOf(world.admin, b.bookingId);
    expect(confirmation).toMatchObject({ state: "failed", last_error_code: "outcome_unknown" });
    await deliverMail(world, T.id, silent);
    expect(calls).toBe(1);
  });

  it("retries a rate-limited message and goes on with the run (fidelity F2)", async () => {
    const T = await tenant("cf-rev-rate");
    const first = await book(world, T, trips.shared(), 1, { booker: booker() });
    const second = await book(world, T, trips.shared(), 1, { booker: booker() });
    const rec = recorder();
    rec.failNext("E_RATE_LIMIT_EXCEEDED");
    const report = await deliverMail(world, T.id, cloudflare(rec));
    expect(report.stopped).toBeNull();
    expect(report.claimed).toBe(2);
    const states = [
      ...(await messagesOf(world.admin, first.bookingId)),
      ...(await messagesOf(world.admin, second.bookingId)),
    ].map((m) => [m.state, m.last_error_code]);
    expect(states).toContainEqual(["queued", "provider_rate_limited"]);
    expect(states).toContainEqual(["sent", null]);
    expect(rec.sends).toHaveLength(2);
  });
});
