#!/usr/bin/env node
// Supply-chain report for CI (W3-OPS-3): an SBOM, a dependency-license report,
// a known-vulnerability check, and a build manifest. Node built-ins only.
//
//   node scripts/supply-chain.mjs <out dir>          # all four, exit 1 on a policy failure
//   node scripts/supply-chain.mjs <out dir> --offline # skip the registry audit
//
// Policy: config/supply-chain-policy.json. Licenses outside the allow list,
// and high or critical advisories, fail unless the policy lists them as an
// exception with a reason and a review date that has not passed. A license
// exception names a package, or a package at one version.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const outDir = resolve(process.argv[2] ?? "supply-chain");
const offline = process.argv.includes("--offline");
const policy = JSON.parse(readFileSync(join(root, "config/supply-chain-policy.json"), "utf8"));
const today = new Date().toISOString().slice(0, 10);
mkdirSync(outDir, { recursive: true });

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...opts });
const problems = [];
const notes = [];

/** An exception counts only with a reason and a review date not yet passed. */
function excepted(list, key) {
  const e = (list ?? []).find((x) => x.id === key);
  if (!e) return false;
  if (!e.reason || !/^\d{4}-\d{2}-\d{2}$/.test(e.review_by ?? "")) {
    problems.push(`exception ${key} needs a reason and a review_by date`);
    return false;
  }
  if (e.review_by < today) {
    problems.push(`exception ${key} passed its review date ${e.review_by}; review it`);
    return false;
  }
  return true;
}

// 1. Licenses, for every installed package (dev tools included: they build the bundles).
const byLicense = JSON.parse(run("pnpm", ["licenses", "list", "--json"]));
const allowed = new Set(policy.licenses.allow);
/**
 * Whether an SPDX expression is allowed: "A OR B" when either side is, "A AND
 * B" when both are, AND binding tighter than OR, parentheses respected. A
 * WITH exception is judged by its license. Anything unparsable fails.
 */
const licenseOk = (expr) => {
  const tokens = expr.match(/\(|\)|[^\s()]+/g) ?? [];
  let i = 0;
  const peek = () => tokens[i];
  const primary = () => {
    const t = tokens[i++];
    if (t === "(") {
      const v = orExpr();
      if (tokens[i++] !== ")") throw new Error("unbalanced");
      return v;
    }
    if (t === undefined || t === ")" || /^(AND|OR|WITH)$/.test(t)) throw new Error("bad token");
    if (peek() === "WITH") i += 2;
    return allowed.has(t);
  };
  const andExpr = () => {
    let v = primary();
    while (peek() === "AND") {
      i++;
      v = primary() && v;
    }
    return v;
  };
  const orExpr = () => {
    let v = andExpr();
    while (peek() === "OR") {
      i++;
      v = andExpr() || v;
    }
    return v;
  };
  try {
    const v = orExpr();
    return i === tokens.length && v;
  } catch {
    return false;
  }
};
const packages = [];
for (const [license, list] of Object.entries(byLicense)) {
  for (const p of list) {
    for (const version of p.versions) {
      packages.push({ name: p.name, version, license });
    }
  }
}
packages.sort((a, b) => (a.name + a.version).localeCompare(b.name + b.version));
const licenseRows = [];
for (const p of packages) {
  const ok =
    licenseOk(p.license) ||
    excepted(policy.licenses.exceptions, `${p.name}@${p.version}`) ||
    excepted(policy.licenses.exceptions, p.name);
  if (!ok) problems.push(`license ${p.license} on ${p.name}@${p.version} is not on the allow list`);
  licenseRows.push(`| ${p.name} | ${p.version} | ${p.license} | ${ok ? "ok" : "NOT ALLOWED"} |`);
}
writeFileSync(
  join(outDir, "licenses.md"),
  `# Dependency licenses\n\n${packages.length} packages.\n\n| Package | Version | License | Policy |\n|---|---|---|---|\n${licenseRows.join("\n")}\n`,
);

