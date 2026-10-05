import { type PublicBrand, PublicExperienceResponse } from "@tidegrid/contracts";

/**
 * Where the page finds the API. Production calls api.tidegrid.us across
 * origins; local development defaults to `wrangler dev` on :8787.
 */
export const apiBase: string =
  import.meta.env.VITE_API_BASE ??
  (import.meta.env.PROD ? "https://api.tidegrid.us" : "http://localhost:8787");

export interface Tenant {
  slug: string;
  name: string;
}

/** Every outcome of the bootstrap maps to one designed screen. */
export type Experience =
  | { kind: "ready"; tenant: Tenant; brand: PublicBrand }
  /** The API says no operator is published at this address. */
  | { kind: "not-published" }
  /** A verified operator that has not published a brand yet. */
  | { kind: "not-ready"; tenant: Tenant }
  /** Network failure, a blocked request, a timeout, a server error, or a response that fails the contract. */
  | { kind: "failed" };

export const bootstrapTimeoutMs = 10_000;

/**
 * Ask the API which operator this page belongs to. The browser sets the
 * Origin header; the page sends no credentials and no hostname of its own.
 * The response is parsed against the contract, so a brand that fails
 * validation is never applied.
 *
 * Uses one AbortController and setTimeout, not AbortSignal.any or
 * AbortSignal.timeout, which Safari lacks before 17.4 and 16.0. Never throws:
 * every failure, including a missing browser API, is the "failed" screen.
 */
export async function loadExperience(
  signal?: AbortSignal,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): Promise<Experience> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopListening = () => {};
  try {
    const controller = new AbortController();
    if (signal?.aborted) controller.abort();
    else if (signal) {
      const forward = () => controller.abort();
      signal.addEventListener("abort", forward, { once: true });
      stopListening = () => signal.removeEventListener("abort", forward);
    }
    timer = setTimeout(() => controller.abort(), bootstrapTimeoutMs);
    const res = await fetchImpl(`${apiBase}/v1/public/tenant`, {
      credentials: "omit",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    const body: unknown = await res.json().catch(() => undefined);
    if (res.status === 404) {
      // Only the API's own answer means "no operator here". Any other 404,
      // such as a proxy or a missing route, is a failure to load.
      const code = (body as { error?: { code?: unknown } } | undefined)?.error?.code;
      return code === "tenant_not_found" ? { kind: "not-published" } : { kind: "failed" };
    }
    if (!res.ok) return { kind: "failed" };
    const parsed = PublicExperienceResponse.safeParse(body);
    if (!parsed.success) return { kind: "failed" };
    const { tenant, brand } = parsed.data;
    return brand ? { kind: "ready", tenant, brand } : { kind: "not-ready", tenant };
  } catch {
    return { kind: "failed" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    stopListening();
  }
}

/** Run a loader and turn anything it throws into the failure screen. */
export async function settle(load: () => Promise<Experience>): Promise<Experience> {
  try {
    return await load();
  } catch {
    return { kind: "failed" };
  }
}

/** US numbers read as (305) 555-0142; others stay in E.164. */
export function formatPhone(e164: string): string {
  const us = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return us ? `(${us[1]}) ${us[2]}-${us[3]}` : e164;
}
