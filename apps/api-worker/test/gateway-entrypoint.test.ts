import { createExecutionContext, env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ConsoleGateway } from "../src/index.ts";

describe("ConsoleGateway entrypoint", () => {
  it("serves staff routes that the public entry hides", async () => {
    const url = "https://api.test/v1/me";
    const viaPublic = await SELF.fetch(url);
    expect(viaPublic.status).toBe(404);

    const gateway = new ConsoleGateway(createExecutionContext(), env);
    const viaGateway = await gateway.fetch(new Request(url));
    // Past the gateway check and into authentication, which fails with no credentials.
    expect(viaGateway.status).toBe(401);
    expect(((await viaGateway.json()) as { error: { code: string } }).error.code).toBe(
      "unauthenticated",
    );
  });
});
