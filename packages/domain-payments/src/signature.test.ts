import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOLERANCE_SECONDS,
  parseSignatureHeader,
  signatureHeaderValue,
  signPayload,
  verifySignature,
} from "./signature.ts";

const secret = "unit-test-webhook-secret-0123456789abcdef";
const body = '{"id":"evt","type":"payment.succeeded"}';
const now = Date.UTC(2026, 9, 5, 12, 0, 0);

describe("webhook signatures", () => {
  it("accepts a body signed with the secret inside the window", async () => {
    const header = await signatureHeaderValue(secret, now, body);
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(await verifySignature({ secret, header, rawBody: body, nowMs: now })).toBe("ok");
    // Either edge of the window still verifies.
    const t = Math.floor(now / 1000);
    const at = (offset: number) =>
      verifySignature({ secret, header, rawBody: body, nowMs: (t + offset) * 1000 });
    expect(await at(DEFAULT_TOLERANCE_SECONDS)).toBe("ok");
    expect(await at(-DEFAULT_TOLERANCE_SECONDS)).toBe("ok");
  });

  it("refuses a changed body, another secret, and a missing or malformed header", async () => {
    const header = await signatureHeaderValue(secret, now, body);
    const check = (h: string | null, b = body, s = secret) =>
      verifySignature({ secret: s, header: h, rawBody: b, nowMs: now });
    expect(await check(header, `${body} `)).toBe("signature_mismatch");
    expect(await check(header, body, `${secret}x`)).toBe("signature_mismatch");
    expect(await check(null)).toBe("missing_signature");
    expect(await check("")).toBe("missing_signature");
    for (const bad of [
      "v1=abc",
      `t=${Math.floor(now / 1000)}`,
      `t=abc,v1=${"0".repeat(64)}`,
      `t=1,t=2,v1=${"0".repeat(64)}`,
      `t=1,v1=${"G".repeat(64)}`,
      `t=1,v1=${"0".repeat(63)}`,
      "garbage",
      `t=1,v1=${"0".repeat(64)},${"x".repeat(2000)}`,
    ]) {
      expect({ bad, result: await check(bad) }).toEqual({ bad, result: "malformed_signature" });
    }
  });

  it("refuses a correctly signed body outside the tolerance window, either way", async () => {
    const t = Math.floor(now / 1000);
    const header = await signatureHeaderValue(secret, now, body);
    const at = (offset: number) =>
      verifySignature({ secret, header, rawBody: body, nowMs: (t + offset) * 1000 });
    expect(await at(DEFAULT_TOLERANCE_SECONDS + 1)).toBe("timestamp_out_of_tolerance");
    expect(await at(-DEFAULT_TOLERANCE_SECONDS - 1)).toBe("timestamp_out_of_tolerance");
  });

  it("refuses a valid signature moved to another timestamp", async () => {
    const t = Math.floor(now / 1000);
    const v1 = await signPayload(secret, t, body);
    const header = `t=${t + 1},v1=${v1}`;
    expect(await verifySignature({ secret, header, rawBody: body, nowMs: now })).toBe(
      "signature_mismatch",
    );
  });

  it("accepts any one matching v1 while a secret rotates, and ignores other schemes", async () => {
    const t = Math.floor(now / 1000);
    const good = await signPayload(secret, t, body);
    const old = await signPayload("an-older-secret-that-was-rotated-out-0000", t, body);
    expect(
      await verifySignature({
        secret,
        header: `t=${t},v0=${"f".repeat(64)},v1=${old},v1=${good}`,
        rawBody: body,
        nowMs: now,
      }),
    ).toBe("ok");
    expect(parseSignatureHeader(`t=${t},v0=zzz,v1=${good}`)).toEqual({
      timestamp: t,
      signatures: [good],
    });
  });
});
