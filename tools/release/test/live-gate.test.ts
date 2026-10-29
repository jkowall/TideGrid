import { describe, expect, it } from "vitest";
import { main } from "../src/cli.ts";
import { classifyHost, classifyUrl } from "../src/gate.ts";
import { loadJournal, saveJournal } from "../src/journal.ts";
import { fakeDeps, headSha, json, providerExecs } from "./helpers.ts";

describe("target classification (invariant 1)", () => {
  it("counts loopback and *.localhost as local, everything else as live", () => {
    for (const h of [
      "localhost",
      "127.0.0.1",
      "::1",
      "[::1]",
      "demo-harbor.book.localhost",
      "LOCALHOST.",
    ]) {
      expect(classifyHost(h)).toBe("local");
    }
    for (const h of [
      "api.tidegrid.us",
      "ep-main.neon.tech",
      "localhost.example.com",
      "",
      "10.0.0.1",
    ]) {
      expect(classifyHost(h)).toBe("live");
    }
    expect(classifyUrl("postgresql://postgres:postgres@localhost:5432/tidegrid")).toBe("local");
    expect(classifyUrl("postgres://u:p@ep-x.us-east-2.aws.neon.tech/neondb")).toBe("live");
    expect(classifyUrl("postgres:///tidegrid")).toBe("live");
    expect(classifyUrl("not a url")).toBe("live");
  });
});

const approve = (deps: ReturnType<typeof fakeDeps>["deps"]) => {
  const j = loadJournal(deps);
  j.approved.push({
    sha: headSha,
    tree: "b".repeat(40),
    gate: "P0.1",
    at: "2026-10-31T00:00:00Z",
    frozen: true,
  });
  saveJournal(deps, j);
};

const releaseApi = ["release", "api", "--phase", "p3", "--live", "--go", "A4"];

