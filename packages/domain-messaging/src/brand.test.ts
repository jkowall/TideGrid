import { describe, expect, it } from "vitest";
import { deliverySender } from "./brand.ts";

// Pull request review fix G1: a stored sender is checked again at delivery.
describe("the sender a stored message goes out under (W1-SENDER-GUARD)", () => {
  const brand = { name: "Guard Impostor Tours" };

  it("keeps a stored name that reads as the brand's name, and a clean reply-to", () => {
    expect(
      deliverySender(
        { fromName: "GUARD IMPOSTOR TOURS", replyTo: "hello@guard-harbor.test" },
        brand,
      ),
    ).toEqual({ fromName: "GUARD IMPOSTOR TOURS", replyTo: "hello@guard-harbor.test" });
  });

  it.each([
    ["another operator", "Guard Reef Divers"],
    ["the brand's name with text appended", "Guard Impostor Tours 2"],
    ["TideGrid", "TideGrid"],
    ["a TideGrid lookalike under some reading", "T!de!Gr!d"],
    ["staff words", "Customer Support"],
    ["a control character", "Guard Impostor\r\nBcc: x@example.test"],
  ])("replaces a stored name of %s with the brand's name", (_label, fromName) => {
    expect(deliverySender({ fromName, replyTo: null }, brand).fromName).toBe(
      "Guard Impostor Tours",
    );
  });

  it.each([
    ["a TideGrid domain", "support@tidegrid.us"],
    ["TideGrid in the local part", "tidegrid.support@guard-harbor.test"],
    ["a digit reading", "tide1grid@guard-harbor.test"],
    ["an internationalized domain", "support@xn--tdegrd-pvfe.test"],
  ])("drops a stored reply-to on %s", (_label, replyTo) => {
    expect(deliverySender({ fromName: "Guard Impostor Tours", replyTo }, brand).replyTo).toBeNull();
  });

  it("falls back to the brand's name when it is the neutral fallback", () => {
    expect(
      deliverySender(
        { fromName: "Guard Reef Divers", replyTo: null },
        { name: "Your trip operator" },
      ),
    ).toEqual({ fromName: "Your trip operator", replyTo: null });
  });
});
