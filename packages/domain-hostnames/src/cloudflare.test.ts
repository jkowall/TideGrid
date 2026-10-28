import { describe, expect, it } from "vitest";
import { createCloudflareHostnameProvider } from "./cloudflare.ts";
import { createCloudflareFixture } from "./cloudflare-fixture.ts";
import { describeProviderContract } from "./provider.contract.ts";
import {
  HostnameProviderRejectedError,
  HostnameProviderUnavailableError,
  isActivatable,
} from "./provider.ts";

const zoneId = "023e105f4ecef8ad9ca31a8372d0c353";
const apiToken = "test-token-Zq7Kx2Lm9Pw4Rt6Vb8Nc";
const routingTarget = "customers.tidegrid.us";
const base = `/client/v4/zones/${zoneId}/custom_hostnames`;
const host = "book.example.com";

function harness() {
  const fixture = createCloudflareFixture({ zoneId, apiToken });
  const events: string[] = [];
  const recordingFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    events.push(`${request.method} ${new URL(request.url).pathname}`);
    return fixture.fetch(request);
  };
  const provider = createCloudflareHostnameProvider({
    zoneId,
    apiToken,
    routingTarget,
    fetch: recordingFetch,
    sleep: async (ms) => {
      events.push(`sleep ${ms}`);
    },
  });
  return { provider, fixture, events };
}

describeProviderContract("cloudflare_saas over the recorded fixture", () => {
  const { provider, fixture } = harness();
  return { provider, controls: fixture };
});

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

function leaks(error: unknown): boolean {
  const e = error as Error & Record<string, unknown>;
  const text = [String(error), e.message, e.stack, JSON.stringify(e), JSON.stringify({ ...e })];
  return text.some((t) => typeof t === "string" && t.includes(apiToken));
}

