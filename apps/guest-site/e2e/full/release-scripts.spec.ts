import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

/**
 * The Nov 1 runbook's HTTP commands, run for real with `--profile local`
 * against this job's stack (P0.3; acceptance item 4): the API in
 * `wrangler dev --env dev` on :8961, and this suite's guest Worker on :5361
 * with *.book.localhost hosts. Local targets need no gate, so they run in CI
 * with no terminal. The CLI is spawned as a child process, so the guest site
 * takes no new dependency.
 *
 * Not proven here, and labeled preview-only in the runbook: the 429 budget
 * (env.dev has no rate limiter binding), the http and port negatives (local
 * host policy accepts them), the staff-route 404 (staff routes answer on
 * loopback), and the release CSP (CI rewrites it through GUEST_LOCAL_API).
 */

const run = promisify(execFile);
const hosts = "demo-harbor.book.localhost:5361,demo-reef.book.localhost:5361";
const api = "http://localhost:8961";

async function nov1(args: string[]) {
  try {
    const { stdout } = await run(
      "pnpm",
      ["--silent", "--filter", "@tidegrid/release", "nov1", ...args],
      {
        cwd: "../..",
        env: { ...process.env, NOV1_STATE_DIR: mkdtempSync(join(tmpdir(), "nov1-ci-")) },
        timeout: 180_000,
      },
    );
    return { code: 0, stdout };
  } catch (err) {
    const e = err as { code?: number; stdout?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "" };
  }
}

test.describe("nov1 release scripts, local profile", () => {
  test.beforeEach(() => {
    // Each command writes synthetic rows or reads shared state; once is enough.
    test.skip(test.info().project.name !== "desktop", "runs once");
  });

  test("smoke: health, the tenant echo, the trailing-dot and unpublished-host negatives, the brand", async () => {
    test.setTimeout(120_000);
    const r = await nov1(["smoke", "--profile", "local", "--base", api, "--hosts", hosts]);
    console.log(r.stdout);
    expect(r.code, r.stdout).toBe(0);
    expect(r.stdout).toContain("smoke passed: 7 checks, profile local");
  });

  test("last-seat: exactly one winner on the shared dive and on the whole-boat charter", async () => {
    test.setTimeout(180_000);
    const r = await nov1(["last-seat", "--profile", "local", "--api", api, "--hosts", hosts]);
    console.log(r.stdout);
    expect(r.code, r.stdout).toBe(0);
    const lines = r.stdout
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .map(
        (l) =>
          JSON.parse(l) as { tenant: string; outcome: string; statuses: Record<string, number> },
      );
    expect(lines.map((l) => [l.tenant, l.outcome])).toEqual([
      ["demo-reef", "pass"],
      ["demo-harbor", "pass"],
    ]);
    for (const l of lines) {
      expect(l.statuses).toEqual({ "201 opened": 1, "409 insufficient_capacity": 7 });
    }
  });

  test("isolation: another tenant's Origin gets the shared 404 for B's trip, quote, and checkout", async () => {
    test.setTimeout(120_000);
    const r = await nov1([
      "isolation",
      "--profile",
      "local",
      "--api",
      api,
      "--hosts",
      "demo-harbor.book.localhost:5361,demo-reef.book.localhost:5361",
    ]);
    console.log(r.stdout);
    expect(r.code, r.stdout).toBe(0);
    expect(r.stdout).toContain('"check":"isolation-public"');
  });

  test("a preview target without --live only prints its plan", async () => {
    const r = await nov1([
      "last-seat",
      "--profile",
      "preview",
      "--api",
      "https://api.tidegrid.us",
      "--hosts",
      "demo-harbor.book.tidegrid.us,demo-reef.book.tidegrid.us",
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("DRY RUN: nov1 last-seat");
  });

  test("a preview target with --live refuses in CI, with no terminal", async () => {
    const r = await nov1([
      "smoke",
      "--profile",
      "preview",
      "--base",
      "https://api.tidegrid.us",
      "--hosts",
      "demo-harbor.book.tidegrid.us",
      "--live",
      "--go",
      "A0",
    ]);
    expect(r.code).toBe(3);
    expect(r.stdout).toMatch(/REFUSED: CI is set|REFUSED: live steps need a terminal/);
  });
});