describe("a live target refuses unless every gate condition holds", () => {
  const cases: [string, string[], Parameters<typeof fakeDeps>[0], RegExp][] = [
    [
      "no --go",
      ["release", "api", "--phase", "p3", "--live"],
      { answers: ["tidegrid-api"] },
      /--go/,
    ],
    [
      "a go for another step",
      ["release", "api", "--phase", "p3", "--live", "--go", "A1"],
      { answers: ["tidegrid-api"] },
      /does not authorize/,
    ],
    ["no terminal", releaseApi, { tty: false, answers: ["tidegrid-api"] }, /terminal/],
    ["CI set", releaseApi, { env: { CI: "true" }, answers: ["tidegrid-api"] }, /CI is set/],
    ["the wrong typed target", releaseApi, { answers: ["tidegrid-guest"] }, /typed confirmation/],
    ["an empty answer", releaseApi, { answers: [""] }, /typed confirmation/],
  ];
  for (const [name, argv, options, why] of cases) {
    it(name, async () => {
      const { deps, execs, fetches, printed } = fakeDeps(options);
      approve(deps);
      expect(await main(argv, deps)).toBe(3);
      expect(printed.join("\n")).toMatch(why);
      expect(providerExecs(execs)).toEqual([]);
      expect(fetches).toEqual([]);
    });
  }

  it("refuses an unapproved HEAD, a dirty tree, or a build leak at execution time", async () => {
    const unapproved = fakeDeps({ answers: ["tidegrid-api"] });
    expect(await main(releaseApi, unapproved.deps)).toBe(3);
    expect(unapproved.printed.join("\n")).toMatch(/approved SHAs/);

    const dirty = fakeDeps({
      answers: ["tidegrid-api"],
      exec: (c) =>
        c.cmd === "git" && c.args[0] === "describe"
          ? { code: 0, stdout: "aaaaaaa-dirty" }
          : undefined,
    });
    approve(dirty.deps);
    expect(await main(releaseApi, dirty.deps)).toBe(3);
    expect(dirty.printed.join("\n")).toMatch(/dirty/);

    const leak = fakeDeps({
      answers: ["tidegrid-api"],
      env: { VITE_API_BASE: "http://localhost:8961" },
    });
    approve(leak.deps);
    expect(await main(releaseApi, leak.deps)).toBe(3);
    expect(leak.printed.join("\n")).toMatch(/VITE_API_BASE/);
    expect(providerExecs(leak.execs)).toEqual([]);
  });

  it("a local target runs with no gate: smoke --profile local on a terminal-less CI", async () => {
    const { deps, fetches } = fakeDeps({
      tty: false,
      env: { CI: "true" },
      fetch: (c) => {
        if (c.url.endsWith("/v1/health")) {
          return json(200, {
            database: "ok",
            environment: "local",
            version: "dev",
            migrations: { latest: "0013_sweep_fairness.sql" },
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
    const code = await main(
      [
        "smoke",
        "--profile",
        "local",
        "--base",
        "http://localhost:8961",
        "--hosts",
        "demo-harbor.book.localhost:5361,demo-reef.book.localhost:5361",
      ],
      deps,
    );
    expect(code).toBe(0);
    expect(fetches.length).toBeGreaterThan(0);
  });

  it("refuses a profile that does not fit its targets", async () => {
    const { deps, printed } = fakeDeps();
    expect(
      await main(
        [
          "smoke",
          "--profile",
          "local",
          "--base",
          "https://api.tidegrid.us",
          "--hosts",
          "demo-harbor.book.tidegrid.us",
        ],
        deps,
      ),
    ).toBe(3);
    expect(printed.join("\n")).toMatch(/needs local targets/);
    expect(
      await main(
        [
          "last-seat",
          "--profile",
          "preview",
          "--api",
          "http://localhost:8961",
          "--hosts",
          "demo-reef.book.localhost:5361",
        ],
        deps,
      ),
    ).toBe(3);
  });

  it("refuses unknown options, so a typo never means dry run", async () => {
    const { deps } = fakeDeps();
    expect(await main(["release", "api", "--phase", "p3", "--lvie"], deps)).toBe(3);
    expect(await main(["db", "migrate", "--api-key", "x"], deps)).toBe(3);
  });
});

describe("wrangler runs on the owner's terminal with a clean environment (invariants 4 and 7)", () => {
  it("spawns the release with stdio inherit and without CLOUDFLARE_API_TOKEN", async () => {
    let healthCalls = 0;
    const { deps, execs, printed } = fakeDeps({
      answers: ["tidegrid-api"],
      env: {
        CLOUDFLARE_API_TOKEN: "cf-token-value-not-real-0123456789abcdef",
        NEON_DATABASE_URL: "postgres://x:y@h/db",
      },
      exec: (c) => {
        if (c.args.includes("deployments")) {
          return {
            code: 0,
            stdout: JSON.stringify([
              {
                author_email: "owner@example.com",
                versions: [{ version_id: "11111111-2222-4333-8444-555555555555" }],
              },
            ]),
          };
        }
        return undefined;
      },
      fetch: (c) => {
        if (c.url === "https://api.tidegrid.us/v1/health") {
          healthCalls++;
          return json(200, { version: healthCalls > 1 ? "aaaaaaa" : "b87e269", database: "ok" });
        }
        return undefined;
      },
    });
    approve(deps);
    expect(await main(releaseApi, deps)).toBe(0);
    const releaseCall = execs.find((e) => e.args.includes("release"));
    expect(releaseCall?.options.stdio).toBe("inherit");
    expect(releaseCall?.args).toEqual(["--filter", "@tidegrid/api-worker", "run", "release"]);
    for (const e of execs.filter((x) => x.cmd !== "git")) {
      expect(Object.keys(e.options.env)).not.toContain("CLOUDFLARE_API_TOKEN");
      expect(Object.keys(e.options.env)).not.toContain("NEON_DATABASE_URL");
    }
    const listing = execs.filter((e) => e.args.includes("deployments"));
    expect(listing.every((e) => e.options.stdio === "pipe" && e.args.includes("--json"))).toBe(
      true,
    );
    const text = printed.join("\n");
    expect(text).toContain("CLOUDFLARE_API_TOKEN stripped");
    expect(text).not.toContain("owner@example.com");
    const journal = loadJournal(deps);
    expect(journal.entries.at(-1)).toMatchObject({
      step: "release",
      worker: "api",
      result: "done",
      versionAfter: ["11111111-2222-4333-8444-555555555555"],
    });
    expect(JSON.stringify(journal)).not.toContain("@");
  });

  it("the guest kill-switch release passes only GUEST_SW_KILL_SWITCH, on the terminal", async () => {
    const { deps, execs, printed } = fakeDeps({
      answers: ["tidegrid-guest"],
      env: { GUEST_SW_KILL_SWITCH: "1" },
      fetch: (c) =>
        c.url.endsWith(".book.tidegrid.us/") ? new Response("ok", { status: 200 }) : undefined,
    });
    approve(deps);
    expect(
      await main(
        ["release", "guest", "--phase", "p4", "--live", "--go", "A4", "--kill-switch"],
        deps,
      ),
    ).toBe(0);
    const rel = execs.find((e) => e.args.includes("release"));
    expect(rel?.options.env.GUEST_SW_KILL_SWITCH).toBe("1");
    expect(rel?.options.stdio).toBe("inherit");
    expect(printed.join("\n")).not.toMatch(/REFUSED/);
  });

  it("without --kill-switch, a GUEST_SW_KILL_SWITCH in the shell refuses the guest release", async () => {
    const { deps, execs } = fakeDeps({
      answers: ["tidegrid-guest"],
      env: { GUEST_SW_KILL_SWITCH: "1" },
    });
    approve(deps);
    expect(await main(["release", "guest", "--phase", "p4", "--live", "--go", "A4"], deps)).toBe(3);
    expect(providerExecs(execs)).toEqual([]);
  });
});
