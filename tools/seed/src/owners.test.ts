import { describe, expect, it } from "vitest";
import { parseSeedOwners } from "./owners.ts";

const slugs = ["demo-harbor", "demo-reef"];

describe("seed owner addresses", () => {
  it("keeps SEED_OWNER_EMAILS as owners of both operators, named by local part", () => {
    expect(
      parseSeedOwners({ SEED_OWNER_EMAILS: " A.One@Owner.test ,b@owner.test" }, slugs),
    ).toEqual([
      { email: "a.one@owner.test", name: "a.one", tenants: [0, 1] },
      { email: "b@owner.test", name: "b", tenants: [0, 1] },
    ]);
  });

  it("adds a single-tenant owner and a synthetic display name for new rows", () => {
    expect(
      parseSeedOwners(
        {
          SEED_OWNER_EMAILS: "a@owner.test",
          SEED_SINGLE_TENANT_OWNER: "Solo@Owner.test:demo-harbor",
          SEED_OWNER_DISPLAY_NAME: "Harbor Desk Owner",
        },
        slugs,
      ),
    ).toEqual([
      { email: "a@owner.test", name: "Harbor Desk Owner", tenants: [0, 1] },
      { email: "solo@owner.test", name: "Harbor Desk Owner", tenants: [0] },
    ]);
  });

  it("refuses a single-tenant address that is also a two-tenant owner", () => {
    expect(() =>
      parseSeedOwners(
        { SEED_OWNER_EMAILS: "a@owner.test", SEED_SINGLE_TENANT_OWNER: "A@owner.test:demo-reef" },
        slugs,
      ),
    ).toThrow(/also in SEED_OWNER_EMAILS/);
  });

  it("refuses malformed values", () => {
    for (const single of ["solo@owner.test", "solo@owner.test:", ":demo-reef", "x:demo-reef"]) {
      expect(() => parseSeedOwners({ SEED_SINGLE_TENANT_OWNER: single }, slugs)).toThrow(
        /SEED_SINGLE_TENANT_OWNER/,
      );
    }
    expect(() =>
      parseSeedOwners({ SEED_SINGLE_TENANT_OWNER: "solo@owner.test:demo-nowhere" }, slugs),
    ).toThrow(/unknown tenant/);
    for (const name of ["a@b.test", " Padded", "x".repeat(121), "line\nbreak"]) {
      expect(() => parseSeedOwners({ SEED_OWNER_DISPLAY_NAME: name }, slugs)).toThrow(
        /SEED_OWNER_DISPLAY_NAME/,
      );
    }
    expect(() => parseSeedOwners({ SEED_OWNER_EMAILS: "not-an-address" }, slugs)).toThrow(
      /invalid address/,
    );
  });

  it("is empty when nothing is set", () => {
    expect(parseSeedOwners({}, slugs)).toEqual([]);
  });
});
