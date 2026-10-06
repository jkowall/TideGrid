import { WorkerEntrypoint } from "cloudflare:workers";
import { createApp } from "./app.ts";
import type { Bindings } from "./env.ts";
import { markConsoleGateway } from "./gateway.ts";
import { runScheduled } from "./scheduled.ts";

const app = createApp();

/**
 * Public entry: api.tidegrid.us. Staff and sign-in routes answer 404 here.
 * The cron trigger in wrangler.jsonc runs the hold sweep. The handler awaits
 * the sweep rather than handing it to waitUntil, so a failed run rejects the
 * invocation itself. The runtime waits for the handler's promise up to the
 * cron time limit, as it would for waitUntil.
 */
export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
  scheduled: async (controller, env, _ctx) => {
    await runScheduled(controller, env);
  },
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
