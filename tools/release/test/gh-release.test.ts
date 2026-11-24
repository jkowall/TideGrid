/**
 * The GitHub release path (src/gh-release). A fake wrangler keeps one
 * Worker's deployments; a fake Cloudflare API answers the trigger reads; a
 * fake health answers for whichever version would serve the request.
 */
import { describe, expect, it } from "vitest";
import type { Env, GhDeps } from "../src/gh-release/deps.ts";
import {
  type GhWorker,
  parseDeploymentStatus,
  parseUploadOutput,
  previousDeployment,
  releaseWorker,
  rollbackWorker,
  schemaReady,
  treeLastMigration,
  triggerDiff,
  type VersionShare,
  versionOverride,
  wantedTriggers,
} from "../src/gh-release/release.ts";
import { repoRoot } from "./helpers.ts";

const OLD = "11111111-1111-4111-8111-111111111111";
const NEW = "22222222-2222-4222-8222-222222222222";
const OLDER = "33333333-3333-4333-8333-333333333333";
const SHA = "a".repeat(40);
const BUILD = "aaaaaaa";

const configs: Record<GhWorker, string> = {
  api: `{
    // comment
    "name": "tidegrid-api",
    "workers_dev": false,
    "preview_urls": false,
    "routes": [{ "pattern": "api.tidegrid.us", "custom_domain": true }],
    "triggers": { "crons": ["*/15 * * * *"] },
  }`,
  console: `{ "name": "tidegrid-console", "workers_dev": false, "preview_urls": false,
    "routes": [{ "pattern": "console.tidegrid.us", "custom_domain": true }] }`,
  guest: `{ "name": "tidegrid-guest", "workers_dev": false,
    "routes": [{ "pattern": "demo-harbor.book.tidegrid.us", "custom_domain": true },
               { "pattern": "demo.tidegrid.us", "custom_domain": true }] }`,
};

interface World {
  deployments: VersionShare[][];
  /** What each version's health reports. */
  builds: Record<string, string>;
  liveDomains: Record<GhWorker, string[]>;
  liveCrons: Record<GhWorker, string[]>;
  subdomain: { enabled: boolean; previews_enabled: boolean };
  /** Make the new version unhealthy. */
  newBroken: boolean;
  /** Fail `versions deploy` calls whose first spec starts with this. */
  failDeployOf?: string;
  /** Make `versions upload` fail (for example under --strict). */
  uploadFails?: boolean;
  /** The new version serves its static pages but its Worker fails. */
  newManifestBroken?: boolean;
  cfStatus: number;
  dbLatest: string;
  calls: string[];
  files: Map<string, string>;
  printed: string[];
  fetched: { url: string; headers: Record<string, string> }[];
  clock: number;
}

function world(over: Partial<World> = {}): World {
  return {
    deployments: [[{ id: OLDER, percentage: 100 }], [{ id: OLD, percentage: 100 }]],
    builds: { [OLD]: "0000000", [OLDER]: "fffffff" },
    liveDomains: {
      api: ["api.tidegrid.us"],
      console: ["console.tidegrid.us"],
      guest: ["demo-harbor.book.tidegrid.us", "demo.tidegrid.us"],
    },
    liveCrons: { api: ["*/15 * * * *"], console: [], guest: [] },
    subdomain: { enabled: false, previews_enabled: false },
    newBroken: false,
    cfStatus: 200,
    dbLatest: "0052_x.sql",
    calls: [],
    files: new Map(),
    printed: [],
    fetched: [],
    clock: Date.parse("2026-11-15T00:00:00Z"),
    ...over,
  };
}

