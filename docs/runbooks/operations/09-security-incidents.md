# 9. Security incidents

Suspected tenant escape, a leaked secret, a lost device or token, a malicious upload, and questions about who opened waiver evidence.

**First, for all of these.** Write down the time and what was seen. Keep every row, log line, and screenshot: evidence first, cleanup after. Do not paste secrets, guest data, or connection strings into chats, tickets, or the repository. Logs last seven days, so copy what matters into the private incident record today.

**Legal and contract duties.** A confirmed exposure of personal data may require telling operators and, through them, guests within a set time, depending on the state and the contract. The TideGrid owner checks the pilot agreement and gets advice before writing to anyone outside the operator.

## Suspected tenant escape

One operator's staff or guests saw another operator's data, or a request reached the wrong operator.

| | |
|---|---|
| Owner | TideGrid owner |
| Approval | Owner go for every live change |
| Safe first action | Collect exactly what was seen: page, time, booking references, which operator's staff |
| Customer impact check | Audit events for both operators around the time; Workers Logs for the request ids |
| Evidence | Private incident record; screenshots; audit rows by id |
| Limit | Data already shown cannot be unseen |
| Communication | TideGrid owner tells both operator owners once confirmed; operators tell guests as the agreement requires |
| Closed when | The cause is found and fixed, a test that reproduces it passes, and both operators have been told |

**Critical**, even if only suspected. The response target is one business hour.

1. Ask the reporter for the exact page and time. A screenshot is best.
2. Rule out the simple cases: one person who is staff at two operators and switched between them; a guest who booked with two operators; demo data.
3. Reproduce it on staging with the same role and steps, never on the live operators. Note: `nov1 isolation` probes only the public reads of the two demo operators and creates a held checkout, so it is not a check for this case.
4. If a leak is real, stop the path: roll back the release that introduced it ([guide 5](05-releases-and-rollback.md)), or turn off the feature, or close sales for the affected operators.
5. Ask an agent session to find the cause with the evidence. The database's row-level security is the backstop; a leak means both the query's own tenant filter and that backstop failed, or the leak is outside the database (a cache, a hostname, an email).
6. A fix ships with a two-operator test that would have caught it.

## Leaked secret

A secret was pasted somewhere, committed, shown in a log or screenshot, or a device holding it was lost.

| | |
|---|---|
| Owner | TideGrid owner |
| Approval | Owner go for each rotation (the owner does them; agents never handle secret values) |
| Safe first action | Rotate first, then investigate |
| Customer impact check | The provider's own logs for use of the secret since it leaked |
| Evidence | Incident record: which secret (by name), when leaked, when rotated |
| Limit | Rotation stops future use, not what was done before |
| Communication | Operators only if it was used against their data or money |
| Closed when | The old value no longer works anywhere and the new one is in place and tested |

How to rotate each one:

| Secret | Where it lives | Rotate by |
|---|---|---|
| Runtime database password (`DATABASE_URL`, Hyperdrive) | API Worker secret, Hyperdrive config | `pnpm --filter @tidegrid/database app-role:password -- --neon-main` (the owner, on purpose), then update Hyperdrive. Breaks the API until both match: do it in a quiet window |
| Neon admin URL and API key | Owner's private location; GitHub `neon-main` environment | Reset in the Neon console; update the GitHub secret |
| `STRIPE_WEBHOOK_SECRET` | API Worker secret | [Guide 3](03-payments.md#rotating-the-webhook-secret) |
| Stripe secret key | API Worker secret | Roll the key in Stripe; `nov1 secrets stripe --put STRIPE_SECRET_KEY --phase <current> --live --go A13`, typed |
| `FAKE_PAYMENT_WEBHOOK_SECRET` | API Worker secret (preview only) | `nov1 secrets ... --generate FAKE_PAYMENT_WEBHOOK_SECRET` |
| `EMAIL_ALLOWED_RECIPIENTS` | API Worker secret | Not a credential; a leak reveals addresses only |
| `EMAIL_EVENTS_ACCOUNT_ID` | API Worker secret | An identifier, not a credential |
| `CF_SAAS_API_TOKEN` | API Worker secret | Roll the token in Cloudflare; put the new one |
| Cloudflare API token for releases or Terraform | GitHub environment secrets; owner's private location | Roll it in Cloudflare; update GitHub |
| R2 state bucket keys | GitHub `infra-staging` secrets | Roll in Cloudflare R2; update GitHub |
| GitHub tokens | Owner's account | Revoke in GitHub settings |
| Android upload key | Owner's Mac | Ask Google Play to reset the upload key ([guide 10](10-native-apps.md)) |

If a secret was committed to the repository: rotate it first. Removing it from history does not help once pushed; treat it as public.

## Lost device or token

A staff member lost a laptop or phone, or a guest says someone else has their booking link.

**Staff device:**

1. Remove their address from the console's Access policy, and disable their membership ([guide 2](02-operators-and-access.md#removing-a-staff-member-or-changing-a-role)). Check their next console request is refused before treating it as contained.
2. If the device had a second-step authenticator, they enroll a new one from a confirmed device. If they had none left, the TideGrid owner removes their registered devices in Cloudflare Zero Trust, as Cloudflare's documentation describes, then adds them back to the Access policy so they enroll again.
3. If the device was the TideGrid owner's own, also rotate everything in the secrets table it could reach, and use the second hardware key to get back into accounts.

**Guest booking link or session:**

1. A management link and its sessions are tied to the booker's email. If the guest's email account itself was taken, staff correct the booker's email on the booking to a new address the guest gives: on an email change, every unused link is closed and every other session ends. This works only for a confirmed booking whose trip has not left. **Gap:** there is no way yet to close one leaked link while keeping the same address, or on a canceled or departed booking. Until there is, the exposure is limited by the one-hour session and the link's own expiry; record it and ask for a reviewed fix.
2. Guest sessions last one hour. Staff can send a waiver request again from the booking.
3. The demo phone app drops a stored booking session once it expires (one hour).

## Malicious upload

During the paid pilots only the TideGrid owner uploads files (brand assets, waiver templates). There is no malware scanning; uploads keep their type and size checks ([decision register, Stage 0 providers](../../v2/06-decision-register.md#2026-11-08-stage-0-providers-for-the-paid-pilots-owner-decisions)).

| | |
|---|---|
| Owner | TideGrid owner |
| Approval | Owner go for publishing a replacement |
| Safe first action | Stop using the file: publish the previous brand version or template version again |
| Customer impact check | Which operators' pages or documents used it, and since when |
| Evidence | The file's hash, the brand or template version, the upload time |
| Limit | Signed waiver PDFs already generated stay as they are; evidence is never changed |
| Communication | TideGrid owner tells the operator |
| Closed when | The file is no longer served and its source is known |

If an operator sent a file that turned out to be harmful, scan it on a separate machine before reuse, and ask for it again from a trusted channel. Scanning returns before operators upload files themselves.

## Who opened waiver evidence

An operator, a guest, or a lawyer asks who saw a signed waiver.

1. Only owners and booking staff can download the signed PDF; finance cannot. TideGrid support sees it only through a grant the operator owner issued, and every support request is recorded with the grant.
2. **Gap:** a download by the operator's own staff is not written to the audit log today. The answer for staff access is "anyone with the owner or booking staff role during that time". Recording each download is a follow-up before real waivers are taken.
3. Every signed PDF's SHA-256 is stored with its evidence, and evidence rows are never changed. To show a PDF is the one signed, download it and compare its hash with the evidence record.
4. For a legal request, the operator owner leads (it is their waiver). TideGrid gives facts on request, with the owner's go.
