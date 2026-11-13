import {
  type DockLookupRequest,
  DockLookupResponse,
  type DockParty,
  DockPartyResponse,
  DockSigningResponse,
} from "@tidegrid/contracts";
import { call, type Result } from "../waiver/api.ts";

/**
 * The dock page's calls (W3-G2.15-rest): find today's booking by its code
 * and the booker's last name, then start a signing for one person. The
 * lookup's secret travels only as `Authorization: Bearer`, never in a URL,
 * and the page keeps it in memory only.
 */

export interface Found {
  secret: string;
  party: DockParty;
  /**
   * When this phone treats the lookup as ended, by its own clock: a new
   * lookup's 15 minutes counted from receipt, so a phone whose clock is off
   * is not shut out early. The server's 401 stays the real answer.
   */
  endsAt: number;
}

const lookupLifetimeMs = 15 * 60_000;

export async function lookUp(body: DockLookupRequest): Promise<Result<Found>> {
  const result = await call("/v1/public/waiver-dock/lookups", DockLookupResponse, {
    method: "POST",
    body,
  });
  return result.kind === "ok"
    ? {
        ...result,
        value: {
          secret: result.value.lookupSecret,
          party: result.value.party,
          endsAt: Date.now() + lookupLifetimeMs,
        },
      }
    : result;
}

/** Start one person's signing; the answer is the signing page's path, with its token. */
export async function startSigning(
  secret: string,
  position: number,
): Promise<Result<{ path: string }>> {
  const result = await call("/v1/public/waiver-dock/signings", DockSigningResponse, {
    method: "POST",
    body: { position },
    bearer: secret,
  });
  return result.kind === "ok" ? { ...result, value: { path: result.value.path } } : result;
}

/** Read the matched lookup's party again, as it stands now. */
export async function readParty(secret: string): Promise<Result<DockParty>> {
  const result = await call("/v1/public/waiver-dock/party", DockPartyResponse, {
    method: "GET",
    bearer: secret,
  });
  return result.kind === "ok" ? { ...result, value: result.value.party } : result;
}
