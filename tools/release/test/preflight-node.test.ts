/**
 * Preflight refuses a release on a Node other than the one `.nvmrc` pins,
 * because CI tests only that version, and a Node patch can change ICU and
 * its time zone data.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.ts";
import { fakeDeps, repoRoot } from "./helpers.ts";

const pinned = readFileSync(join(repoRoot, ".nvmrc"), "utf8").trim();
const offline = ["preflight", "--offline", "--phase", "p3", "--allow-branch", "--skip-build"];

describe("preflight checks the running Node against .nvmrc", () => {
  it("fails on a Node other than the pinned one", async () => {
    const { deps, printed } = fakeDeps({ nodeVersion: "24.0.0" });
    expect(await main(offline, deps)).not.toBe(0);
    expect(printed.join("\n")).toContain(`FAIL  node: running 24.0.0, .nvmrc says ${pinned}`);
  });

  it("passes the Node check on the pinned version", async () => {
    const { deps, printed } = fakeDeps();
    await main(offline, deps);
    expect(printed.join("\n")).toContain(`PASS  node: running ${pinned}, .nvmrc says ${pinned}`);
  });
});
