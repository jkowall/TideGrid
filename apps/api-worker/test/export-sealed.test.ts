import {
  FieldKeyringError,
  newFieldKeyringSecret,
  parseFieldKeyring,
  sealContact,
} from "@tidegrid/database";
import { describe, expect, it } from "vitest";
import { openSealedEvidence } from "../src/export-sealed.ts";

const tenant = "11111111-1111-4111-8111-111111111111";

/** The tenant export opens sealed contact details (W3-OPS-4, 0055) into their usual columns. */
describe("export of sealed contact details", () => {
  it("opens a sealed booker and an imported customer, and keeps the tokens", async () => {
    const keyring = await parseFieldKeyring(newFieldKeyringSecret());
    const open = openSealedEvidence(tenant, keyring);
    const booker_sealed = await sealContact(
      keyring,
      { tenantId: tenant, field: "checkout_sessions.booker_sealed" },
      { name: "Ana Example", email: "ana@example.test" },
    );
    expect(
      await open("checkout_sessions", {
        id: "c1",
        booker_name: null,
        booker_email: null,
        booker_sealed,
        booker_email_index: "a".repeat(64),
      }),
    ).toEqual({
      id: "c1",
      booker_name: "Ana Example",
      booker_email: "ana@example.test",
      booker_email_index: "a".repeat(64),
    });
    const contact_sealed = await sealContact(
      keyring,
      { tenantId: tenant, field: "import_customers.contact_sealed" },
      { name: "Jo Example", email: null, phone: "+15555550123" },
    );
    expect(await open("import_customers", { record_id: "r1", contact_sealed })).toEqual({
      record_id: "r1",
      full_name: "Jo Example",
      email: null,
      phone: "+15555550123",
    });
    // A value sealed for one column never opens as another's.
    await expect(
      open("import_customers", { record_id: "r2", contact_sealed: booker_sealed }),
    ).rejects.toThrow();
  });

  it("passes plain rows through, and refuses a sealed one without the keyring", async () => {
    const plain = {
      id: "c2",
      booker_name: "Pat",
      booker_email: "pat@example.test",
      booker_sealed: null,
    };
    expect(await openSealedEvidence(tenant, undefined)("checkout_sessions", plain)).toEqual(plain);
    await expect(
      openSealedEvidence(tenant, undefined)("checkout_sessions", {
        id: "c3",
        booker_sealed: "tgf1:k1:AAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      }),
    ).rejects.toBeInstanceOf(FieldKeyringError);
  });
});