const releaseEnv: Env = {
  GITHUB_ACTIONS: "true",
  CLOUDFLARE_API_TOKEN: "t".repeat(40),
  CLOUDFLARE_ACCOUNT_ID: "acct",
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_REPOSITORY: "jkowall/TideGrid",
  GITHUB_RUN_ID: "42",
  GITHUB_STEP_SUMMARY: "/summary.md",
  PATH: "/usr/bin",
  HOME: "/home/runner",
  SOMETHING_ELSE: "must not reach wrangler",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function current(w: World): VersionShare[] {
  return w.deployments.at(-1) ?? [];
}

/** Which version serves a request: the override if it names a live version, else the biggest share. */
function serving(w: World, worker: GhWorker, headers: Record<string, string>): string {
  const o = headers["Cloudflare-Workers-Version-Overrides"];
  const m = o?.match(/^([a-z-]+)="([0-9a-f-]+)"$/);
  const live = current(w);
  if (m && live.some((s) => s.id === m[2])) return m[2] as string;
  void worker;
  return [...live].sort((a, b) => b.percentage - a.percentage)[0]?.id ?? "";
}

function deps(w: World, worker: GhWorker, env: Env = releaseEnv): GhDeps {
  return {
    repoRoot: "/repo",
    env,
    print: (l) => w.printed.push(l),
    sleep: async (ms) => {
      w.clock += ms;
    },
    now: () => new Date(w.clock),
    readFile: (p) => {
      const f = w.files.get(p);
      if (f !== undefined) return f;
      const m = p.match(/apps\/(api-worker|operator-site|guest-site)\/wrangler\.jsonc$/);
      if (m) {
        return configs[
          ({ "api-worker": "api", "operator-site": "console", "guest-site": "guest" } as const)[
            m[1] as "api-worker"
          ]
        ];
      }
      throw new Error(`no file ${p}`);
    },
    appendFile: (p, t) => w.files.set(p, (w.files.get(p) ?? "") + t),
    tempPath: (n) => `/tmp/${n}`,
    exec: async (cmd, args, { env }) => {
      w.calls.push(`${cmd} ${args.join(" ")}`);
      expect(env.SOMETHING_ELSE).toBeUndefined();
      if (cmd !== "pnpm" || args[1] !== "wrangler") {
        // Builds never see the Cloudflare token.
        expect(env.CLOUDFLARE_API_TOKEN).toBeUndefined();
        expect(env.CLOUDFLARE_ACCOUNT_ID).toBeUndefined();
        return { code: 0, stdout: "" };
      }
      expect(env.CLOUDFLARE_API_TOKEN).toBeDefined();
      const a = args.slice(2);
      if (a[0] === "deployments" && a[1] === "status") {
        return {
          code: 0,
          stdout: `banner\n${JSON.stringify({ id: "d", author_email: "x@y.z", versions: current(w).map((s) => ({ version_id: s.id, percentage: s.percentage })) })}`,
        };
      }
      if (a[0] === "deployments" && a[1] === "list") {
        return {
          code: 0,
          stdout: JSON.stringify(
            w.deployments.map((d) => ({
              author_email: "x@y.z",
              versions: d.map((s) => ({ version_id: s.id, percentage: s.percentage })),
            })),
          ),
        };
      }
      if (a[0] === "versions" && a[1] === "upload") {
        expect(a).toContain("--strict");
        if (w.uploadFails) return { code: 1, stdout: "" };
        const out = env.WRANGLER_OUTPUT_FILE_PATH as string;
        w.files.set(
          out,
          `${JSON.stringify({ type: "wrangler-session" })}\n${JSON.stringify({ type: "version-upload", version_id: NEW })}\n`,
        );
        const v = a.indexOf("--var");
        w.builds[NEW] = v >= 0 ? String(a[v + 1]).replace("BUILD_ID:", "") : BUILD;
        return { code: 0, stdout: "" };
      }
      if (a[0] === "versions" && a[1] === "deploy") {
        expect(a).toContain("--yes");
        const specs = a.slice(2).filter((s) => s.includes("@"));
        if (w.failDeployOf && specs[0]?.startsWith(w.failDeployOf)) return { code: 1, stdout: "" };
        w.deployments.push(
          specs.map((s) => {
            const [id, pct] = s.split("@");
            return { id: id as string, percentage: Number(String(pct).replace("%", "")) };
          }),
        );
        return { code: 0, stdout: "" };
      }
      return { code: 1, stdout: "" };
    },
    fetch: async (input, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      w.fetched.push({ url: input, headers });
      if (input.startsWith("https://api.cloudflare.com/")) {
        if (w.cfStatus !== 200) return json({ success: false }, w.cfStatus);
        const name = input.match(/service=([a-z-]+)|scripts\/([a-z-]+)\//);
        const workerName = (name?.[1] ?? name?.[2]) as string;
        const wk = (
          {
            "tidegrid-api": "api",
            "tidegrid-console": "console",
            "tidegrid-guest": "guest",
          } as const
        )[workerName as "tidegrid-api"];
        if (input.includes("/workers/domains")) {
          return json({
            success: true,
            result: w.liveDomains[wk].map((hostname) => ({ hostname })),
          });
        }
        if (input.endsWith("/schedules")) {
          return json({
            success: true,
            result: { schedules: w.liveCrons[wk].map((cron) => ({ cron })) },
          });
        }
        if (input.endsWith("/subdomain")) return json({ success: true, result: w.subdomain });
      }
      const id = serving(w, worker, headers);
      const healthy = !(w.newBroken && id === NEW);
      if (input === "https://api.tidegrid.us/v1/health") {
        return json({
          version: w.builds[id],
          database: "ok",
          migrations: { latest: w.dbLatest },
          status: healthy ? "ok" : "degraded",
          ...(healthy ? {} : { database: "error" }),
        });
      }
      if (input === "https://console.tidegrid.us/") {
        return healthy
          ? new Response(null, {
              status: 302,
              headers: { location: "https://winter-feather-7169.cloudflareaccess.com/x" },
            })
          : new Response("", { status: 500 });
      }
      if (input.endsWith("/manifest.webmanifest")) {
        const ok = healthy && !(w.newManifestBroken && id === NEW);
        return ok ? json({ name: "Harbor" }) : new Response("", { status: 502 });
      }
      return new Response("", { status: healthy ? 200 : 503 });
    },
  };
}

const opts = (worker: GhWorker, over: object = {}) => ({
  worker,
  sha: SHA,
  buildId: BUILD,
  traffic: "all-at-once" as const,
  soakSeconds: 60,
  ledgerPath: "/ledger.ndjson",
  ...over,
});

function ledger(w: World) {
  return (w.files.get("/ledger.ndjson") ?? "")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe("gh-release parsing", () => {
  it("reads deployment status and drops the author", () => {
    expect(
      parseDeploymentStatus(
        `x\n{"author_email":"a@b.c","versions":[{"version_id":"${OLD}","percentage":100}]}`,
      ),
    ).toEqual([{ id: OLD, percentage: 100 }]);
    expect(() => parseDeploymentStatus("nope")).toThrow(/JSON/);
    expect(() =>
      parseDeploymentStatus(`{"versions":[{"version_id":"x","percentage":1}]}`),
    ).toThrow();
  });

  it("reads the upload's version id from wrangler's output file", () => {
    expect(
      parseUploadOutput(`{"type":"x"}\n{"type":"version-upload","version_id":"${NEW}"}\n`),
    ).toBe(NEW);
    expect(() => parseUploadOutput(`{"type":"version-upload","version_id":"bad"}`)).toThrow();
    expect(() => parseUploadOutput("")).toThrow();
  });

  it("previous is the version that served before the current one first went live", () => {
    const list = (...ds: [string, number][][]) =>
      JSON.stringify(
        ds.map((d) => ({
          versions: d.map(([version_id, percentage]) => ({ version_id, percentage })),
        })),
      );
    const at100 = (id: string) => [{ id, percentage: 100 }];
    expect(previousDeployment(list([[OLDER, 100]], [[OLD, 100]]), at100(OLD))).toEqual(
      at100(OLDER),
    );
    // After a 10% release, not the split.
    expect(
      previousDeployment(
        list(
          [[OLD, 100]],
          [
            [NEW, 10],
            [OLD, 90],
          ],
          [[NEW, 100]],
        ),
        at100(NEW),
      ),
    ).toEqual(at100(OLD));
    // After an automatic rollback, not the release that failed.
    expect(
      previousDeployment(
        list([[OLDER, 100]], [[OLD, 100]], [[NEW, 100]], [[OLD, 100]]),
        at100(OLD),
      ),
    ).toEqual(at100(OLDER));
    expect(previousDeployment(list([[OLD, 100]]), at100(OLD))).toBeNull();
    expect(previousDeployment(list([[OLD, 100]]), [{ id: OLD, percentage: 50 }])).toBeNull();
  });

  it("refuses a plain route and a wrong name", () => {
    expect(() =>
      wantedTriggers({ name: "tidegrid-api", routes: [{ pattern: "a.example/*" }] }, "api"),
    ).toThrow(/not a custom domain/);
    expect(() => wantedTriggers({ name: "other" }, "api")).toThrow(/names other/);
  });

  it("names each trigger difference", () => {
    const want = {
      domains: ["a"],
      crons: ["*/5 * * * *"],
      workersDev: false,
      previewUrls: undefined,
    };
    expect(triggerDiff(want, { ...want })).toEqual([]);
    expect(
      triggerDiff(want, { domains: ["a", "b"], crons: [], workersDev: true, previewUrls: true }),
    ).toEqual([
      "custom domains: tree a, live a, b",
      "cron schedules: tree */5 * * * *, live none",
      "workers.dev: tree false, live true",
    ]);
  });

  it("uses the documented version override header", () => {
    expect(versionOverride("api", NEW)).toEqual({
      "Cloudflare-Workers-Version-Overrides": `tidegrid-api="${NEW}"`,
    });
  });

  it("the tree's last migration ignores other files", () => {
    expect(treeLastMigration(["README.md", "0002_b.sql", "0010_c.sql", "0001_a.sql"])).toBe(
      "0010_c.sql",
    );
  });

  it("the real configs pass the trigger reading", async () => {
    const { readFileSync } = await import("node:fs");
    const { parseJsonc } = await import("../src/phase.ts");
    for (const [w, dir] of [
      ["api", "api-worker"],
      ["console", "operator-site"],
      ["guest", "guest-site"],
    ] as const) {
      const c = parseJsonc(readFileSync(`${repoRoot}/apps/${dir}/wrangler.jsonc`, "utf8"));
      expect(wantedTriggers(c as never, w).domains.length).toBeGreaterThan(0);
    }
  });
});

describe("gh-release schema gate", () => {
  it("passes at or ahead of the tree, refuses behind", async () => {
    const w = world({ dbLatest: "0052_x.sql" });
    await expect(schemaReady(deps(w, "api"), "0052_x.sql")).resolves.toBeUndefined();
    await expect(schemaReady(deps(w, "api"), "0051_x.sql")).resolves.toBeUndefined();
    await expect(schemaReady(deps(w, "api"), "0053_y.sql")).rejects.toThrow(/behind/);
  });
});

describe("gh-release release", () => {
  it("refuses outside GitHub Actions or without the token", async () => {
    const w = world();
    await expect(
      releaseWorker(deps(w, "api", { ...releaseEnv, GITHUB_ACTIONS: undefined }), opts("api")),
    ).rejects.toThrow(/only inside the release workflow/);
    await expect(
      releaseWorker(deps(w, "api", { ...releaseEnv, CLOUDFLARE_API_TOKEN: "" }), opts("api")),
    ).rejects.toThrow(/CLOUDFLARE_API_TOKEN/);
    await expect(
      releaseWorker(deps(w, "api", { ...releaseEnv, VITE_API_BASE: "http://x" }), opts("api")),
    ).rejects.toThrow(/leak/);
    expect(w.calls).toEqual([]);
  });

  it("releases the API all at once, tagged with the commit, and writes the ledger", async () => {
    const w = world();
    await releaseWorker(deps(w, "api"), opts("api"));
    expect(current(w)).toEqual([{ id: NEW, percentage: 100 }]);
    const upload = w.calls.find((c) => c.includes("versions upload")) as string;
    expect(upload).toContain(`--tag ${SHA.slice(0, 12)}`);
    expect(upload).toContain(`--var BUILD_ID:${BUILD}`);
    expect(w.calls.some((c) => / wrangler deploy\b/.test(c) || c.includes("triggers"))).toBe(false);
    const [entry] = ledger(w);
    expect(entry).toMatchObject({
      kind: "release",
      worker: "tidegrid-api",
      sha: SHA,
      outcome: "released",
      before: [{ id: OLD, percentage: 100 }],
      after: [{ id: NEW, percentage: 100 }],
      run_url: "https://github.com/jkowall/TideGrid/actions/runs/42",
    });
    expect(w.files.get("/summary.md")).toContain("Release tidegrid-api: released");
  });

  it("builds the guest site and checks each host", async () => {
    const w = world();
    w.files.set(
      "/repo/apps/guest-site/package.json",
      JSON.stringify({
        scripts: { release: "vite build && node scripts/build-phone-app.mjs --release" },
      }),
    );
    await releaseWorker(deps(w, "guest"), opts("guest"));
    expect(w.calls[1]).toBe("pnpm exec vite build");
    expect(w.calls[2]).toBe("node scripts/check-precache.mjs");
    expect(w.calls[3]).toBe("node scripts/build-phone-app.mjs --release");
    expect(w.calls.find((c) => c.includes("upload"))).not.toContain("BUILD_ID");
    expect(w.fetched.some((f) => f.url === "https://demo.tidegrid.us/")).toBe(true);
    expect(ledger(w)[0].outcome).toBe("released");
  });

  it("an older guest commit without the phone app builds as before", async () => {
    const w = world();
    w.files.set(
      "/repo/apps/guest-site/package.json",
      JSON.stringify({ scripts: { release: "vite build && wrangler deploy" } }),
    );
    await releaseWorker(deps(w, "guest"), opts("guest"));
    expect(w.calls.some((c) => c.includes("build-phone-app"))).toBe(false);
    expect(ledger(w)[0].outcome).toBe("released");
  });

  it("a guest version whose Worker fails never reaches 100%, even when its pages load", async () => {
    const w = world({ newManifestBroken: true });
    await expect(
      releaseWorker(deps(w, "guest"), opts("guest", { traffic: "ten-percent-first" })),
    ).rejects.toThrow(/at 10%.*rolled back/);
    expect(current(w)).toEqual([{ id: OLD, percentage: 100 }]);
    expect(
      w.fetched.some((f) => f.url === "https://demo-harbor.book.tidegrid.us/manifest.webmanifest"),
    ).toBe(true);
  });

  it("a traffic move that exits 1 but took is not rolled back", async () => {
    const w = world();
    const d = deps(w, "api");
    const real = d.exec;
    d.exec = async (cmd, args, o) => {
      const r = await real(cmd, args, o);
      return args.includes("deploy") ? { ...r, code: 1 } : r;
    };
    await releaseWorker(d, opts("api"));
    expect(current(w)).toEqual([{ id: NEW, percentage: 100 }]);
    expect(ledger(w)[0].outcome).toBe("released");
  });

  it("refuses before uploading when a custom domain or schedule differs", async () => {
    const w = world();
    w.liveCrons.api = [];
    await expect(releaseWorker(deps(w, "api"), opts("api"))).rejects.toThrow(
      /cron schedules: tree \*\/15 \* \* \* \*, live none.*nov1/,
    );
    const g = world();
    g.liveDomains.guest = ["demo.tidegrid.us"];
    await expect(releaseWorker(deps(g, "guest"), opts("guest"))).rejects.toThrow(/custom domains/);
    const s = world({ subdomain: { enabled: true, previews_enabled: false } });
    await expect(releaseWorker(deps(s, "console"), opts("console"))).rejects.toThrow(/workers.dev/);
    for (const x of [w, g, s]) {
      expect(x.calls.some((c) => c.includes("upload") || c.includes("versions deploy"))).toBe(
        false,
      );
    }
  });

  it("refuses when the Cloudflare API will not answer", async () => {
    const w = world({ cfStatus: 403 });
    await expect(releaseWorker(deps(w, "api"), opts("api"))).rejects.toThrow(/permissions/);
    expect(w.calls.some((c) => c.includes("upload"))).toBe(false);
  });

  it("refuses while a split deployment is live", async () => {
    const w = world();
    w.deployments.push([
      { id: OLD, percentage: 90 },
      { id: OLDER, percentage: 10 },
    ]);
    await expect(releaseWorker(deps(w, "api"), opts("api"))).rejects.toThrow(/not on one version/);
  });

  it("puts the old version back when the new one is unhealthy", async () => {
    const w = world({ newBroken: true });
    await expect(releaseWorker(deps(w, "api"), opts("api"))).rejects.toThrow(/rolled back/);
    expect(current(w)).toEqual([{ id: OLD, percentage: 100 }]);
    expect(ledger(w)[0]).toMatchObject({
      outcome: "rolled_back",
      after: [{ id: OLD, percentage: 100 }],
    });
  });

  it("ten percent first: checks the new version by override, soaks, then moves to 100%", async () => {
    const w = world();
    await releaseWorker(
      deps(w, "api"),
      opts("api", { traffic: "ten-percent-first", soakSeconds: 90 }),
    );
    const deploys = w.deployments.slice(2);
    expect(deploys[0]).toEqual([
      { id: NEW, percentage: 10 },
      { id: OLD, percentage: 90 },
    ]);
    expect(deploys.at(-1)).toEqual([{ id: NEW, percentage: 100 }]);
    const overridden = w.fetched.filter((f) => f.headers["Cloudflare-Workers-Version-Overrides"]);
    expect(overridden.length).toBeGreaterThanOrEqual(3);
  });

  it("ten percent first: a broken new version never reaches 100%", async () => {
    const w = world({ newBroken: true });
    await expect(
      releaseWorker(deps(w, "api"), opts("api", { traffic: "ten-percent-first" })),
    ).rejects.toThrow(/at 10%.*rolled back/);
    expect(w.deployments.some((d) => d.length === 1 && d[0]?.id === NEW)).toBe(false);
    expect(current(w)).toEqual([{ id: OLD, percentage: 100 }]);
  });

  it("says so when the rollback itself does not take", async () => {
    const w = world({ newBroken: true, failDeployOf: OLD });
    await expect(releaseWorker(deps(w, "api"), opts("api"))).rejects.toThrow(/did not take/);
    expect(ledger(w)[0].outcome).toBe("rollback_failed");
  });
});

describe("gh-release review fixes", () => {
  it("a rollback whose command exits 1 after taking effect is recorded as taken", async () => {
    const w = world({ newBroken: true });
    const d = deps(w, "api");
    const real = d.exec;
    d.exec = async (cmd, args, o) => {
      const r = await real(cmd, args, o);
      return args.includes("deploy") && args.some((x) => x.startsWith(OLD)) ? { ...r, code: 1 } : r;
    };
    await expect(releaseWorker(d, opts("api"))).rejects.toThrow(/; rolled back/);
    expect(current(w)).toEqual([{ id: OLD, percentage: 100 }]);
    expect(ledger(w)[0].outcome).toBe("rolled_back");
  });

  it("an upload that fails writes a ledger line and moves nothing", async () => {
    const w = world({ uploadFails: true });
    await expect(releaseWorker(deps(w, "api"), opts("api"))).rejects.toThrow(/upload failed/);
    expect(current(w)).toEqual([{ id: OLD, percentage: 100 }]);
    expect(ledger(w)[0]).toMatchObject({ outcome: "failed_before_traffic" });
  });

  it("rollback to previous after a 10% release goes to the old version, not the split", async () => {
    const w = world();
    await releaseWorker(
      deps(w, "api"),
      opts("api", { traffic: "ten-percent-first", soakSeconds: 0 }),
    );
    await rollbackWorker(deps(w, "api"), "api", "previous", "/ledger.ndjson");
    expect(current(w)).toEqual([{ id: OLD, percentage: 100 }]);
  });

  it("rollback to previous after an automatic rollback does not bring back the failed version", async () => {
    const w = world({ newBroken: true });
    await expect(releaseWorker(deps(w, "api"), opts("api"))).rejects.toThrow(/rolled back/);
    await rollbackWorker(deps(w, "api"), "api", "previous", "/ledger.ndjson");
    expect(current(w)).toEqual([{ id: OLDER, percentage: 100 }]);
  });
});

describe("gh-release rollback", () => {
  it("goes back to the previous deployment", async () => {
    const w = world();
    await rollbackWorker(deps(w, "console"), "console", "previous", "/ledger.ndjson");
    expect(current(w)).toEqual([{ id: OLDER, percentage: 100 }]);
    expect(ledger(w)[0]).toMatchObject({ kind: "rollback", outcome: "rolled_back" });
  });

  it("goes to a named version, and refuses nonsense", async () => {
    const w = world();
    await rollbackWorker(deps(w, "api"), "api", OLDER, "/ledger.ndjson");
    expect(current(w)).toEqual([{ id: OLDER, percentage: 100 }]);
    await expect(rollbackWorker(deps(w, "api"), "api", OLDER, "/l")).rejects.toThrow(/already/);
    await expect(rollbackWorker(deps(w, "api"), "api", "v1", "/l")).rejects.toThrow(
      /previous or a version id/,
    );
  });

  it("refuses with no earlier deployment", async () => {
    const w = world({ deployments: [[{ id: OLD, percentage: 100 }]] });
    await expect(rollbackWorker(deps(w, "api"), "api", "previous", "/l")).rejects.toThrow(
      /no earlier/,
    );
  });
});
