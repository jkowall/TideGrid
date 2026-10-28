# @tidegrid/hostnames-cli

The admin CLI for custom hostnames (G2.14b). It runs on the admin connection, the only one that may request, activate, or disable a hostname: the runtime role holds no EXECUTE on those functions (see the [database README](../../packages/database/README.md#custom-hostname-lifecycle-g214b)). Every command names one tenant by slug and writes its audit rows as actor `support` / `hostname-cli`.

```sh
DATABASE_URL=<admin url> pnpm --filter @tidegrid/hostnames-cli hostnames status demo-harbor
DATABASE_URL=<admin url> pnpm --filter @tidegrid/hostnames-cli hostnames disable demo-reef reef-e2e.book.localhost "Reason"
# Cloudflare for SaaS (G2.14b-live, once the owner enables it):
DATABASE_URL=... CF_SAAS_ZONE_ID=... CF_SAAS_API_TOKEN=... pnpm --filter @tidegrid/hostnames-cli hostnames request demo-harbor book.example.com
DATABASE_URL=... CF_SAAS_ZONE_ID=... CF_SAAS_API_TOKEN=... pnpm --filter @tidegrid/hostnames-cli hostnames activate demo-harbor book.example.com
# The scripted fake, in one process, on a throwaway database only:
DATABASE_URL=... TIDEGRID_EPHEMERAL_DB=1 pnpm --filter @tidegrid/hostnames-cli hostnames fake-lifecycle demo-harbor book.example.com
```

- `request` checks the name rules, reserves the name, creates the provider's record, and prints the DNS records the operator publishes.
- `activate` reads the provider again and activates only when ownership and certificate are both active.
- `disable` turns any hostname off; a disabled name stays reserved.
- `fake-lifecycle` runs request, a refused early activation, validation, activation, a demotion after the CNAME moves, and disable, because the fake's records live in memory and cannot outlive one process.

Secrets come from the environment only. The token is never printed; errors print their type and code.
