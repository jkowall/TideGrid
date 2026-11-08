/**
 * Staff sign-in methods (owner decision 2026-11-08, "Cloudflare's own second
 * step"): deployed environments accept Cloudflare Access only. The email link
 * and its session cookie work in local development alone. Everything here is
 * decided before any database work, so no database is bound.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { emailLinkSignInEnabled } from "../src/auth/methods.ts";
import type { Bindings } from "../src/env.ts";
import { markConsoleGateway } from "../src/gateway.ts";

const app = createApp();
const local = env as Bindings;
const deployed = (environment: Bindings["ENVIRONMENT"]) =>
  markConsoleGateway({ ...local, ENVIRONMENT: environment });
const token = "A".repeat(43);

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

describe("the email link is local development only", () => {
  it("is on for local and off for every deployed environment", () => {
    expect(emailLinkSignInEnabled({ ENVIRONMENT: "local" })).toBe(true);
    for (const environment of ["preview", "staging", "production"] as const) {
      expect(emailLinkSignInEnabled({ ENVIRONMENT: environment })).toBe(false);
    }
  });

  for (const environment of ["preview", "staging", "production"] as const) {
    it(`refuses a sign-in link request on ${environment}`, async () => {
      const res = await app.request(
        "https://api.test/v1/auth/login-links",
        {
          method: "POST",
          headers: { origin: "https://console.test", "content-type": "application/json" },
          body: JSON.stringify({ email: "ava@demo-harbor.example" }),
        },
        deployed(environment),
      );
      expect(res.status).toBe(403);
      expect(await errorCode(res)).toBe("sign_in_method_disabled");
    });

    it(`refuses to exchange a sign-in token on ${environment}`, async () => {
      const res = await app.request(
        "https://api.test/v1/auth/sessions",
        {
          method: "POST",
          headers: { origin: "https://console.test", "content-type": "application/json" },
          body: JSON.stringify({ token }),
        },
        deployed(environment),
      );
      expect(res.status).toBe(403);
      expect(await errorCode(res)).toBe("sign_in_method_disabled");
    });

    it(`never accepts a session cookie on ${environment}, and asks for Access`, async () => {
      const res = await app.request(
        "https://api.test/v1/me",
        { headers: { cookie: `__Host-tg_session=${token}` } },
        deployed(environment),
      );
      expect(res.status).toBe(401);
      expect(await errorCode(res)).toBe("access_required");
    });
  }

  it("still checks a session cookie in local development", async () => {
    const res = await app.request(
      "http://localhost/v1/me",
      { headers: { cookie: "__Host-tg_session=not-a-token" } },
      local,
    );
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe("session_invalid");
  });
});
