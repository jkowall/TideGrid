import { describe, expect, it } from "vitest";
import { deliveryEnvironment } from "./delivery.ts";

describe("delivery host rules (G2.14b)", () => {
  it("uses the strict deployed rules when the caller names no environment", () => {
    expect(deliveryEnvironment({})).toBe("production");
    expect(deliveryEnvironment({ environment: "local" })).toBe("local");
    expect(deliveryEnvironment({ environment: "preview" })).toBe("preview");
  });
});