describe("the Cloudflare for SaaS client", () => {
  it("posts, waits, then reads the new record back by id", async () => {
    const { provider, fixture, events } = harness();
    const created = await provider.create({ hostname: host });
    const id = created.providerId;
    expect(events).toEqual([`POST ${base}`, "sleep 2000", `GET ${base}/${id}`]);
    expect(fixture.requests[0]?.body).toEqual({
      hostname: host,
      ssl: { method: "txt", type: "dv" },
    });
    expect(created.raw).toEqual({
      hostnameStatus: "pending",
      certificateStatus: "pending_validation",
    });
  });

  it("honors a custom delay and the http certificate method", async () => {
    const fixture = createCloudflareFixture({ zoneId, apiToken });
    const waits: number[] = [];
    const provider = createCloudflareHostnameProvider({
      zoneId,
      apiToken,
      routingTarget,
      fetch: fixture.fetch,
      delayedGetMs: 50,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    const created = await provider.create({ hostname: host, certificateValidation: "http" });
    expect(waits).toEqual([50]);
    expect(fixture.requests[0]?.body).toEqual({
      hostname: host,
      ssl: { method: "http", type: "dv" },
    });
    expect(created.instructions).toContainEqual(
      expect.objectContaining({ kind: "http", purpose: "certificate" }),
    );
  });

  it("falls back to the POST answer, without validation records, when the read is 404", async () => {
    const { provider, fixture } = harness();
    fixture.answerNext(
      {
        status: 404,
        body: JSON.stringify({
          success: false,
          errors: [{ code: 1436, message: "The custom hostname was not found." }],
          messages: [],
          result: null,
        }),
      },
      { method: "GET" },
    );
    const created = await provider.create({ hostname: host });
    expect(created.raw.certificateStatus).toBe("initializing");
    expect(created.certificateState).toBe("pending");
    expect(created.instructions.some((i) => "purpose" in i && i.purpose === "certificate")).toBe(
      false,
    );
    expect(created.instructions).toContainEqual(
      expect.objectContaining({ kind: "txt", name: `_cf-custom-hostname.${host}` }),
    );
  });

  it("falls back to the POST answer when the delayed read is unavailable", async () => {
    const { provider, fixture } = harness();
    fixture.answerNext({ status: 503, body: "busy" }, { method: "GET" });
    const created = await provider.create({ hostname: host });
    expect(created.hostname).toBe(host);
    expect(fixture.records().map((r) => r.id)).toEqual([created.providerId]);
  });

  it("looks a name up with hostname.exact only", async () => {
    const { provider, fixture } = harness();
    fixture.plantRecord(host);
    await provider.findByHostname(host);
    const lookup = fixture.requests.at(-1);
    expect(lookup?.method).toBe("GET");
    expect(lookup?.path).toBe(base);
    expect(lookup?.search).toEqual([["hostname.exact", host]]);
  });

  it("keeps only exact matches, and refuses two", async () => {
    const { provider, fixture } = harness();
    const record = (id: string, hostname: string) => ({
      id,
      hostname,
      status: "active",
      ssl: { status: "active" },
    });
    const list = (result: unknown[]) => ({
      status: 200,
      body: JSON.stringify({ success: true, errors: [], messages: [], result }),
    });
    fixture.answerNext(list([record("a1", `shop.${host}`), record("a2", `x${host}`)]));
    expect(await provider.findByHostname(host)).toBeNull();
    fixture.answerNext(list([record("a1", `shop.${host}`), record("a2", host)]));
    expect((await provider.findByHostname(host))?.providerId).toBe("a2");
    fixture.answerNext(list([record("a1", host), record("a2", host)]));
    const error = await caught(provider.findByHostname(host));
    expect((error as HostnameProviderRejectedError).code).toBe("ambiguous_hostname");
  });

  it("uses the documented paths and methods for every call", async () => {
    const { provider, fixture } = harness();
    const created = await provider.create({ hostname: host });
    const id = created.providerId;
    await provider.get(id, host);
    await provider.refreshValidation(id, host);
    await provider.remove(id);
    await provider.remove(id);
    expect(fixture.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      `POST ${base}`,
      `GET ${base}/${id}`,
      `GET ${base}/${id}`,
      `GET ${base}/${id}`,
      `PATCH ${base}/${id}`,
      `DELETE ${base}/${id}`,
      `DELETE ${base}/${id}`,
    ]);
    expect(fixture.requests[4]?.body).toEqual({ ssl: { method: "txt", type: "dv" } });
  });

  it("sends Authorization on every request and never a substring search", async () => {
    const { provider, fixture } = harness();
    fixture.plantRecord(`shop.${host}`);
    const created = await provider.create({ hostname: host });
    await provider.findByHostname(host);
    await provider.findByHostname("ook.example.com");
    await provider.refreshValidation(created.providerId, host);
    await provider.remove(created.providerId);
    expect(fixture.requests.length).toBeGreaterThan(5);
    for (const r of fixture.requests) {
      expect(r.authorization).toBe(true);
      const names = r.search.map(([name]) => name);
      expect(names).not.toContain("hostname.contain");
      expect(names).not.toContain("hostname.startsWith");
      expect(names).not.toContain("hostname");
    }
  });

  it("never puts the token in a thrown value", async () => {
    const { provider, fixture } = harness();
    const errors: unknown[] = [];
    fixture.failNext({ status: 429, retryAfterSeconds: 5 });
    errors.push(await caught(provider.findByHostname(host)));
    fixture.failNext({ status: 500 });
    errors.push(await caught(provider.findByHostname(host)));
    fixture.timeoutNext();
    errors.push(await caught(provider.findByHostname(host)));
    fixture.answerNext({ status: 200, body: "not json" });
    errors.push(await caught(provider.findByHostname(host)));
    fixture.answerNext({ status: 400, body: JSON.stringify({ errors: [{ code: 1409 }] }) });
    errors.push(await caught(provider.findByHostname(host)));
    const wrongToken = createCloudflareHostnameProvider({
      zoneId,
      apiToken: `${apiToken}-wrong`,
      routingTarget,
      fetch: fixture.fetch,
    });
    errors.push(await caught(wrongToken.findByHostname(host)));
    const thrower = createCloudflareHostnameProvider({
      zoneId,
      apiToken,
      routingTarget,
      fetch: async (_input, init) => {
        throw new Error(`refused: ${JSON.stringify(init?.headers)}`);
      },
    });
    errors.push(await caught(thrower.findByHostname(host)));
    expect(errors).toHaveLength(7);
    for (const error of errors) {
      expect(error).toBeInstanceOf(Error);
      expect(leaks(error)).toBe(false);
      expect((error as Error).cause).toBeUndefined();
    }
  });

  it("maps 4xx answers to rejected codes", async () => {
    const { provider, fixture } = harness();
    const envelope = (code: unknown) =>
      JSON.stringify({ success: false, errors: [{ code, message: "x" }], result: null });
    fixture.answerNext({ status: 400, body: envelope(1409) });
    expect(((await caught(provider.findByHostname(host))) as { code: string }).code).toBe(
      "cloudflare_1409",
    );
    fixture.answerNext({ status: 400, body: envelope("not-a-number") });
    expect(((await caught(provider.findByHostname(host))) as { code: string }).code).toBe(
      "http_400",
    );
    fixture.answerNext({ status: 403, body: "<html>forbidden</html>" });
    expect(((await caught(provider.findByHostname(host))) as { code: string }).code).toBe(
      "http_403",
    );
    fixture.answerNext({ status: 400, body: envelope(1406) });
    expect(((await caught(provider.create({ hostname: host }))) as { code: string }).code).toBe(
      "already_exists",
    );
  });

  it("keeps the HTTP status on a refusal, so a 401 or 403 reads as account-level", async () => {
    const { provider, fixture } = harness();
    const envelope = (code: unknown) =>
      JSON.stringify({ success: false, errors: [{ code, message: "x" }], result: null });
    for (const status of [401, 403, 400]) {
      fixture.answerNext({ status, body: envelope(1234) });
      const error = (await caught(provider.get("abc", host))) as HostnameProviderRejectedError;
      expect({ code: error.code, httpStatus: error.httpStatus }).toEqual({
        code: "cloudflare_1234",
        httpStatus: status,
      });
    }
  });

  it("reads retry-after only as whole seconds", async () => {
    const { provider, fixture } = harness();
    fixture.answerNext({
      status: 429,
      body: "{}",
      headers: { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" },
    });
    const dated = (await caught(provider.findByHostname(host))) as HostnameProviderUnavailableError;
    expect(dated).toBeInstanceOf(HostnameProviderUnavailableError);
    expect(dated.retryAfterSeconds).toBeNull();
    fixture.answerNext({ status: 429, body: "{}", headers: { "retry-after": "-1" } });
    expect(
      ((await caught(provider.findByHostname(host))) as HostnameProviderUnavailableError)
        .retryAfterSeconds,
    ).toBeNull();
    fixture.answerNext({ status: 503, body: "", headers: { "retry-after": "120" } });
    const later = (await caught(provider.findByHostname(host))) as HostnameProviderUnavailableError;
    expect(later.status).toBe(503);
    expect(later.retryAfterSeconds).toBe(120);
  });

  it("treats a fetch that throws as unavailable with no status", async () => {
    const provider = createCloudflareHostnameProvider({
      zoneId,
      apiToken,
      routingTarget,
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    const error = (await caught(provider.get("abc", host))) as HostnameProviderUnavailableError;
    expect(error).toBeInstanceOf(HostnameProviderUnavailableError);
    expect(error.status).toBeNull();
  });

  it("rejects malformed answers", async () => {
    const { provider, fixture } = harness();
    const created = await provider.create({ hostname: host });
    const id = created.providerId;
    const bodies = [
      "not json",
      JSON.stringify({ result: {} }),
      JSON.stringify({ success: false, errors: [], result: null }),
      JSON.stringify({ success: true, errors: [], result: { hostname: host, status: "active" } }),
      JSON.stringify({
        success: true,
        errors: [],
        result: { id: "../../zones", hostname: host, status: "active" },
      }),
      JSON.stringify({ success: true, errors: [], result: { id, hostname: host, status: 7 } }),
      JSON.stringify({
        success: true,
        errors: [],
        result: {
          id,
          hostname: host,
          status: "active",
          ssl: { status: "active", validation_records: "x" },
        },
      }),
    ];
    for (const body of bodies) {
      fixture.answerNext({ status: 200, body });
      const error = await caught(provider.get(id, host));
      expect(error).toBeInstanceOf(HostnameProviderRejectedError);
      expect((error as HostnameProviderRejectedError).code).toBe("malformed_response");
    }
    fixture.answerNext({ status: 200, body: JSON.stringify({ success: true, result: {} }) });
    expect(((await caught(provider.findByHostname(host))) as { code: string }).code).toBe(
      "malformed_response",
    );
  });

  // UNVERIFIED against live Cloudflare: whether a routine renewal reports
  // ssl.status pending_validation while the current certificate still serves.
  // Listed for G2.14b-live. Whatever the answer, a pending certificate is not
  // a definitive negative, so the sweep records it and demotes nothing.
  it("reads a certificate renewal on an active hostname as pending, not failed", async () => {
    const { provider, fixture } = harness();
    fixture.answerNext({
      status: 200,
      body: JSON.stringify({
        success: true,
        errors: [],
        messages: [],
        result: {
          id: "renewing",
          hostname: host,
          status: "active",
          ssl: { status: "pending_validation", validation_records: [] },
        },
      }),
    });
    const read = await provider.get("renewing", host);
    expect(read).toMatchObject({ hostnameState: "active", certificateState: "pending" });
    expect(read && isActivatable(read)).toBe(false);
  });

  it("allows extra fields and maps unknown statuses fail-closed", async () => {
    const { provider, fixture } = harness();
    fixture.answerNext({
      status: 200,
      body: JSON.stringify({
        success: true,
        errors: [],
        messages: [],
        result: {
          id: "abc",
          hostname: host,
          status: "brand_new_state",
          ssl: { status: "another_new_state", future_field: true },
          future_field: { nested: 1 },
        },
      }),
    });
    const read = await provider.get("abc", host);
    expect(read).toMatchObject({
      hostnameState: "unknown",
      certificateState: "unknown",
      raw: { hostnameStatus: "brand_new_state", certificateStatus: "another_new_state" },
    });
  });

  it("refuses a bad zone id, token, routing target, or API base at construction", () => {
    const make = (overrides: Record<string, unknown>) => () =>
      createCloudflareHostnameProvider({ zoneId, apiToken, routingTarget, ...overrides });
    expect(make({})).not.toThrow();
    for (const bad of [
      "",
      "023E105F4ECEF8AD9CA31A8372D0C353",
      "023e105f4ecef8ad9ca31a8372d0c35",
      "023e105f4ecef8ad9ca31a8372d0c3533",
      "023e105f4ecef8ad9ca31a8372d0c35g",
      "023e105f4ecef8ad9ca31a8372d0c35/",
      " 023e105f4ecef8ad9ca31a8372d0c353",
    ]) {
      expect(make({ zoneId: bad })).toThrow(TypeError);
    }
    expect(make({ apiToken: "" })).toThrow(TypeError);
    expect(make({ apiToken: "   " })).toThrow(TypeError);
    expect(make({ routingTarget: "" })).toThrow();
    expect(make({ apiBase: "http://api.cloudflare.com/client/v4" })).toThrow(TypeError);
  });

  it("refuses a bad id or hostname before any request", async () => {
    const { provider, fixture } = harness();
    for (const id of ["", "../x", "a/b", "a?b", "a%2fb", "x".repeat(65)]) {
      expect(((await caught(provider.get(id, host))) as { code: string }).code).toBe(
        "invalid_provider_id",
      );
    }
    for (const name of ["", "Book.example.com", "book.example.com.", "a b.example.com"]) {
      expect(((await caught(provider.findByHostname(name))) as { code: string }).code).toBe(
        "invalid_hostname",
      );
    }
    expect(fixture.requests).toHaveLength(0);
  });

  it("refuses a create answer that names another hostname", async () => {
    const { provider, fixture } = harness();
    fixture.answerNext(
      {
        status: 200,
        body: JSON.stringify({
          success: true,
          errors: [],
          result: { id: "abc", hostname: "other.example.com", status: "pending" },
        }),
      },
      { method: "POST" },
    );
    expect(((await caught(provider.create({ hostname: host }))) as { code: string }).code).toBe(
      "hostname_mismatch",
    );
  });
});
