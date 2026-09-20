# TideGrid API Worker

Hono on Cloudflare Workers. Routes live under `/v1`; every request and response schema comes from `@tidegrid/contracts`, and the OpenAPI document is generated from the routes (`pnpm contracts:generate` at the root).

Local development: copy `.dev.vars.example` to `.dev.vars` with the runtime role's connection string, then `pnpm dev`. The Worker prefers a `HYPERDRIVE` binding when one is configured and falls back to the `DATABASE_URL` secret. Deploy only when the owner asks, with `pnpm run release`; the build id in `/v1/health` comes from `git describe --always --dirty`.
