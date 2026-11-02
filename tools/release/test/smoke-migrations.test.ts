/**
 * The smoke's health check fails when the live database is behind the tree:
 * `migrations.latest` must equal the tree's last migration file. The older
 * name below is written by hand, not derived from the tree, so this test
 * still means "behind" once a later migration lands.
 */
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.ts";
import { treeMigrations } from "../src/commands/preflight.ts";
import { fakeDeps, json, repoRoot } from "./helpers.ts";

const older = "0002_tenancy_access_audit.sql";
const treeLatest = treeMigrations(repoRoot).at(-1) ?? "";

function localSmoke(latest: string) {
  return fakeDeps({
    tty: false,
    env: { CI: "true" },
    fetch: (c) => {
      if (c.url.endsWith("/v1/health")) {
        return json(200, {
          database: "ok",
          environment: "local",
          version: "dev",
          migrations: { latest },
        });
      }
      if (c.url.endsWith("/v1/public/tenant")) {
        const o = c.headers.origin ?? "";
        const m = /^http:\/\/(demo-harbor|demo-reef)\.book\.localhost:5361$/.exec(o);
        return m
          ? json(200, { tenant: { slug: m[1] } }, { "access-control-allow-origin": o })
          : json(404, { error: { code: "tenant_not_found" } });
      }
      if (c.url.endsWith("/manifest.webmanifest")) {
        const name = c.url.includes("demo-harbor") ? "Demo Harbor Charters" : "Demo Reef Divers";
        return json(200, { name });
      }
      return undefined;
    },
  });
}

const args = [
  "smoke",
  "--profile",
  "local",
  "--base",
  "http://localhost:8961",
  "--hosts",
  "demo-harbor.book.localhost:5361,demo-reef.book.localhost:5361",
];

describe("smoke health: migrations.latest against the tree", () => {
  it("the hand-written older name sorts before the tree's last migration", () => {
    expect(treeLatest > older).toBe(true);
  });

  it("fails when the health reports an older migration than the tree's last", async () => {
    const { deps, printed } = localSmoke(older);
    expect(await main(args, deps)).not.toBe(0);
    const text = printed.join("\n");
    expect(text).toContain(`FAIL  health: migrations.latest ${older} (tree ${treeLatest})`);
    expect(text).toMatch(/smoke: 1 check\(s\) failed/);
  });
});
