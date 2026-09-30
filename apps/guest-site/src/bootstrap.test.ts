import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapTimeoutMs, loadExperience, settle } from "./bootstrap.ts";

const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="30"/></svg>';
const tenant = { slug: "demo-harbor", name: "Demo Harbor Charters" };
const brand = {
  version: 1,
  name: "Demo Harbor Charters",
  colors: { primary: "#0b3c5d", accent: "#e0a526" },
  fonts: { display: "fraunces", body: "source-sans-3" },
  logo: {
    src: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
    kind: "mark",
    alt: "Demo Harbor Charters",
    width: 64,
    height: 64,
  },
  contact: { phone: "+13055550142" },
  legal: { terms: "/legal/terms", privacy: "/legal/privacy" },
  locale: "en-US",
  capabilities: [],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Fetch = typeof fetch;
const respond = (make: () => Response | Promise<Response>) => vi.fn<Fetch>(async () => make());

describe("guest bootstrap", () => {
  const saved = { any: AbortSignal.any, timeout: AbortSignal.timeout };

  beforeEach(() => {
    // Safari before 17.4 has no AbortSignal.any; before 16 no AbortSignal.timeout.
    Reflect.deleteProperty(AbortSignal, "any");
    Reflect.deleteProperty(AbortSignal, "timeout");
  });

  afterEach(() => {
    Object.assign(AbortSignal, saved);
    vi.useRealTimers();
  });

  it("loads the brand without AbortSignal.any or AbortSignal.timeout", async () => {
    expect("any" in AbortSignal || "timeout" in AbortSignal).toBe(false);
    const fetchImpl = respond(() => json({ tenant, brand }));
    expect(await loadExperience(undefined, fetchImpl)).toEqual({ kind: "ready", tenant, brand });
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ credentials: "omit" });
  });

  it("returns the identity alone as the not-ready screen", async () => {
    expect(
      await loadExperience(
        undefined,
        respond(() => json({ tenant })),
      ),
    ).toEqual({
      kind: "not-ready",
      tenant,
    });
  });

  it("shows the no-booking-site screen only for the API's tenant_not_found", async () => {
    const notFound = { error: { code: "tenant_not_found", message: "x", requestId: "r" } };
    expect(
      await loadExperience(
        undefined,
        respond(() => json(notFound, 404)),
      ),
    ).toEqual({
      kind: "not-published",
    });
    for (const body of [
      { error: { code: "not_found", message: "No such route", requestId: "r" } },
      "<html>Not Found</html>",
      null,
    ]) {
      const res = () =>
        typeof body === "string" ? new Response(body, { status: 404 }) : json(body, 404);
      expect(await loadExperience(undefined, respond(res))).toEqual({ kind: "failed" });
    }
  });

  it("maps network errors, server errors, bad JSON, and contract failures to the failed screen", async () => {
    const outcomes = await Promise.all([
      loadExperience(
        undefined,
        vi.fn<Fetch>(async () => {
          throw new TypeError("Failed to fetch");
        }),
      ),
      loadExperience(
        undefined,
        respond(() => json({ error: { code: "brand_unavailable" } }, 503)),
      ),
      loadExperience(
        undefined,
        respond(() => new Response("{not json", { status: 200 })),
      ),
      loadExperience(
        undefined,
        respond(() => json({ tenant, brand: { ...brand, name: "<script>" } })),
      ),
      loadExperience(
        undefined,
        respond(() => json({ tenant: { ...tenant, id: "internal" } })),
      ),
    ]);
    expect(outcomes).toEqual(Array(5).fill({ kind: "failed" }));
  });

  it("gives up after the timeout", async () => {
    vi.useFakeTimers();
    const hang = vi.fn<Fetch>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const pending = loadExperience(undefined, hang);
    await vi.advanceTimersByTimeAsync(bootstrapTimeoutMs);
    expect(await pending).toEqual({ kind: "failed" });
  });

  it("stops when the caller aborts", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const hang = vi.fn<Fetch>((_url, init) => {
      seen = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    });
    const pending = loadExperience(controller.signal, hang);
    controller.abort();
    expect(await pending).toEqual({ kind: "failed" });
    expect(seen?.aborted).toBe(true);
  });

  it("turns a loader that throws into the failed screen", async () => {
    expect(
      await settle(async () => {
        throw new TypeError("AbortSignal.any is not a function");
      }),
    ).toEqual({ kind: "failed" });
  });
});
