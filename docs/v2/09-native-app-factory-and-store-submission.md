# TideGrid V2 native app factory and store submission

**Status:** Canonical native delivery and store-operations plan

This document defines how TideGrid would build, submit, maintain, and retire one branded iOS and Android application pair per operator brand. It supplements the product scope and target architecture. It is not evidence that store approval, customer demand, or delivery economics have been validated. Public store approval of an operator's app pair is one condition of the [Native pilot gate](05-roadmap-validation.md#native-pilot-gate) for that operator, together with push, deep links, and the native guest journeys passing in production. That gate controls when the Native add-on goes live and does not block the operator's PWA or Core live gate.

## Feasibility decision

The native offer is feasible for a three-customer pilot. It is not yet proven scalable.

The proposed model is:

- one React Native application using Expo prebuild;
- one shared source tree and release line;
- one immutable application identity and store-app pair per operator brand;
- operator-owned Apple and Google organization accounts;
- build-time variation limited to identifiers, supported entitlements, approved assets, and store metadata;
- versioned server configuration for catalogs, policies, waivers, messages, and most brand content;
- no customer source forks and no per-boat applications; and
- a custom-domain PWA that remains the universal fallback.

This approach can remove most repeated engineering work. It cannot remove account verification, customer approvals, store review, policy declarations, release monitoring, or occasional rejection handling. Those are separate per-operator work items.

The main product risk is store policy, not binary generation. Apple requires an app to provide more utility than a repackaged website, warns against multiple bundle IDs for substantially the same app, and states that apps created from commercialized templates must be submitted directly by the provider of the app's content. Google explicitly supports white-label development but recommends a separate client-owned developer account and unique content, assets, and metadata for every app.

TideGrid therefore cannot promise store acceptance or a fixed approval date. The first three pilot operator applications are also a store-policy experiment.

## Store-policy boundary

### Apple

