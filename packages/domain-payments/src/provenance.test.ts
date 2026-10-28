/**
 * Provenance guards for the verified-event brand and the Stripe fixture.
 *
 * The brand on VerifiedProviderEvent is type-only, and `verifiedEvent` is a
 * plain cast, so the compiler alone cannot stop a forged event. These scans
 * do: `verifyWebhook` stays the only producer of the brand, nothing outside
 * this package reaches into its source, and no runtime code imports the
 * test fixture.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const self = fileURLToPath(import.meta.url);
const skipped = new Set(["node_modules", "dist", "generated", "playwright-report", "test-results"]);
const codeFile = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const testFile = /\.test\.(?:ts|tsx)$/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || skipped.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (codeFile.test(entry.name)) out.push(path);
  }
  return out;
}

const files = ["apps", "packages", "tools"]
  .flatMap((top) => walk(join(root, top)))
  .filter((path) => path !== self)
  .map((path) => ({ path, rel: relative(root, path).split(sep).join("/"), text: "" }));
for (const file of files) file.text = readFileSync(file.path, "utf8");

const payments = "packages/domain-payments/src/";
const mintName = ["verified", "Event"].join("");
const brandName = ["Verified", "Provider", "Event"].join("");

/** The body of `async verifyWebhook(...) {...}`, as a [start, end) range of offsets. */
function verifyWebhookBody(text: string): [number, number] | null {
  const start = text.indexOf("async verifyWebhook(");
  if (start < 0) return null;
  const open = text.indexOf("{", text.indexOf(")", start));
  if (open < 0) return null;
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "/" && text[i + 1] === "/") {
      i = text.indexOf("\n", i);
      if (i < 0) return null;
    } else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return [open, i + 1];
  }
  return null;
}

