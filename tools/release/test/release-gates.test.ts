import { describe, expect, it } from "vitest";
import { main } from "../src/cli.ts";
import { releaseGateFor } from "../src/commands/release.ts";
import { fakeDeps, providerExecs } from "./helpers.ts";

describe("a release needs the gate of its phase", () => {
  it("pins the phase-to-gate table", () => {
    expect(releaseGateFor).toEqual({
      p3: "A4",
      p4: "A4",
      p7: "A8",
      p8: "A10",
      p9: "A13",
      p10: "A17",
      p11: "A19",
    });
  });

  it("refuses another phase's gate, and a phase with no release", async () => {
    for (const argv of [
      ["release", "api", "--phase", "p7", "--live", "--go", "A4"],
      ["release", "guest", "--phase", "p4", "--live", "--go", "A10"],
      ["release", "api", "--phase", "p6", "--live", "--go", "A4"],
    ]) {
      const { deps, execs, fetches } = fakeDeps({ answers: ["tidegrid-api", "tidegrid-guest"] });
      expect(await main(argv, deps)).toBe(3);
      expect(providerExecs(execs)).toEqual([]);
      expect(fetches).toEqual([]);
    }
  });
});
