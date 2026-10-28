/**
 * The email provider contract (G2.16a). One suite drives the fake (over the
 * database, in its integration suite) and the Cloudflare adapter (over its
 * recorded fixture, in unit tests), so the demo's fake cannot drift from what
 * the real adapter does. Both honor the same scripted addresses: a local part
 * ending in `+bounce` is refused, one ending in `+fail-once` is unavailable
 * once and then accepted.
 *
 * Whether a repeat with the same key sends again is provider-specific and is
 * checked against the provider's own `deduplicates`.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  type EmailProvider,
  EmailProviderRejectedError,
  EmailProviderUnavailableError,
  type OutgoingEmail,
  providerMessageIdPattern,
} from "./adapter.ts";

export interface EmailProviderHarness {
  provider: EmailProvider;
  /** A tenant the provider may file mail under (the fake needs a real one). */
  tenantId: string;
  /** A fresh run id; addresses are made unique with it. */
  run: string;
}

/** The addresses a run uses; a fenced adapter's allowlist must hold them. */
export function contractAddresses(run: string) {
  return {
    ok: `contract.ok.${run}@example.test`,
    bounce: `contract.${run}+bounce@example.test`,
    failOnce: `contract.${run}+fail-once@example.test`,
  };
}

const SUBJECT = "Contract subject Zq-Personal";
const TO_NAME = "Contract Guest Personal-Name";

function email(h: EmailProviderHarness, to: string, key = crypto.randomUUID()): OutgoingEmail {
  return {
    idempotencyKey: key,
    tenantId: h.tenantId,
    from: { email: "bookings@tidegrid.test", name: "Contract Harbor" },
    replyTo: "hello@contract-harbor.test",
    to: { email: to, name: TO_NAME },
    subject: SUBJECT,
    html: "<p>A synthetic contract message.</p>",
    text: "A synthetic contract message.",
  };
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

/** Every text an error exposes: message, code, string form, and enumerable properties. */
export function errorTexts(error: unknown): string[] {
  const e = error as Error & Record<string, unknown>;
  return [
    String(error),
    String(e.message),
    String(e.stack),
    JSON.stringify(e),
    JSON.stringify({ ...e }),
    ...Object.values(e).map((v) => String(v)),
  ];
}

export function describeEmailProviderContract(
  label: string,
  makeHarness: () => EmailProviderHarness | Promise<EmailProviderHarness>,
): void {
  describe(`email provider contract: ${label}`, () => {
    let h: EmailProviderHarness;

    beforeEach(async () => {
      h = await makeHarness();
    });

    const personal = () => [contractAddresses(h.run).bounce, TO_NAME, SUBJECT, h.tenantId];

    it("accepts an email and answers with an id the message table admits", async () => {
      const sent = await h.provider.send(email(h, contractAddresses(h.run).ok));
      expect(sent.providerMessageId).toMatch(providerMessageIdPattern);
    });

    it("refuses a refused address at once, with a lowercase snake code", async () => {
      const error = await caught(h.provider.send(email(h, contractAddresses(h.run).bounce)));
      expect(error).toBeInstanceOf(EmailProviderRejectedError);
      expect((error as EmailProviderRejectedError).code).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
    });

    it("answers a +fail-once address unavailable once, then accepts it", async () => {
      const key = crypto.randomUUID();
      const message = email(h, contractAddresses(h.run).failOnce, key);
      const error = await caught(h.provider.send(message));
      expect(error).toBeInstanceOf(EmailProviderUnavailableError);
      expect((error as EmailProviderUnavailableError).code).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
      const sent = await h.provider.send(message);
      expect(sent.providerMessageId).toMatch(providerMessageIdPattern);
    });

    it("keeps the recipient, names, subject and tenant out of every error", async () => {
      const errors = [
        await caught(h.provider.send(email(h, contractAddresses(h.run).bounce))),
        await caught(h.provider.send(email(h, contractAddresses(h.run).failOnce))),
      ];
      for (const error of errors) {
        for (const text of errorTexts(error)) {
          for (const secret of [...personal(), contractAddresses(h.run).failOnce]) {
            expect(text).not.toContain(secret);
          }
        }
      }
    });

    it("states whether a repeat with the same key sends again, and behaves so", async () => {
      const message = email(h, contractAddresses(h.run).ok);
      const first = await h.provider.send(message);
      const again = await h.provider.send(message);
      if (h.provider.deduplicates !== true) {
        // Sent twice: delivery must never repeat a send whose outcome is unknown.
        expect(again.providerMessageId).not.toBe(first.providerMessageId);
      } else {
        expect(again.providerMessageId).toBe(first.providerMessageId);
      }
    });
  });
}
