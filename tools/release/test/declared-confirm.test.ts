/**
 * Declared confirmations and test-mode secret files (owner decision
 * 2026-11-05, items 2 and 3, and the three follow-up selections recorded
 * with it). An unattended run declares its targets up front with
 * --confirm; nov1 answers its own type-backs only with those, refuses
 * anything else with nothing run, journals that the answer was declared,
 * and keeps the terminal and CI rules. A secret value may come from a 0600
 * file outside the repository only for a Stripe test-mode key, or a webhook
 * secret paired with one, and the file is removed after a done put.
 */
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.ts";
import { treeMigrations } from "../src/commands/preflight.ts";
import type { Deps } from "../src/core.ts";
import { type Entry, loadJournal, saveJournal } from "../src/journal.ts";
import {
  configsWith,
  type ExecCall,
  fakeDeps,
  headSha,
  json,
  providerExecs,
  repoRoot,
} from "./helpers.ts";

const treeLatest = treeMigrations(repoRoot).at(-1) ?? "";
const releaseApi = ["release", "api", "--phase", "p3", "--live", "--go", "A4"];

function approve(deps: Deps, flags = {}, entries: Entry[] = []) {
  const j = loadJournal(deps);
  j.approved.push({ sha: headSha, tree: "t", gate: "P0.1", at: "x", frozen: true });
  j.flags = { ...j.flags, ...flags };
  j.entries.push(...entries);
  saveJournal(deps, j);
}

const confirmEntries = (deps: Deps) =>
  loadJournal(deps).entries.filter((e) => e.step === "confirm");

/** An API release whose health reports `latest`, or nothing about migrations when undefined. */
function apiRelease(latest: string | undefined, o: Parameters<typeof fakeDeps>[0] = {}) {
  let deployed = false;
  const f = fakeDeps({
    ...o,
    exec: (c) => {
      if (c.args.includes("release")) deployed = true;
      return o.exec?.(c);
    },
    fetch: (c) =>
      c.url.endsWith("/v1/health")
        ? json(200, {
            version: deployed ? "aaaaaaa" : "old",
            database: "ok",
            ...(latest === undefined ? {} : { migrations: { latest } }),
          })
        : undefined,
  });
  approve(f.deps);
  return f;
}

describe("--confirm parsing", () => {
  const refusals: [string, string[], Parameters<typeof fakeDeps>[0], RegExp][] = [
    ["CI set", [...releaseApi, "--confirm", "tidegrid-api"], { env: { CI: "1" } }, /CI/],
    ["an empty entry", [...releaseApi, "--confirm", "tidegrid-api,,x"], {}, /empty/],
    ["an unknown question", [...releaseApi, "--confirm", "yes:anything"], {}, /yes:anything/],
    ["an inherited name", [...releaseApi, "--confirm", "yes:constructor"], {}, /yes:constructor/],
    [
      "yes:feature-off, which only a typed rollback asks",
      [...releaseApi, "--confirm", "yes:feature-off"],
      {},
      /rollback is typed/,
    ],
    [
      "a secret-shaped entry",
      [...releaseApi, "--confirm", `sk_test_${"a".repeat(24)}`],
      {},
      /looks like a secret/,
    ],
  ];
  for (const [name, argv, options, why] of refusals) {
    it(`refuses ${name} before anything runs`, async () => {
      const { deps, execs, fetches, printed, prompts } = fakeDeps(options);
      approve(deps);
      expect(await main(argv, deps)).toBe(3);
      expect(printed.join("\n")).toMatch(why);
      expect(execs).toEqual([]);
      expect(fetches).toEqual([]);
      expect(prompts).toEqual([]);
    });
  }
});

