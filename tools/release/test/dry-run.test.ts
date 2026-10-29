import { describe, expect, it } from "vitest";
import { main } from "../src/cli.ts";
import { fakeDeps, providerExecs } from "./helpers.ts";

const liveDb = { NEON_DATABASE_URL: "postgresql://owner:pw@ep-main.neon.tech/neondb" };

/** Every subcommand's dry run, with a live target. Acceptance item 2. */
const dryRuns: [string, string[], Record<string, string>?][] = [
  ["preflight offline", ["preflight", "--phase", "p3", "--allow-branch", "--skip-build"]],
  ["db status", ["db", "status"], liveDb],
  ["db backup", ["db", "backup"], liveDb],
  ["db migrate", ["db", "migrate"], liveDb],
  ["db seed", ["db", "seed"], liveDb],
  ["db outbox-summary", ["db", "outbox-summary"], liveDb],
  ["db platform", ["db", "platform", "demo-harbor"], liveDb],
  ["secrets preview", ["secrets", "preview"]],
  ["secrets email", ["secrets", "email"]],
  ["secrets stripe", ["secrets", "stripe"]],
  ["secrets saas", ["secrets", "saas"]],
  ["release api", ["release", "api", "--phase", "p3"]],
  ["release console", ["release", "console", "--phase", "p4"]],
  ["release guest", ["release", "guest", "--phase", "p4"]],
  ["release guest rollback", ["release", "guest", "--phase", "p4", "--rollback"]],
  [
    "smoke preview",
    [
      "smoke",
      "--profile",
      "preview",
      "--base",
      "https://api.tidegrid.us",
      "--hosts",
      "demo-harbor.book.tidegrid.us,demo-reef.book.tidegrid.us",
    ],
  ],
  [
    "last-seat preview",
    [
      "last-seat",
      "--profile",
      "preview",
      "--api",
      "https://api.tidegrid.us",
      "--hosts",
      "demo-harbor.book.tidegrid.us,demo-reef.book.tidegrid.us",
    ],
  ],
  [
    "isolation preview",
    [
      "isolation",
      "--profile",
      "preview",
      "--api",
      "https://api.tidegrid.us",
      "--hosts",
      "demo-harbor.book.tidegrid.us,demo-reef.book.tidegrid.us",
    ],
  ],
  ["accept guest", ["accept", "guest"]],
  ["accept console", ["accept", "console"]],
  ["stripe-smoke", ["stripe-smoke"]],
  ["payment-account", ["payment-account", "set", "demo-harbor", "stripe"], liveDb],
  ["hostname-disable", ["hostname-disable", "demo-harbor", "book.example-owner.com"], liveDb],
];

describe("dry runs make no exec or fetch to a provider, wrangler, or dig", () => {
  for (const [name, argv, env] of dryRuns) {
    it(name, async () => {
      const { deps, execs, fetches, printed } = fakeDeps({ env: env ?? {}, tty: false });
      const code = await main(argv, deps);
      expect(code, printed.join("\n")).toBe(0);
      expect(providerExecs(execs)).toEqual([]);
      expect(execs.every((e) => e.cmd === "git")).toBe(true);
      expect(fetches).toEqual([]);
      if (name !== "preflight offline") expect(printed.join("\n")).toContain("DRY RUN: nov1");
      // The plan never shows a value: the URL's credentials stay out.
      expect(printed.join("\n")).not.toContain("owner:pw");
    });
  }
});
