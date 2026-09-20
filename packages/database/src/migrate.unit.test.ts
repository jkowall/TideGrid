import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("migration loader strictness", () => {
  async function dirWith(names: string[]) {
    const dir = await mkdtemp(join(tmpdir(), "tg-mig-"));
    for (const n of names) await writeFile(join(dir, n), "SELECT 1;");
    return dir;
  }

  it("rejects a file that does not match the naming rule", async () => {
    const dir = await dirWith(["0001_ok.sql", "0002_AddTenants.sql"]);
    await expect(loadMigrations(dir)).rejects.toThrow(/rejected: 0002_AddTenants.sql/);
  });

  it("rejects a gap in numbering", async () => {
    const dir = await dirWith(["0001_ok.sql", "0003_gap.sql"]);
    await expect(loadMigrations(dir)).rejects.toThrow(/contiguous/);
  });

  it("accepts a contiguous, well-named set", async () => {
    const dir = await dirWith(["0001_ok.sql", "0002_also_ok.sql"]);
    const files = await loadMigrations(dir);
    expect(files.map((f) => f.name)).toEqual(["0001_ok.sql", "0002_also_ok.sql"]);
  });
});
