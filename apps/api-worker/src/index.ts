import { WorkerEntrypoint } from "cloudflare:workers";
import { createApp } from "./app.ts";
import type { Bindings } from "./env.ts";
import { markConsoleGateway } from "./gateway.ts";

const app = createApp();

/** Public entry: api.tidegrid.us. Staff and sign-in routes answer 404 here. */
export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
} satisfies ExportedHandler<Bindings>;

/**
 * Reachable only through a service binding (the console Worker behind
 * Cloudflare Access). It serves the same app with the console-gateway mark.
 */
export class ConsoleGateway extends WorkerEntrypoint<Bindings> {
  override async fetch(request: Request): Promise<Response> {
    return app.fetch(request, markConsoleGateway(this.env), this.ctx);
  }
}
