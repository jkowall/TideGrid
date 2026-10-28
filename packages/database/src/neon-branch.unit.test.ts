import { describe, expect, it } from "vitest";
import { createBody, createBranch, deleteBranch, parseCreateArgs } from "./neon-branch.ts";

const env = { NEON_API_KEY: "test-key-not-real", NEON_PROJECT_ID: "proj-test" };

function recorder(responses: Record<string, { status: number; body: string }>) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    const key = Object.keys(responses).find((k) => url.includes(k));
    const r = key ? responses[key] : undefined;
    return new Response(r?.body ?? "", { status: r?.status ?? 500 });
  };
  return { calls, deps: { fetch, env } };
}

describe("neon-branch create options", () => {
  const now = Date.parse("2026-11-01T12:00:00Z");

  it("keeps the throwaway default: 6 h expiry and a 0.25 to 1 CU endpoint", () => {
    const { options } = parseCreateArgs(["ci-x"], now);
    expect(createBody("ci-x", options, now)).toEqual({
      branch: { name: "ci-x", expires_at: "2026-11-01T18:00:00.000Z" },
      endpoints: [
        { type: "read_write", autoscaling_limit_min_cu: 0.25, autoscaling_limit_max_cu: 1 },
      ],
    });
    // No --out: the connection string is never fetched.
    expect(options.withConnectionString).toBe(false);
  });

  it("makes a backup branch with no expiry and no compute", () => {
    const { options, out } = parseCreateArgs(["pre-nov1-abc1234", "--no-expiry", "--no-endpoint"]);
    expect(out).toBeNull();
    expect(createBody("pre-nov1-abc1234", options, now)).toEqual({
      branch: { name: "pre-nov1-abc1234" },
    });
  });

  it("takes a TTL in hours", () => {
    const { options } = parseCreateArgs(["b", "--ttl", "168"], now);
    expect(createBody("b", options, now).branch).toEqual({
      name: "b",
      expires_at: "2026-11-08T12:00:00.000Z",
    });
  });

  it("refuses contradictions and bad input", () => {
    expect(() => parseCreateArgs(["b", "--ttl", "5", "--no-expiry"])).toThrow(/contradict/);
    expect(() => parseCreateArgs(["b", "--ttl", "0"])).toThrow(/--ttl/);
    expect(() => parseCreateArgs(["b", "--ttl", "721"])).toThrow(/--ttl/);
    expect(() => parseCreateArgs(["b", "--ttl", "1.5"])).toThrow(/--ttl/);
    expect(() => parseCreateArgs(["b", "--no-endpoint", "--out", "/tmp/x"])).toThrow(/endpoint/);
    expect(() => parseCreateArgs(["b", "--out"])).toThrow(/--out/);
    expect(() => parseCreateArgs(["b", "--api-key", "x"])).toThrow(/unknown option/);
    expect(() => parseCreateArgs(["Bad Name"])).toThrow(/branch names/);
  });
});

describe("neon-branch requests (injected fetch, no network)", () => {
  it("skips the connection_uri call without --out", async () => {
    const { calls, deps } = recorder({
      "/branches": { status: 201, body: JSON.stringify({ branch: { id: "br-1" } }) },
    });
    const { options } = parseCreateArgs(["pre-nov1-x", "--no-expiry", "--no-endpoint"]);
    const result = await createBranch("pre-nov1-x", options, deps);
    expect(result).toEqual({ branchId: "br-1", connectionString: null });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST https://console.neon.tech/api/v2/projects/proj-test/branches",
    ]);
    expect(calls[0]?.body).toEqual({ branch: { name: "pre-nov1-x" } });
  });

  it("fetches the URI only when it has a private file to go to", async () => {
    const { calls, deps } = recorder({
      "/branches": { status: 201, body: JSON.stringify({ branch: { id: "br-2" } }) },
      "/connection_uri": { status: 200, body: JSON.stringify({ uri: "postgresql://redacted" }) },
    });
    const { options } = parseCreateArgs(["ci-y", "--out", "/nonexistent/uri.json"]);
    const result = await createBranch("ci-y", options, deps);
    expect(result.branchId).toBe("br-2");
    expect(calls).toHaveLength(2);
  });

  it("reports a failure by status only, never the response body", async () => {
    const { deps } = recorder({
      "/branches": { status: 403, body: "secret-looking body postgresql://user:pw@host" },
    });
    const { options } = parseCreateArgs(["ci-z"]);
    await expect(createBranch("ci-z", options, deps)).rejects.toThrow(
      /^Neon POST \/projects\/proj-test\/branches -> 403$/,
    );
  });

  it("treats an already deleted branch as deleted", async () => {
    const { deps } = recorder({ "/branches/br-gone": { status: 404, body: "" } });
    await expect(deleteBranch("br-gone", deps)).resolves.toBeUndefined();
  });
});
