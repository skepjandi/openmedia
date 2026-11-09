# Store Builds

> Build instructions reflect the checked-in Tauri configuration. A successful local build does not mean the app is signed, store-ready, or accepted. Android device/emulator behavior and store submission have not been verified.

## Requirements

Follow [Development Guide](./development-guide.md#prerequisites) for Node/Yarn, Rust, and native toolchains. Store uploads also require accounts and signing credentials for the relevant store. Do not commit certificates, provisioning profiles, keystores, or signing properties.

Before a release, configure the RevenueCat keys and live HTTPS privacy/terms URLs described in [Paywall](./paywall.md#configuration). Without them, purchases remain unavailable. Review the store product checklist there too.

## iOS App Store

1. Set up Xcode signing for the `surf.openmedia` bundle ID with an Apple Distribution identity and App Store provisioning. `APPLE_DEVELOPMENT_TEAM` is used by the documented Tauri iOS development flow; confirm the signing team and profile in Xcode for distribution.
2. Set the marketing version in `src-tauri/tauri.conf.json`. Increment `bundle.iOS.bundleVersion` for every upload; it is currently `1000`. The version (`1.0.0`) is the top-level `version` in `tauri.conf.json`; it matches the "1.0" version records in App Store Connect.
3. Build an App Store Connect export (not a simulator build):

   ```bash
   APPLE_DEVELOPMENT_TEAM=<team-id> yarn tauri ios build --target aarch64 --export-method app-store-connect --ci
   ```

   The CLI builds the frontend via `beforeBuildCommand` and asks Xcode to export for App Store Connect. Inspect the resulting archive/IPA and signing in Xcode Organizer before uploading.
4. Upload the validated App Store build through Xcode Organizer or App Store Connect, then complete the app’s listing, privacy declarations, and review submission there.

`--target aarch64-sim --archive-only` is for Simulator testing only; its `.app` cannot be submitted to the App Store. Store signing and upload have not been verified in this repository.

The app ships `src-tauri/gen/apple/openmedia_iOS/PrivacyInfo.xcprivacy` declaring the required-reason APIs the binary links (file timestamps `C617.1`, UserDefaults `CA92.1`; found with `nm -u` on a release build). Re-check with `nm -u` and update it when a dependency changes. `Info.plist` sets `ITSAppUsesNonExemptEncryption` to `false` (HTTPS only, no custom cryptography); the account holder must confirm that answer applies before the first upload. The privacy nutrition label in App Store Connect is separate and still manual (RevenueCat's anonymous purchase data, the user-initiated AI snapshot).

## Mac App Store

The Mac App Store takes a signed installer package (`.pkg`), not the `.app` or `.dmg` that `yarn build macos` makes, and requires the App Sandbox (`src-tauri/macos/OpenMedia.entitlements`: network, Downloads folder, file picker).

1. In the Apple Developer account create a **Mac App Distribution** certificate, a **Mac Installer Distribution** certificate and a **Mac App Store** provisioning profile for `surf.openmedia`; install the two certificates in a keychain.
2. Build and package:

   ```bash
   yarn tauri build --bundles app
   MAS_APP_IDENTITY="3rd Party Mac Developer Application: <team>" \
   MAS_INSTALLER_IDENTITY="3rd Party Mac Developer Installer: <team>" \
   MAS_PROFILE=<path to the .provisionprofile> \
   sh scripts/package-mac-app-store.sh
   ```

   The package is `src-tauri/target/release/bundle/macos/OpenMedia-MacAppStore.pkg`.
3. Validate with `xcrun altool --validate-app -f <pkg> -t macos --apiKey <id> --apiIssuer <issuer>`, then upload with Transporter.

The sandbox build was only started (to the onboarding screen) in an ad-hoc signed copy; page loading, downloads, the Keychain and purchases inside the sandbox have not been checked. StoreKit purchases on the Mac only work in a build signed this way.

## Android Google Play

1. Create a Play upload keystore and keep it outside version control. Create the ignored file `src-tauri/gen/android/keystore.properties` with these fields:

   ```properties
   keyAlias=<upload-key-alias>
   password=<keystore-and-key-password>
   storeFile=<path-to-keystore>
   ```

   Gradle reads this file and applies release signing only when it exists. Verify that `storeFile` resolves to the intended upload keystore.
2. Increment `bundle.android.versionCode` in `src-tauri/tauri.conf.json` for each upload; set the app version there for the displayed version name. The current Android code is `1000`; application ID is `surf.openmedia`, minimum SDK 24.
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
