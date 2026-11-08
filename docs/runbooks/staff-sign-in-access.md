# Staff sign-in through Cloudflare Access, with Cloudflare's own second step

Owner-run dashboard steps. Nothing here is run by an agent: agents do not change Access settings, policies, or login methods. The code side shipped with W3-G2.2b staff sign-in (see the [decision register](../v2/06-decision-register.md)): on every deployed environment the API accepts Cloudflare Access only, and the email sign-in link works in local development alone.

## What staff will see

1. They open the console.
2. Cloudflare asks them to pick Google or Microsoft and sign in there.
3. Cloudflare then asks for its own second step: a code from an authenticator app, or a security key (Touch ID, Face ID, and Windows Hello count as security keys here). The first time, Cloudflare walks them through adding one.
4. The console opens. If their email is not a TideGrid staff member, the console says so and shows nothing else.

The second step is Cloudflare's, not Google's or Microsoft's. Cloudflare's documentation lists Okta, Microsoft Entra ID, generic OIDC, and generic SAML as the providers whose own two-step login Access can check, and Google is not among them. Cloudflare's own second step works the same way for every provider, so it is the one we require (owner decision, 2026-11-08, "Cloudflare's own second step").

## Steps (Cloudflare Zero Trust dashboard)

Cloudflare renames dashboard items often. The names below follow Cloudflare's documentation as read on 2026-11-08; if one has moved, the linked page has the current path.

1. **Add the login methods.** Zero Trust, then Integrations, then Identity providers, then Add new identity provider:
   - Google (personal Gmail accounts), or Google Workspace for staff on a company Workspace.
   - Microsoft Entra ID.
   - Follow each provider's page from that screen. They involve creating an app on the Google or Microsoft side and pasting its client ID and secret into Cloudflare. Keep those secrets in the dashboard only, never in the repository or a chat.
2. **Turn on Cloudflare's second step for the organization.** Zero Trust, then Access controls, then Access settings, then "Allow multi-factor authentication (MFA)":
   - Allow "Authenticator application" and "Security key". Leave "Biometrics" on as well if staff use Touch ID, Face ID, or Windows Hello.
   - Set the authentication duration. 24 hours matches the console's own session length.
   - Select "Apply global MFA settings by default".
   - Reference: <https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/independent-mfa/>
3. **Make the console application require it.** Zero Trust, then Access controls, then Applications, then the console application (console.tidegrid.us), then Edit:
   - Authentication, then the MFA tab: choose "Respect global enforcement setting" (or "Custom MFA settings" with the same methods). Do not choose "Disable MFA".
   - Login methods: allow Google and Microsoft Entra ID only. Turn off One-time PIN for this application: a PIN by email is one factor, and staff should not be offered it.
   - The application's policy: Allow, including the staff email addresses (or the operator's email domain). If the policy has its own MFA setting, it wins over the application's, so set it the same way or leave it on the application's setting.
4. **Check it.** In a private browser window, open the console:
   - Sign in with a Google account that is a staff member. Cloudflare must ask for the second step before the console opens. If it does not, stop and recheck step 3.
   - Do the same with a Microsoft account.
   - Sign in with an address that is not staff. The console must say it has no access.
   - This check is the evidence the [security controls](../v2/08-build-hosting-and-operations.md#security-controls) ask for before an operator's first live booking: a sign-in without a second step is refused, for every provider that operator's staff may use.

## How staff add their second step

The first time, Cloudflare offers it during sign-in. To add another device later, staff go to `https://<team name>.cloudflareaccess.com/AddMfaDevice` (the team name is the first part of the Access team domain), sign in, and add the device under Account, then MFA devices. Cloudflare's App Launcher does not ask for the second step, so staff can always reach it to enroll.

## What the code does and does not check

- The API verifies the Access token on every request (signature, issuer, the console application's audience tag, expiry, and an email), then looks the email up among TideGrid staff. A disabled staff member is refused on their next request.
- The Access token does not say whether Cloudflare's second step happened; Cloudflare does not document a claim for it. So the second step is enforced by the Access settings above, and step 4 is how we show it is on.
- Deployed environments refuse the email sign-in link and never accept its session cookie, so there is no way into the console around Access.
