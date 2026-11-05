/**
 * nov1 smoke (P5; acceptance step 1 over HTTP). Read-only. Each profile has its
 * own table of expectations, because local development legitimately accepts
 * http, ports, and staff routes on loopback (public-tenant.ts:59-61,
 * gateway.ts:23-30), and CI rewrites the guest CSP through GUEST_LOCAL_API.
 * The preview-only rows are first exercised on Nov 1.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Args, flag, onlyFlags } from "../args.ts";
import { type Deps, Failure, out, type Plan, printPlan } from "../core.ts";
import { liveGate } from "../gate.ts";
import {
  client,
  errorCode,
  guestGet,
  newCallLog,
  originOf,
  type Profile,
  type ProfileName,
  parseHosts,
  profileFor,
  tenantMetas,
} from "../http.ts";
import { record } from "../journal.ts";
import { treeMigrations } from "./preflight.ts";

export type SmokeCheck =
  | "health"
  | "tenant-echo"
  | "negative-trailing-dot"
  | "negative-unpublished-host"
  | "negative-workers-dev"
  | "negative-port"
  | "negative-http"
  | "staff-route-404"
  | "brand-manifest"
  | "release-csp";

/** The checks each profile runs. Pinned by a unit test. */
export const smokeProfiles: Record<ProfileName, SmokeCheck[]> = {
  local: [
    "health",
    "tenant-echo",
    "negative-trailing-dot",
    "negative-unpublished-host",
    "brand-manifest",
  ],
  preview: [
    "health",
    "tenant-echo",
    "negative-trailing-dot",
    "negative-unpublished-host",
    "negative-workers-dev",
    "negative-port",
    "negative-http",
    "staff-route-404",
    "brand-manifest",
    "release-csp",
  ],
};

/** Expected health per profile. */
export const healthExpect: Record<ProfileName, { environment: string }> = {
  local: { environment: "local" },
  preview: { environment: "preview" },
};

export const workersDevOrigin = "https://tidegrid-guest.jkowall.workers.dev";

export function releaseCsp(repoRoot: string): string {
  const text = readFileSync(join(repoRoot, "apps/guest-site/public/_headers"), "utf8");
  const line = text.split("\n").find((l) => l.trim().startsWith("Content-Security-Policy:"));
  return (line ?? "").trim().replace(/^Content-Security-Policy:\s*/, "");
}

export function smokePlan(profile: Profile): Plan {
  const checks = smokeProfiles[profile.name];
  return {
    command: `smoke --profile ${profile.name}`,
    target: `${profile.apiBase} and ${profile.hosts.map((h) => h.host).join(", ")}`,
    notes: ["Read-only HTTP. No write, so no rate budget is spent."],
    steps: checks.map((c, i) => ({
      id: `${i + 1}`,
      title: c,
      gate: profile.name === "preview" ? "A0" : undefined,
      commands: [
        `GET ${c === "brand-manifest" || c === "release-csp" ? "https://<host>/" : `${profile.apiBase}/v1/`}... (see smoke.ts)`,
      ],
      expect: [describeCheck(c)],
      rollback: ["not applicable (read-only)"],
    })) as Plan["steps"],
  };
}

function describeCheck(c: SmokeCheck): string {
  const d: Record<SmokeCheck, string> = {
    health:
      "200, database ok, environment for the profile, migrations.latest = the tree's last file, version = --build when given",
    "tenant-echo":
      "GET /v1/public/tenant with each host's Origin returns its slug and echoes the Origin in Access-Control-Allow-Origin",
    "negative-trailing-dot": "an Origin with a trailing dot gets the shared 404 tenant_not_found",
    "negative-unpublished-host": "an unpublished host's Origin gets the shared 404",
    "negative-workers-dev": `${workersDevOrigin} gets the shared 404`,
    "negative-port": "another tenant's host with a port gets the shared 404",
    "negative-http": "an http Origin gets the shared 404",
    "staff-route-404": "GET /v1/me on the public API answers 404 (gateway.ts:23-35)",
    "brand-manifest": "each host's /manifest.webmanifest names its own brand",
    "release-csp": "each host's page carries the CSP from apps/guest-site/public/_headers:2",
  };
  return d[c];
}

export async function smoke(deps: Deps, args: Args): Promise<number> {
  onlyFlags(args, ["profile", "base", "api", "hosts", "build", "live", "go", "dry-run"]);
  const hosts = parseHosts(flag(args, "hosts"));
  const profile = profileFor(flag(args, "profile"), flag(args, "base") ?? flag(args, "api"), hosts);
  if (args.flags.has("dry-run") || (profile.name === "preview" && !args.flags.has("live"))) {
    printPlan(deps, smokePlan(profile));
    return 0;
  }
  let gate: string | undefined;
  if (profile.name === "preview") {
    gate = await liveGate(
      deps,
      { live: true, go: flag(args, "go") },
      {
        gates: ["A0", "A10"],
        confirm: [],
        action: "read-only HTTP smoke of the preview",
        readOnly: true,
      },
    );
  }
  const results = await runSmoke(deps, profile, flag(args, "build"));
  const ran = results.filter((r) => !r.notRun);
  const notRun = results.filter((r) => r.notRun);
  const failed = ran.filter((r) => !r.ok);
  for (const r of results) {
    const label = r.notRun ? "NOT RUN" : r.ok ? "PASS" : "FAIL";
    out(deps, `${label}  ${r.check}${r.host ? ` ${r.host}` : ""}: ${r.detail}`);
  }
  const skipped = notRun.length
    ? `, ${notRun.length} not run (${notRun.map((r) => r.check).join(", ")})`
    : "";
  if (profile.name === "preview") {
    // The gate says which phase this is: A0 is the P5 smoke, A10 the P8 rerun.
    record(deps, {
      phase: gate === "A10" ? "p8" : "p5",
      step: "smoke",
      ...(gate ? { gate } : {}),
      result: failed.length ? "failed" : "done",
      note: `${ran.length - failed.length}/${ran.length} passed${skipped}`,
    });
  }
  if (failed.length) throw new Failure(`smoke: ${failed.length} check(s) failed`);
  out(deps, `smoke passed: ${ran.length} checks${skipped}, profile ${profile.name}`);
  return 0;
}

