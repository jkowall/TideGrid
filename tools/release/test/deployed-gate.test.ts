import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertDeployedRunAllowed,
  deployedBaseUrl,
  privateDir,
  privateFile,
} from "../src/deployed-gate.ts";

const ok = { NOV1_GO: "A5" };

describe("deployed Playwright gate (invariants 1 and 10)", () => {
  it("allows a terminal run with the go nov1 accept sets", () => {
    expect(assertDeployedRunAllowed({ env: ok, stdinIsTTY: true })).toBe("A5");
    expect(assertDeployedRunAllowed({ env: { NOV1_GO: "A10" }, stdinIsTTY: true })).toBe("A10");
  });

  it("refuses under CI, without a terminal, without the go, or with the disable variables", () => {
    const cases: [Record<string, string>, boolean, RegExp][] = [
      [{ ...ok, CI: "true" }, true, /CI is set/],
      [ok, false, /not a terminal/],
      [{}, true, /NOV1_GO/],
      [{ NOV1_GO: "A4" }, true, /NOV1_GO/],
      [{ ...ok, E2E_ADMIN_DATABASE_URL: "postgres://x" }, true, /E2E_ADMIN_DATABASE_URL/],
      [{ ...ok, E2E_DISABLE_HOST: "a.book.tidegrid.us" }, true, /E2E_DISABLE_HOST/],
    ];
    for (const [env, tty, why] of cases) {
      expect(() => assertDeployedRunAllowed({ env, stdinIsTTY: tty })).toThrow(why);
    }
  });

  it("takes only an https origin on a real host", () => {
    expect(deployedBaseUrl("https://{slug}.book.tidegrid.us").hostname).toBe(
      "slug.book.tidegrid.us",
    );
    expect(deployedBaseUrl("https://console.tidegrid.us").origin).toBe(
      "https://console.tidegrid.us",
    );
    for (const bad of [
      undefined,
      "http://console.tidegrid.us",
      "https://localhost",
      "https://demo-harbor.book.localhost",
      "https://127.0.0.1",
      "https://console.tidegrid.us:8443",
      "https://user:pw@console.tidegrid.us",
      "https://console.tidegrid.us/path",
    ]) {
      expect(() => deployedBaseUrl(bad)).toThrow(/refused/);
    }
  });
});

describe("owner-private directory", () => {
  const base = mkdtempSync(join(tmpdir(), "nov1-gate-"));
  const repo = join(base, "repo");
  const home = join(base, "home");
  mkdirSync(repo);
  mkdirSync(join(home, ".claude", "projects"), { recursive: true });

  it("accepts a 0700 directory outside the repository and ~/.claude", () => {
    const dir = join(base, "private");
    mkdirSync(dir, { mode: 0o700 });
    expect(privateDir({ env: { NOV1_PRIVATE_DIR: dir }, repoRoot: repo, home })).toMatch(
      /private$/,
    );
  });

  it("refuses a loose, relative, missing, in-repo, or ~/.claude directory", () => {
    const loose = join(base, "loose");
    mkdirSync(loose);
    chmodSync(loose, 0o755);
    const inRepo = join(repo, "private");
    mkdirSync(inRepo, { mode: 0o700 });
    const inClaude = join(home, ".claude", "projects", "nov1");
    mkdirSync(inClaude, { mode: 0o700 });
    const cases: [string | undefined, RegExp][] = [
      [undefined, /not set/],
      ["relative/dir", /absolute/],
      [join(base, "missing"), /does not exist/],
      [loose, /0700/],
      [inRepo, /inside the repository/],
      [inClaude, /~\/.claude/],
    ];
    for (const [dir, why] of cases) {
      const env = dir === undefined ? {} : { NOV1_PRIVATE_DIR: dir };
      expect(() => privateDir({ env, repoRoot: repo, home })).toThrow(why);
    }
  });

  it("keeps the Access storage state inside it, mode 0600", () => {
    const dir = join(base, "state-dir");
    mkdirSync(dir, { mode: 0o700 });
    const state = join(dir, "access.json");
    writeFileSync(state, "{}", { mode: 0o600 });
    expect(privateFile(state, dir, "E2E_STORAGE_STATE")).toMatch(/state-dir\/access\.json$/);
    const outside = join(base, "outside.json");
    writeFileSync(outside, "{}", { mode: 0o600 });
    expect(() => privateFile(outside, dir, "E2E_STORAGE_STATE")).toThrow(/NOV1_PRIVATE_DIR/);
    const loose = join(dir, "loose.json");
    writeFileSync(loose, "{}", { mode: 0o644 });
    chmodSync(loose, 0o644);
    expect(() => privateFile(loose, dir, "E2E_STORAGE_STATE")).toThrow(/0600/);
  });
});
