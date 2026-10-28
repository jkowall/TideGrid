import { describe, expect, it } from "vitest";
import { createFakeHostnameProvider } from "./fake.ts";
import { describeProviderContract } from "./provider.contract.ts";
import { HostnameProviderUnavailableError } from "./provider.ts";

describeProviderContract("fake", () => {
  const provider = createFakeHostnameProvider();
  return { provider, controls: provider };
});

describe("the fake custom-hostname provider", () => {
  const at = new Date("2026-10-27T12:00:00.000Z");

  it("hands out deterministic ids and tokens, stamped by the injected clock", async () => {
    const a = createFakeHostnameProvider({ clock: () => at });
    const b = createFakeHostnameProvider({ clock: () => at });
    const first = await a.create({ hostname: "book.example.com" });
    const second = await a.create({ hostname: "stay.example.com" });
    expect(first.providerId).toBe("fake-ch-0001");
    expect(second.providerId).toBe("fake-ch-0002");
    expect(first.checkedAt).toEqual(at);
    expect(await b.create({ hostname: "book.example.com" })).toEqual(first);
  });

  it("writes Cloudflare-shaped instructions and raw statuses", async () => {
    const provider = createFakeHostnameProvider();
    const created = await provider.create({ hostname: "book.example.com" });
    expect(provider.routingTarget()).toBe("customers.tidegrid.us");
    expect(created.raw).toEqual({
      hostnameStatus: "pending",
      certificateStatus: "pending_validation",
    });
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(created.instructions).toEqual([
      { kind: "cname", name: "book.example.com", target: "customers.tidegrid.us" },
      {
        kind: "txt",
        name: "_cf-custom-hostname.book.example.com",
        value: expect.stringMatching(uuid),
        purpose: "ownership",
      },
      {
        kind: "txt",
        name: "_acme-challenge.book.example.com",
        value: expect.any(String),
        purpose: "certificate",
      },
      {
        kind: "http",
        url: "http://book.example.com/.well-known/cf-custom-hostname-challenge/fake-ch-0001",
        body: expect.stringMatching(uuid),
        purpose: "ownership",
      },
    ]);
  });

  it("uses a custom routing target", async () => {
    const provider = createFakeHostnameProvider({ routingTarget: "edge.example.net" });
    const created = await provider.create({ hostname: "book.example.com" });
    expect(created.instructions[0]).toEqual({
      kind: "cname",
      name: "book.example.com",
      target: "edge.example.net",
    });
  });

  it("logs every call, faulted ones included", async () => {
    const provider = createFakeHostnameProvider();
    provider.failNext({ status: 503 });
    await expect(provider.create({ hostname: "book.example.com" })).rejects.toBeInstanceOf(
      HostnameProviderUnavailableError,
    );
    const created = await provider.create({ hostname: "book.example.com" });
    await provider.get(created.providerId, "book.example.com");
    await provider.remove(created.providerId);
    expect(provider.calls).toEqual([
      { method: "create", hostname: "book.example.com" },
      { method: "create", hostname: "book.example.com" },
      { method: "get", providerId: "fake-ch-0001", hostname: "book.example.com" },
      { method: "remove", providerId: "fake-ch-0001" },
    ]);
  });

  it("keeps a lost create in its records and marks planted foreign ones", async () => {
    const provider = createFakeHostnameProvider({ clock: () => at });
    provider.plantRecord("shop.example.com", { foreign: true });
    provider.loseNextAnswer();
    await expect(provider.create({ hostname: "book.example.com" })).rejects.toBeInstanceOf(
      HostnameProviderUnavailableError,
    );
    expect(provider.records()).toEqual([
      expect.objectContaining({ hostname: "shop.example.com", foreign: true }),
      expect.objectContaining({ hostname: "book.example.com", foreign: false, createdAt: at }),
    ]);
  });

  it("follows advance with matching raw strings", async () => {
    const provider = createFakeHostnameProvider();
    const created = await provider.create({ hostname: "book.example.com" });
    provider.advance("book.example.com", {
      hostnameState: "blocked",
      certificateState: "failed",
      errors: ["blocked_by_policy"],
    });
    const read = await provider.get(created.providerId, "book.example.com");
    expect(read).toMatchObject({
      hostnameState: "blocked",
      certificateState: "failed",
      raw: { hostnameStatus: "blocked", certificateStatus: "validation_timed_out" },
      errors: ["blocked_by_policy"],
    });
    expect(() => provider.advance("missing.example.com", { hostnameState: "active" })).toThrow();
  });

  it("refuses a hostname that is not in normalized form", async () => {
    const provider = createFakeHostnameProvider();
    await expect(provider.create({ hostname: "Book.Example.com" })).rejects.toMatchObject({
      code: "invalid_hostname",
    });
  });
});