/** Every place a file names the minting function or casts to the brand, with why it is allowed. */
function brandFindings(rel: string, text: string): string[] {
  const problems: string[] = [];
  const mint = new RegExp(`\\b${mintName}\\b`, "g");
  const casts = [
    new RegExp(`\\bas\\s+(?:unknown\\s+as\\s+)?${brandName}\\b`, "g"),
    new RegExp(`(?:^|[^\\w$.])<${brandName}>(?!\\s*[=;,)\\]|])`, "gm"),
  ];
  const line = (offset: number) => text.slice(0, offset).split("\n").length;
  const castHits = casts.flatMap((re) => [...text.matchAll(re)]);
  const mintHits = [...text.matchAll(mint)];
  if (rel === `${payments}adapter.ts`) {
    // The definition, and its one cast.
    if (mintHits.length !== 1 || !/export function \w+\(fields/.test(text)) {
      problems.push(`${rel}: the minting function is named ${mintHits.length} times`);
    }
    if (castHits.length !== 1) problems.push(`${rel}: ${castHits.length} casts to the brand`);
    return problems;
  }
  for (const hit of castHits) problems.push(`${rel}:${line(hit.index)}: a cast to the brand`);
  if (rel === `${payments}fake.ts` || rel === `${payments}stripe.ts`) {
    const body = verifyWebhookBody(text);
    const imported = new RegExp(
      `import\\s*\\{[^}]*\\b${mintName}\\b[^}]*\\}\\s*from\\s*"\\./adapter\\.ts"`,
    ).exec(text);
    let calls = 0;
    for (const hit of mintHits) {
      const at = hit.index;
      if (imported && at >= imported.index && at < imported.index + imported[0].length) continue;
      if (body && at >= body[0] && at < body[1] && text[at + mintName.length] === "(") {
        calls++;
        continue;
      }
      problems.push(`${rel}:${line(at)}: the minting function outside verifyWebhook`);
    }
    if (calls !== 1) problems.push(`${rel}: ${calls} calls inside verifyWebhook, not 1`);
    return problems;
  }
  for (const hit of mintHits) problems.push(`${rel}:${line(hit.index)}: the minting function`);
  return problems;
}

const specifier =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|\bmock\s*\(\s*)["'`]([^"'`]+)["'`]/g;

function specifiers(text: string): string[] {
  return [...text.matchAll(specifier)].map((m) => m[1] ?? "");
}

/** Imports that reach this package's source or test support from where they must not. */
function importFindings(rel: string, text: string): string[] {
  const problems: string[] = [];
  const inside = rel.startsWith(payments);
  const runtime =
    /^(?:apps\/[^/]+\/(?:src|worker)|packages\/[^/]+\/src)\//.test(rel) && !testFile.test(rel);
  for (const spec of specifiers(text)) {
    if (!inside && spec.startsWith(".")) {
      const target = relative(root, resolve(root, dirname(rel), spec))
        .split(sep)
        .join("/");
      if (`${target}/`.startsWith(payments) || target.startsWith(payments)) {
        problems.push(`${rel}: reaches into ${payments} through ${spec}`);
      }
    }
    if (
      spec.startsWith("@tidegrid/domain-payments/") &&
      spec !== "@tidegrid/domain-payments/testing"
    ) {
      problems.push(`${rel}: imports the unexported ${spec}`);
    }
    const fixture = spec === "@tidegrid/domain-payments/testing" || spec.includes("stripe-fixture");
    if (fixture && runtime && rel !== `${payments}testing.ts`) {
      problems.push(`${rel}: runtime code imports the Stripe fixture through ${spec}`);
    }
  }
  return problems;
}

describe("verified-event provenance", () => {
  it("scans the whole workspace", () => {
    expect(files.length).toBeGreaterThan(150);
    for (const rel of ["adapter.ts", "fake.ts", "stripe.ts", "index.ts", "testing.ts"]) {
      expect(files.some((f) => f.rel === `${payments}${rel}`)).toBe(true);
    }
  });

  it("lets only verifyWebhook in the fake and Stripe adapters mint the brand", () => {
    const problems = files.flatMap((f) => brandFindings(f.rel, f.text));
    expect(problems).toEqual([]);
    const stripe = files.find((f) => f.rel === `${payments}stripe.ts`);
    expect(verifyWebhookBody(stripe?.text ?? "")).not.toBeNull();
  });

  it("keeps the minting function and the fixture out of the package's exports", () => {
    const index = files.find((f) => f.rel === `${payments}index.ts`)?.text ?? "";
    expect(new RegExp(`\\b${mintName}\\b`).test(index)).toBe(false);
    expect(index.includes("stripe-fixture")).toBe(false);
    expect(index.includes("testing")).toBe(false);
    const testing = files.find((f) => f.rel === `${payments}testing.ts`)?.text ?? "";
    const exported = [...testing.matchAll(/^\s+(?!type\s)(\w+),?$/gm)].map((m) => m[1]);
    expect(exported).toEqual(["createStripeFixture"]);
  });

  it("catches a forged event", () => {
    const forged = [
      `const e = {} as ${brandName};`,
      `const e = x as unknown as ${brandName};`,
      `const e = <${brandName}>x;`,
      `import { ${mintName} as mint } from "./adapter.ts";`,
    ];
    for (const text of forged) {
      expect(brandFindings("apps/api-worker/src/x.ts", text), text).not.toEqual([]);
    }
    const generic = `function f(): Promise<${brandName}> { return g<${brandName}>(); }`;
    expect(brandFindings("apps/api-worker/src/x.ts", generic)).toEqual([]);
    const outside = `async other() { return ${mintName}({}); }\nasync verifyWebhook(input) { return ${mintName}(input); }`;
    expect(brandFindings(`${payments}stripe.ts`, outside).length).toBeGreaterThan(0);
  });
});

describe("fixture and source boundaries", () => {
  it("lets nothing outside the package import its source, and no runtime code import the fixture", () => {
    const problems = files.flatMap((f) => importFindings(f.rel, f.text));
    expect(problems).toEqual([]);
  });

  it("catches each kind of bad import", () => {
    const bad: [string, string][] = [
      [
        "packages/domain-booking/src/x.ts",
        `import { a } from "../../domain-payments/src/stripe.ts";`,
      ],
      [
        "apps/api-worker/test/x.test.ts",
        `import { a } from "../../../packages/domain-payments/src/fake.ts";`,
      ],
      [
        "apps/api-worker/src/x.ts",
        `import { createStripeFixture } from "@tidegrid/domain-payments/testing";`,
      ],
      ["apps/api-worker/src/x.ts", `const m = await import("@tidegrid/domain-payments/testing");`],
      ["packages/domain-payments/src/stripe.ts", `import { x } from "./stripe-fixture.ts";`],
      ["packages/domain-payments/src/index.ts", `export * from "./stripe-fixture.ts";`],
      ["apps/guest-site/worker/x.ts", `import "@tidegrid/domain-payments/testing";`],
      ["apps/api-worker/src/x.ts", `import { x } from "@tidegrid/domain-payments/src/stripe.ts";`],
    ];
    for (const [rel, text] of bad) {
      expect(importFindings(rel, text), `${rel}: ${text}`).not.toEqual([]);
    }
    const fine: [string, string][] = [
      [
        "apps/api-worker/test-integration/x.integration.test.ts",
        `import { createStripeFixture } from "@tidegrid/domain-payments/testing";`,
      ],
      ["packages/domain-payments/src/stripe.test.ts", `import { x } from "./stripe-fixture.ts";`],
      ["packages/domain-payments/src/testing.ts", `export { x } from "./stripe-fixture.ts";`],
      [
        "apps/api-worker/src/x.ts",
        `import { createStripePaymentProvider } from "@tidegrid/domain-payments";`,
      ],
    ];
    for (const [rel, text] of fine) {
      expect(importFindings(rel, text), `${rel}: ${text}`).toEqual([]);
    }
  });
});
