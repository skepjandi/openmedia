# Store Builds

> Build instructions reflect the checked-in Tauri configuration. A successful local build does not mean the app is signed, store-ready, or accepted. Android device/emulator behavior and store submission have not been verified.

> **Releasing?** `yarn release doctor`, then `yarn release ship patch`. See [Releasing](#releasing-yarn-release).

> **Platform rule.** iOS, Android and macOS have paid (Pro) versions and ship **only through their stores**; their binaries (`.ipa`, `.aab`, `.apk`, `.pkg`, `.dmg`) are never published to GitHub Releases or the landing page. Windows and Linux are free with every feature unlocked and are the only platforms released as downloads on GitHub: see [Windows and Linux releases](#windows-and-linux-releases-github). Windows/Linux packaging has not been verified on hardware.

## Requirements

Follow [Development Guide](./development-guide.md#prerequisites) for Node/Yarn, Rust, and native toolchains. Store uploads also require accounts and signing credentials for the relevant store. Do not commit certificates, provisioning profiles, keystores, or signing properties.

Before a release, configure the RevenueCat keys and live HTTPS privacy/terms URLs described in [Paywall](./paywall.md#configuration). Without them, purchases remain unavailable. Review the store product checklist there too.

## iOS App Store

1. Set up Xcode signing for the `surf.openmedia` bundle ID with an Apple Distribution identity and App Store provisioning. `APPLE_DEVELOPMENT_TEAM` is used by the documented Tauri iOS development flow; confirm the signing team and profile in Xcode for distribution.
2. The marketing version is the top-level `version` in `src-tauri/tauri.conf.json` (kept equal to `package.json`'s by `yarn release bump`); it matches the "1.0" version records in App Store Connect. `bundle.iOS.bundleVersion` must rise for every upload; `yarn release` does it.
3. Build an App Store Connect export (not a simulator build):

   ```bash
   APPLE_DEVELOPMENT_TEAM=<team-id> yarn tauri ios build --target aarch64 --export-method app-store-connect --ci
   ```

   The CLI builds the frontend via `beforeBuildCommand` and asks Xcode to export for App Store Connect. Inspect the resulting archive/IPA and signing in Xcode Organizer before uploading.
4. Upload the validated App Store build through Xcode Organizer or App Store Connect, then complete the app’s listing, privacy declarations, and review submission there.

`--target aarch64-sim --archive-only` is for Simulator testing only; its `.app` cannot be submitted to the App Store. An `.ipa` signed with a distribution certificate and an App Store profile (made with `yarn release`) passed `altool --validate-app`; it has not been uploaded or reviewed.

The app ships `src-tauri/gen/apple/openmedia_iOS/PrivacyInfo.xcprivacy` declaring the required-reason APIs the binary links (file timestamps `C617.1`, UserDefaults `CA92.1`; found with `nm -u` on a release build). Re-check with `nm -u` and update it when a dependency changes. `Info.plist` sets `ITSAppUsesNonExemptEncryption` to `false` (HTTPS only, no custom cryptography); the account holder must confirm that answer applies before the first upload. The privacy nutrition label in App Store Connect is separate and still manual (RevenueCat's anonymous purchase data, the user-initiated AI snapshot).

## Releasing: `yarn release`

One CLI does the whole release. Everything it needs is discovered, so there is nothing to export or remember. Releasing is for maintainers who hold the store accounts and signing material; contributors never need it (`yarn build` and `yarn tauri dev` build unsigned, and nothing here is required to send a PR).

```bash
yarn release doctor            # is this machine ready? prints one fix per problem
yarn release setup             # import certificates and profiles from the signing folder
yarn release ship patch        # doctor -> version PR -> merge -> build all three
yarn release                   # build all three from the current checkout
yarn release ios macos         # build only some platforms
yarn release github            # tag v<version> on main; CI publishes Windows and Linux (below)
```

| Command | What it does |
|---|---|
| `doctor [platforms]` | Checks version files agree, Xcode, certificates, profiles, Android keystore/SDK/NDK/Java, and the optional App Store Connect key. With `windows` / `linux`: Node and Yarn, Rust, that this machine runs that OS, the Linux libraries (`webkit2gtk-4.1`, `gtk+-3.0`, `librsvg-2.0`, `patchelf`), and the updater signing key. Each problem names its fix. Read-only. |
| `setup` | Imports every `.p12` in the signing folder into the login keychain (needs `SIGNING_P12_PASSWORD`), installs the iOS profile for Xcode, then runs `doctor`. Safe to repeat. |
| `build` (default) | Runs `doctor`, picks the build number, builds the platforms, and collects the packages in `release/<version>-<build>/`: `ios/OpenMedia.ipa` and `macos/OpenMedia-MacAppStore.pkg` for Transporter, `android/app-universal-release.aab` for Play Console. Flags: `--no-bump` (reuse the number in `tauri.conf.json`), `--build N`, `--validate` (`altool --validate-app` on the `.ipa` and `.pkg`). |
| `windows` / `linux` (opt-in by name) | `yarn release windows` or `linux`, on that OS: runs `doctor`, then `yarn ota app --dry-run` and collects the installer, its `.sig` and (Linux) the `.deb` in `release/<version>-<build>/windows|linux/`. Prints the paths and the upload step; uploads nothing and leaves the store build numbers alone. A bare `yarn release` and `ship` stay the three store platforms. |
| `github [version]` | Tags `v<version>` and pushes it so CI publishes the Windows and Linux installers. Refuses unless `tauri.conf.json` and `package.json` say that version, you are on `main`, it is clean and equal to `origin/main`, and the tag is new. |
| `bump <patch\|minor\|major\|x.y.z>` | Edits `package.json`, `src-tauri/tauri.conf.json` (version and all three build numbers) and adds a `CHANGELOG.md` entry. No git. |
| `ship <patch\|minor\|major\|x.y.z> [platforms]` | The full release. Runs `doctor` first and stops before touching GitHub if the machine cannot finish. Then: a worktree `.worktrees/release-<version>` from `origin/main`, `bump`, commit, push, PR, waits for CI (`--no-wait` does an admin merge instead), squash merge, cleans up, pulls `main`, and builds from it with the number the PR recorded. Needs a clean `main` checkout and `gh auth login`. |

Build numbers: one above the largest of the iOS `bundleVersion`, macOS `bundleVersion`, Android `versionCode` and, when the `ASC_*` settings are present, the latest build App Store Connect holds. `bump` and `build` write it to all three fields. Google Play cannot be queried without a service account, so if Play answers "version code already used", run again with `--build N`. A plain `build` changes `tauri.conf.json`; commit that change (or use `ship`, which commits the number in the version PR).

`ship` stops when CI fails, and nothing merges. If GitHub Actions itself is down (jobs fail within seconds with no steps run and no log), check the PR yourself and use `ship ... --no-wait`.

### Windows and Linux releases (GitHub)

Windows and Linux are free: `Entitlement::from_build` forces Pro, so there is no paywall or purchase UI and nothing to sign for a store. Their installers are the only executables published on GitHub Releases:

- `OpenMedia_<version>_windows-x86_64.exe` (NSIS setup) and `OpenMedia_<version>_linux-x86_64.AppImage`, each with a `.sig`, plus `OpenMedia_<version>_linux-x86_64.deb` and `latest.json` (what the in-app updater reads; see [Updates](./updates.md)).
- Normal path: merge the version PR, then `yarn release github`. The tag push runs `.github/workflows/ota.yml`: one job per OS builds and uploads its installer, then `manifest` writes `latest.json` and marks the `v<version>` release latest with its notes. Needs the repository secrets `TAURI_SIGNING_PRIVATE_KEY` (and its password if any) and `OPENMEDIA_OTA_KEY`.
- By hand, on a Windows or Linux machine with `gh auth login`: `yarn release doctor windows` (or `linux`), then `yarn ota app`. `yarn build windows|linux [--production]` only builds (`--production` adds the updater artifacts and needs the signing key).
- `yarn ota app` refuses macOS and mobile on purpose. CI's `desktop-build` job runs `cargo check` on Windows and Linux for every PR so a compile break is caught early.

### Signing material

The release is signed with files that are never in the repo. They live in the **signing folder**, `~/Documents/openmedia-signing` unless `SIGNING_DIR` says otherwise:

| File | What it is |
|---|---|
| `ios_dist.p12` | iOS Distribution certificate and private key (exported from Keychain Access) |
| `mac_app.p12` | Mac App Distribution certificate and key (shows as "3rd Party Mac Developer Application: ...") |
| `mac_inst.p12` | Mac Installer Distribution certificate and key ("3rd Party Mac Developer Installer: ...") |
| `*.mobileprovision` | the iOS App Store profile for `surf.openmedia` |
| `*.provisionprofile` | the Mac App Store profile for `surf.openmedia` |

`yarn release` finds the identities in the login keychain and the newest unexpired App Store profile for `surf.openmedia` in that folder (and in Xcode's profile folders for iOS). If a certificate is missing from the keychain and `SIGNING_P12_PASSWORD` is set, it imports the `.p12` files itself. File names do not matter; the contents do. Only an explicit setting overrides discovery.

`.env` settings (all optional except the p12 password on a fresh Mac; `.env` is gitignored, `.env.example` lists them):

| Variable | Used for |
|---|---|
| `SIGNING_P12_PASSWORD` | the password the `.p12` files were exported with; needed to import them on a new Mac |
| `KEYCHAIN_PASSWORD` | the login password; lets `setup` allow codesign to use the keys without a keychain prompt. Without it, macOS asks once; choose Always Allow |
| `SIGNING_DIR` | signing folder, if not the default |
| `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_PATH` | App Store Connect API key: latest-build lookup and `--validate` |
| `APPLE_TEAM_ID`, `IOS_SIGN_IDENTITY`, `IOS_PROFILE`, `MAS_APP_IDENTITY`, `MAS_INSTALLER_IDENTITY`, `MAS_PROFILE` | override what was discovered |

Android signs with `src-tauri/gen/android/keystore.properties` (see [Android Google Play](#android-google-play)); it lives only in the main checkout, so build from there (`ship` does).

### New Mac, expired certificate, or missing file

| Symptom (from `yarn release doctor`) | Do this |
|---|---|
| Certificate missing on a new Mac | Copy the signing folder over, put `SIGNING_P12_PASSWORD` in `.env`, run `yarn release setup` |
| "MAC verification failed" on import | `SIGNING_P12_PASSWORD` is wrong for those files; correct `.env` or re-export the `.p12` |
| Profile missing or expired | Developer portal > Profiles: create or renew the App Store profile for `surf.openmedia` (iOS: App Store Connect; Mac: Mac App Store Connect), download it into the signing folder, rerun `doctor` |
| Certificate expired or lost its private key | Create a new one (Keychain Access > Certificate Assistant > Request a Certificate From a Certificate Authority, then Certificates > + in the developer portal: iOS Distribution, Mac App Distribution, Mac Installer Distribution), export each as `.p12` into the signing folder, then renew the profiles above |
| Play: "version code already used" | `yarn release android --build <higher number>` |

Without distribution certificates in the account, the certificates and profiles can be created through the App Store Connect API (a key with the Admin role).


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

## See also

[Development Guide](./development-guide.md) · [Platform Support](./platform-support.md) · [Paywall](./paywall.md)
