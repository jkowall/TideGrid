import {
  createExecutionContext,
  createScheduledController,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index.ts";
import { runScheduled } from "../src/scheduled.ts";

const cron = "*/15 * * * *";

describe("scheduled hold sweep", () => {
  it("logs a skip and returns when no database is configured", async () => {
    const lines: string[] = [];
    await runScheduled({ cron }, env, { log: (line) => lines.push(line) });
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({
        level: "warn",
        message: "hold_sweep_skipped",
        "event.name": "hold_sweep",
        "error.type": "database_unconfigured",
        "tidegrid.environment": "local",
      }),
    ]);
  });

  it("is the default export's scheduled handler", async () => {
    expect(typeof worker.scheduled).toBe("function");
    const ctx = createExecutionContext();
    await worker.scheduled(
      createScheduledController({ scheduledTime: new Date(0), cron }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
  });
});
