# @tidegrid/email-cli

The admin CLI for operators' sending domains and suppressed addresses (W3-G2.16-rest, migration `0023`). It runs on the admin connection, the only one that may add, verify, or retire a sending domain, or lift a suppression: the runtime role holds no EXECUTE on those functions (see the [database README](../../packages/database/README.md#sender-domains-and-suppression-0023)). Every command names one tenant by slug and runs in that tenant's transaction; the audit rows say actor `support` / `email-cli`.

```sh
DATABASE_URL=<admin url> pnpm --filter @tidegrid/email-cli email domain-status demo-harbor
DATABASE_URL=<admin url> pnpm --filter @tidegrid/email-cli email domain-add demo-harbor mail.harbor.example --mailbox bookings
DATABASE_URL=<admin url> pnpm --filter @tidegrid/email-cli email domain-verify demo-harbor mail.harbor.example "Cloudflare showed SPF, DKIM, DMARC verified on <date>"
DATABASE_URL=<admin url> pnpm --filter @tidegrid/email-cli email domain-retire demo-harbor mail.harbor.example "Operator moved to a new domain"
DATABASE_URL=<admin url> pnpm --filter @tidegrid/email-cli email suppressions demo-harbor
DATABASE_URL=<admin url> pnpm --filter @tidegrid/email-cli email suppression-lift demo-harbor guest@example.com "Guest asked us to send again"
```

It never calls Cloudflare and never changes DNS. Onboarding a domain is the owner's work, in this order:

1. `domain-add`. The domain is pending, and nothing sends from it. The command prints the steps below.
2. Onboard the domain in Cloudflare Email Sending, in the account the API Worker sends from.
3. Have the operator publish the SPF, DKIM, and DMARC records Cloudflare lists, and wait until Cloudflare shows the domain verified.
4. Allow `<mailbox>@<domain>` on the API Worker's `send_email` binding (`allowed_sender_addresses` in `apps/api-worker/wrangler.jsonc`), or remove that list, and release the API. Until then Cloudflare refuses the sender, and only that operator's mail waits.
5. `domain-verify`, with what Cloudflare showed. From the next claim on, the operator's mail goes out from its own address.

`suppressions` prints counts only, never an address. `suppression-lift` takes the address the operator gave and answers whether it was suppressed; the audit row names only the suppression's id. Lifting does not remove Cloudflare's own suppression of the address, which is managed in Cloudflare.

Errors print their type, SQLSTATE, and constraint, never the connection string. Tests: `src/commands.test.ts` (arguments) and `src/commands.integration.test.ts` (a throwaway database).
