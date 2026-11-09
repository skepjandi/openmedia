# Store Builds

> Build instructions reflect the checked-in Tauri configuration. A successful local build does not mean the app is signed, store-ready, or accepted. Android device/emulator behavior and store submission have not been verified.

## Requirements

Follow [Development Guide](./development-guide.md#prerequisites) for Node/Yarn, Rust, and native toolchains. Store uploads also require accounts and signing credentials for the relevant store. Do not commit certificates, provisioning profiles, keystores, or signing properties.

Before a release, configure the RevenueCat keys and live HTTPS privacy/terms URLs described in [Paywall](./paywall.md#configuration). Without them, purchases remain unavailable. Review the store product checklist there too.

## iOS App Store

1. Set up Xcode signing for the `surf.openmedia` bundle ID with an Apple Distribution identity and App Store provisioning. `APPLE_DEVELOPMENT_TEAM` is used by the documented Tauri iOS development flow; confirm the signing team and profile in Xcode for distribution.
2. Set the marketing version in `src-tauri/tauri.conf.json`. Increment `bundle.iOS.bundleVersion` for every upload (`yarn release` does it; see below). The version (`1.0.0`) is the top-level `version` in `tauri.conf.json`; it matches the "1.0" version records in App Store Connect.
3. Build an App Store Connect export (not a simulator build):

   ```bash
   APPLE_DEVELOPMENT_TEAM=<team-id> yarn tauri ios build --target aarch64 --export-method app-store-connect --ci
   ```

   The CLI builds the frontend via `beforeBuildCommand` and asks Xcode to export for App Store Connect. Inspect the resulting archive/IPA and signing in Xcode Organizer before uploading.
4. Upload the validated App Store build through Xcode Organizer or App Store Connect, then complete the app’s listing, privacy declarations, and review submission there.

`--target aarch64-sim --archive-only` is for Simulator testing only; its `.app` cannot be submitted to the App Store. An `.ipa` signed with a distribution certificate and an App Store profile (made with `yarn release`) passed `altool --validate-app`; it has not been uploaded or reviewed.

The app ships `src-tauri/gen/apple/openmedia_iOS/PrivacyInfo.xcprivacy` declaring the required-reason APIs the binary links (file timestamps `C617.1`, UserDefaults `CA92.1`; found with `nm -u` on a release build). Re-check with `nm -u` and update it when a dependency changes. `Info.plist` sets `ITSAppUsesNonExemptEncryption` to `false` (HTTPS only, no custom cryptography); the account holder must confirm that answer applies before the first upload. The privacy nutrition label in App Store Connect is separate and still manual (RevenueCat's anonymous purchase data, the user-initiated AI snapshot).

## One command: `yarn release`

`yarn release [ios] [android] [macos] [--build N] [--no-bump] [--validate]` builds the store packages (all three by default) and collects them in `release/<version>-<build>/`: `ios/OpenMedia.ipa` and `macos/OpenMedia-MacAppStore.pkg` for Transporter, `android/app-universal-release.aab` for Play Console.

It handles the build number. Unless `--no-bump` or `--build N` is given, the number becomes one more than the largest of the iOS `bundleVersion`, macOS `bundleVersion` and Android `versionCode` in `tauri.conf.json` and, when the `ASC_*` settings are present, the largest build App Store Connect already has. It writes the new number back to `tauri.conf.json` (commit it). Google Play cannot be queried without a service account, so if Play answers "version code already used", run again with a higher `--build N`. `--validate` runs `altool --validate-app` on the `.ipa` and `.pkg`.

Settings come from the environment or `.env` (never commit them):

| Variable | Used for |
|---|---|
| `APPLE_TEAM_ID` | iOS export |
| `IOS_SIGN_IDENTITY`, `IOS_PROFILE` | iOS export: the iOS Distribution certificate name and the App Store provisioning profile name (installed in Xcode) |
| `MAS_APP_IDENTITY`, `MAS_INSTALLER_IDENTITY`, `MAS_PROFILE`, optional `MAS_KEYCHAIN` | Mac package: see [Mac App Store](#mac-app-store) |
| `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_PATH` | optional: latest build lookup and `--validate` (App Store Connect API key) |

The first time a signing key is used, macOS asks for the login keychain password; choose Always Allow so later runs do not stop. Android needs `src-tauri/gen/android/keystore.properties` (see [Android Google Play](#android-google-play)). Without distribution certificates in the account, the certificates and profiles can be created through the App Store Connect API (a key with the Admin role; Xcode's own cloud signing was refused for the key used so far).

## Mac App Store

The Mac App Store takes a signed installer package (`.pkg`), not the `.app` or `.dmg` that `yarn build macos` makes, and requires the App Sandbox (`src-tauri/macos/OpenMedia.entitlements`: network, Downloads folder, file picker). StoreKit purchases on the Mac only work in a build signed this way.

1. In the Apple Developer account create a **Mac App Distribution** certificate, a **Mac Installer Distribution** certificate and a **Mac App Store** provisioning profile for `surf.openmedia`; install the two certificates in a keychain.
2. Build and package:

   ```bash
   yarn tauri build --bundles app
   MAS_APP_IDENTITY="3rd Party Mac Developer Application: <team>" \
   MAS_INSTALLER_IDENTITY="3rd Party Mac Developer Installer: <team>" \
   MAS_PROFILE=<path to the .provisionprofile> \
   sh scripts/package-mac-app-store.sh
   ```

   The package is `OpenMedia-MacAppStore.pkg` next to the `.app`. The script adds the sandbox entitlements and the profile, makes every file readable by all users (App Store validation error 90255 otherwise), compiles the app icon from `src-tauri/macos/Assets.xcassets` into `Assets.car` and `AppIcon.icns` (the macOS-style tile, made from the iOS icon), and signs the installer.
3. Validate with `xcrun altool --validate-app -f <pkg> -t macos --apiKey <id> --apiIssuer <issuer>`, then upload with Transporter.

The sandboxed Mac app was only launched to the onboarding screen (an ad-hoc signed copy). Page loading, downloads, the Keychain and purchases inside the sandbox, and whether Transporter shows the icon, have not been checked.

## Android Google Play

1. Create a Play upload keystore and keep it outside version control. Create the ignored file `src-tauri/gen/android/keystore.properties` with these fields:

   ```properties
   keyAlias=<upload-key-alias>
   password=<keystore-and-key-password>
   storeFile=<path-to-keystore>
   ```

   Gradle reads this file and applies release signing only when it exists. Verify that `storeFile` resolves to the intended upload keystore.
2. Increment `bundle.android.versionCode` in `src-tauri/tauri.conf.json` for each upload; set the app version there for the displayed version name. `yarn release` raises it too; Play had already used 1000; application ID is `surf.openmedia`, minimum SDK 24.
3. Build the release Android App Bundle:

   ```bash
   yarn tauri android build --aab --ci
   ```

   Expected output: `src-tauri/gen/android/app/build/outputs/bundle/universalRelease/app-universal-release.aab`. A previous build without signing properties produced an unsigned AAB; do not upload it. Check the current artifact’s signature with `jarsigner -verify` and inspect Gradle’s release signing configuration before submission.
4. Upload the signed AAB through Play Console, finish required listing and policy forms, and use an internal testing track before production rollout.

The Kotlin Android implementation and AAB build path exist, but Android runtime behavior and a signed release have not been verified. Store account setup, policy declarations, review, and rollout are manual Play Console work.

## Store artwork

Artwork files and sizes are listed in [`assets/store/README.md`](../../assets/store/README.md). The Android images currently use iOS captures in device frames; **replace them with screenshots captured from the Android app before submitting to Google Play**. Usage and Limits screens show synthetic sample data.

## See also

[Development Guide](./development-guide.md) · [Platform Support](./platform-support.md) · [Paywall](./paywall.md)
