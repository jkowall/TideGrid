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
      const { PublicExperienceResponse } = await import("@tidegrid/contracts");
      const result = PublicExperienceResponse.safeParse({
        tenant: { slug: "demo-harbor", name: "Demo Harbor Charters" },
      });
      expect(result.success).toBe(true);
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
