/**
 * The custom-hostname provider contract (G2.14b). One suite drives the fake
 * and the Cloudflare client over its recorded fixture, so the demo's fake
 * cannot drift from what the real client does.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { HostnameProviderControls } from "./fake.ts";
import {
  type CustomHostnameProvider,
  HostnameProviderRejectedError,
  HostnameProviderUnavailableError,
  isActivatable,
  isServable,
} from "./provider.ts";

export interface ProviderHarness {
  provider: CustomHostnameProvider;
  controls: HostnameProviderControls;
}

const host = "book.example.com";

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

async function rejectedCode(promise: Promise<unknown>): Promise<string> {
  const error = await caught(promise);
  expect(error).toBeInstanceOf(HostnameProviderRejectedError);
  return (error as HostnameProviderRejectedError).code;
}

async function unavailable(promise: Promise<unknown>): Promise<HostnameProviderUnavailableError> {
  const error = await caught(promise);
  expect(error).toBeInstanceOf(HostnameProviderUnavailableError);
  return error as HostnameProviderUnavailableError;
}

export function describeProviderContract(
  label: string,
  makeHarness: () => ProviderHarness | Promise<ProviderHarness>,
): void {
  describe(`custom-hostname provider contract: ${label}`, () => {
    let provider: CustomHostnameProvider;
    let controls: HostnameProviderControls;

    beforeEach(async () => {
      ({ provider, controls } = await makeHarness());
    });

    it("creates a pending record whose read carries the CNAME and ownership TXT", async () => {
      const created = await provider.create({ hostname: host });
      expect(created.hostname).toBe(host);
      expect(created.providerId).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
      expect(created.hostnameState).toBe("pending");
      expect(created.certificateState).toBe("pending");
      expect(isServable(created)).toBe(false);
      expect(created.instructions).toContainEqual({
        kind: "cname",
        name: host,
        target: provider.routingTarget(),
      });
      const ownership = created.instructions.find(
        (i) => i.kind === "txt" && i.purpose === "ownership",
      );
      expect(ownership).toMatchObject({ kind: "txt", name: `_cf-custom-hostname.${host}` });
      expect(created.instructions).toContainEqual(
        expect.objectContaining({ kind: "txt", name: `_acme-challenge.${host}` }),
      );
      const read = await provider.get(created.providerId, host);
      expect(read?.providerId).toBe(created.providerId);
      expect(read?.instructions).toEqual(created.instructions);
    });

    it("refuses a duplicate create with already_exists", async () => {
      await provider.create({ hostname: host });
      expect(await rejectedCode(provider.create({ hostname: host }))).toBe("already_exists");
    });

    it("surfaces a 429 with its retry-after as unavailable, with no effect", async () => {
      controls.failNext({ status: 429, retryAfterSeconds: 30 });
      const error = await unavailable(provider.create({ hostname: host }));
      expect(error.status).toBe(429);
      expect(error.retryAfterSeconds).toBe(30);
      expect(await provider.findByHostname(host)).toBeNull();
    });

    it("surfaces a 5xx as unavailable, with no effect", async () => {
      controls.failNext({ status: 503 });
      const error = await unavailable(provider.create({ hostname: host }));
      expect(error.status).toBe(503);
      expect(error.retryAfterSeconds).toBeNull();
      controls.failNext({ status: 500 });
      expect((await unavailable(provider.findByHostname(host))).status).toBe(500);
      expect(await provider.findByHostname(host)).toBeNull();
    });

    it("surfaces a timeout as unavailable with no status, with no effect", async () => {
      controls.timeoutNext();
      expect((await unavailable(provider.create({ hostname: host }))).status).toBeNull();
      expect(await provider.findByHostname(host)).toBeNull();
    });

    it("after a lost create answer, finds exactly that record by name for adoption", async () => {
      controls.loseNextAnswer();
      expect((await unavailable(provider.create({ hostname: host }))).status).toBeNull();
      const found = await provider.findByHostname(host);
      expect(found?.hostname).toBe(host);
      expect(found?.hostnameState).toBe("pending");
      const read = await provider.get(found?.providerId ?? "", host);
      expect(read?.providerId).toBe(found?.providerId);
      expect(await rejectedCode(provider.create({ hostname: host }))).toBe("already_exists");
    });

    it("never returns a longer name that contains the one asked for", async () => {
      controls.plantRecord(`shop.${host}`);
      controls.plantRecord(`${host}.attacker.example.net`);
      expect(await provider.findByHostname(host)).toBeNull();
    });

    it("never returns a shorter name contained in the one asked for", async () => {
      controls.plantRecord(host);
      expect(await provider.findByHostname(`shop.${host}`)).toBeNull();
      expect(await provider.findByHostname("ook.example.com")).toBeNull();
      expect((await provider.findByHostname(host))?.hostname).toBe(host);
    });

    it("refuses to create over a foreign record already in the zone", async () => {
      controls.plantRecord(host, { foreign: true });
      expect(await rejectedCode(provider.create({ hostname: host }))).toBe("already_exists");
    });

    it("succeeds when removing a record that is already gone", async () => {
      const created = await provider.create({ hostname: host });
      await provider.remove(created.providerId);
      await provider.remove(created.providerId);
      expect(await provider.get(created.providerId, host)).toBeNull();
      expect(await provider.findByHostname(host)).toBeNull();
    });

    it("activates at once when the CNAME is already present", async () => {
      controls.cnamePresent(host);
      const created = await provider.create({ hostname: host });
      expect(created.hostnameState).toBe("active");
      expect(created.certificateState).toBe("active");
      expect(isActivatable(created)).toBe(true);
      expect(isServable(created)).toBe(true);
    });

    it("activates on a refresh once the CNAME appears", async () => {
      const created = await provider.create({ hostname: host });
      controls.cnamePresent(host);
      const refreshed = await provider.refreshValidation(created.providerId, host);
      expect(isActivatable(refreshed)).toBe(true);
    });

    it("refuses a read whose record names another hostname", async () => {
      const created = await provider.create({ hostname: host });
      const other = "other.example.com";
      expect(await rejectedCode(provider.get(created.providerId, other))).toBe("hostname_mismatch");
      expect(await rejectedCode(provider.refreshValidation(created.providerId, other))).toBe(
        "hostname_mismatch",
      );
    });

    it("does not activate an active hostname whose certificate is pending", async () => {
      const created = await provider.create({ hostname: host });
      controls.advance(host, { hostnameState: "active" });
      const read = await provider.get(created.providerId, host);
      expect(read?.hostnameState).toBe("active");
      expect(read?.certificateState).toBe("pending");
      expect(read && isActivatable(read)).toBe(false);
      expect(read && isServable(read)).toBe(false);
    });

    it("serves an expiring certificate but does not activate on it", async () => {
      const created = await provider.create({ hostname: host });
      controls.advance(host, { hostnameState: "active", certificateState: "expiring" });
      const read = await provider.get(created.providerId, host);
      expect(read?.certificateState).toBe("expiring");
      expect(read && isServable(read)).toBe(true);
      expect(read && isActivatable(read)).toBe(false);
    });

    it("reports provider errors as lowercase codes", async () => {
      const created = await provider.create({ hostname: host });
      controls.advance(host, { errors: ["cname_not_found"] });
      const read = await provider.get(created.providerId, host);
      expect(read?.errors.length).toBeGreaterThan(0);
      for (const code of read?.errors ?? []) expect(code).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
    });

    it("returns null for an absent id and not_found when refreshing one", async () => {
      const created = await provider.create({ hostname: host });
      await provider.remove(created.providerId);
      expect(await provider.get(created.providerId, host)).toBeNull();
      expect(await rejectedCode(provider.refreshValidation(created.providerId, host))).toBe(
        "not_found",
      );
    });

    it("refuses an id that could change a request path", async () => {
      expect(await rejectedCode(provider.get("../other", host))).toBe("invalid_provider_id");
      expect(await rejectedCode(provider.remove("a/b"))).toBe("invalid_provider_id");
    });
  });
}