describe("the live gate answers a type-back only with a declared target", () => {
  it("deploys with every prompted target declared, asks nothing, and journals it as declared", async () => {
    const { deps, printed, prompts } = apiRelease(treeLatest);
    expect(await main([...releaseApi, "--confirm", "tidegrid-api"], deps), printed.join("\n")).toBe(
      0,
    );
    expect(prompts).toEqual([]);
    expect(printed.join("\n")).toMatch(/declared, not typed: tidegrid-api/);
    const [c] = confirmEntries(deps);
    expect(c).toMatchObject({
      step: "confirm",
      gate: "A4",
      result: "answered",
      confirmation: "declared",
      targets: ["tidegrid-api"],
    });
    // The confirmation comes before the deploy it authorized.
    const steps = loadJournal(deps).entries.map((e) => e.step);
    expect(steps.indexOf("confirm")).toBeLessThan(steps.indexOf("release"));
  });

  it("refuses an undeclared target with nothing run, and journals the refusal", async () => {
    const { deps, execs, printed, prompts } = apiRelease(treeLatest);
    expect(await main([...releaseApi, "--confirm", "tidegrid-guest"], deps)).toBe(3);
    expect(printed.join("\n")).toMatch(/not declared: tidegrid-api/);
    expect(prompts).toEqual([]);
    expect(providerExecs(execs)).toEqual([]);
    expect(confirmEntries(deps)).toMatchObject([
      { result: "refused", confirmation: "declared", targets: ["tidegrid-api"] },
    ]);
  });

  it("keeps the terminal rule under --confirm", async () => {
    const { deps, execs, printed } = apiRelease(treeLatest, { tty: false });
    expect(await main([...releaseApi, "--confirm", "tidegrid-api"], deps)).toBe(3);
    expect(printed.join("\n")).toMatch(/terminal/);
    expect(providerExecs(execs)).toEqual([]);
  });

  it("still asks the owner when --confirm is absent", async () => {
    const { deps, prompts } = apiRelease(treeLatest, { answers: ["tidegrid-api"] });
    expect(await main(releaseApi, deps)).toBe(0);
    expect(prompts).toHaveLength(1);
    expect(confirmEntries(deps)).toEqual([]);
  });

  it("names a declared target that was never asked for", async () => {
    const { deps, printed } = apiRelease(treeLatest);
    expect(await main([...releaseApi, "--confirm", "tidegrid-api,tidegrid-guest"], deps)).toBe(0);
    expect(printed.join("\n")).toMatch(/declared but not asked: tidegrid-guest/);
  });
});

describe("yes/no attestations are declared by id", () => {
  it("answers 'is the database already at the tree' only when yes:db-at-tree is declared", async () => {
    const { deps, printed, prompts } = apiRelease(undefined);
    expect(
      await main([...releaseApi, "--confirm", "tidegrid-api,yes:db-at-tree"], deps),
      printed.join("\n"),
    ).toBe(0);
    expect(prompts).toEqual([]);
    expect(confirmEntries(deps).map((e) => e.targets)).toEqual([
      ["tidegrid-api"],
      ["yes:db-at-tree"],
    ]);
  });

  it("refuses the undeclared question with nothing deployed", async () => {
    const { deps, execs, printed, prompts } = apiRelease(undefined);
    expect(await main([...releaseApi, "--confirm", "tidegrid-api"], deps)).toBe(3);
    expect(printed.join("\n")).toMatch(/--confirm yes:db-at-tree/);
    expect(prompts).toEqual([]);
    expect(providerExecs(execs)).toEqual([]);
    expect(confirmEntries(deps).at(-1)).toMatchObject({
      result: "refused",
      targets: ["yes:db-at-tree"],
    });
  });

  it("refuses a declared rollback before anything runs: wrangler's rollback prompts stay typed", async () => {
    const { deps, execs, fetches, printed, prompts } = fakeDeps();
    approve(deps);
    const rollback = ["release", "api", "--phase", "p7", "--rollback", "--live", "--go", "A8"];
    expect(await main([...rollback, "--confirm", "tidegrid-api"], deps)).toBe(3);
    expect(printed.join("\n")).toMatch(/rollback is typed by the owner/);
    expect(execs).toEqual([]);
    expect(fetches).toEqual([]);
    expect(prompts).toEqual([]);
  });
});

