import { checkContent } from "@tidegrid/domain-messaging";
import { describe, expect, it } from "vitest";
import { elide, waiverRequestEmail } from "./email.ts";

const long = (label: string) => `${label} ${"x".repeat(120)}`.slice(0, 120);

describe("the waiver request email", () => {
  it("fits the messaging module's limits with every name at its longest", () => {
    for (const requiredSigner of ["participant", "guardian"] as const) {
      const content = waiverRequestEmail({
        requiredSigner,
        participantName: long("Participant"),
        recipientName: long("Guardian"),
        operatorName: long("Operator"),
        trip: {
          name: long("Product"),
          when: "Saturday, November 7, 2026 at 6:00 PM EST",
          place: long("Place"),
          bookingReference: "7KQ2M9XA",
        },
        linkDays: 7,
        kind: "initial",
      });
      expect(() => checkContent(content)).not.toThrow();
      expect([...content.subject].length).toBeLessThanOrEqual(200);
      expect(content.subject).not.toMatch(/[\r\n]/);
    }
  });

  it("keeps short names whole and cuts long ones with an ellipsis", () => {
    expect(elide("Ann Adult", 60)).toBe("Ann Adult");
    const cut = elide("A".repeat(70), 60);
    expect([...cut].length).toBe(60);
    expect(cut.endsWith("…")).toBe(true);
    // Never splits a character outside the basic plane in two.
    expect(elide("\u{1F30A}".repeat(5), 3)).toBe("\u{1F30A}\u{1F30A}…");
  });
});
