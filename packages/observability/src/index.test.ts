import { describe, expect, it } from "vitest";
import { createLogger, redact, redactPath } from "./index.ts";

describe("observability", () => {
  it("drops attributes that are not on the allowlist", () => {
    const out = redact({ "url.path": "/v1/health", email: "guest@example.com", card: "4242" });
    expect(out).toEqual({ "url.path": "/v1/health" });
  });

  it("keeps the SQLSTATE of a failed query and the hold sweep counters", () => {
    const out = redact({
      "db.response.status_code": "23514",
      "tidegrid.hold_sweep.tenant_count": 2,
      "tidegrid.hold_sweep.expired_count": 5,
      "tidegrid.hold_sweep.failed_tenant_count": 0,
      "tidegrid.hold_sweep.complete": true,
      "db.query.text": "select secret",
    });
    expect(out).toEqual({
      "db.response.status_code": "23514",
      "tidegrid.hold_sweep.tenant_count": 2,
      "tidegrid.hold_sweep.expired_count": 5,
      "tidegrid.hold_sweep.failed_tenant_count": 0,
      "tidegrid.hold_sweep.complete": true,
    });
  });

  it("keeps the fair-sweep counters, the email account fault, and the hostname retry wait", () => {
    const counts = ["turn_count", "pass_count", "deferred_tenant_count", "stamp_failure_count"];
    const keys = [
      ...["hold", "checkout", "email", "hostname"].flatMap((job) =>
        counts.map((c) => `tidegrid.${job}_sweep.${c}`),
      ),
      "tidegrid.hostname_sweep.expiry_only_turn_count",
      "tidegrid.hostname_sweep.provider_call_count",
      "tidegrid.hostname_sweep.retry_after_seconds",
    ];
    const kept: Record<string, unknown> = Object.fromEntries(keys.map((k, i) => [k, i + 1]));
    kept["tidegrid.email_sweep.account_fault"] = true;
    expect(Object.keys(kept)).toHaveLength(20);
    expect(redact({ ...kept, "tidegrid.hostname": "guest.example.com" })).toEqual(kept);
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

describe("redactPath", () => {
  it("masks token-like segments and keeps UUIDs and short segments", () => {
    const token = "a".repeat(43);
    const id = "11111111-1111-4111-8111-111111111111";
    expect(redactPath(`/v1/staff/tenants/${id}/members`)).toBe(`/v1/staff/tenants/${id}/members`);
    expect(redactPath(`/v1/links/${token}`)).toBe("/v1/links/:redacted");
  });

  it("applies to url.path through redact()", () => {
    expect(redact({ "url.path": `/x/${"b".repeat(30)}` })).toEqual({ "url.path": "/x/:redacted" });
  });
});
