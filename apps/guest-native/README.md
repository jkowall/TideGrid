# @tidegrid/guest-native

The demo guest app: one React Native and Expo app, built once per synthetic operator. It is the shell goal W1N-APP of Wave 1n, by the owner's decision of 2026-11-08 ([decision register](../../docs/v2/06-decision-register.md#2026-11-08-demo-guest-app-pulled-forward-into-the-demo-owner-decision)). Synthetic data only. It is not the Native add-on and claims no gate; the store factory, push, deep links, and public release stay with the G4 goals in the [native app factory plan](../../docs/v2/09-native-app-factory-and-store-submission.md).

## What it does today

- Starts with the operator's brand from `GET /v1/public/tenant`, parsed against the same contract as the guest web app (`PublicExperienceResponse`). The header shows the brand's name, tagline, and primary color.
- Lists the operator's bookable trips for the next four weeks from `GET /v1/public/trips`, with seats left.
- Books a trip (W1N-JOURNEYS): the party by ticket type or charter guests, extras, a price from `POST /v1/public/quotes`, the booker's name and email, the cancellation policy to accept, a hold from `POST /v1/public/checkout-sessions`, and the demo's test payment ("Simulate successful payment" or "Simulate declined payment"). The app then waits for the checkout's own state, which only the provider's verified event changes, and shows the outcome: booked, declined, hold expired, canceled, or refunded because the seats were gone.
- Shows "Your bookings": each booking opened on this phone in the last hour, and the booking's page with the trip, where to meet, the party, what was paid, and each named person's waiver status. A booking opens right after paying, or by pasting the link from the confirmation email.
- Shows one designed screen for each other outcome: loading, not published, not ready, could not connect (with Try again), trips that did not load, no trips, sold out, booking closed, prices not set, payments unavailable, too many open checkouts, a price that expired, a misconfigured build, and an answer for the wrong operator.

The app uses the same API calls, headers, and bodies as the guest web app, and the same words for prices, the policy, and each failure (`src/booking-model.ts` is a port of the web app's booking model for the parts the app shows). No API change.

Not in the app yet: Stripe's card form (the demo runs the fake provider; a checkout that asks for Stripe gives the seats back and says to book on the website), changing the party, naming people, and canceling (the booking's page says to use the email link), promotion codes, push, and deep links. The logo and the brand fonts are not drawn yet: React Native cannot show an SVG data URI without another package, and the fonts need bundling. The app uses system fonts.

## Secrets on the phone

- The checkout secret and the payment's client secret live only in the booking screen's memory, as on the web. Closing the app mid-payment loses them; the confirmation email still opens the booking.
- A booking session is what the web app keeps in its tab's sessionStorage: its token, when it expires, and the booking's reference. The app keeps those same three fields, one record per booking and per operator, in the platform's secure storage through expo-secure-store (Keychain on iOS, readable only while the phone is unlocked and never restored to another device; Keystore-backed storage on Android). Sessions last an hour, as the API sets them, and expired ones are dropped. Nothing else is stored. If secure storage fails, the app keeps the record in memory until it closes.
- Secrets and personal data travel only in an Authorization header or a POST body, never a path or query. A unit test checks every route's URL. The app's source never logs; a unit test checks for `console`.
- Checkout secrets and Idempotency-Keys come from expo-crypto's `getRandomValues`, the platform's secure generator. There is no fallback to `Math.random`.

## Variants

Each file in `variants/` is one build: the operator's slug, the app's name, its iOS bundle id and Android package, and the guest origin it presents. The brand itself always comes from the API, as on the web. A unit test checks that every variant matches its tenant in `config/tenants` and that store ids are unique. The demo ids (`us.tidegrid.demo.*`) are for demo builds only and are never reused for an operator's app.

`app.config.ts` reads `TIDEGRID_VARIANT`. A missing or unknown name stops the build. It never falls back to another operator.

## How it finds its operator

The API picks the operator from the request's Origin header, for the web app and this app alike. A native app has no browser origin, so it sends its variant's guest origin (for example `https://demo-harbor.book.tidegrid.us`). That is not authentication. Any client can send any Origin, and the API uses it only to choose which public operator to answer for. Guests are anonymous until checkout, and the app sends no credentials. No API change was needed.

