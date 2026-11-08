/**
 * Per-hostname Workers routes for Cloudflare for SaaS (W1-SAAS-PREP,
 * proposed). A custom hostname reaches the guest Worker through a route in
 * the SaaS zone whose pattern is exactly `<hostname>/*`, so no wildcard
 * route such as `*\/*` can shadow the API, the console, or the demo domains.
 *
 * - The command is a dry run unless `--apply` is given (D3): a dry run prints
 *   the calls it would make and makes none.
 * - With `--apply` it lists the zone's routes first. A route with the same
 *   pattern and script is left alone; a route with the same pattern and any
 *   other script (or none) is refused, never replaced or deleted.
 * - The token needs Workers Routes Write on the SaaS zone, in addition to the
 *   custom hostname permissions (see the package README).
 * - The token goes only into the Authorization header. No error carries it,
 *   and no response text is echoed.
 *
 * API reference: https://developers.cloudflare.com/api/resources/workers/subresources/routes/
 * Never called against the real API before P10.
 */
import {
  HostnameProviderRejectedError,
  HostnameProviderUnavailableError,
} from "@tidegrid/domain-hostnames";

export interface WorkerRoute {
  id: string;
  pattern: string;
  script: string | null;
}

export interface WorkersRoutesClient {
  list(): Promise<WorkerRoute[]>;
  create(pattern: string, script: string): Promise<WorkerRoute>;
  remove(routeId: string): Promise<void>;
}

export interface WorkersRoutesOptions {
  /** The SaaS zone's id: 32 lowercase hex characters. */
  zoneId: string;
  apiToken: string;
  fetch?: typeof fetch;
  apiBase?: string;
  /** Each request's deadline. Defaults to 15000 ms. */
  requestTimeoutMs?: number;
}

/** The guest Worker's script name (`apps/guest-site/wrangler.jsonc`). */
export const DEFAULT_ROUTE_SCRIPT = "tidegrid-guest";

const zoneIdPattern = /^[0-9a-f]{32}$/;
const routeIdPattern = /^[A-Za-z0-9_-]{1,64}$/;
const scriptPattern = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export function checkScriptName(script: string): string {
  if (!scriptPattern.test(script)) {
    throw new TypeError("a Worker script name is lowercase letters, digits, - and _");
  }
  return script;
}

/** The one pattern a custom hostname's route may have. */
export function routePattern(hostname: string): string {
  return `${hostname}/*`;
}

export type RouteAction = "add" | "remove";

export interface RoutePlan {
  action: RouteAction;
  hostname: string;
  pattern: string;
  script: string;
}

export function planRoute(action: RouteAction, hostname: string, script: string): RoutePlan {
  return { action, hostname, pattern: routePattern(hostname), script: checkScriptName(script) };
}

/** What a dry run prints. The zone id is never printed; the path names its variable. */
export function describePlan(plan: RoutePlan): string[] {
  const path = "/zones/$CF_SAAS_ZONE_ID/workers/routes";
  const lines = [
    `${plan.hostname}: dry run, no call made`,
    `  would list GET ${path} and look for ${plan.pattern}`,
  ];
  if (plan.action === "add") {
    lines.push(
      `  would create POST ${path} ${JSON.stringify({ pattern: plan.pattern, script: plan.script })}`,
      "  unless that pattern already routes to that script; refused if it routes elsewhere",
    );
  } else {
    lines.push(
      `  would delete DELETE ${path}/<route id> for ${plan.pattern} on script ${plan.script}`,
      "  refused if that pattern routes to another script",
    );
  }
  lines.push(
    "Run again with --apply. It needs CF_SAAS_ZONE_ID and CF_SAAS_API_TOKEN with Workers Routes Write.",
  );
  return lines;
}

export type RouteOutcome =
  | { kind: "routed"; routeId: string }
  | { kind: "already_routed"; routeId: string }
  | { kind: "removed"; routeIds: string[] }
  | { kind: "no_route" }
  | { kind: "conflict"; script: string | null };

/** Apply a plan: list first, then create or delete only what the plan names. */
export async function applyRoutePlan(
  client: WorkersRoutesClient,
  plan: RoutePlan,
): Promise<RouteOutcome> {
  const same = (await client.list()).filter((r) => r.pattern === plan.pattern);
  const foreign = same.find((r) => r.script !== plan.script);
  if (foreign) return { kind: "conflict", script: foreign.script };
  if (plan.action === "add") {
    const existing = same[0];
    if (existing) return { kind: "already_routed", routeId: existing.id };
    const created = await client.create(plan.pattern, plan.script);
    return { kind: "routed", routeId: created.id };
  }
  if (same.length === 0) return { kind: "no_route" };
  for (const route of same) await client.remove(route.id);
  return { kind: "removed", routeIds: same.map((r) => r.id) };
}

