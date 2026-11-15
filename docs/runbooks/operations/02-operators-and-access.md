# 2. Operators, staff, and support access

Setting up a new operator (a tenant), publishing its brand, adding and removing its staff, and TideGrid's own time-limited support access.

**Status today.** The demo operators were created by the seed tool. There is no admin command yet that creates a real operator or publishes a brand outside the seed. Staff invitations, member enable and disable, support grants, the data export, and deletion requests exist in the API ([database README](../../../packages/database/README.md#tenant-access-remainder-0026-w3-g22b)) but have no console pages yet. Staff sign-in is Cloudflare Access with Cloudflare's own second step ([staff sign-in runbook](../staff-sign-in-access.md)).

**Gap before the first pilot.** A reviewed admin command (or a reviewed one-off SQL script run by the owner) to create a tenant and publish its brand is needed. Until then, the steps below say what it must do.

## Creating an operator and publishing its brand

| | |
|---|---|
| Owner | TideGrid owner |
| Approval | Owner go for every write to the production database |
| Safe first action | Do the whole setup on staging first with the same inputs |
| Customer impact check | The operator's platform name loads with the right brand and no other operator's data |
| Evidence | Change record: slug, brand version number, times. Verification log entry for the first operator |
| Limit | A slug and a hostname, once used, are not reused. A published brand version is never changed, only replaced by a newer one |
| Communication | TideGrid owner tells the operator owner when their console is ready |
| Closed when | The operator owner signs in, sees only their own operator, and a test booking on staging went through |

1. Agree the slug, legal name, time zone, locations, boats, and brand (logo, colors, contact details) with the operator owner. Keep the signed setup form in the private location.
2. On staging: create the tenant, publish its first brand version, and add the operator owner as the first owner member.
3. Publishing a brand must take the per-tenant brand lock first, as the seed does, so two publishes never race ([database README](../../../packages/database/README.md#brand-configuration)).
4. Check the platform name `<slug>.book.tidegrid.us` shows the brand, and that it shows no other operator's trips. (`nov1 isolation` only works on the demo operators' products today, and it creates a quote and a held checkout.)
5. Repeat on production under the owner's go.
6. Set up the operator's payment account ([guide 3](03-payments.md#connecting-an-operators-stripe-account)) and, if they want one, their custom name ([guide 1](01-custom-hostnames.md)).

**A new brand version** (new logo or colors): publish a new version. The guest site and app pick up the highest one. To undo, publish the previous config again as a newer version.

## Adding a staff member

| | |
|---|---|
| Owner | Operator owner decides who; TideGrid owner does the Access part |
| Approval | Operator owner's request in writing; TideGrid owner adds the Access policy entry |
| Safe first action | Confirm the exact email address with the operator owner |
| Customer impact check | None |
| Evidence | The membership's audit rows; the change record notes the date |
| Limit | Invitations expire after seven days. A person who accepted cannot be re-invited, only enabled again |
| Communication | Operator owner tells the new staff member to sign in the same day |
| Closed when | The person signs in with a second step and sees the right role |

1. The operator owner invites the person with their role: `owner`, `booking_staff`, or `finance` (read-only money). API: `POST /v1/staff/tenants/{tenantId}/members`.
2. In the same sitting, the TideGrid owner adds the exact address to the console's Access policy for the login method that person uses, as the [staff sign-in runbook](../staff-sign-in-access.md#steps-cloudflare-zero-trust-dashboard) says. Never a whole domain.
3. The person signs in, sets up Cloudflare's second step, and accepts the invitation.

## Removing a staff member, or changing a role

Urgent when the person left on bad terms or a device was lost.

| | |
|---|---|
| Owner | Operator owner decides; TideGrid owner acts on Access |
| Approval | Operator owner's request. In an emergency the TideGrid owner may act first and confirm after |
| Safe first action | Remove the address from the console's Access policy. That alone blocks sign-in |
| Customer impact check | Audit events for that person in the last days: `GET .../audit-events` |
| Evidence | The audit rows for the disable; change record |
| Limit | Work the person already did stays. The last active owner of an operator cannot be disabled |
| Communication | TideGrid owner confirms to the operator owner when it is done |
| Closed when | The person's next request is refused and their open sessions are revoked |

1. Remove their address from the Access policy.
2. Disable the membership: `POST /v1/staff/tenants/{tenantId}/members/{userId}/status`. Disabling revokes their open sessions at once.
3. **Gap:** there is no way to change a member's role yet. Inviting an existing member again is refused (`member_exists`). Until a role change exists, disable the membership and ask an agent session for a reviewed fix.
4. If a device was lost, also follow [guide 9](09-security-incidents.md#lost-device-or-token).

## TideGrid support access

The TideGrid owner can read one operator's data only through a grant the operator owner issues. A grant lasts 15 minutes to 4 hours and is recorded.

| | |
|---|---|
| Owner | Operator owner issues; TideGrid owner uses |
| Approval | The operator owner's grant is the approval. Nothing else allows it |
| Safe first action | Ask for the shortest grant that covers the task |
| Customer impact check | None; support access is read-only, and personal data stays masked unless the grant says otherwise |
| Evidence | The grant row (who, reason, start, end) and the audit rows of what was read |
| Limit | A grant cannot be extended, only replaced by a new one |
| Communication | TideGrid owner tells the operator owner when the work is done |
| Closed when | The grant has expired or was revoked, and the grant list shows nothing open |

1. The operator owner issues a grant with a reason: `POST /v1/staff/tenants/{tenantId}/support-grants`.
2. Do the work. Do not copy guest data out of the console.
3. When done, revoke it early: `POST .../support-grants/{grantId}/revoke`. Otherwise it expires on its own.
4. Each quarter, list support grants for every operator and check every one had a reason and ended.

## Export and account deletion

An operator owner can export their data (`GET .../export`) and ask TideGrid to close their account (`POST .../deletion-request`). A deletion request is only a request. Nothing is deleted by it. Closing an account is a separate, reviewed piece of work with the owner's go, and must keep the records the law or the contract require.
