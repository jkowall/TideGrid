# 10. Native apps

Building an operator's branded iOS and Android app, testing it with testers, sending it to the stores, answering review, releasing it in steps, and blocking an old version that is no longer safe.

**Status today.** The demo guest app is on TestFlight and Google Play internal testing only. Store submission, review, and public release are Wave 5 and the Native pilot gate. The Native add-on never blocks an operator's Core live gate: the web booking site works without it. The full process, including each operator's account packet, is in [native app factory and store submission](../../v2/09-native-app-factory-and-store-submission.md). This guide is the short version for when something goes wrong.

**Builds run on the owner's Mac** with Xcode and Android Studio, not a cloud build service ([guest-native README](../../../apps/guest-native/README.md#builds-for-testers)). Signing keys stay on that Mac. The operator owns their store accounts and has the final say on release.

## A tester build

| | |
|---|---|
| Owner | TideGrid owner |
| Approval | Owner go for each upload |
| Safe first action | Build both variants' JavaScript bundles without signing (the README's bundle check) |
| Customer impact check | None; testers only |
| Evidence | The build number, source commit, and upload time in the release record |
| Limit | Both stores refuse a build number they have seen; numbers only go up |
| Communication | TideGrid owner tells the operator's testers |
| Closed when | The build installs from TestFlight and Play internal testing and completes a booking on staging |

1. Pick the variant and the next build number above the last upload for that variant.
2. iOS: archive and upload from Xcode with automatic signing.
3. Android: `./gradlew bundleRelease` with the upload key from `~/.gradle/gradle.properties`, then upload to internal testing.
4. Install on a real phone and book once.

## The first store submission

Follow the initial launch steps in [doc 09](../../v2/09-native-app-factory-and-store-submission.md#initial-launch-sop). The operator approves the listing, privacy answers, and screenshots before submission. TideGrid never accepts store agreements for the operator.

## Store review rejects the app

| | |
|---|---|
| Owner | TideGrid owner prepares; operator owner approves anything said on their behalf |
| Approval | Operator owner approves a reply or an appeal |
| Safe first action | Read the rejection in full and copy it into the release record |
| Customer impact check | None; the web booking site is unaffected |
| Evidence | The rejection, the reply, and the result |
| Limit | Review times are not under TideGrid's control |
| Communication | TideGrid owner tells the operator what was asked and the plan |
| Closed when | The build is approved, or the operator decides to stop |

1. Sort the rejection: metadata (fix the listing), binary (needs a new build), or policy (may need the operator's business answers). Doc 09's [review response and appeal](../../v2/09-native-app-factory-and-store-submission.md#review-response-and-appeal) has the rules.
2. Answer in the store console. Keep it factual: the app sells in-person trips, which is why it uses card payments and not in-app purchase.
3. If an appeal is needed, the operator owner approves the text first.

## A phased release goes wrong

| | |
|---|---|
| Owner | TideGrid owner |
| Approval | Owner go to pause; operator owner told at once |
| Safe first action | Pause the phased release (App Store) or halt the rollout (Google Play) |
| Customer impact check | Crash reports in each store console; operator reports |
| Evidence | Release record with the version, the share reached, and the pause time |
| Limit | Phones that already updated keep the new version until a fixed one ships |
| Communication | Operator tells guests to use the web booking site meanwhile |
| Closed when | A fixed build is released, or the bad one was halted before it mattered |

1. Pause or halt.
2. If the problem is on the server side, fix and release the API instead; that reaches every phone at once ([guide 5](05-releases-and-rollback.md)).
3. If the app itself is broken, build a fix with a higher build number and send it through review.

## Urgent compatibility block

An old app version must stop working because it would break a rule (price, waiver, payment, or security).

The API is meant to support a documented range of app versions and tell older apps to upgrade ([doc 09, updates](../../v2/09-native-app-factory-and-store-submission.md#updates)). **That check is not built yet.** The demo app sends no version to the API. Before any operator's app is public, add it: the app sends its build, and the API answers an upgrade message to builds below a minimum.

Until then, the safe moves are:

1. Fix the problem on the server so that old apps get a refusal they already show as an error (the app shows a designed screen for each failure).
2. Ask the stores to remove the bad version from sale, and release a fixed one.
3. Tell guests through the operator to use the web booking site.

## Signing key lost or leaked

- **Android upload key.** Google Play App Signing holds the real signing key. Ask Google Play support to reset the upload key, and make a new one on the Mac.
- **Apple.** Revoke the certificate in the Apple Developer account; Xcode's automatic signing makes a new one.
- Record it as a security incident ([guide 9](09-security-incidents.md#leaked-secret)).
