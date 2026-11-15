# 1. Custom hostnames

An operator's booking site can live on its own name, such as `book.<operator domain>`, through Cloudflare for SaaS. Every operator also has a platform name, `<slug>.book.tidegrid.us`, which always works and is the fallback.

**Status today.** No custom hostname exists on the live build. Cloudflare for SaaS (the [Nov 1 runbook](../2026-11-01-preview-deploy.md#p10-cloudflare-for-saas-deferred-by-default-d9)'s P10) is deferred. The commands below are written and tested on throwaway databases only. The first real request is a rehearsal under the owner's go.

**Tools.** The admin hostnames CLI ([tools/hostnames](../../../tools/hostnames/README.md)) on a direct admin connection, and `nov1 hostname-disable`, the release tool's only path to disabling a name. The detailed removal steps are in the [hostname removal runbook](../hostname-removal.md). This guide does not repeat them.

**Rules.** Every provider call, DNS change, route change, and deploy needs the owner's go at that time. No token, zone id, or operator domain goes into the repository or the incident record's public parts.

## Request and pre-validation

The operator wants their own name.

| | |
|---|---|
| Owner | TideGrid owner |
| Approval | Owner go for `hostnames request` and `hostnames route --apply` |
| Safe first action | `hostnames status <slug>`, read-only |
| Customer impact check | None yet: guests keep using the platform name |
| Evidence | Incident or change record: slug, hostname, time of each step |
| Limit | A name disabled later stays reserved for good; reusing it needs a migration |
| Communication | TideGrid owner gives the operator the DNS records to publish |
| Closed when | `hostnames status` shows the name `active`, and the booking page loads on it |

1. Agree the exact name with the operator owner. Check it is a subdomain they control (`book.` is the usual choice).
2. `hostnames request <slug> <hostname>`. It reserves the name, creates the provider record, and prints the TXT and CNAME records.
3. Send the operator the records. They publish the TXT records first (pre-validation). The CNAME can wait for cutover.
4. Wait for Cloudflare to show ownership and certificate active. The cron sweep reads the provider every run and records what it sees.
5. If the run was interrupted between the provider and the database (the row is `pending` with no provider id), follow `release` in the [CLI README](../../../tools/hostnames/README.md#recovering-an-interrupted-request-release-proposed-w1-saas-prep).

## Cutover

| | |
|---|---|
| Owner | TideGrid owner, with the operator's DNS person |
| Approval | Owner go for `activate` and the route |
| Safe first action | Confirm the platform name works for this operator |
| Customer impact check | Load the booking page on the new name from a phone on mobile data |
| Evidence | Change record, plus a verification log entry for the first one |
| Limit | Guests with the old name bookmarked still reach the platform name; nothing redirects them |
| Communication | Operator owner updates their website links |
| Closed when | A test booking on the new name reaches the console |

1. `hostnames activate <slug> <hostname>`. It activates only when ownership and certificate are both active.
2. `hostnames route <slug> <hostname>` (dry run), then with `--apply`. It adds the exact `<hostname>/*` route to the guest Worker and never touches a wildcard route.
3. The operator publishes the CNAME.
4. Check from outside: the page loads with the operator's brand and a valid certificate.

## The name stops working

Symptoms: the operator or a guest reports a certificate error, the wrong site, or "not found" on the custom name.

| | |
|---|---|
| Owner | TideGrid owner |
| Approval | None to read; owner go for `disable` |
| Safe first action | Tell the operator to point guests at the platform name |
| Customer impact check | `hostnames status <slug>` shows the provider's last states and when it was read |
| Evidence | Incident record with the status lines (no ids in public notes) |
| Limit | The sweep demotes only on a definite negative and never promotes. A demoted name is `disabled`, which is final: no command brings it back |
| Communication | TideGrid owner to operator owner; the operator tells guests if needed |
| Closed when | The name is `active` again, or guests are on the platform name or a new custom name |

1. `hostnames status <slug>`. Read the provider's ownership and certificate states.
2. If the name is still `pending` or `active` and the CNAME moved or was deleted, the operator fixes their DNS. A `pending` name can then be activated.
3. If the sweep already demoted it, it is `disabled` for good. Guests use the platform name, and the operator can request a different custom name. Reusing the same name needs a reviewed migration (see the [removal runbook](../hostname-removal.md)).
4. If the certificate is still pending, check the TXT records are still published.
5. If Cloudflare refused the whole account (429, 5xx, or an account error), the sweep records nothing and stops reading. That is not this operator's fault. Wait one run and recheck before acting.
6. If the name now points somewhere that is not TideGrid, treat it as a possible hijack: disable it at once (next section) and open [guide 9](09-security-incidents.md).

## Moving or removing a name

The operator changes their domain, leaves, or a name must go for a security reason. Follow the [hostname removal runbook](../hostname-removal.md) from H0. In short: disable now, keep the CNAME in place 24 hours so installed copies clean themselves, then the operator deletes the CNAME, then the route, then the provider record.

| | |
|---|---|
| Owner | TideGrid owner |
| Approval | Owner go for each live step in the removal runbook |
| Safe first action | `hostnames status <slug>` |
| Customer impact check | After disable, the name answers "not found" and installed copies clear their cache |
| Evidence | Change record, verification log entry |
| Limit | A disabled name never comes back. A move is a new request for a new name |
| Communication | TideGrid owner tells the operator the order and the 24-hour wait |
| Closed when | The removal runbook's last check passes |

For a move: request the new name first and bring it to `active`, then remove the old one.

To disable at once from the release tool: `nov1 hostname-disable <slug> <hostname> --live --go A18`. It refuses platform and preview names.
