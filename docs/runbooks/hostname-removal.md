# Custom hostname removal (proposed)

**Status.** Proposed on 2026-11-08 under goal W1-SAAS-PREP. It has never run. No custom hostname exists on the live build until the [Nov 1 runbook](2026-11-01-preview-deploy.md)'s P10 (Cloudflare for SaaS) runs, and P10 is deferred. TideGrid stays exploratory; this runbook commits the owner to nothing. Every decision below is a coordinator default, pending owner confirmation ([decision register](../v2/06-decision-register.md#2026-11-08-w1-saas-prep-pre-saas-hostname-items-and-the-d-e11-and-d-e12-sweep-follow-ups-owner-go-coordinator-defaults-pending-owner-confirmation)).

**Why.** The demo build plan's [hostnames narrowing](../v2/12-demo-build-plan.md#goal-sequence) (D4(a)) says a disabled name stays reserved, and that reusing a name needs TXT ownership pre-validation for the new request, the kill switch on that host for one recheck interval, and a removal runbook that has the operator delete the CNAME, all before any operator domain. This is that runbook.

## Rules

- Every live step needs the owner's go at the time: a provider call, a DNS change, a route change, a deploy. An agent message is never consent.
- Secrets come from the environment only. No token, zone id, account id, or operator domain goes into the repository, the journal, or the verification log. Synthetic names in examples only.
- The commands are the admin CLI's ([tools/hostnames](../../tools/hostnames/README.md)), on the admin connection. `route` and `release` are proposed and dry-run by default.
- A disabled name stays disabled. Nothing in this runbook re-enables one, and no database function can.

## Decisions (coordinator defaults, pending owner confirmation)

| Id | Question | Default |
|---|---|---|
| R1 | How long is "one recheck interval" for the kill switch? | 24 hours from the disable. A browser checks a registered service worker for an update on each navigation to its site, and never serves `sw.js` from its HTTP cache when the last check is more than 24 hours old. So an installed client that opens the site in that window gets the kill switch. |
| R2 | Who deletes the provider record? | The owner, in the Cloudflare dashboard or by the API, by its exact name, after checking its id against `hostnames status` and the database. A CLI `remove` command is a proposed follow-up, not built. |
| R3 | Route before or after the provider record? | The route first, then the provider record, each after the operator deleted the CNAME. |

## Removal

### H0. Prep (no live call)

1. Name the tenant slug and the custom hostname, and why it goes (the operator left, the name is wrong, a security reason). Get the owner's go.
2. `hostnames status <slug>`: the name is `custom` and `active` or `pending`. A `disabled` name skips to H3.
3. Tell the operator the order: TideGrid turns the name off now, the CNAME stays in place for 24 hours so installed copies of the site clean themselves, then the operator deletes the CNAME and the TXT records.

### H1. Disable: the kill switch goes on

1. `hostnames disable <slug> <hostname> "<reason>"`. It prints `disabled`.
2. Effect, from the code: resolution fails closed at once. The bootstrap answers 404 and the page unregisters its service worker and deletes its caches. Data routes answer the shared 404. The guest Worker serves the kill-switch service worker as `/sw.js`, with `Clear-Site-Data: "cache"`, on a definite miss. Its host projection may keep the old `found` answer for up to 10 seconds in one isolate, so the `/sw.js` layer can lag by that long ([guest site README](../../apps/guest-site/README.md)).
3. Check, after 10 seconds: `curl -sSI https://<hostname>/sw.js` shows `Clear-Site-Data: "cache"`. `hostnames status <slug>` shows the name `disabled`.

If a security reason demands it, the owner can skip H2's wait. The cost: installed copies that never open the site in the window keep their old worker and cache.

### H2. Keep the host reachable for one recheck interval (R1)

1. Leave the route, the provider record, and the operator's CNAME in place for 24 hours from H1. The host keeps reaching the guest Worker, which keeps serving the kill switch.
2. The sweep never reads a disabled row, so nothing changes in the database meanwhile. The provider keeps the certificate.

### H3. The operator deletes the CNAME

1. After the window, the operator deletes the CNAME to the routing target, and the TXT records the request printed (`_cf-custom-hostname.<hostname>` and `_acme-challenge.<hostname>`).
2. Check: `dig +short CNAME <hostname>` no longer names the routing target, and `dig +short TXT _cf-custom-hostname.<hostname>` is empty.

### H4. Remove the route

1. `hostnames route <slug> <hostname> --remove`: a dry run, which needs no token and makes no call.
2. With the owner's go: `hostnames route <slug> <hostname> --remove --apply`. It deletes only the route `<hostname>/*` on the guest Worker's script, and refuses if that pattern routes anywhere else. `no route` is fine: the route may never have been added.

### H5. Delete the provider record (R2)

1. Find the custom hostname by its exact name in the dashboard. Its id must equal the provider id the database holds for the name.
2. With the owner's go, delete it.
3. The database row stays `disabled` and the name stays reserved. Nothing re-requests it: `request` refuses a name any tenant holds, in any status.

### H6. Record

Record the dates of H1 to H5, the checks' output with hosts masked, and the owner's go for each live step, in the verification log under the day it ran.

## A request interrupted before its id was stored

Not a removal. A row that is pending with no provider id is recovered with `hostnames release`, or turned off with `hostnames disable` and then removed from H3 on ([tools/hostnames README](../../tools/hostnames/README.md#recovering-an-interrupted-request-release-proposed-w1-saas-prep)).

## Reuse of a removed name (not possible today)

No database function re-enables a disabled name, and goal W1-SAAS-PREP adds no migration for it (D2, a coordinator default pending owner confirmation). Any future reuse needs the owner's decision and a migration first. Proposed preconditions for that decision, all before the new request:

1. **Removal is complete.** H1 to H5 ran, and H2's window passed.
2. **The old CNAME is gone.** `dig` shows no CNAME to the routing target, so no traffic of the old operator's reaches TideGrid.
3. **TXT pre-validation.** The new request proves ownership and the certificate by TXT records the new operator publishes before any CNAME points at TideGrid: `request` asks for TXT certificate validation and prints the ownership TXT record. Activation waits until the provider reports both ownership and the certificate active. Control of an existing CNAME alone never proves ownership.
4. **The kill switch on that host.** The host serves the kill switch for at least one recheck interval (R1) before the new tenant's site goes live on it, so no installed copy of the old site intercepts the new one.

## Unverified (labeled wherever they appear)

- What Cloudflare does with traffic for a deleted custom hostname whose CNAME still points at the routing target.
- Whether every browser honors `Clear-Site-Data: "cache"` from a service worker script response.
- The 24-hour window as an upper bound in practice: a client that never opens the site keeps its old worker until it does.
- The Workers Routes and custom hostname delete calls themselves: never made against the real API.
