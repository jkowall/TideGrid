import type { ErrorResponse } from "@tidegrid/contracts";

/**
 * The console's calls. Same-origin under /api: the console Worker forwards
 * them to the API's ConsoleGateway. The API checks the session, the
 * membership, and the role on every call; the console's role checks only
 * decide what to show.
 */

const timeoutMs = 15_000;

/** A fetch that gives up after `timeoutMs` or when `signal` aborts. Throws on network failure. */
export async function call(
  path: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    return await fetch(path, { ...init, credentials: "same-origin", signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export async function errorCode(res: Response): Promise<string | undefined> {
  const body = (await res.json().catch(() => null)) as Partial<ErrorResponse> | null;
  const code = body?.error?.code;
  return typeof code === "string" ? code : undefined;
}

export const tenantPath = (tenantId: string) =>
  `/api/v1/staff/tenants/${encodeURIComponent(tenantId)}`;

/**
 * Why a read did not load:
 * - signed_out, forbidden, suspended: what the API said about the person or
 *   the operator;
 * - no_access: the person is no longer a member of the operator (404
 *   tenant_not_found);
 * - not_found: the operator has no such thing, such as a booking or a trip;
 * - rejected: the API refused the request as asked (400);
 * - unreadable: an answer the console cannot show, such as an unknown state;
 * - unreachable: no answer; unavailable: any other failure.
 */
export type ReadFailure =
  | "signed_out"
  | "forbidden"
  | "suspended"
  | "no_access"
  | "not_found"
  | "rejected"
  | "unreadable"
  | "unreachable"
  | "unavailable";

/** A failed answer's reason. */
export async function failureOf(res: Response): Promise<ReadFailure> {
  if (res.status === 401) return "signed_out";
  if (res.status === 403) {
    return (await errorCode(res)) === "tenant_suspended" ? "suspended" : "forbidden";
  }
  if (res.status === 404) {
    return (await errorCode(res)) === "tenant_not_found" ? "no_access" : "not_found";
  }
  if (res.status === 400) return "rejected";
  return "unavailable";
}
