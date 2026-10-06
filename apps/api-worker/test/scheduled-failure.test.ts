import {
  createExecutionContext,
  createScheduledController,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";

// The sweep fails as a lost connection would, before it touches the network.
vi.mock("@tidegrid/domain-inventory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tidegrid/domain-inventory")>()),
  sweepExpiredHolds: vi.fn(async () => {
    throw Object.assign(new Error("terminating connection"), { code: "57P01" });
  }),
}));

describe("a failed hold sweep", () => {
  it("fails the cron invocation itself, after logging why", async () => {
    const configured = { ...env, DATABASE_URL: "postgres://nobody:nothing@127.0.0.1:1/none" };
    const lines: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    try {
      const ctx = createExecutionContext();
      await expect(
        worker.scheduled(
          createScheduledController({ scheduledTime: new Date(0), cron: "*/15 * * * *" }),
          configured,
          ctx,
        ),
      ).rejects.toThrow("terminating connection");
      await waitOnExecutionContext(ctx);
    } finally {
      logSpy.mockRestore();
    }
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({
        level: "error",
        message: "hold_sweep_failed",
        "event.name": "hold_sweep",
        "error.type": "Error",
        "db.response.status_code": "57P01",
      }),
    ]);
    expect(lines.join("\n")).not.toContain("nothing@");
  });
});