export interface SmokeResult {
  check: SmokeCheck;
  host?: string;
  ok: boolean;
  detail: string;
  /** The profile lists the check, but the targets given cannot exercise it. */
  notRun?: boolean;
}

export async function runSmoke(
  deps: Deps,
  profile: Profile,
  build?: string,
): Promise<SmokeResult[]> {
  const log = newCallLog();
  const metas = tenantMetas(deps.repoRoot);
  const results: SmokeResult[] = [];
  const checks = new Set(smokeProfiles[profile.name]);
  const first = profile.hosts[0];
  if (!first) return results;
  const any = client(deps, profile, first, log);
  const push = (r: SmokeResult) => results.push(r);
  const notFound = async (check: SmokeCheck, origin: string) => {
    const a = await any("GET", "/v1/public/tenant", { origin });
    push({
      check,
      ok: a.status === 404 && errorCode(a) === "tenant_not_found",
      detail: `${a.status} ${errorCode(a) ?? ""}`,
    });
  };

  if (checks.has("health")) {
    const a = await any("GET", "/v1/health");
    const latest = treeMigrations(deps.repoRoot).at(-1);
    const m = a.json.migrations as { latest?: string } | null;
    const problems = [
      a.status !== 200 && `status ${a.status}`,
      a.json.database !== "ok" && `database ${String(a.json.database)}`,
      a.json.environment !== healthExpect[profile.name].environment &&
        `environment ${String(a.json.environment)}`,
      m?.latest !== latest && `migrations.latest ${m?.latest ?? "none"} (tree ${latest})`,
      build && a.json.version !== build && `version ${String(a.json.version)} (expected ${build})`,
    ].filter(Boolean);
    push({
      check: "health",
      ok: problems.length === 0,
      detail: problems.join(", ") || `ok, ${latest}`,
    });
  }

  for (const host of profile.hosts) {
    const call = client(deps, profile, host, log);
    const meta = metas.find((t) => t.slug === host.slug);
    if (checks.has("tenant-echo")) {
      const a = await call("GET", "/v1/public/tenant");
      const slug = (a.json.tenant as { slug?: string } | undefined)?.slug;
      const acao = a.headers.get("access-control-allow-origin");
      push({
        check: "tenant-echo",
        host: host.host,
        ok: a.status === 200 && slug === host.slug && acao === originOf(profile, host),
        detail: `${a.status} slug ${slug ?? "none"}, ACAO ${acao === originOf(profile, host) ? "echoed" : (acao ?? "none")}`,
      });
    }
    if (checks.has("brand-manifest")) {
      const res = await guestGet(deps, profile, host, "/manifest.webmanifest");
      const body = (await res.json().catch(() => ({}))) as { name?: string };
      push({
        check: "brand-manifest",
        host: host.host,
        ok: res.status === 200 && body.name === meta?.name,
        detail: `${res.status} ${body.name ?? "no name"}`,
      });
    }
    if (checks.has("release-csp")) {
      const res = await guestGet(deps, profile, host, "/");
      const csp = res.headers.get("content-security-policy");
      push({
        check: "release-csp",
        host: host.host,
        ok: res.status === 200 && csp === releaseCsp(deps.repoRoot),
        detail: `${res.status} ${csp === releaseCsp(deps.repoRoot) ? "release CSP" : "CSP differs"}`,
      });
    }
  }

  const [hostA, hostB] = profile.hosts;
  if (checks.has("negative-trailing-dot")) {
    const dotted = first.host.includes(":") ? first.host.replace(":", ".:") : `${first.host}.`;
    await notFound("negative-trailing-dot", `${profile.guestScheme}://${dotted}`);
  }
  if (checks.has("negative-unpublished-host")) {
    const sample = first.host.replace(/^[^.:]+/, "nobody-nov1");
    await notFound("negative-unpublished-host", `${profile.guestScheme}://${sample}`);
  }
  if (checks.has("negative-workers-dev")) await notFound("negative-workers-dev", workersDevOrigin);
  if (checks.has("negative-port")) {
    if (hostB) await notFound("negative-port", `https://${hostB.host}:8443`);
    else
      push({
        check: "negative-port",
        ok: true,
        notRun: true,
        detail: "needs a second host (another tenant's host with a port); give --hosts h1,h2",
      });
  }
  if (checks.has("negative-http") && hostA) await notFound("negative-http", `http://${hostA.host}`);
  if (checks.has("staff-route-404")) {
    const a = await any("GET", "/v1/me");
    push({ check: "staff-route-404", ok: a.status === 404, detail: `${a.status}` });
  }
  return results;
}