describe("approve-sha takes a declared first 12", () => {
  const argv = ["approve-sha", headSha, "--go", "A3"];

  it("approves when the first 12 are declared, and marks the approval declared", async () => {
    const { deps, prompts } = fakeDeps();
    expect(await main([...argv, "--confirm", headSha.slice(0, 12)], deps)).toBe(0);
    expect(prompts).toEqual([]);
    expect(loadJournal(deps).approved).toMatchObject([
      { sha: headSha, gate: "A3", confirmation: "declared" },
    ]);
    expect(confirmEntries(deps)).toMatchObject([
      { result: "answered", gate: "A3", targets: [headSha.slice(0, 12)] },
    ]);
  });

  it("refuses another declared SHA and records no approval", async () => {
    const { deps, prompts } = fakeDeps();
    expect(await main([...argv, "--confirm", "bbbbbbbbbbbb"], deps)).toBe(3);
    expect(prompts).toEqual([]);
    expect(loadJournal(deps).approved).toEqual([]);
  });

  it("keeps the terminal rule", async () => {
    const { deps } = fakeDeps({ tty: false });
    expect(await main([...argv, "--confirm", headSha.slice(0, 12)], deps)).toBe(3);
    expect(loadJournal(deps).approved).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Secrets

const p9 = configsWith("c1", "c2", "c4", "c5");
const testKey = `sk_test_${"K".repeat(30)}`;
const restrictedKey = `rk_test_${"R".repeat(30)}`;
const whsec = `whsec_${"W".repeat(32)}`;

/** A private directory outside the repository, and a secret file in it. */
function secretFile(value: string, mode = 0o600, name = "secret"): string {
  const dir = mkdtempSync(join(tmpdir(), "nov1-private-"));
  chmodSync(dir, 0o700);
  const path = join(dir, name);
  writeFileSync(path, value, { mode });
  chmodSync(path, mode);
  return path;
}

function stripeDeps(o: Parameters<typeof fakeDeps>[0] = {}, entries: Entry[] = []) {
  let sent: string | undefined;
  const f = fakeDeps({
    configs: p9,
    ...o,
    exec: (c: ExecCall) => {
      if (c.args.includes("put") && c.options.stdin instanceof Uint8Array)
        sent = Buffer.from(c.options.stdin).toString("utf8");
      return o.exec?.(c);
    },
  });
  approve(f.deps, { cutoverDone: true }, entries);
  return { ...f, sent: () => sent };
}

const put = (name: string, file?: string, confirm = `tidegrid-api,${name}`) => [
  "secrets",
  "stripe",
  "--put",
  name,
  ...(file ? ["--from-file", file] : []),
  "--phase",
  "p9",
  "--live",
  "--go",
  "A13",
  ...(confirm ? ["--confirm", confirm] : []),
];

const keyPut = (source: Entry["source"], phase = "p9"): Entry => ({
  at: "2026-11-04T18:00:00Z",
  phase,
  step: "secret-put",
  gate: "A13",
  worker: "api",
  result: "done",
  secret: "STRIPE_SECRET_KEY",
  ...(source ? { source } : {}),
});

describe("secret values from a test-mode file", () => {
  it("puts an sk_test_ key from a 0600 file through wrangler's stdin, then removes the file", async () => {
    const file = secretFile(`${testKey}\n`);
    const { deps, execs, printed, prompts, sent } = stripeDeps();
    expect(await main(put("STRIPE_SECRET_KEY", file), deps), printed.join("\n")).toBe(0);
    expect(prompts).toEqual([]);
    expect(sent()).toBe(testKey);
    const call = execs.find((e) => e.args.includes("put"));
    expect(call?.args).toEqual(["exec", "wrangler", "secret", "put", "STRIPE_SECRET_KEY"]);
    expect(call?.options.stdio).toBe("inherit");
    expect(JSON.stringify(call?.args)).not.toContain("sk_test_");
    expect(printed.join("\n")).not.toContain("sk_test_K");
    expect(existsSync(file)).toBe(false);
    const entry = loadJournal(deps)
      .entries.filter((e) => e.step === "secret-put")
      .at(-1);
    expect(entry).toMatchObject({
      result: "done",
      secret: "STRIPE_SECRET_KEY",
      source: "test-file",
    });
    expect(entry?.note).toMatch(/file removed/);
    expect(readFileSync(join(deps.stateDir, "journal.json"), "utf8")).not.toContain("KKKKKKKK");
  });

  it("accepts an rk_test_ key without --confirm (the owner at the terminal)", async () => {
    const file = secretFile(restrictedKey);
    const { deps, prompts, sent } = stripeDeps({
      answers: ["tidegrid-api", "STRIPE_SECRET_KEY"],
    });
    expect(await main(put("STRIPE_SECRET_KEY", file, ""), deps)).toBe(0);
    expect(prompts).toHaveLength(2);
    expect(sent()).toBe(restrictedKey);
  });

  const refusals: [string, () => string, string, RegExp][] = [
    ["a live key", () => secretFile(`sk_live_${"L".repeat(30)}`), "STRIPE_SECRET_KEY", /live/],
    [
      "a publishable key",
      () => secretFile(`pk_test_${"P".repeat(30)}`),
      "STRIPE_SECRET_KEY",
      /test-mode/,
    ],
    ["a group-readable file", () => secretFile(testKey, 0o640), "STRIPE_SECRET_KEY", /0600/],
    ["a relative path", () => "secret", "STRIPE_SECRET_KEY", /absolute/],
    ["a missing file", () => "/nonexistent/nov1/secret", "STRIPE_SECRET_KEY", /cannot read/],
    [
      "a symlink",
      () => {
        const target = secretFile(testKey);
        const link = `${target}-link`;
        symlinkSync(target, link);
        return link;
      },
      "STRIPE_SECRET_KEY",
      /symlink/,
    ],
    ["two lines", () => secretFile(`${testKey}\n${testKey}\n`), "STRIPE_SECRET_KEY", /one line/],
    ["an empty file", () => secretFile(""), "STRIPE_SECRET_KEY", /test-mode/],
  ];
  for (const [name, make, secret, why] of refusals) {
    it(`refuses ${name}, spawns no wrangler, and leaves the file`, async () => {
      const file = make();
      const { deps, execs, printed } = stripeDeps();
      expect(await main(put(secret, file), deps)).toBe(3);
      expect(printed.join("\n")).toMatch(why);
      expect(execs.filter((e) => e.args.includes("wrangler"))).toEqual([]);
      if (file.startsWith("/") && !file.startsWith("/nonexistent"))
        expect(existsSync(file)).toBe(true);
    });
  }

  it("refuses a hard-linked file: a second name could sit in a repository and outlive the removal", async () => {
    const file = secretFile(testKey);
    linkSync(file, `${file}-second`);
    const { deps, execs, printed } = stripeDeps();
    expect(await main(put("STRIPE_SECRET_KEY", file), deps)).toBe(3);
    expect(printed.join("\n")).toMatch(/hard link/);
    expect(execs.filter((e) => e.args.includes("wrangler"))).toEqual([]);
  });

  it("refuses a file in any git work tree, such as the main checkout seen from a worktree", async () => {
    const top = mkdtempSync(join(tmpdir(), "nov1-checkout-"));
    mkdirSync(join(top, ".git"));
    mkdirSync(join(top, "notes"));
    const file = join(top, "notes", "stripe-key");
    writeFileSync(file, testKey, { mode: 0o600 });
    const { deps, execs, printed } = stripeDeps();
    expect(await main(put("STRIPE_SECRET_KEY", file), deps)).toBe(3);
    expect(printed.join("\n")).toMatch(/git work tree/);
    expect(execs.filter((e) => e.args.includes("wrangler"))).toEqual([]);
  });

  it("refuses a file inside the repository", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "nov1-repo-")));
    const file = join(root, "stripe-key");
    writeFileSync(file, testKey, { mode: 0o600 });
    const { deps, execs, printed } = stripeDeps();
    const inRepo = { ...deps, repoRoot: root };
    expect(await main(put("STRIPE_SECRET_KEY", file), inRepo)).toBe(3);
    expect(printed.join("\n")).toMatch(/outside the repository/);
    expect(execs.filter((e) => e.args.includes("wrangler"))).toEqual([]);
  });

  for (const name of [
    "EMAIL_ALLOWED_RECIPIENTS",
    "CF_SAAS_API_TOKEN",
    "FAKE_PAYMENT_WEBHOOK_SECRET",
  ]) {
    it(`refuses ${name} from a file: only Stripe test-mode values may`, async () => {
      const set =
        name === "EMAIL_ALLOWED_RECIPIENTS"
          ? "email"
          : name === "CF_SAAS_API_TOKEN"
            ? "saas"
            : "preview";
      const { deps, execs, printed } = fakeDeps({ configs: p9 });
      approve(deps, { cutoverDone: true });
      const argv = ["secrets", set, "--put", name, "--from-file", secretFile("x".repeat(40))];
      expect(
        await main(
          [...argv, "--phase", "p10", "--live", "--go", "A2", "--confirm", `tidegrid-api,${name}`],
          deps,
        ),
      ).toBe(3);
      expect(printed.join("\n")).toMatch(/from-file/);
      expect(execs.filter((e) => e.args.includes("wrangler"))).toEqual([]);
    });
  }

  it("refuses --from-file with --delete or --generate", async () => {
    const { deps } = stripeDeps();
    const file = secretFile(testKey);
    expect(
      await main(
        [
          "secrets",
          "stripe",
          "--delete",
          "STRIPE_SECRET_KEY",
          "--from-file",
          file,
          "--phase",
          "p9",
          "--live",
          "--go",
          "A13",
        ],
        deps,
      ),
    ).toBe(3);
  });

  it("keeps the file when wrangler fails, and says so", async () => {
    const file = secretFile(testKey);
    const { deps, printed } = stripeDeps({
      exec: (c) => (c.args.includes("put") ? { code: 1, stdout: "" } : undefined),
    });
    expect(await main(put("STRIPE_SECRET_KEY", file), deps)).toBe(1);
    expect(existsSync(file)).toBe(true);
    expect(printed.join("\n")).toMatch(/file kept/);
    expect(
      loadJournal(deps)
        .entries.filter((e) => e.step === "secret-put")
        .map((e) => e.result),
    ).toEqual(["started", "failed"]);
  });

  it("refuses a declared put without --from-file: nobody would answer wrangler's prompt", async () => {
    const { deps, execs, printed } = stripeDeps();
    expect(await main(put("STRIPE_SECRET_KEY"), deps)).toBe(3);
    expect(printed.join("\n")).toMatch(/--from-file/);
    expect(execs.filter((e) => e.args.includes("wrangler"))).toEqual([]);
  });
});

