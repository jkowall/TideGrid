import { ErrorResponse, type Problem, ProblemResponse } from "@tidegrid/contracts";
import type { z } from "zod";
import type { Endpoint } from "./variant.ts";

/**
 * One guest API call, as the guest web app makes it (apps/guest-site
 * src/booking/api.ts), with the variant's guest origin in place of a
 * browser's. Every answer is parsed against the contract before the app uses
 * it, and a call never throws.
 *
 * Secrets: a checkout secret, a payment's client secret, and a booking
 * session travel only in an Authorization header; the booker's name and
 * email and a link's token only in a POST body. No path or query here ever
 * carries them, and nothing here logs.
 */

export type Failure =
  /** No answer: offline, blocked, or no answer in time. A command may or may not have happened. */
  | { kind: "network" }
  /** A success answer that breaks the contract. */
  | { kind: "unreadable" }
  /** The API's own refusal, or a server error, with its code. */
  | {
      kind: "refused";
      status: number;
      code: string;
      message: string;
      problems?: readonly Problem[];
      remaining?: number;
    };

/** `replayed`: the API answered a repeated Idempotency-Key with the first answer, so it is old. */
export type Result<T> = { kind: "ok"; value: T; replayed?: boolean } | Failure;

export const readTimeoutMs = 10_000;
/** Opening a checkout calls the payment provider after commit, so commands get longer. */
export const commandTimeoutMs = 20_000;

export interface CallOptions<S extends z.ZodType> {
  method?: "GET" | "POST" | "PUT";
  body?: unknown;
  key?: string;
  bearer?: string;
  schema: S;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export async function call<S extends z.ZodType>(
  endpoint: Endpoint,
  path: string,
  options: CallOptions<S>,
): Promise<Result<z.infer<S>>> {
  const {
    method = "GET",
    body,
    key,
    bearer,
    schema,
    timeoutMs = readTimeoutMs,
    fetchImpl = (...args) => fetch(...args),
  } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {
      accept: "application/json",
      // Which public operator to answer for; not authentication (see api.ts).
      origin: endpoint.origin,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (key) headers["idempotency-key"] = key;
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    const res = await fetchImpl(`${endpoint.apiBase}${path}`, {
      method,
      credentials: "omit",
      cache: "no-store",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    const json: unknown = await res.json().catch(() => undefined);
    if (!res.ok) {
      const problem = ProblemResponse.safeParse(json);
      if (problem.success) {
        const { error, problems, remaining } = problem.data;
        return {
          kind: "refused",
          status: res.status,
          code: error.code,
          message: error.message,
          problems,
          ...(remaining === undefined ? {} : { remaining }),
        };
      }
      const error = ErrorResponse.safeParse(json);
      return {
        kind: "refused",
        status: res.status,
        code: error.success ? error.data.error.code : "unknown",
        message: error.success ? error.data.error.message : "",
      };
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) return { kind: "unreadable" };
    return {
      kind: "ok",
      value: parsed.data,
      replayed: res.headers.get("idempotent-replayed") === "true",
    };
  } catch {
    return { kind: "network" };
  } finally {
    clearTimeout(timer);
  }
}

export const mapOk = <T, U>(result: Result<T>, map: (value: T) => U): Result<U> =>
  result.kind === "ok" ? { ...result, value: map(result.value) } : result;

/**
 * Whether a failure leaves a command's outcome unknown, so only the same
 * request may follow. A 503 `payments_unavailable` is definite.
 */
export function outcomeUnknown(failure: Failure): boolean {
  return (
    failure.kind === "network" ||
    failure.kind === "unreadable" ||
    (failure.kind === "refused" && failure.status >= 500 && failure.code !== "payments_unavailable")
  );
}
