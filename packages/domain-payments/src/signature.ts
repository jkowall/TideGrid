/**
 * Webhook signatures in the Stripe style: a header `t=<unix seconds>,v1=<hex>`
 * where v1 is HMAC-SHA256 over `<t>.<raw body>` with the endpoint secret. More
 * than one v1 may be present while a secret rotates. A signature is accepted
 * only within the tolerance window around the receiver's clock, so a captured
 * request cannot be replayed later; within the window the inbox's unique event
 * id makes a replay a no-op. Comparison uses WebCrypto's HMAC verify, which is
 * constant time. Runs in Workers and Node.
 */
import type { WebhookRejection } from "./adapter.ts";

/** Five minutes either side, as Stripe's libraries default to. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

const encoder = new TextEncoder();

function hmacKey(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

/** HMAC-SHA256 of `<timestamp>.<body>`, hex. */
export async function signPayload(secret: string, timestamp: number, rawBody: string) {
  const key = await hmacKey(secret);
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${rawBody}`)));
}

/** The header value for a body signed now. */
export async function signatureHeaderValue(secret: string, nowMs: number, rawBody: string) {
  const timestamp = Math.floor(nowMs / 1000);
  return `t=${timestamp},v1=${await signPayload(secret, timestamp, rawBody)}`;
}

export interface ParsedSignature {
  timestamp: number;
  signatures: string[];
}

/** Null unless the header has exactly one numeric t and at least one well-formed v1. */
export function parseSignatureHeader(header: string): ParsedSignature | null {
  if (header.length > 1024) return null;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) return null;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (key === "t") {
      if (timestamp !== null || !/^\d{1,12}$/.test(value)) return null;
      timestamp = Number(value);
    } else if (key === "v1") {
      if (!/^[0-9a-f]{64}$/.test(value)) return null;
      signatures.push(value);
    }
    // Other schemes (Stripe sends v0 in test mode) are ignored, as Stripe's libraries do.
  }
  if (timestamp === null || signatures.length === 0 || signatures.length > 8) return null;
  return { timestamp, signatures };
}

/**
 * Checks a signature header against the raw body. The HMAC is checked before
 * the timestamp, so a forged header learns nothing about the window.
 */
export async function verifySignature(input: {
  secret: string;
  header: string | null;
  rawBody: string;
  nowMs: number;
  toleranceSeconds?: number;
}): Promise<"ok" | Exclude<WebhookRejection, "payload_invalid">> {
  if (!input.header) return "missing_signature";
  const parsed = parseSignatureHeader(input.header);
  if (!parsed) return "malformed_signature";
  const key = await hmacKey(input.secret);
  const signed = encoder.encode(`${parsed.timestamp}.${input.rawBody}`);
  let matched = false;
  for (const candidate of parsed.signatures) {
    const bytes = fromHex(candidate);
    if (bytes && (await crypto.subtle.verify("HMAC", key, bytes, signed))) matched = true;
  }
  if (!matched) return "signature_mismatch";
  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(Math.floor(input.nowMs / 1000) - parsed.timestamp) > tolerance) {
    return "timestamp_out_of_tolerance";
  }
  return "ok";
}