describe("a webhook secret from a file is paired with a test key", () => {
  const env = { STRIPE_SECRET_KEY: testKey };

  it("puts whsec_ when the shell's key is a test key and the journal shows a test-file key put in this phase", async () => {
    const file = secretFile(whsec);
    const { deps, printed, sent } = stripeDeps({ env }, [keyPut("test-file")]);
    expect(await main(put("STRIPE_WEBHOOK_SECRET", file), deps), printed.join("\n")).toBe(0);
    expect(sent()).toBe(whsec);
    expect(existsSync(file)).toBe(false);
  });

  const refusals: [string, Parameters<typeof fakeDeps>[0], Entry[], RegExp][] = [
    ["no test-file key put", { env }, [], /STRIPE_SECRET_KEY/],
    ["a key the owner typed", { env }, [keyPut(undefined)], /test-file/],
    ["a key put in another phase", { env }, [keyPut("test-file", "p8")], /P9/],
    [
      "a key deleted since",
      { env },
      [keyPut("test-file"), { ...keyPut(undefined), step: "secret-delete" }],
      /STRIPE_SECRET_KEY/,
    ],
    [
      "a failed key put since",
      { env },
      [keyPut("test-file"), { ...keyPut("typed"), result: "failed" }],
      /may have changed/,
    ],
    [
      "an interrupted key put since (started only)",
      { env },
      [keyPut("test-file"), { ...keyPut("typed"), result: "started" }],
      /may have changed/,
    ],
    [
      "an API rollback since",
      { env },
      [
        keyPut("test-file"),
        {
          at: "2026-11-04T19:00:00Z",
          phase: "p9",
          step: "rollback",
          worker: "api",
          result: "done",
        },
      ],
      /may have changed/,
    ],
    [
      "a live key in the shell",
      { env: { STRIPE_SECRET_KEY: `sk_live_${"L".repeat(30)}` } },
      [keyPut("test-file")],
      /shell/,
    ],
    ["no key in the shell", {}, [keyPut("test-file")], /shell/],
  ];
  for (const [name, o, entries, why] of refusals) {
    it(`refuses with ${name}`, async () => {
      const file = secretFile(whsec);
      const { deps, execs, printed } = stripeDeps(o, entries);
      expect(await main(put("STRIPE_WEBHOOK_SECRET", file), deps)).toBe(3);
      expect(printed.join("\n")).toMatch(why);
      expect(execs.filter((e) => e.args.includes("wrangler") && e.args.includes("put"))).toEqual(
        [],
      );
      expect(existsSync(file)).toBe(true);
    });
  }

  it("refuses a malformed webhook secret", async () => {
    const file = secretFile("whsec_short");
    const { deps } = stripeDeps({ env }, [keyPut("test-file")]);
    expect(await main(put("STRIPE_WEBHOOK_SECRET", file), deps)).toBe(3);
  });
});