The app then fails closed: if the answer names any other operator than its variant, it shows "This app cannot open" and nothing from that answer.

## Running it

Node 24 and pnpm, from the repository root: `pnpm install`.

```sh
# Bundle the JavaScript for both platforms and both variants. No simulator,
# no signing. Proves each variant's config and the shared source bundle.
pnpm --filter @tidegrid/guest-native bundle:check

# On a Mac with Xcode or Android Studio: run on a simulator or a phone.
# Each run regenerates that platform's native project (disposable,
# gitignored) from the variant, so switching variants never keeps the
# other operator's bundle id or application id.
TIDEGRID_VARIANT=demo-harbor pnpm --filter @tidegrid/guest-native ios
TIDEGRID_VARIANT=demo-reef pnpm --filter @tidegrid/guest-native android
```

By default a build talks to `https://api.tidegrid.us` as its preview host. Against a local API (`tools/local-db/local-db.sh prepare guest-e2e`, then `local-db.sh api 8787 <log>`), set `TIDEGRID_API_BASE` to the API's address as the phone sees it, such as `http://<your Mac's LAN address>:8787`, and `TIDEGRID_GUEST_ORIGIN=http://demo-harbor.book.localhost:5361`. A local origin must name the variant's own tenant. Without a local origin the API must be https. A build with `TIDEGRID_RELEASE=1`, as for TestFlight, refuses both settings, so a value left over from local work cannot reach testers. `app.config.ts` stops the build on any of these.

`ios/` and `android/` are generated by `expo prebuild` and never committed. A change that needs editing them by hand is a missing shared capability, as the native plan says.

## Builds for testers

TestFlight and Google Play internal testing only. No public release and no review submission; those stay in Wave 5. Builds run on the owner's Mac with Xcode and Android Studio, not a cloud build service.

A tester build sets `TIDEGRID_RELEASE=1` and `TIDEGRID_BUILD_NUMBER`, a whole number above the last upload of that variant. Both stores refuse a number they have already seen. The build number becomes the iOS build number and the Android version code.

- **Icons.** `assets/<slug>/` holds each variant's 1024 px icon, drawn from the operator's logo on its primary color, and the Android adaptive foreground. The iOS icon has no transparency, as Apple requires. A unit test checks both.
- **iOS.** The app uses only the platform's HTTPS and Keychain, so it declares exempt encryption (`ITSAppUsesNonExemptEncryption` false) and TestFlight does not ask. Signing is Xcode's automatic signing with the owner's team. Archive and upload from Xcode.
- **Android.** A release build is signed with the owner's upload key, never the template's debug key. The keystore and its passwords stay on the owner's Mac, outside the repository. Gradle reads `TIDEGRID_UPLOAD_STORE_FILE`, `TIDEGRID_UPLOAD_STORE_PASSWORD`, `TIDEGRID_UPLOAD_KEY_ALIAS`, and `TIDEGRID_UPLOAD_KEY_PASSWORD` from `~/.gradle/gradle.properties` and stops if one is missing. Google Play App Signing keeps the app signing key. Build an app bundle with `./gradlew bundleRelease` and upload it to the internal testing track.

## Hermes and the brand contract

The brand contract checks a logo with `atob` and a fatal UTF-8 `TextDecoder`. Expo's fetch also decodes text with a default `TextDecoder`. `src/text-polyfill.ts` runs before anything else loads. It tests the engine's own `atob` and `TextDecoder` against the web platform's behavior (fatal and replacement decoding, the utf-8 labels, bad base64) and replaces only one that is missing or wrong, with versions that follow the WHATWG algorithms. Unit tests compare them with Node's on fixed and random input, and run the contract's logo check on both tenants' logos with only the stand-ins present. Nothing has run on Hermes yet; W1N-TESTFLIGHT checks the app on a device.

## Tests

`pnpm --filter @tidegrid/guest-native test` runs the unit tests in Node: the variant files, the endpoint guard, the start and trip loaders (origin sent, no credentials, wrong operator refused, the API's own 404 versus any other, broken bodies), the polyfills, and the booking journey (quote and checkout bodies parsed by the API's own schemas, the routes the web app uses, no secret in any URL, refusals mapped to the right screen, secrets and keys, and the stored sessions). `typecheck` and the repository's Biome lint cover the app's code. No test needs a simulator.
