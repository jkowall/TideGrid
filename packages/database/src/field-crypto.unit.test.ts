import { describe, expect, it } from "vitest";
import {
  blindIndex,
  FieldDecryptError,
  FieldKeyringError,
  newFieldKeyringSecret,
  openField,
  parseFieldKeyring,
  sealedKeyId,
  sealField,
} from "./field-crypto.ts";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const place = { tenantId: T1, field: "waiver_evidence.personal_sealed" };

describe("field encryption", () => {
  it("seals and opens a value, with a fresh IV each time", async () => {
    const keyring = await parseFieldKeyring(newFieldKeyringSecret());
    const a = await sealField(keyring, place, "Ann Ådult");
    const b = await sealField(keyring, place, "Ann Ådult");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^tgf1:k1:[A-Za-z0-9_-]+$/);
    expect(a).not.toContain("Ann");
    expect(sealedKeyId(a)).toBe("k1");
    expect(await openField(keyring, place, a)).toBe("Ann Ådult");
  });

  it("refuses a value moved to another tenant or field, or damaged", async () => {
    const keyring = await parseFieldKeyring(newFieldKeyringSecret());
    const sealed = await sealField(keyring, place, "secret");
    await expect(openField(keyring, { ...place, tenantId: T2 }, sealed)).rejects.toBeInstanceOf(
      FieldDecryptError,
    );
    await expect(
      openField(keyring, { ...place, field: "other.column" }, sealed),
    ).rejects.toBeInstanceOf(FieldDecryptError);
    const flipped = `${sealed.slice(0, -2)}${sealed.endsWith("AA") ? "AB" : "AA"}`;
    await expect(openField(keyring, place, flipped)).rejects.toBeInstanceOf(FieldDecryptError);
    await expect(openField(keyring, place, "plain text")).rejects.toBeInstanceOf(FieldDecryptError);
  });

  it("rotates: new values use the current key, old ones open while their key stays", async () => {
    const first = JSON.parse(newFieldKeyringSecret("k1")) as {
      keys: Record<string, string>;
      index: string;
    };
    const second = JSON.parse(newFieldKeyringSecret("k2")) as { keys: Record<string, string> };
    const old = await parseFieldKeyring(JSON.stringify({ current: "k1", ...first }));
    const sealedOld = await sealField(old, place, "before");
    const rotated = await parseFieldKeyring(
      JSON.stringify({
        current: "k2",
        keys: { ...first.keys, ...second.keys },
        index: first.index,
      }),
    );
    const sealedNew = await sealField(rotated, place, "after");
    expect(sealedKeyId(sealedNew)).toBe("k2");
    expect(await openField(rotated, place, sealedOld)).toBe("before");
    const retired = await parseFieldKeyring(
      JSON.stringify({ current: "k2", keys: second.keys, index: first.index }),
    );
    await expect(openField(retired, place, sealedOld)).rejects.toMatchObject({ keyId: "k1" });
    // The index key did not change, so tokens stay the same across a rotation.
    expect(await blindIndex(old, T1, "email", "a@example.test")).toBe(
      await blindIndex(rotated, T1, "email", "a@example.test"),
    );
  });

  it("gives blind index tokens per tenant and purpose", async () => {
    const keyring = await parseFieldKeyring(newFieldKeyringSecret());
    const a = await blindIndex(keyring, T1, "email", "a@example.test");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await blindIndex(keyring, T1, "email", "a@example.test")).toBe(a);
    expect(await blindIndex(keyring, T2, "email", "a@example.test")).not.toBe(a);
    expect(await blindIndex(keyring, T1, "name", "a@example.test")).not.toBe(a);
  });

  it("refuses malformed keyrings without echoing a key", async () => {
    const good = JSON.parse(newFieldKeyringSecret()) as Record<string, unknown>;
    for (const bad of [
      "not json",
      JSON.stringify({ ...good, current: "K1" }),
      JSON.stringify({ ...good, current: "k9" }),
      JSON.stringify({ ...good, keys: { k1: "c2hvcnQ=" } }),
      JSON.stringify({ ...good, index: undefined }),
    ]) {
      const err = await parseFieldKeyring(bad).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FieldKeyringError);
      expect(String((err as Error).message)).not.toContain(String(good.index));
    }
  });
});