describe("a declared secret delete", () => {
  const del = (confirm?: string) => [
    "secrets",
    "stripe",
    "--delete",
    "STRIPE_SECRET_KEY",
    "--phase",
    "p9",
    "--live",
    "--go",
    "A13",
    ...(confirm ? ["--confirm", confirm] : []),
  ];

  it("gives wrangler no terminal stdin, so its own delete prompt takes its non-interactive yes", async () => {
    const { deps, execs, prompts } = stripeDeps();
    expect(await main(del("tidegrid-api,STRIPE_SECRET_KEY"), deps)).toBe(0);
    expect(prompts).toEqual([]);
    const call = execs.find((e) => e.args.includes("delete"));
    expect(call?.args).toEqual(["exec", "wrangler", "secret", "delete", "STRIPE_SECRET_KEY"]);
    expect(call?.options).toMatchObject({ stdio: "inherit", stdin: "null" });
  });

  it("refuses a delete whose name is not declared", async () => {
    const { deps, execs } = stripeDeps();
    expect(await main(del("tidegrid-api,STRIPE_WEBHOOK_SECRET"), deps)).toBe(3);
    expect(execs.filter((e) => e.args.includes("delete"))).toEqual([]);
  });

  it("leaves wrangler's prompt to the owner when typed", async () => {
    const { deps, execs } = stripeDeps({ answers: ["tidegrid-api", "STRIPE_SECRET_KEY"] });
    expect(await main(del(), deps)).toBe(0);
    expect(execs.find((e) => e.args.includes("delete"))?.options.stdin).toBeUndefined();
  });
});

