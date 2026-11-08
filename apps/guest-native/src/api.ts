import {
  type AvailableTrip,
  type PublicBrand,
  PublicExperienceResponse,
  TripAvailabilityResponse,
} from "@tidegrid/contracts";
import type { Endpoint, Variant } from "./variant.ts";

export const requestTimeoutMs = 10_000;

/**
 * Every outcome of starting the app maps to one screen.
 * - ready: the API answered for this variant's operator with a brand.
 * - wrong-tenant: the API answered for a different operator. The app shows
 *   nothing from that answer.
 * - not-published / not-ready: the same states the guest web app shows.
 * - failed: no answer, a timeout, a server error, or a body that breaks the
 *   contract.
 */
export type Start =
  | { kind: "ready"; tenant: { slug: string; name: string }; brand: PublicBrand }
  | { kind: "wrong-tenant" }
  | { kind: "not-published" }
  | { kind: "not-ready"; tenant: { slug: string; name: string } }
  | { kind: "failed" };

/**
 * The API picks the operator from the Origin header, as it does for the
 * guest web app. A native app has no browser origin, so it presents its
 * variant's guest origin. That is not authentication: any client can send any
 * Origin, the API treats it only as which public operator to answer for, and
 * guests are anonymous until checkout. Credentials are never sent.
 */
function guestHeaders(endpoint: Endpoint): Record<string, string> {
  return { accept: "application/json", origin: endpoint.origin };
}

async function getJson(
  endpoint: Endpoint,
  path: string,
  fetchImpl: typeof fetch,
): Promise<{ status: number; body: unknown } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const res = await fetchImpl(`${endpoint.apiBase}${path}`, {
      credentials: "omit",
      headers: guestHeaders(endpoint),
      signal: controller.signal,
    });
    const body: unknown = await res.json().catch(() => undefined);
    return { status: res.status, body };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Ask the API which operator this build serves. Never throws. */
export async function loadStart(
  variant: Variant,
  endpoint: Endpoint,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): Promise<Start> {
  const res = await getJson(endpoint, "/v1/public/tenant", fetchImpl);
  if (!res) return { kind: "failed" };
  if (res.status === 404) {
    const code = (res.body as { error?: { code?: unknown } } | undefined)?.error?.code;
    return code === "tenant_not_found" ? { kind: "not-published" } : { kind: "failed" };
  }
  if (res.status !== 200) return { kind: "failed" };
  const parsed = PublicExperienceResponse.safeParse(res.body);
  if (!parsed.success) return { kind: "failed" };
  const { tenant, brand } = parsed.data;
  // Fail closed: a build for one operator never shows another one.
  if (tenant.slug !== variant.slug) return { kind: "wrong-tenant" };
  if (!brand) return { kind: "not-ready", tenant };
  return { kind: "ready", tenant, brand };
}

export type Trips = { kind: "ok"; trips: AvailableTrip[] } | { kind: "failed" };

/** Bookable trips for the next days, for a party of one. Never throws. */
export async function loadTrips(
  endpoint: Endpoint,
  range: { from: string; to: string; party?: number },
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): Promise<Trips> {
  const params = new URLSearchParams({
    from: range.from,
    to: range.to,
    party: String(range.party ?? 1),
  });
  const res = await getJson(endpoint, `/v1/public/trips?${params}`, fetchImpl);
  if (res?.status !== 200) return { kind: "failed" };
  const parsed = TripAvailabilityResponse.safeParse(res.body);
  if (!parsed.success) return { kind: "failed" };
  return { kind: "ok", trips: parsed.data.trips };
}

/** A calendar date as YYYY-MM-DD, `days` after `from`, in UTC. */
export function isoDate(from: Date, days = 0): string {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + days));
  return d.toISOString().slice(0, 10);
}
