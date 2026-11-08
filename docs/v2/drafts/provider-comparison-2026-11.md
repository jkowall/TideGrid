# Stage 0 provider comparison (draft)

**Status:** A comparison, not a decision. The owner's choices of 2026-11-08 are in the [decision register](../06-decision-register.md#2026-11-08-stage-0-providers-for-the-paid-pilots-owner-decisions): Cloudflare only for staff sign-in, Cloudflare Email Service for email, and no paging or long-retention telemetry for the paid pilots. Malware scanning is not decided. Where this draft's suggested defaults differ, the register wins.
**Drafted:** 2026-11-08, goal O-PROVIDERS prep, for the Stage 0 sentence in [Build, hosting, and operations](../08-build-hosting-and-operations.md#security-controls): "Stage 0 must choose the managed OIDC, transactional email, malware scanning, paging, and long-retention telemetry providers. Those choices must support US customer data, deletion, export, audit, and incident-response requirements."
**Placement:** a draft, not a numbered V2 document. It is not part of the [authority order](../00-index.md#authority-and-historical-artifacts). Where it differs from the register or a numbered document, they win.
**Method:** read-only. Every price comes from a public pricing or documentation page read on 2026-11-08 and cited beside it. No account was opened, no trial started, and no API was called. Providers change prices; recheck before choosing.

## Summary

| Slot | Recommended default | Expected pilot cost per month | Main open question |
|---|---|---:|---|
| Managed OIDC with MFA | WorkOS AuthKit as the identity provider, with Cloudflare Access kept as the console perimeter | $0 | WorkOS data region and deletion process are not published on the pages read |
| Transactional email | Keep Cloudflare Email Service; name Amazon SES as the fallback behind the existing email adapter | $0 to $2 | Sending is still labeled beta, and new accounts start on an unpublished daily quota |
| Malware scanning | Cloudmersive Virus Scan API, free tier first, Basic plan if volume passes 600 files | $0 to $20 | Processing region not checked; files leave Cloudflare for the scan |
| Paging | PagerDuty Free | $0 | 100 SMS or phone notifications a month is the ceiling |
| Long-retention telemetry | Grafana Cloud Free, with Pro when 30-day retention is needed | $0 to $19 | 14 days on Free is short of "long"; region choice not checked |
| **Total** | | **$0 to about $41** | The [pilot cost envelope](../08-build-hosting-and-operations.md#tidegrid-planning-budget-for-three-pilot-operators) budgets $40 to $80 for these five |

Pilot scale assumed throughout: three operators, fewer than 50 staff users in total, a few thousand transactional emails a month, a few hundred uploaded files a month, one person on call, and low telemetry volume. These are assumptions, not measurements.

### How to read the requirement columns

- **US data:** whether the page read states that data stays in the United States, or offers a US region.
- **Deletion and export:** whether the provider documents a way to delete or export the data TideGrid sends it.
- **Audit:** whether the provider gives TideGrid a record of who did what in the account.
- **Incident response:** whether the page read states breach notification or security attestation.
- "Not stated" means the pages read are silent. It does not mean the provider lacks it. Each "not stated" item needs the provider's data processing agreement or trust page before a choice.

## 1. Managed OIDC with MFA

**Need.** Operator staff, the owner, and any later TideGrid staff sign in to the console through managed OIDC with MFA ([security controls](../08-build-hosting-and-operations.md#security-controls)). Today the console sits behind Cloudflare Access, and the demo's Access login offered no one-time PIN ([demo build plan](../12-demo-build-plan.md)). Access is a perimeter, not an identity provider: it relies on an identity provider for sign-in, and MFA is enforced there (an inference from the Access page, which lists "Authentication via identity providers (IdPs)" and does not say Access itself enforces MFA).

| | WorkOS AuthKit | Amazon Cognito (Essentials) | Auth0 (Essentials) |
|---|---|---|---|
| Pilot cost per month | $0. Free up to 1 million active users; MFA with TOTP and SMS is listed as included | $0. 10,000 MAU free on Lite or Essentials; then $0.015 per MAU. SMS codes are billed separately through SNS | $35. Free plan (25,000 MAU) lists no MFA; Essentials is $35 for up to 500 MAU and includes "Pro Multi-Factor Authentication" |
| US data | Not stated | AWS regions are chosen per user pool (not stated on the pricing page) | Not stated; data residency is mentioned only for Private Cloud |
| Deletion | By request to support@workos.com, per its security page | Not stated on the pricing page | Not stated on the pricing page |
| Export | Not stated | Not stated on the pricing page | User Import/Export extension or Management API |
| Audit | Audit Logs product, $0 base; streaming to a SIEM is $125 a month | User activity and auth event export on Plus only | Log streaming on paid plans |
| Incident response | SOC 2 Type 2 and annual third-party penetration tests, per its security page | 99.9% SLA on Lite and Essentials | Not stated on the pricing page |
| Sources | [WorkOS pricing](https://workos.com/pricing), [WorkOS security](https://workos.com/security) | [Cognito pricing](https://aws.amazon.com/cognito/pricing/) | [Auth0 pricing](https://auth0.com/pricing) |

**The perimeter.** Cloudflare Access Free covers up to 50 users at $0; pay-as-you-go is $7 per user a month. Zero Trust log retention is up to 24 hours on Free and up to 30 days on pay-as-you-go ([Cloudflare Access](https://www.cloudflare.com/sase/products/access/)). Three pilot operators fit under 50 users. The short log window on Free is a reason to keep the sign-in audit in the application and the identity provider, not in Access.

**Recommended default: WorkOS AuthKit behind Cloudflare Access Free, $0.** WorkOS and Cognito both meet the MFA need at $0 at pilot size (Cognito's separate SNS charge applies only to SMS codes, not authenticator apps). WorkOS is preferred for its simpler hosted sign-in and its free ceiling far above pilot size; Auth0 needs a $35 plan for MFA. Before choosing, read the WorkOS trust center for its hosting region and deletion process. Cognito is the fallback if a US region must be guaranteed in writing, at the same $0 cost with authenticator-app MFA, but with more setup work.

## 2. Transactional email

**Need.** Booking confirmations, cancellations, waiver requests, and staff sign-in links. The demo uses Cloudflare Email Service behind a provider-neutral adapter, sending as `bookings@mail.tidegrid.us`, switched on for allowlisted addresses on 2026-11-08 ([demo build plan](../12-demo-build-plan.md)). The adapter already handles a provider with no idempotency key by sending at most once.

**Does Cloudflare Email Service carry into the pilot?** It can. On cost it is the cheapest option and already built. The risks are that "Send emails" is labeled beta in the docs, new accounts start on "a conservative daily quota" with no published number, and the dashboard activity log covers up to 30 days. None of these blocks a three-operator pilot, but the daily quota should be raised before the first operator launches, and the fallback should be named now so the adapter can switch if the beta changes terms.

| | Cloudflare Email Service | Amazon SES | Postmark (Basic) | Resend |
|---|---|---|---|---|
| Pilot cost per month | $0 to about $1. 3,000 emails a month included on Workers Paid, then $0.35 per 1,000 | Under $1. $0.10 per 1,000 a la carte, or $0.16 per 1,000 on Essentials, where new accounts start from July 21, 2026 | $15 for 10,000 emails; then $1.80 per 1,000 | $0 for 3,000 a month but capped at 100 a day; Pro is $20 for 50,000 |
| US data | Cloudflare account; region not stated | AWS region is chosen per account (not stated on the pricing page) | Not stated | Not stated; "Multi-region" listed without detail |
| Deletion and export | Message previews kept about seven days; activity log view up to 30 days | Not stated on the pricing page | 45-day retention on Basic | 30-day retention on Free and Pro |
| Audit | Dashboard activity log, 30 minutes to 30 days | Not stated on the pricing page | Not stated on the pricing page | Not stated on the pricing page |
| Incident response | Not stated on the pages read | Not stated on the pricing page | Not stated on the pricing page | Not stated on the pricing page |
| Already built | Yes, live behind the allowlist | No | No | No |
| Sources | [Pricing](https://developers.cloudflare.com/email-service/platform/pricing/), [limits](https://developers.cloudflare.com/email-service/platform/limits/), [logs](https://developers.cloudflare.com/email-service/observability/logs/) | [SES pricing](https://aws.amazon.com/ses/pricing/) | [Postmark pricing](https://postmarkapp.com/pricing) | [Resend pricing](https://resend.com/pricing) |

**Recommended default: keep Cloudflare Email Service for the pilot, with Amazon SES named as the fallback adapter.** Cost is near $0 either way. Resend's free tier is ruled out by its 100-a-day cap, which one busy morning of confirmations could hit.

## 3. Malware scanning

**Need.** "Scan generated or uploaded documents, and record hashes" ([security controls](../08-build-hosting-and-operations.md#security-controls)). At pilot scale the files are operator brand assets, standard CSV imports, and generated waiver PDFs, all stored in private R2. That is likely a few hundred files a month.

| | Cloudmersive Virus Scan API | ClamAV on Cloudflare Containers | Amazon GuardDuty Malware Protection for S3 |
|---|---|---|---|
| Pilot cost per month | $0 for 600 scans a month (3.5 MB file cap); Basic is $19.99 for 10,000 scans (1 GB cap) | About $5 to $32. Containers need Workers Paid; ClamAV recommends 3 GiB or more of memory, so the 4 GiB size applies. Always on is about $26 above the plan's included memory (calculated from published rates); scale to zero costs less but reloads signatures on each start | Under $1 at pilot volume ($0.09 per GB, $0.215 per 1,000 objects; free tier of 1,000 requests and 1 GB a month), plus an AWS account and S3 copies |
| US data | Not stated | Runs on Cloudflare; files stay with the existing provider | AWS region chosen by the account |
| Deletion | "Do not store or retain payload data or copies after the transaction completes" | Self-run; nothing kept unless TideGrid keeps it | Files must be copied to S3 and then deleted by TideGrid |
| Export | Not applicable (no data kept) | Not applicable | Not applicable |
| Audit | Not stated | TideGrid logs each scan result itself | Scan results appear in AWS |
| Incident response | Not stated | TideGrid owns signature updates and patching; ClamAV is GPL v2 | Not stated on the pricing page |
| Sources | [Pricing](https://cloudmersive.com/pricing-small-business), [Virus API](https://cloudmersive.com/virus-api) | [Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/), [ClamAV docs](https://docs.clamav.net/) | [GuardDuty pricing](https://aws.amazon.com/guardduty/pricing/) |

Ruled out: Cloudflare WAF uploaded content scanning needs an Enterprise plan with a paid add-on and only detects, it does not block ([malicious uploads](https://developers.cloudflare.com/waf/detections/malicious-uploads/)).

**Recommended default: Cloudmersive, starting on the free tier, $0, moving to Basic at $19.99 if monthly scans pass 600 or a file passes 3.5 MB.** It is the cheapest with no infrastructure to run and states it keeps no copies. Its processing region needs checking before choosing. ClamAV on Containers keeps files inside Cloudflare but costs more and makes the owner responsible for keeping signatures current.

## 4. Paging

**Need.** Page the owner for suspected tenant escape, database unavailability, payment without booking, a threatened recovery point, or a critical dead-letter queue ([observability and incident signals](../08-build-hosting-and-operations.md#observability-and-incident-signals)). One person on call, later a named emergency custodian.

| | PagerDuty Free | Grafana Cloud IRM (free) | Better Stack (Responder) |
|---|---|---|---|
| Pilot cost per month | $0. 5 users, 1 schedule, 1 escalation policy, 100 SMS or phone notifications a month; Professional is $21 to $25 per user | $0 for up to 3 active IRM users; then $20 per user on Pro ($19 platform fee) | $29 to $34 per responder, including unlimited phone and SMS; Free has Slack and email alerts only |
| US data | Not stated | Not stated on the pricing page | Default storage is the EU per its FAQ; US offered on the quote form |
| Deletion and export | Not stated | Not stated | Not stated |
| Audit | Not stated on the pricing page | Not stated | Not stated |
| Incident response | Not stated on the pricing page | Not stated | Not stated |
| Sources | [PagerDuty pricing](https://www.pagerduty.com/pricing/) | [Grafana pricing](https://grafana.com/pricing/) | [Better Stack pricing](https://betterstack.com/pricing) |

Paging holds alert text, not customer data, so residency matters less here as long as alerts carry no guest details.

Ruled out: Atlassian Opsgenie stopped new sales on June 4, 2025 and ends support on April 5, 2027 ([Opsgenie migration](https://www.atlassian.com/software/opsgenie/migration)).

**Recommended default: PagerDuty Free, $0.** It is the only free option whose page states phone and SMS alerts. 100 notifications a month is ample for the page-worthy events listed above. Grafana IRM is worth a look if telemetry also lands on Grafana Cloud, but its free tier's phone and SMS coverage was not confirmed.

## 5. Long-retention telemetry

**Need.** Workers Logs keep seven days on Workers Paid. TideGrid exports operational logs and traces through OpenTelemetry when it needs longer retention ([observability and incident signals](../08-build-hosting-and-operations.md#observability-and-incident-signals)). Business audit evidence stays in PostgreSQL, so this slot is for operations, not for the audit trail. Workers OpenTelemetry export needs Workers Paid, includes 10 million events a month each for traces and logs, then $0.05 per million, and is in beta ([Workers OTel export](https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/)). Its listed destinations include Grafana Cloud, Axiom, and Honeycomb.

| | Grafana Cloud | Axiom | Honeycomb |
|---|---|---|---|
| Pilot cost per month | $0 on Free: 50 GB of logs and 50 GB of traces a month, 14-day retention. Pro is $19 a month plus usage, 30-day retention | $0 on Personal: 500 GB loading, 25 GB storage, 30-day retention. Axiom Cloud is $25 a month with configurable retention | $0 on Free: 20 million events a month; Pro from $150 |
| Retention | 14 days Free, 30 days Pro | 30 days Personal, configurable on Cloud | Not stated in the text read |
| US data | Not stated on the pricing page | "Regional residency" listed, no named US region | Not stated |
| Deletion and export | Not stated | Not stated | Not stated |
| Audit | Not stated | Not stated | Not stated |
| Incident response | Not stated | Not stated | Not stated |
| Sources | [Grafana pricing](https://grafana.com/pricing/) | [Axiom pricing](https://axiom.co/pricing) | [Honeycomb pricing](https://www.honeycomb.io/pricing) |

A cheaper archive path also exists: Cloudflare Logpush can send Workers Trace Events to R2 on Workers Paid, which gives cheap long storage but no search ([Logpush](https://developers.cloudflare.com/logs/logpush/)). Its per-request price was not read.

**Recommended default: Grafana Cloud Free, $0, moving to Pro at $19 if 14 days proves too short.** It accepts Workers OpenTelemetry export directly, carries both logs and traces, and keeps paging and telemetry in reach of one vendor later. Axiom Personal gives 30 days free, but whether its Personal plan suits a business was not checked. Telemetry must carry no guest contact or waiver data, whichever is chosen, so residency risk stays low.

## Gaps to close before choosing

1. Read each recommended provider's data processing agreement or trust page for US hosting, deletion on request, and breach notification terms. None of the pricing pages answered these fully.
2. Ask Cloudflare for the Email Service daily sending quota on the TideGrid account and how to raise it.
3. Confirm Cloudmersive's processing region and whether the free tier allows business use.
4. Confirm whether Grafana Cloud lets a free stack choose a US region.
5. Replace every cost above with measured invoices once the pilot runs, as the [cost envelope](../08-build-hosting-and-operations.md#pilot-cost-envelope) requires.
