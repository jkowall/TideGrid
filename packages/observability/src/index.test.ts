import { describe, expect, it } from "vitest";
import { createLogger, redact } from "./index.ts";

describe("observability", () => {
  it("drops attributes that are not on the allowlist", () => {
    const out = redact({ "url.path": "/v1/health", email: "guest@example.com", card: "4242" });
    expect(out).toEqual({ "url.path": "/v1/health" });
  });

  it("emits one JSON line with level, message, and merged attributes", () => {
    const lines: string[] = [];
    const log = createLogger({ "tidegrid.environment": "local" }, (l) => lines.push(l));
    log.child({ "tidegrid.request_id": "r1" }).info("hello", { duration_ms: 3, secret: "x" });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] as string);
    expect(parsed.level).toBe("info");
    expect(parsed["tidegrid.environment"]).toBe("local");
    expect(parsed["tidegrid.request_id"]).toBe("r1");
    expect(parsed.duration_ms).toBe(3);
    expect(parsed.secret).toBeUndefined();
  });
});
