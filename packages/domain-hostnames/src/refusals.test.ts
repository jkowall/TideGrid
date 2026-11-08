import { describe, expect, it } from "vitest";
import { createCloudflareHostnameProvider } from "./cloudflare.ts";
import {
  accountRefusalBody,
  createCloudflareFixture,
  recordedAccountRefusals,
} from "./cloudflare-fixture.ts";
import { HostnameProviderRejectedError, HostnameProviderUnavailableError } from "./provider.ts";
import {
  ACCOUNT_LEVEL_REFUSAL_CODES,
  ACCOUNT_LEVEL_REFUSALS_VERIFIED,
  isAccountLevelRefusal,
} from "./refusals.ts";

const zoneId = "023e105f4ecef8ad9ca31a8372d0c353";
const otherZone = "f0e1d2c3b4a5968778695a4b3c2d1e0f";
const apiToken = "test-token-Zq7Kx2Lm9Pw4Rt6Vb8Nc";
const routingTarget = "customers.tidegrid.us";
const host = "book.example.com";

function client(overrides: { apiToken?: string; zoneId?: string } = {}) {
  const fixture = createCloudflareFixture({ zoneId, apiToken });
  const provider = createCloudflareHostnameProvider({
    zoneId: overrides.zoneId ?? zoneId,
    apiToken: overrides.apiToken ?? apiToken,
    routingTarget,
    fetch: fixture.fetch,
    sleep: async () => {},
  });
  return { provider, fixture };
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

// UNVERIFIED against live Cloudflare: the codes and statuses below are the
// fixture's recorded shapes, as remembered from Cloudflare's API. They count
// as verified only at the first real request, the runbook's P10 (A18).
describe("account-level refusals through the Cloudflare client (W1-SAAS-PREP)", () => {
  it("is labeled unverified until the first real request", () => {
    expect(ACCOUNT_LEVEL_REFUSALS_VERIFIED).toBe(false);
    expect(ACCOUNT_LEVEL_REFUSAL_CODES).toContain("cloudflare_10000");
    expect(Object.isFrozen(ACCOUNT_LEVEL_REFUSAL_CODES)).toBe(true);
  });

  it.each(recordedAccountRefusals)(
    "maps $label ($status, $code) to a refusal on a read and a lookup",
    async (refusal) => {
      const { provider, fixture } = client();
      for (const call of [() => provider.get("abc", host), () => provider.findByHostname(host)]) {
        fixture.answerNext({ status: refusal.status, body: accountRefusalBody(refusal) });
        const error = await caught(call());
        expect(error).toBeInstanceOf(HostnameProviderRejectedError);
        expect((error as HostnameProviderRejectedError).code).toBe(`cloudflare_${refusal.code}`);
        expect(isAccountLevelRefusal(error)).toBe(true);
        expect(isAccountLevelRefusal(error, { lookup: true })).toBe(true);
      }
    },
  );

  it("maps the fixture's answer to a wrong token to a refusal", async () => {
    const { provider } = client({ apiToken: `${apiToken}-rotated` });
    const error = (await caught(provider.get("abc", host))) as HostnameProviderRejectedError;
    expect({ code: error.code, httpStatus: error.httpStatus }).toEqual({
      code: "cloudflare_10000",
      httpStatus: 403,
    });
    expect(isAccountLevelRefusal(error)).toBe(true);
  });

  it("maps a wrong zone to a refusal only through the lookup's 404", async () => {
    const { provider } = client({ zoneId: otherZone });
    // A read by id answers not found, which alone proves nothing.
    expect(await provider.get("abc", host)).toBeNull();
    const error = (await caught(provider.findByHostname(host))) as HostnameProviderRejectedError;
    expect(error.code).toBe("http_404");
    expect(isAccountLevelRefusal(error)).toBe(false);
    expect(isAccountLevelRefusal(error, { lookup: true })).toBe(true);
  });

  it("treats any 401 or 403 as account-level, whatever the code", async () => {
    const { provider, fixture } = client();
    for (const status of [401, 403]) {
      fixture.answerNext({
        status,
        body: JSON.stringify({ success: false, errors: [{ code: 1234 }], result: null }),
      });
      expect(isAccountLevelRefusal(await caught(provider.get("abc", host)))).toBe(true);
    }
  });

  it("keeps refusals about one record, and anything else, out", async () => {
    const { provider, fixture } = client();
    const errors: unknown[] = [];
    for (const code of [1409, 1414]) {
      fixture.answerNext({
        status: 400,
        body: JSON.stringify({ success: false, errors: [{ code }], result: null }),
      });
      errors.push(await caught(provider.get("abc", host)));
    }
    fixture.answerNext({ status: 200, body: "not json" });
    errors.push(await caught(provider.get("abc", host)));
    fixture.answerNext({ status: 429, body: "{}" });
    errors.push(await caught(provider.get("abc", host)));
    errors.push(new HostnameProviderRejectedError("ambiguous_hostname"));
    errors.push(new HostnameProviderRejectedError("already_exists"));
    errors.push(new Error("cloudflare_10000"));
    expect(errors[3]).toBeInstanceOf(HostnameProviderUnavailableError);
    for (const error of errors) {
      expect(isAccountLevelRefusal(error)).toBe(false);
      expect(isAccountLevelRefusal(error, { lookup: true })).toBe(false);
    }
  });
});