// 2. SBOM, CycloneDX 1.5 JSON, from the same installed set.
const commit = run("git", ["rev-parse", "HEAD"]).trim();
const sbom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    component: { type: "application", name: "tidegrid", version: commit },
    tools: { components: [{ type: "application", name: "scripts/supply-chain.mjs" }] },
  },
  components: packages.map((p) => {
    const purl = `pkg:npm/${p.name.startsWith("@") ? `%40${p.name.slice(1)}` : p.name}@${p.version}`;
    return {
      type: "library",
      "bom-ref": purl,
      name: p.name,
      version: p.version,
      purl,
      licenses: [{ expression: p.license }],
    };
  }),
};
writeFileSync(join(outDir, "sbom.cdx.json"), `${JSON.stringify(sbom, null, 2)}\n`);

// 3. Known vulnerabilities from the registry's audit. High and critical fail.
let audit = { skipped: offline };
if (!offline) {
  let text;
  try {
    text = run("pnpm", ["audit", "--json"]);
  } catch (e) {
    // pnpm audit exits non-zero when it finds anything; the JSON is still on stdout.
    text = e.stdout ?? "";
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    problems.push("pnpm audit did not answer JSON (registry unreachable?)");
  }
  // A failed audit can still answer JSON (an error object). Only a real report counts.
  if (parsed && (parsed.error || typeof parsed.metadata?.vulnerabilities !== "object")) {
    problems.push(
      `pnpm audit did not return a report: ${JSON.stringify(parsed.error ?? parsed).slice(0, 300)}`,
    );
    parsed = undefined;
  }
  if (parsed) {
    const found = Object.values(parsed.advisories ?? {}).map((a) => ({
      id: a.github_advisory_id ?? String(a.id),
      severity: a.severity,
      module: a.module_name,
      title: a.title,
      path: a.findings?.[0]?.paths?.[0] ?? "",
    }));
    for (const a of found) {
      const blocking = policy.vulnerabilities.fail_on.includes(a.severity);
      if (blocking && !excepted(policy.vulnerabilities.exceptions, a.id)) {
        problems.push(`${a.severity} advisory ${a.id} in ${a.module} (${a.path})`);
      } else {
        notes.push(`${a.severity} advisory ${a.id} in ${a.module} (${a.path})`);
      }
    }
    audit = { counts: parsed.metadata?.vulnerabilities ?? {}, advisories: found };
  }
}
writeFileSync(join(outDir, "audit.json"), `${JSON.stringify(audit, null, 2)}\n`);

// 4. Build manifest: what this commit builds from.
const sha256 = (path) => createHash("sha256").update(readFileSync(join(root, path))).digest("hex");
const tracked = (glob) => run("git", ["ls-files", "--", glob]).split("\n").filter(Boolean);
const manifest = {
  commit,
  tree: run("git", ["rev-parse", "HEAD^{tree}"]).trim(),
  node: process.versions.node,
  pnpm: run("pnpm", ["--version"]).trim(),
  lockfile_sha256: sha256("pnpm-lock.yaml"),
  wrangler_configs: Object.fromEntries(tracked("apps/*/wrangler.jsonc").map((f) => [f, sha256(f)])),
  tenant_manifests: Object.fromEntries(tracked("config/tenants/*.json").map((f) => [f, sha256(f)])),
  migrations: tracked("packages/database/migrations/*.sql").length,
  packages: packages.length,
};
writeFileSync(join(outDir, "build-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

const summary = [
  "## Supply chain",
  `- ${packages.length} packages, SBOM \`sbom.cdx.json\` (CycloneDX 1.5)`,
  `- Licenses: ${problems.filter((p) => p.startsWith("license")).length} outside the allow list`,
  offline ? "- Vulnerabilities: not checked (offline)" : `- Vulnerabilities: ${JSON.stringify(audit.counts ?? {})}`,
  ...notes.map((n) => `- Noted, not blocking: ${n}`),
  ...problems.map((p) => `- **Blocking:** ${p}`),
  "",
].join("\n");
writeFileSync(join(outDir, "summary.md"), summary);
console.log(summary);
if (problems.length) process.exitCode = 1;
