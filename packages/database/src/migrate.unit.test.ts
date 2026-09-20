import { describe, expect, it } from "vitest";
import { loadMigrations } from "./migrate.ts";

describe("migration files", () => {
  it("are named NNNN_description.sql, ordered, and unique", async () => {
    const files = await loadMigrations();
    expect(files.length).toBeGreaterThan(0);
    const numbers = files.map((f) => Number(f.name.slice(0, 4)));
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(numbers[0]).toBe(1);
  });

  it("have stable checksums", async () => {
    const [a, b] = await Promise.all([loadMigrations(), loadMigrations()]);
    expect(a.map((f) => f.checksum)).toEqual(b.map((f) => f.checksum));
  });
});
