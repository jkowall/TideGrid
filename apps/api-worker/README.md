# TideGrid API Worker

Hono on Cloudflare Workers. Routes live under `/v1`; every request and response schema comes from `@tidegrid/contracts`, and the OpenAPI document is generated from the routes (`pnpm contracts:generate` at the root).

Local development: copy `.dev.vars.example` to `.dev.vars` with the runtime role's connection string, then `pnpm dev`. The Worker prefers a `HYPERDRIVE` binding when one is configured and falls back to the `DATABASE_URL` secret. Deploy only when the owner asks, with `pnpm run release`; the build id in `/v1/health` comes from `git describe --always --dirty`.

Payments (G2.7): the `dev` environment sets `PAYMENT_PROVIDER=fake`, the demo's payment shim; give it a `FAKE_PAYMENT_WEBHOOK_SECRET` of at least 32 characters in `.dev.vars`. Without one, or anywhere `PAYMENT_PROVIDER` is unset, checkout answers 503 `payments_unavailable`. A production configuration refuses the fake outright. `scripts/shim-replay.ts` drives a running Worker through the fake provider and the real webhook route and records the state before and after each delivery, replay, and reordering; its header says how to run it against a throwaway branch. The contracts are in [domain-booking](../../packages/domain-booking/README.md) and [domain-payments](../../packages/domain-payments/README.md).