export function describeOutcome(plan: RoutePlan, outcome: RouteOutcome): string[] {
  switch (outcome.kind) {
    case "routed":
      return [
        `${plan.hostname}: routed ${plan.pattern} to ${plan.script} (route ${outcome.routeId})`,
      ];
    case "already_routed":
      return [`${plan.hostname}: already routed to ${plan.script} (route ${outcome.routeId})`];
    case "removed":
      return [`${plan.hostname}: removed route ${outcome.routeIds.join(", ")}`];
    case "no_route":
      return [`${plan.hostname}: no route for ${plan.pattern}`];
    case "conflict":
      return [
        `${plan.hostname}: refused: ${plan.pattern} routes to ${outcome.script ?? "no script"}, not ${plan.script}; nothing changed`,
      ];
  }
}

function parseEnvelope(
  text: string,
): { success: boolean; result: unknown; code: number | null } | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null) return null;
  const envelope = json as { success?: unknown; result?: unknown; errors?: unknown };
  if (typeof envelope.success !== "boolean") return null;
  let code: number | null = null;
  if (Array.isArray(envelope.errors)) {
    const first = envelope.errors[0] as { code?: unknown } | undefined;
    if (typeof first?.code === "number" && Number.isSafeInteger(first.code) && first.code >= 0) {
      code = first.code;
    }
  }
  return { success: envelope.success, result: envelope.result, code };
}

function parseRoute(value: unknown): WorkerRoute {
  const r = value as { id?: unknown; pattern?: unknown; script?: unknown } | null;
  if (
    typeof r !== "object" ||
    r === null ||
    typeof r.id !== "string" ||
    !routeIdPattern.test(r.id) ||
    typeof r.pattern !== "string" ||
    !(r.script === undefined || r.script === null || typeof r.script === "string")
  ) {
    throw new HostnameProviderRejectedError("malformed_response");
  }
  return { id: r.id, pattern: r.pattern, script: typeof r.script === "string" ? r.script : null };
}

export function createWorkersRoutesClient(options: WorkersRoutesOptions): WorkersRoutesClient {
  if (typeof options.zoneId !== "string" || !zoneIdPattern.test(options.zoneId)) {
    throw new TypeError("a Cloudflare zone id is 32 lowercase hex characters");
  }
  if (typeof options.apiToken !== "string" || options.apiToken.trim().length === 0) {
    throw new TypeError("a Cloudflare API token is required");
  }
  const apiBase = (options.apiBase ?? "https://api.cloudflare.com/client/v4").replace(/\/+$/, "");
  if (!apiBase.startsWith("https://")) throw new TypeError("the Cloudflare API base is https");
  const base = `${apiBase}/zones/${options.zoneId}/workers/routes`;
  const token = options.apiToken;
  const doFetch: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.requestTimeoutMs ?? 15000;

  async function request(method: "GET" | "POST" | "DELETE", path: string, body?: unknown) {
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: "application/json",
    };
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    let response: Response;
    let text: string;
    try {
      response = await doFetch(`${base}${path}`, init);
      text = await response.text();
    } catch {
      // The cause is not kept, so nothing from the request travels with the error.
      throw new HostnameProviderUnavailableError(null);
    }
    const status = response.status;
    if (status === 429 || status >= 500) {
      throw new HostnameProviderUnavailableError(status);
    }
    const envelope = parseEnvelope(text);
    if (status >= 400) {
      const code = envelope?.code ?? null;
      throw new HostnameProviderRejectedError(
        code === null ? `http_${status}` : `cloudflare_${code}`,
        undefined,
        status,
      );
    }
    if (status < 200 || status >= 300 || !envelope || !envelope.success) {
      throw new HostnameProviderRejectedError("malformed_response");
    }
    return envelope.result;
  }

  return {
    async list() {
      const result = await request("GET", "");
      if (!Array.isArray(result)) throw new HostnameProviderRejectedError("malformed_response");
      return result.map(parseRoute);
    },
    async create(pattern, script) {
      const result = await request("POST", "", { pattern, script: checkScriptName(script) });
      // The answer may carry the id alone. Fields it does carry must match.
      const r = result as { id?: unknown; pattern?: unknown; script?: unknown } | null;
      const created = parseRoute({ pattern, script, ...(typeof r === "object" ? r : {}) });
      if (created.pattern !== pattern || created.script !== script) {
        throw new HostnameProviderRejectedError("malformed_response");
      }
      return created;
    },
    async remove(routeId) {
      if (!routeIdPattern.test(routeId)) {
        throw new HostnameProviderRejectedError("invalid_provider_id");
      }
      await request("DELETE", `/${routeId}`);
    },
  };
}