Apple [App Review Guideline 4.2.6](https://developer.apple.com/app-store/review/guidelines/) says a commercial template or app-generation service should not submit applications on behalf of clients. Apple permits the application when the content provider submits it directly and the application supplies a customized, useful experience. Guideline 4.2 requires adequate native utility, and Guideline 4.3 addresses spam and repeated bundle identifiers.

TideGrid will use the following conservative operating rule until Apple gives written guidance or three distinct operator applications establish a repeatable review history:

1. The operator enrolls in and owns its Apple Developer Program organization account.
2. TideGrid uses delegated access to create identifiers, build, sign, upload, test, and prepare metadata.
3. The operator reviews the complete submission packet.
4. The operator's Account Holder or App Manager performs the final App Review submission from the operator account.
5. TideGrid remains available to answer technical review questions, but the operator is the publisher and content provider.

Automation must stop at `READY_FOR_OPERATOR_SUBMISSION` on Apple. A release credential must not silently cross that state.

The application must demonstrate durable native value through upcoming trips, booking management, saved guest profiles, waiver status, trip-card balances, secure deep links, and push notifications. A thin WebView of the PWA is not the native product.

### Google

Google's [white-label guidance](https://support.google.com/googleplay/android-developer/answer/15884185) recommends decentralized account management. Each operator owns a separate Play Console account and may grant TideGrid managed administrative access. This isolates account enforcement and lets the operator publish under its own developer identity.

TideGrid may automate Google Play preparation and submission after the operator records approval. Each listing must use operator-specific descriptions, icons, graphics, screenshots, support information, and actual content. Metadata or screenshots reused across operators without meaningful changes fail TideGrid's release checklist for the [Native pilot gate](05-roadmap-validation.md#native-pilot-gate) even if the console accepts them.

### Physical-service payments

Trip, charter, equipment, trip-card, and tip payments buy physical services consumed outside the application. Apple [requires a method other than In-App Purchase for those purchases](https://developer.apple.com/app-store/review/guidelines/), and Google says [Play Billing must not be used for physical services](https://support.google.com/googleplay/android-developer/answer/9858738).

The review notes for every app must explain this model. The native client uses the approved Stripe payment flow for the operator's real-world service. TideGrid does not sell digital application functionality to guests.

## Shared application factory

### Source and build layout

The implementation should use a structure equivalent to:

```text
apps/
  guest-web/                    branded PWA
  guest-native/                 one React Native and Expo application
packages/
  api-client/                   generated shared API client
  auth-client/                  shared authentication contracts
  brand-contract/               manifest schema and validation
  design-tokens/                compatible web and native tokens
app-factory-private/
  manifests/<operator>.yaml     non-secret operator build manifest
  assets/<operator>/            approved source assets
  store/<operator>/apple/       localized Apple metadata
  store/<operator>/google/      localized Google metadata
```

The exact private configuration location may change, but customer assets and unpublished metadata must not enter a public repository. Store passwords, API private keys, certificates, keystores, provider secrets, and signing credentials never belong in a manifest or source repository.

Expo prebuild produces the native projects from the same source and validated manifest. Generated Xcode and Android project changes are disposable build output. A request that requires editing generated native code for one operator is either a missing shared capability or unsupported custom work. It cannot be committed as an operator branch.

### Build and hosting model

For the pilot cohort:

- GitHub Actions or an equivalent central workflow orchestrates validation, testing, build requests, metadata generation, and release-state recording.
- Expo Application Services builds the iOS and Android artifacts using pinned toolchain and dependency versions. Use one EAS project per operator app pair so credentials, update channels, build history, and access stay isolated. Every EAS project still builds the same shared source revision.
- App Store Connect and Google Play APIs manage supported records, metadata, screenshots, testing groups, build uploads, and release status.
- TideGrid's release ledger remains the source of operational status. Expo, Apple, and Google are delivery systems.
- The build setup must remain portable. TideGrid must be able to build with standard Xcode and Gradle tooling if it replaces the hosted build service.

Apple and Google distribute the production binaries. TideGrid does not host downloadable production binaries. TideGrid hosts the shared API, PWA, versioned runtime configuration, deep-link association files, support pages, deletion workflow, and private application evidence.

Over-the-air JavaScript updates may fix behavior already represented in the approved binary only after a specific policy and rollback review. They must not add new native capabilities, materially change application purpose, bypass review, or create operator-specific code. The pilot should default to store releases.

### Solo release authority and launch capacity

TideGrid serializes the pilot's human-controlled launch work. Across the pilot cohort, only one operator may be in initial configuration, operator acceptance testing, an active store-review response, production cutover, or Native go-live at a time; the rule is stated once in [Stage 5](05-roadmap-validation.md#stage-5-pilot-launches-and-review). Automated validation and artifact generation may run for other operators when they do not require a production decision.

The sole TideGrid owner and the operator's authorized representative retain human release authority. Agents and automated workflows may prepare, validate, build, test, upload drafts, and collect evidence. They cannot approve content or a release candidate, send a store-review response, submit a production release, schedule publication, or authorize cutover without the required recorded human decisions. For Google, automation may submit the exact approved candidate only after the operator approves it and the TideGrid owner releases the job. For Apple, automation stops at `READY_FOR_OPERATOR_SUBMISSION`, and the operator's Account Holder or App Manager performs the final App Review submission.

### Manifest contract

Every operator app pair has one schema-validated manifest. Required fields include:

| Group | Required fields | Mutability |
|---|---|---|
| TideGrid identity | Immutable application ID, tenant ID, operator brand ID, EAS project ID | Locked before the first build |
| Apple identity | Team ID, bundle ID, App Store Connect app ID, SKU | Locked before first upload |
| Android identity | Developer account ID, package name, Play app ID | Locked before first upload |
| Public identity | Display name, legal publisher, copyright owner, support contact | Versioned; some changes require review |
| Brand | Logo, application icon, splash assets, approved color and typography tokens | Versioned; icon and splash changes require a binary |
| Web | Canonical custom hostname, privacy, terms, support, deletion, and marketing URLs | Versioned and continuously checked |
| Native services | Associated domains, App Links, APNs topic, Firebase project, push capability | Controlled build-time configuration |
| Distribution | Locale, countries, device classes, minimum OS versions | Approved per release |
| Compatibility | Native version, build number, API capability set, runtime configuration version | Generated per build |
| Evidence | Source commit, manifest hash, asset hashes, approving user and time | Immutable per release candidate |

The application embeds the immutable TideGrid application ID, not a user-editable tenant slug. At startup, it exchanges that identity for a signed bootstrap document and then authenticates the guest. Application identity selects the correct branded experience but never grants data access.

### Build-time and runtime boundaries

The following changes require a new store binary:

- bundle or package identity;
- application name shown by the operating system;
- application icon or launch assets;
- native entitlements, permissions, associated domains, or push capabilities;
- native modules, executable code, privacy manifest, or platform SDK; and
- minimum supported operating-system version.

The following normally use versioned server configuration:

- catalog, schedule, boat, pricing, and inventory content;
- operator contact and arrival information;
- cancellation, weather, refund, and reschedule policies;
- waiver templates and non-medical intake questions;
- transactional message content;
- in-scope module enablement; and
- most theme tokens and imagery that do not change the installed application icon.

Server configuration may select only compiled, reviewed behavior. It cannot download executable code or turn the shared application into an unrestricted app builder.

## Operator account prerequisites

Native setup cannot start until the operator completes the account-readiness gate.

### Apple organization account

Apple's [organization enrollment requirements](https://developer.apple.com/help/account/membership/program-enrollment) include:

- a legal entity able to contract with Apple;
- a D-U-N-S number matching that entity;
- an enrolling representative with authority to bind the entity;
- an email address on the organization's domain;
- a publicly available, functional organization website;
- an Apple Account with two-factor authentication; and
- the current Apple Developer Program agreement and annual membership payment.

Apple does not accept a DBA, trade name, or branch as the enrolling legal entity. The legal entity name appears as seller. An individual or sole proprietor may enroll personally, but the person's legal name appears as seller. That is an exception to the Native offer and requires written operator acceptance.

The Apple Developer Program is currently **$99 per membership year**, with regional currency and price variation possible. The operator pays Apple directly and owns renewal. An expired membership can interrupt releases and distribution.

### Google organization account

Google's [organization account requirements](https://support.google.com/googleplay/android-developer/answer/13628312) include:

- a D-U-N-S number;
- legal organization name and address matching the linked Google payments profile;
- organization website and phone number;
- named contact, contact email, and contact phone;
- public developer email and phone; and
- completed identity and contact verification.

Google says a new D-U-N-S request can take up to 30 days. Native delivery dates exclude time spent waiting for an operator's business record, D-U-N-S profile, payments profile, or identity verification.

Google currently charges a **one-time $25 registration fee**. The operator pays Google directly and retains the registration transaction receipt. Beginning September 30, 2026, Play packages must also meet Google's [Android developer verification and package registration requirements](https://support.google.com/googleplay/android-developer/answer/16984799).

### Readiness evidence

The release ledger records, without copying unnecessary identity documents:

- legal entity name and D-U-N-S verification status;
- verified business domain, email, phone, and address;
- Apple Team ID, Account Holder, membership renewal date, and agreement status;
- Google developer account ID, account owner, payments-profile match, and package-registration status;
- operator acceptance of the public seller and developer identity; and
- TideGrid invitations and access expiration or review date.

Account Holder passwords and multifactor tokens are never shared with TideGrid.

## Required public websites and deep links

Each Native operator needs stable, public, operator-specific pages. TideGrid may render these from managed templates on the verified custom domain.

```text
https://book.operator.example/                 booking PWA
https://book.operator.example/app              application information and store links
https://book.operator.example/support          current support and legal contact details
https://book.operator.example/privacy          operator-specific privacy policy
https://book.operator.example/terms            guest terms
https://book.operator.example/delete-account   deletion request and status
https://book.operator.example/.well-known/apple-app-site-association
https://book.operator.example/.well-known/assetlinks.json
```

The support, privacy, terms, and deletion pages must work before submission and remain monitored after launch. They cannot be placeholders. The privacy page identifies the operator or named application and explains TideGrid and other processors, collected data, purposes, sharing, retention, consent, and deletion.

Apple's [associated-domain documentation](https://developer.apple.com/documentation/xcode/supporting-associated-domains) requires the `apple-app-site-association` file over HTTPS without redirects. Android's [App Links verification](https://developer.android.com/training/app-links/verify-applinks) uses `assetlinks.json` with the certificate fingerprint used by Google Play to sign the application.

The hosting layer generates both files from the approved manifest and store signing records. A deployment test verifies every declared link on a physical device before submission.

## Identifier, signing, and credential custody

### Apple

- Use one explicit App ID and bundle ID per operator brand.
- The operator approves the bundle ID before registration. It cannot be treated as disposable after a build is uploaded.
- Enable only required capabilities, initially push notifications and associated domains.
- Create a dedicated TideGrid release identity with the smallest App Store Connect role and Certificates, Identifiers & Profiles access needed for its work.
- Use a per-operator App Store Connect API credential where supported. Store its issuer, key ID, and private key in the release vault under that operator boundary.
- Use an environment-specific, topic-specific APNs key where available. Record the Apple Team ID, key ID, environment, and topic.
- Partition APNs credentials and connection pools by Apple Team ID. Apple [does not permit one APNs connection to span developer accounts](https://developer.apple.com/documentation/UserNotifications/establishing-a-token-based-connection-to-apns).
- Revoke and rotate the delegated release and APNs credentials at offboarding or suspected compromise.

The operator Account Holder retains agreement, membership, transfer, and other owner-only responsibilities. TideGrid never relies on an employee's personal Apple credentials as a production secret.

### Google

- The operator approves the package name before the Play record is created. Google describes package names as unique and permanent.
- Enroll each application in [Play App Signing](https://support.google.com/googleplay/android-developer/answer/9842756).
- Use a distinct upload key per operator application and keep it in the release vault. Google holds the production app-signing key.
- Register the Google-held signing certificate fingerprint with App Links and any identity or API provider.
- Configure a dedicated Firebase application and narrowly scoped push credential for the package.
- Grant TideGrid app-specific permissions for draft applications, store presence, policy declarations, testing tracks, and production release. Do not grant financial permissions.
- Use access expiration dates or a scheduled quarterly access review.

Google's [Play Console permission model](https://support.google.com/googleplay/android-developer/answer/9844686) separates store, policy, testing, and production-release permissions. The operator remains the account owner.

### Vault and audit rules

- Separate credentials by operator and environment.
- Deny one operator's release job access to another operator's secrets.
- Require an approval record before a production upload or release.
- Log credential use without logging private key material.
- Store recovery and revocation instructions with each credential record.
- Alert on membership expiration, agreement changes, invalid credentials, and unexpected signing fingerprints.
- Test restore or rotation for one Apple and one Google credential during the pilot.

## Per-operator submission and release packet

Every operator launch produces one versioned packet. Its contents are structured data and immutable generated artifacts, not a collection of undocumented console screenshots.

### Ownership and account packet

- legal entity, D-U-N-S, public contact, website, and authorized representative;
- Apple Account Holder, Team ID, membership expiration, agreement status, and delegated users;
- Google account owner, developer account ID, payments-profile match, verification state, and registration transaction identifier;
- operator approval of publisher name, identifiers, countries, and release roles; and
- access review and offboarding contacts.

### Brand and rights packet

- source logo and icon files at the required resolution;
- generated application icons, splash assets, and approved color tokens;
- operator-specific photography and screenshot seed data;
- legal publisher and copyright text;
- trademark, logo, photograph, and other content-rights authorization; and
- operator sign-off on every public asset.

### Store metadata packet

Apple metadata includes the application name, subtitle, primary language, bundle ID, SKU, description, keywords, categories, age rating, content-rights response, copyright, support URL, privacy URL, optional marketing URL, countries, release setting, screenshots, and review information. Apple accepts [one to ten screenshots](https://developer.apple.com/help/app-store-connect/manage-app-information/upload-app-previews-and-screenshots) for each required device class.

Google metadata includes the application name, short and full descriptions, category, tags, support contact, privacy URL, countries, application icon, 1024 by 500 feature graphic, and phone screenshots. Google requires [at least two screenshots and permits up to eight per device type](https://support.google.com/googleplay/android-developer/answer/9866151). TideGrid's standard is at least four 1080-resolution phone screenshots.

The Pilot Native scope includes:

- English-US metadata;
- US store availability;
- iPhone and Android phone layouts;
- one public listing per platform; and
- one submission and one standard review-response cycle per platform, consisting of either one corrected resubmission or one evidence-based appeal.

Tablet-specific design, additional localizations or countries, app transfer, repeated policy remediation, or custom marketing production requires a separate quote. International guests can still use the PWA while store availability remains US-only.

Every listing must clearly describe the named operator and its real services. Screenshots must come from that operator's configured application and show functionality available to reviewers. Reusing another operator's screenshots or substituting generic TideGrid marketing material fails acceptance.

### Privacy and declaration packet

- operator-approved privacy and retention policy;
- Apple App Privacy answers covering TideGrid and all third-party SDKs;
- valid `PrivacyInfo.xcprivacy`, required-reason API declarations, and third-party SDK signature validation;
- Google Data Safety answers covering all versions, regions, and SDK behavior;
- in-app and web account-deletion paths;
- ads declaration;
- target audience and content selection;
- content-rating questionnaire;
- Google Financial features declaration and the recorded rationale for its answer;
- Apple export-compliance determination;
- Apple Digital Services Act trader declaration; and
- permission and purpose-string inventory.

Apple requires [privacy disclosures for the application and integrated third parties](https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy/). Google requires an accurate [Data Safety form and public privacy policy](https://support.google.com/googleplay/android-developer/answer/10144311). Every Play app must complete the [Financial features declaration](https://support.google.com/googleplay/android-developer/answer/13849271), including when the answer is that it supplies no covered financial feature.

The intended audience is an adult booker or guardian. Supporting a guardian signing for a minor participant does not make the application child-directed. Store copy, screenshots, account creation, SDKs, and audience declarations must remain consistent with that position.

If guests can create an account, both platforms require account-deletion support. Apple requires users to initiate deletion inside the application. Google requires an in-app path and an external web resource. Deletion removes the account and associated data except records TideGrid or the operator is legally required to retain. The application and privacy policy must explain any retained transaction or waiver evidence and its restricted status. See Apple's [account-deletion guidance](https://developer.apple.com/support/offering-account-deletion-in-your-app/) and Google's [User Data policy](https://support.google.com/googleplay/android-developer/answer/10144311).

### Review-access packet

Every app has a disclosed, isolated reviewer mode or synthetic reviewer tenant with:

- reusable credentials that do not depend on a one-time password, location, or expiring link;
- no real customer, payment, waiver, or message data;
- seeded upcoming and past trips;
- a booking, participant invitation, waiver, trip-card balance, cancellation, refund status, tip, and deletion example;
- a no-charge booking or documented sandboxed payment demonstration that cannot charge a real card;
- clear instructions for every restricted feature; and
- an operator and TideGrid review contact available during the submission window.

There is no universal master credential across production tenants. Review access is scoped to the specific operator application, rate limited, monitored, and removable after approval while keeping an approved method available for future reviews.

Apple asks for a valid demo account or fully featured demo mode when sign-in protects features. Google requires review credentials to remain valid, reusable, usable from any location, and free of expiring two-factor challenges. Store notes must disclose the synthetic environment and explain how it differs from live service.

### Reproducibility packet

- source commit and dirty-tree check;
- dependency lockfile and hash;
- operator manifest and asset hashes;
- Expo, React Native, Xcode, iOS SDK, Java, Gradle, Android plugin, and Android target SDK versions;
- semantic version, iOS build number, and Android version code;
- generated entitlement, permission, privacy-manifest, and application-link reports;
- software bill of materials and dependency vulnerability result;
- signed iOS `.xcarchive` with dSYM files;
- exported signed `.ipa` when the selected upload workflow produces one;
- App Store Connect uploaded-build identifier and processing result;
- signed Android App Bundle (`.aab`), R8 mapping file, and native debug symbols when applicable;
- artifact checksums and retention deadline; and
- build-system provenance and approving release actor.

An App Store Connect build is the release authority for Apple. An exported `.ipa` is a delivery artifact, not a replacement for the archived Xcode build and App Store Connect record. The `.aab` is the Android upload artifact; Google Play generates signed device APKs from it.

### Verification packet

- shared unit, contract, integration, and security-test results;
- manifest-schema and all-tenant configuration validation;
- operator-specific branded smoke test;
- screenshot visual comparison and accessibility checks;
- real-device authentication, account deletion, deep-link, push, payment, waiver, and trip-card tests;
- `apple-app-site-association` and `assetlinks.json` verification;
- TestFlight and Google internal-track installation evidence;
- operator acceptance with approver and timestamp;
- store submission IDs, state history, and review correspondence; and
- production store URLs, release time, and first-day health check.

## Release state machine

The release ledger uses explicit states:

```text
QUALIFIED
  -> ACCOUNTS_PENDING
  -> MANIFEST_APPROVED
  -> IDENTIFIERS_LOCKED
  -> BUILDING
  -> INTERNAL_TEST
  -> OPERATOR_ACCEPTANCE
  -> READY_FOR_OPERATOR_SUBMISSION
  -> IN_REVIEW
  -> APPROVED
  -> SCHEDULED
  -> LIVE
  -> MAINTENANCE
  -> RETIRING
  -> RETIRED
```

Exception states are `BLOCKED_CUSTOMER`, `BLOCKED_CREDENTIAL`, `BUILD_FAILED`, `REJECTED_POLICY`, `REJECTED_METADATA`, `REJECTED_BINARY`, and `ROLLOUT_HALTED`. Every exception records the accountable party, next action, due date, and whether time is customer-specific setup, support, shared engineering, or external waiting.

Only the operator can move an Apple release from `READY_FOR_OPERATOR_SUBMISSION` to `IN_REVIEW`. TideGrid automation observes and records the result. Google may use an operator-approved automated transition.

## Initial launch SOP

1. Confirm Native qualification, repeat-use case, and direct-first channel mix.
2. Verify the legal entity, D-U-N-S record, public website, domain email, authorized representative, and content rights.
3. Have the operator create, pay for, and complete verification of both organization accounts, accept current agreements, and invite TideGrid with least privilege.
4. Execute the recurring agreement and confirm the setup payment after the account-readiness gate passes. If an account fails verification, apply the contract's refund or exit term.
5. Collect and validate the brand, website, store, privacy, support, and review-access packets.
6. Generate the manifest. Obtain written operator approval before registering permanent bundle and package identifiers.
7. Create the store records, identifiers, signing configuration, push configuration, and deep-link associations.
8. Build from a clean shared-source revision with the currently required platform toolchains.
9. Run shared tests and the operator-specific smoke, visual, accessibility, deep-link, push, deletion, and payment tests.
10. Upload the build to TestFlight and the Google internal track. The operator completes acceptance testing on both platforms.
11. Generate final screenshots from the accepted build and complete all store metadata and declarations.
12. Freeze code, server behavior affecting review, store metadata, and reviewer seed data.
13. TideGrid prepares both submissions. The operator approves both and performs the final Apple review submission.
14. Monitor review messages. The operator answers publisher, rights, and business questions; TideGrid answers technical questions.
15. If rejected, classify the issue before changing anything. Use the included review-response cycle only for a correction or appeal within standard scope.
16. After both stores approve, schedule an attended Native go-live for that operator and verify store, PWA, API, payment, message, and push health. The operator's migration cutover and first live bookings belong to its Core live gate and may already be complete; store approval does not block them, and an operator that has not yet cut over still waits for its Core live gate rather than for the stores.
17. Record customer-specific hours, direct costs, review duration, exceptions, and first-day results.

Store submission is not proof of approval. Store approval is not proof of release. Release is not proof that the correct production version, tenant, links, and backend are healthy.

## Review and timing rules

Apple reports that, on average, 90% of submissions are reviewed in less than 24 hours, while warning that complex or novel submissions can take longer. Google says processing can take a few hours to seven days or longer and recommends at least a one-week buffer. See Apple's [review guidance](https://developer.apple.com/app-store/review/) and Google's [managed-publishing guidance](https://support.google.com/googleplay/android-developer/answer/9859654).

These are observations and recommendations, not service-level guarantees. Sales and project plans must also allow for customer account verification, revised agreements, build processing, TestFlight review, Play review, holidays, repeated questions, and propagation after release.

During review:

- freeze the candidate, public URLs, reviewer data, and material server behavior;
- do not submit unrelated metadata changes that may restart review timing;
- route store messages to the operator and TideGrid release owner;
- answer with app-specific facts and reproducible navigation steps; and
- preserve every question, response, attachment, rejection reason, and remediation.

### Review response and appeal

Classify a rejection before choosing the included response cycle. A metadata or binary defect normally uses a corrected resubmission. A template, spam, content-rights, or business-model finding may require an evidence-based appeal when the accepted build already complies and changing it would not address the stated policy.

Standard Native setup includes one review-response cycle per store: one corrected resubmission or one formal appeal. The operator owns publisher, legal-entity, rights, and business statements and performs any Apple publisher action. TideGrid prepares technical evidence, reproducible navigation, artifact hashes, and the response draft. The operator approves the complete response before it is sent. Response labor counts as customer-specific setup time; store waiting is external waiting.

A further correction, resubmission, or appeal requires a written custom scope. For a pilot operator application, TideGrid may approve one extra template-policy appeal as shared research or customer-specific subsidy, but it must record the classification and remain inside the $25,000 pilot-customer subsidy cap. The appeal packet retains the rejection text, guideline cited, build and metadata state, evidence submitted, operator approval, store response, time, and final decision.

## Testing and production release

### Preproduction

Apple TestFlight supports internal and external testing. The pilot workflow starts with internal testing; external testing is used only when participants cannot join the operator team and its review overhead is justified. Apple's [TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/) allows up to 100 internal and 10,000 external testers, and the first external build may require review.

Google provides internal, closed, and open tracks. Start with the [internal track](https://support.google.com/googleplay/android-developer/answer/9845334), then use a closed test only when a broader operator cohort is required. Personal-account testing requirements are another reason to require organization accounts.

### First production release

Use a manual Apple release after approval. Google managed publishing and staged rollout are not dependable controls for a first production launch, so schedule the first release during an attended window and limit initial countries to the approved pilot territory.

The production checklist verifies:

- correct publisher, application name, icon, description, privacy page, and support page;
- correct tenant bootstrap with no cross-tenant content;
- production authentication and deletion;
- production deep links and store links;
- a low-value or controlled production payment and refund;
- push registration and one non-sensitive test notification;
- current version and minimum-supported-version reporting; and
- crash, performance, API, queue, payment, and message monitoring.

### Updates

The initial operating assumption is one shared native train every eight weeks, plus urgent security releases. The pilot must validate or change that cadence.

- Validate every enabled manifest on every source change.
- Build all enabled operator variants before a fleet release.
- Release a small internal canary set before submitting the fleet.
- Submit operator apps independently so one account or rejection does not block the others.
- Use Apple's [seven-day phased release](https://developer.apple.com/help/app-store-connect/update-your-app/release-a-version-update-in-phases) and Google [staged rollouts](https://support.google.com/googleplay/android-developer/answer/6346149) for eligible updates.
- Monitor crashes, ANRs, authentication, deep links, payment, deletion, and push health before increasing exposure.
- Keep the PWA available when a store delays or rejects a native update.

The API supports a documented native compatibility window. A native application outside that window receives a clear upgrade requirement and a PWA route where possible. An old client must never bypass current price, waiver, authorization, or payment rules.

As of September 2026, Apple requires uploads to use [Xcode 26 and the iOS 26 SDK](https://developer.apple.com/news/upcoming-requirements/), and Google requires new apps and updates to target [Android 16, API level 36](https://support.google.com/googleplay/android-developer/answer/11926878). These requirements change. The pipeline checks current store requirements before every train instead of treating the recorded versions as permanent.

## Security fixes and operational support

Server or runtime-configuration fixes may ship independently when they preserve approved client behavior and backward compatibility. A native dependency, entitlement, permission, SDK, or executable vulnerability requires a rebuilt binary.

For a material native security issue:

1. identify affected application and dependency versions;
2. patch the shared source line;
3. build and test every enabled operator manifest;
4. notify operator release contacts and collect any required submission approval;
5. submit each app independently;
6. request expedited review only when the store's published criteria fit;
7. apply server-side mitigation without presenting it as a complete binary fix;
8. monitor approval and version adoption per operator; and
9. retire vulnerable client capability when the defined compatibility window and user communication allow it.

Native recurring service includes shared compatibility work, planned fleet releases, store monitoring, and security updates to the standard application. It does not include operator-requested navigation changes, unique native capabilities, new integrations, repeated customer-caused account remediation, new countries or languages, or unlimited store-rejection work.

Support must distinguish:

- guest application support;
- operator account or membership action;
- store policy or review action;
- provider or signing failure;
- shared application defect;
- operator configuration defect; and
- unsupported custom request.

## Offboarding and transfer

Normal offboarding requires no app transfer because the operator owns both developer accounts from the start.

The contract and runbook must define whether the operator will unpublish, keep the last binary available during a transition period, or appoint a successor developer. Store-account and listing ownership does not convey ownership of TideGrid's shared source tree or a perpetual right to the hosted service.

At offboarding TideGrid will:

1. export contractually required customer, booking, financial, waiver, trip-card, and configuration data;
2. archive the manifest, metadata, public signing fingerprints, store history, review correspondence, and last supported release record;
3. disable new bookings at the agreed cutover and give installed applications an explicit service-state response;
4. revoke TideGrid users, API keys, APNs keys, upload credentials, Firebase access, and CI access;
5. rotate credentials if TideGrid personnel had access and the operator continues with another provider;
6. remove or transfer custom-hostname and deep-link associations according to the cutover plan;
7. complete retention and deletion actions separately from removal of a store listing; and
8. obtain written confirmation of the final store and data state.

An app transfer is reserved for a change in legal ownership or an exceptional initial-account mistake. Apple [preserves the bundle ID, ratings, reviews, and user updates](https://developer.apple.com/help/app-store-connect/transfer-an-app/overview-of-app-transfer), but APNs, keychain, Sign in with Apple, Apple Pay, and other capabilities can require migration. Google [transfers users, ratings, statistics, and listings](https://support.google.com/googleplay/android-developer/answer/6230247), but testing groups, reports, and some linked-service permissions do not transfer. Transfer work is outside standard Native setup.

## Cost and labor controls

### Pass-through costs

Current operator-paid store costs are:

| Cost | Current amount | Billing treatment |
|---|---:|---|
| Apple Developer Program | $99 per year, subject to regional variation | Operator pays Apple directly |
| Google developer registration | $25 one time | Operator pays Google directly |

Hosted build minutes, dedicated signing services, test devices, screenshot tooling, monitoring, and operator-specific provider charges count as direct Native delivery cost. TideGrid should publish the standard tooling it includes and pass through a dedicated service only when the customer requests or causes it.

### Standard setup labor budget

The $4,500 setup band depends on staying at or below 22 customer-specific hours and below $500 of direct cost. Use this initial budget:

| Activity | Target hours |
|---|---:|
| Qualification and account-readiness guidance | 2 |
| Manifest, brand, rights, and website validation | 3 |
| Identifiers, signing, push, and deep links | 3 |
| Store metadata, screenshots, privacy, and declarations | 4 |
| Operator-specific build, testing, and acceptance | 4 |
| Submission and one correction-or-appeal response allowance | 4 |
| Release, verification, and handoff | 2 |
| **Total** | **22** |

External waiting does not count as labor but does block the calendar. Time spent correcting customer legal records, creating policies, repairing a website, producing missing brand assets, adding locales or device classes, or handling more than one store resubmission is out of scope.

### Time classification

Record time in four separate buckets:

- shared product engineering, which benefits every operator;
- customer-specific setup, measured against the setup band;
- recurring Native operations and support, measured against the two-hour monthly gate; and
- external waiting, which carries no labor cost but explains elapsed delivery time.

For fleet releases, also measure:

- automated pass rate;
- per-operator manual touch time across the app pair;
- store rejection and resubmission rate;
- credential or account failure rate;
- elapsed approval time; and
- time until the supported version reaches the adoption target.

At 85 Native operators, one shared version still creates 170 store-specific submission paths. Four releases per year create 680 paths; six create 1,020, before rejections. The recurring model works only when almost all of those paths are automated and exceptions remain rare.

## Acceptance gates

This list is the operator-level checklist for the [Native pilot gate](05-roadmap-validation.md#native-pilot-gate). It gates the Native add-on going live for that operator. It does not block the Core live gate or the PWA, and an operator may already be live on the PWA while its apps are in review.

An operator application pair is ready for production only when:

- both binaries build from one clean shared-source revision without operator code changes;
- every manifest and asset passes schema, security, accessibility, and brand validation;
- operator-owned organization accounts are verified and in good standing;
- bundle ID, package name, signing fingerprints, push topics, and tenant identity match the approved manifest;
- no credential is shared between operators or stored in source control;
- operator-specific privacy, support, terms, deletion, and association URLs pass continuously;
- App Privacy, Data Safety, content, audience, financial, export, and trader declarations are complete and approved by the operator;
- screenshots and descriptions are unique, accurate, and reproducible from the accepted build;
- the reviewer account exposes every in-scope feature without real customer data or expiring credentials;
- physical-service payment treatment is explained in both review packets;
- TestFlight and Play internal installations pass on supported physical devices;
- deep links, push, authentication, account deletion, payment, waiver, trip-card, and version compatibility pass;
- the operator records acceptance and performs the final Apple submission;
- both stores approve public distribution; and
- production verification confirms the correct operator, version, links, and backend.

The Native factory is commercially acceptable beyond the pilot cohort only when:

- median customer-specific delivery remains at or below the applicable setup band;
- direct setup cost remains below the applicable ceiling;
- at least 95% of enabled operator variants build and pass without manual repair;
- routine fleet-release touch time averages under 15 minutes per operator across both stores;
- Native operations and support remain below two hours per operator per month after day 90;
- no customer source fork exists;
- one failed account or review cannot block another operator's release; and
- shared security fixes can be prepared for the full fleet within the documented incident target.

## Change or stop gates

Pause new Native sales and review the model when any of these occurs:

- Apple rejects a compliant pilot operator application under template, minimum-functionality, or spam rules after the included response cycle and any separately approved pilot appeal;
- Google rejects a compliant pilot operator application for repetitive content after the included response cycle and any separately approved pilot appeal;
- an operator cannot or will not own and maintain the required organization accounts;
- any delivery requires a customer source fork;
- routine release touch time exceeds 15 minutes per operator after the pilot process stabilizes;
- recurring Native support exceeds two hours per operator per month after day 90;
- median customer-specific setup exceeds 40 hours;
- account, credential, or customer approval failures repeatedly prevent fleet security updates; or
- native adoption does not improve repeat booking or reduce customer-service work.

If two otherwise compliant pilot operator applications receive unresolved template or repetitive-content rejections, stop selling separate branded binaries. Continue with the branded PWA and evaluate one aggregated TideGrid application with an operator picker, which Apple identifies as an acceptable template-provider alternative.

## Official source register

### Apple

- [Program enrollment and fees](https://developer.apple.com/help/account/membership/program-enrollment)
- [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
- [App review preparation and timing](https://developer.apple.com/app-store/review/)
- [Roles and access](https://developer.apple.com/help/account/access/roles)
- [Register an App ID](https://developer.apple.com/help/account/identifiers/register-an-app-id)
- [App Store Connect API](https://developer.apple.com/app-store-connect/api/)
- [Create an app record](https://developer.apple.com/help/app-store-connect/create-an-app-record/add-a-new-app/)
- [Platform version metadata](https://developer.apple.com/help/app-store-connect/reference/app-information/platform-version-information)
- [Screenshots and previews](https://developer.apple.com/help/app-store-connect/manage-app-information/upload-app-previews-and-screenshots)
- [App privacy](https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy/)
- [Third-party SDK requirements](https://developer.apple.com/support/third-party-SDK-requirements/)
- [Account deletion](https://developer.apple.com/support/offering-account-deletion-in-your-app/)
- [TestFlight](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/)
- [Phased release](https://developer.apple.com/help/app-store-connect/update-your-app/release-a-version-update-in-phases)
- [Current SDK requirements](https://developer.apple.com/news/upcoming-requirements/)
- [Associated domains](https://developer.apple.com/documentation/xcode/supporting-associated-domains)
- [APNs token connections](https://developer.apple.com/documentation/UserNotifications/establishing-a-token-based-connection-to-apns)
- [App transfer](https://developer.apple.com/help/app-store-connect/transfer-an-app/overview-of-app-transfer)

### Google

- [White-label developer guidance](https://support.google.com/googleplay/android-developer/answer/15884185)
- [Organization account information](https://support.google.com/googleplay/android-developer/answer/13628312)
- [Users and permissions](https://support.google.com/googleplay/android-developer/answer/9844686)
- [Create and set up an app](https://support.google.com/googleplay/android-developer/answer/9859152)
- [Play App Signing](https://support.google.com/googleplay/android-developer/answer/9842756)
- [Preview assets](https://support.google.com/googleplay/android-developer/answer/9866151)
- [Prepare an app for review](https://support.google.com/googleplay/android-developer/answer/9859455)
- [Reviewer sign-in details](https://support.google.com/googleplay/android-developer/answer/15748846)
- [User Data, privacy, and deletion](https://support.google.com/googleplay/android-developer/answer/10144311)
- [Data Safety](https://support.google.com/googleplay/android-developer/answer/10787469)
- [Financial features declaration](https://support.google.com/googleplay/android-developer/answer/13849271)
- [Physical-service payment policy](https://support.google.com/googleplay/android-developer/answer/9858738)
- [Testing tracks](https://support.google.com/googleplay/android-developer/answer/9845334)
- [Managed publishing and review timing](https://support.google.com/googleplay/android-developer/answer/9859654)
- [Staged rollouts](https://support.google.com/googleplay/android-developer/answer/6346149)
- [Target API requirements](https://support.google.com/googleplay/android-developer/answer/11926878)
- [Package-name registration](https://support.google.com/googleplay/android-developer/answer/16984799)
- [App transfer](https://support.google.com/googleplay/android-developer/answer/6230247)
- [Android App Links verification](https://developer.android.com/training/app-links/verify-applinks)