describe("evidence shows a declared approval", () => {
  it("marks it in the approved list", async () => {
    const { deps, printed } = fakeDeps();
    await main(["approve-sha", headSha, "--go", "A3", "--confirm", headSha.slice(0, 12)], deps);
    printed.length = 0;
    expect(await main(["evidence"], deps)).toBe(0);
    expect(printed.join("\n")).toMatch(/under A3, declared, not typed/);
  });
});

describe("the real exec", () => {
  it("refuses stdin bytes with captured output, where they would be dropped", async () => {
    const { realDeps } = await import("../src/cli.ts");
    await expect(
      realDeps().exec("true", [], { env: {}, stdio: "pipe", stdin: Buffer.from("x") }),
    ).rejects.toThrow(/stdin/);
  });
});

describe("a typed rollback is journaled as started before wrangler runs", () => {
  it("so an interrupted rollback still breaks the webhook pairing", async () => {
    const v = (n: number) => `${String(n).repeat(8)}-2222-4333-8444-555555555555`;
    let rolled = false;
    let startedBeforeWrangler = false;
    const f = fakeDeps({
      answers: ["tidegrid-api", v(1).slice(0, 8), "yes"],
      exec: (c) => {
        if (c.args.includes("rollback")) {
          startedBeforeWrangler = loadJournal(f.deps).entries.some(
            (e) => e.step === "rollback" && e.result === "started" && e.worker === "api",
          );
          rolled = true;
          return { code: 0, stdout: "" };
        }
        if (c.args.includes("deployments"))
          return {
            code: 0,
            stdout: JSON.stringify([{ versions: [{ version_id: rolled ? v(1) : v(2) }] }]),
          };
        return undefined;
      },
    });
    approve(f.deps, {}, [
      {
        at: "2026-11-01T15:00:00Z",
        phase: "p3",
        step: "release",
        worker: "api",
        result: "done",
        sha: headSha,
        versionBefore: [v(1)],
        versionAfter: [v(2)],
      },
    ]);
    const argv = ["release", "api", "--phase", "p7", "--rollback", "--live", "--go", "A8"];
    expect(await main(argv, f.deps), f.printed.join("\n")).toBe(0);
    expect(startedBeforeWrangler).toBe(true);
    expect(
      loadJournal(f.deps)
        .entries.filter((e) => e.step === "rollback")
        .map((e) => e.result),
    ).toEqual(["started", "done"]);
  });
});
