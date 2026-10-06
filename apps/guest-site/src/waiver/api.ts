import {
  ErrorResponse,
  WaiverSessionOpenResponse,
  WaiverSessionResponse,
  type WaiverSigning,
  WaiverSignProblemsResponse,
  type WaiverSignRequest,
} from "@tidegrid/contracts";
import type { z } from "zod";
import { apiBase } from "../bootstrap.ts";

/**
 * The waiver page's calls to the API (G2.15). The browser sends the page's
 * Origin and the API answers for the operator published there. Every answer
 * is parsed against the contract before the page uses it.
 *
 * Secrets: the link's token travels once, in the body of the POST that opens
 * the session; the session's secret travels only as `Authorization: Bearer`.
 * No path or query ever carries either; tests check every URL.
 */

export type Failure =
  /** No answer: offline, blocked, or no answer in time. */
  | { kind: "network" }
  /** A success answer that breaks the contract. */
  | { kind: "unreadable" }
  /** The API's own refusal, with its code. */
  | { kind: "refused"; status: number; code: string };

export type Result<T> = { kind: "ok"; value: T; status: number } | Failure;

const timeoutMs = 15_000;

async function send(
  path: string,
  init: { method?: "GET" | "POST"; body?: unknown; bearer?: string; accept?: string },
): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { accept: init.accept ?? "application/json" };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
    return await fetch(`${apiBase}${path}`, {
      method: init.method ?? "GET",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: controller.signal,
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function call<S extends z.ZodType>(
  path: string,
  schema: S,
  init: { method?: "GET" | "POST"; body?: unknown; bearer?: string } = {},
): Promise<Result<z.infer<S>>> {
  const res = await send(path, init);
  if (!res) return { kind: "network" };
  const json: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    const error = ErrorResponse.safeParse(json);
    return {
      kind: "refused",
      status: res.status,
      code: error.success ? error.data.error.code : "unknown",
    };
  }
  const parsed = schema.safeParse(json);
  return parsed.success
    ? { kind: "ok", value: parsed.data, status: res.status }
    : { kind: "unreadable" };
}

export interface OpenedSession {
  secret: string;
  waiver: WaiverSigning;
}

/** Open a signing session with the link's token. Only the guest's tap calls this. */
export async function openSession(token: string): Promise<Result<OpenedSession>> {
  const result = await call("/v1/public/waiver-sessions", WaiverSessionOpenResponse, {
    method: "POST",
    body: { token },
  });
  return result.kind === "ok"
    ? { ...result, value: { secret: result.value.sessionSecret, waiver: result.value.waiver } }
    : result;
}

export async function readSession(secret: string): Promise<Result<WaiverSigning>> {
  const result = await call("/v1/public/waiver-sessions/current", WaiverSessionResponse, {
    bearer: secret,
  });
  return result.kind === "ok" ? { ...result, value: result.value.waiver } : result;
}

export type SignOutcome =
  | { kind: "ok"; waiver: WaiverSigning }
  | { kind: "problems"; problems: WaiverSignProblemsResponse["problems"] }
  | Failure;

export async function sign(secret: string, body: WaiverSignRequest): Promise<SignOutcome> {
  const res = await send("/v1/public/waiver-sessions/current/signature", {
    method: "POST",
    body,
    bearer: secret,
  });
  if (!res) return { kind: "network" };
  const json: unknown = await res.json().catch(() => undefined);
  if (res.status === 422) {
    const problems = WaiverSignProblemsResponse.safeParse(json);
    if (problems.success) return { kind: "problems", problems: problems.data.problems };
  }
  if (!res.ok) {
    const error = ErrorResponse.safeParse(json);
    return {
      kind: "refused",
      status: res.status,
      code: error.success ? error.data.error.code : "unknown",
    };
  }
  const parsed = WaiverSessionResponse.safeParse(json);
  return parsed.success ? { kind: "ok", waiver: parsed.data.waiver } : { kind: "unreadable" };
}

/** The signed PDF, as recorded. */
export async function downloadDocument(secret: string): Promise<Result<Blob>> {
  const res = await send("/v1/public/waiver-sessions/current/document", {
    bearer: secret,
    accept: "application/pdf",
  });
  if (!res) return { kind: "network" };
  if (!res.ok) {
    const error = ErrorResponse.safeParse(await res.json().catch(() => undefined));
    return {
      kind: "refused",
      status: res.status,
      code: error.success ? error.data.error.code : "unknown",
    };
  }
  if (!(res.headers.get("content-type") ?? "").startsWith("application/pdf")) {
    return { kind: "unreadable" };
  }
  return { kind: "ok", value: await res.blob(), status: res.status };
}
