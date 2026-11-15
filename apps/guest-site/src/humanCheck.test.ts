// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { humanToken, setHumanCheck } from "./humanCheck.ts";

afterEach(() => {
  setHumanCheck(undefined);
  delete window.turnstile;
  vi.useRealTimers();
});

describe("Turnstile human check (W3-OPS-4)", () => {
  it("gives no token and loads nothing without a site key", async () => {
    expect(await humanToken("checkout")).toBeNull();
    expect(document.querySelector('script[src*="challenges.cloudflare.com"]')).toBeNull();
  });

  it("renders for the action, returns the token, and cleans up", async () => {
    const removed: string[] = [];
    let options: Record<string, unknown> = {};
    window.turnstile = {
      render: (_el, o) => {
        options = o as unknown as Record<string, unknown>;
        return "w1";
      },
      execute: () => (options.callback as (t: string) => void)("tok-123"),
      remove: (id) => removed.push(id),
    };
    setHumanCheck({ siteKey: "0x4AAAAAAAtest" });
    expect(await humanToken("dock_lookup")).toBe("tok-123");
    expect(options).toMatchObject({
      sitekey: "0x4AAAAAAAtest",
      action: "dock_lookup",
      appearance: "interaction-only",
      execution: "execute",
    });
    expect(removed).toEqual(["w1"]);
    expect(document.querySelector(".human-check")).toBeNull();
  });

  it("throws when Cloudflare refuses", async () => {
    let options: Record<string, unknown> = {};
    window.turnstile = {
      render: (_el, o) => {
        options = o as unknown as Record<string, unknown>;
        return "w2";
      },
      execute: () => (options["error-callback"] as () => void)(),
      remove: () => {},
    };
    setHumanCheck({ siteKey: "0x4AAAAAAAtest" });
    await expect(humanToken("checkout")).rejects.toThrow();
  });

  it("gives up on a stalled script load, removes it, and loads afresh on the next try", async () => {
    vi.useFakeTimers();
    setHumanCheck({ siteKey: "0x4AAAAAAAtest" });
    const first = humanToken("checkout");
    const failed = expect(first).rejects.toThrow(/timed out/);
    expect(document.querySelectorAll('script[src*="challenges.cloudflare.com"]')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(15_000);
    await failed;
    expect(document.querySelector('script[src*="challenges.cloudflare.com"]')).toBeNull();
    const second = humanToken("checkout");
    second.catch(() => {});
    expect(document.querySelectorAll('script[src*="challenges.cloudflare.com"]')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(second).rejects.toThrow();
  });
});
