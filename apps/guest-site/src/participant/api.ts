import {
  type OwnDetailsInput,
  OwnDetailsResponse,
  type ParticipantProfile,
  ParticipantProfileResponse,
  ParticipantSessionEndResponse,
  ParticipantSessionResponse,
} from "@tidegrid/contracts";
import { call, commandTimeoutMs, type Result } from "../booking/api.ts";

/**
 * The participant page's calls to the API (W3-G2.11-rest). As on the
 * booking's management page, the browser sends the page's Origin and every
 * answer is parsed against the contract. The invitation's token travels once,
 * in the body of the POST that opens the session; the session's token travels
 * only as `Authorization: Bearer`. No path or query carries either, or any
 * personal data.
 */

export interface OpenedSession {
  token: string;
  expiresAt: string;
}

const mapOk = <T, U>(result: Result<T>, map: (value: T) => U): Result<U> =>
  result.kind === "ok" ? { ...result, value: map(result.value) } : result;

/** Exchange the invitation's token for a session. Only the person's tap calls this. */
export async function openWithLink(token: string): Promise<Result<OpenedSession>> {
  const result = await call("/v1/public/participant-access", {
    method: "POST",
    body: { token },
    schema: ParticipantSessionResponse,
    timeoutMs: commandTimeoutMs,
  });
  return mapOk(result, (r) => r.session);
}

export async function readProfile(
  session: string,
  signal?: AbortSignal,
): Promise<Result<ParticipantProfile>> {
  const result = await call("/v1/public/participant/profile", {
    bearer: session,
    schema: ParticipantProfileResponse,
    signal,
  });
  return mapOk(result, (r) => r.profile);
}

export async function saveOwnDetails(
  session: string,
  input: OwnDetailsInput,
  key: string,
): Promise<Result<{ profile: ParticipantProfile; changed: boolean }>> {
  return call("/v1/public/participant/profile", {
    method: "PUT",
    bearer: session,
    body: input,
    key,
    schema: OwnDetailsResponse,
    timeoutMs: commandTimeoutMs,
  });
}

/** End the session on the server. Best effort: the page has already forgotten it. */
export async function endSession(session: string): Promise<void> {
  await call("/v1/public/participant/session/end", {
    method: "POST",
    bearer: session,
    schema: ParticipantSessionEndResponse,
    // "I'm done" and a closed tab right after still end the session.
    keepalive: true,
  });
}
