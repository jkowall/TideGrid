import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("zod on the guest site", () => {
  it("never compiles code while building or running the public contract", async () => {
    const compiled: unknown[][] = [];
    const RealFunction = globalThis.Function;
    // Under the guest CSP, `new Function` is a violation even when caught.
    globalThis.Function = new Proxy(RealFunction, {
      construct(target, args, newTarget) {
        compiled.push(args);
        return Reflect.construct(target, args, newTarget);
      },
      apply(target, self, args) {
        compiled.push(args);
        return Reflect.apply(target, self, args);
      },
    });
    try {
      await import("./zod-jitless.ts");
      const { PublicExperienceResponse, TripAvailabilityResponse } = await import(
        "@tidegrid/contracts"
      );
      const result = PublicExperienceResponse.safeParse({
        tenant: { slug: "demo-harbor", name: "Demo Harbor Charters" },
      });
      expect(result.success).toBe(true);
      // The trips list parses every response against the contract too.
      const trips = TripAvailabilityResponse.safeParse({
        trips: [
          {
            tripId: "bc5f3492-d330-487d-8078-7221db331601",
            timeZone: "America/New_York",
            localDate: "2026-11-01",
            localStartTime: "08:00",
            startsAt: "2026-11-01T13:00:00.000Z",
            endsAt: "2026-11-01T17:00:00.000Z",
            startsAtLocal: "2026-11-01T08:00:00-05:00",
            endsAtLocal: "2026-11-01T12:00:00-05:00",
            durationMinutes: 240,
            product: {
              id: "4f51db31-f9aa-492a-ad2b-05d7c1c3cb2b",
              name: "Private Half-Day Charter",
              kind: "private_charter",
              summary: "The whole boat for your group.",
              minPartySize: 1,
              maxPartySize: 12,
            },
            location: { name: "Harbor Marina, Dock C", meetingPoint: "Dock C, slip 14" },
            salesCloseAt: "2026-10-31T13:00:00.000Z",
            capacity: { kind: "whole_boat", total: 12, remaining: 12 },
          },
        ],
      });
      expect(trips.success).toBe(true);
    } finally {
      globalThis.Function = RealFunction;
    }
    expect(compiled).toEqual([]);
  });

  it("is configured before anything else loads", () => {
    const main = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");
    const firstImport = /^import\s+["']([^"']+)["'];?$/m.exec(main)?.[1];
    expect(firstImport).toBe("./zod-jitless.ts");
    expect(main.indexOf('import "./zod-jitless.ts"')).toBe(main.indexOf("import "));
  });
});
