# Development Guide

> **Status: Implemented, with platform verification limits.** The iOS app and checks are verified on simulators. Android has Kotlin site-view and billing implementations and an AAB build path, but device/emulator behavior and signed store builds are unverified. macOS site views exist (debug builds, run by hand on one Mac); Windows and Linux site views are not implemented.

## Prerequisites

| Tool | Needed for |
|------|------------|
| Rust (stable, 1.90 or newer) + `cargo`, plus the `aarch64-apple-ios-sim` and `aarch64-apple-ios` targets | Core, iOS |
| Node 22 or newer + yarn 1.x | Shell, tooling (CI uses 22; also ran on 26) |
| Xcode (+ command line tools), CocoaPods, XcodeGen | iOS builds, iOS plugin (Swift) |
| Android Studio + Android SDK/NDK, JDK | Android builds (device behavior not yet verified) |
| WebView2 runtime / WebKitGTK dev packages | Windows / Linux builds (site views deferred) |

## Commands

```bash
yarn install
APPLE_DEVELOPMENT_TEAM=<team id> yarn dev:ios "iPhone 17 Pro Max"   # iOS simulator
yarn dev:android                                                      # Android emulator or device

yarn verify        # the full local check, web and Rust. CI runs lint; pre-commit runs format:check and test
yarn check:web     # ts:check, lint, format:check, test
yarn check:rust    # cargo fmt --all --check, clippy --workspace -D warnings, cargo test --workspace
yarn test:swift    # iOS plugin's domain-pinning rules (needs only swiftc)
yarn test:android # Android plugin's domain-pinning rules (JUnit; needs a prior `yarn build android`)
cargo deny --manifest-path src-tauri/Cargo.toml check   # licenses, advisories, sources
```

The Rust app and both plugins form one Cargo workspace rooted at `src-tauri/`, so `--workspace` covers all three crates and they share `src-tauri/Cargo.lock`.

Local builds:

```bash
yarn build                       # web bundle only
yarn build macos                 # src-tauri/target/release/bundle/macos/OpenMedia.app
yarn build android               # debug-signed arm64 APK, installable on a device
APPLE_DEVELOPMENT_TEAM=<team id> yarn build ios   # development-signed iOS build
```

Release builds (`--production`) are described in [Store Builds](./store-builds.md). `yarn release` is the release CLI: `yarn release doctor` checks the machine, `yarn release ship patch` does the version PR, merge and all three store builds; see [Releasing: `yarn release`](./store-builds.md#releasing-yarn-release).

To measure startup or install a simulator build:

```bash
APPLE_DEVELOPMENT_TEAM=<team id> yarn tauri ios build -t aarch64-sim --archive-only --ci
xcrun simctl install <device> src-tauri/gen/apple/build/openmedia_iOS.xcarchive/Products/Applications/OpenMedia.app
```

Point `lastUrl` in the app's `library.json` at a local fixture server and record the launch with `xcrun simctl io <device> recordVideo`; results are in [Platform Support](./platform-support.md#startup). The simulator archive is not an App Store release. See [Store Builds](./store-builds.md) for signed releases.

Android commands are available with `yarn tauri android dev` and `yarn tauri android build --aab --ci`; see [Platform Support](./platform-support.md#the-android-site-view) for the limited build evidence. `yarn dev:desktop` runs the macOS app with site views (macOS 14 or later); Windows and Linux have none yet.

## Conventions

- Work in a worktree under `.worktrees/` (see `AGENTS.md`).
- Conventional-commit prefixes: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, with scope = area (`engine`, `ai`, `recipes`, `shell`, `siteview`, `secrets`, `ios`, `android`).
- The recipe schema and validation live in Rust under `src-tauri/src/recipes/`; the current repository has no `yarn gen:schema` script.
- Changes to a recipe in `recipes/official/` require fixture updates in `recipes/fixtures/<site>/`; `cargo test` validates them and runs the fixtures, and the recipes are embedded in the app by `build.rs`, so a merged change ships with the next release. A new community recipe arrives as a pull request ([Recipe Library and Sharing](./recipe-library.md)); `.github/workflows/recipes.yml` validates it.
- Fixtures are scrubbed of personal data before commit; raw captures go in the gitignored `captures/`.
- Bundled filter lists in `blocklists/` are refreshed only with `scripts/update-blocklists.sh` and shipped with a release; the app never downloads them. Run `cargo test ad_block` after a refresh ([Ad Blocking](./ad-blocking.md#updating-the-lists)).
- The Public Suffix List (which hosts belong to one site) lives once, in `shared/public-suffix/resources/public_suffix_rules.txt`, with the official test vectors and `app-vectors.json` beside it. Refresh it with `yarn suffix:update` (it also regenerates the iOS plugin's `PublicSuffixRules.swift`; `yarn suffix:check` fails when that file is stale). Then run `yarn verify`, `yarn test:swift` and `yarn test:android`: all four matchers (`tauri-plugin-siteview/src/site.rs`, `site.ts`, `PublicSuffix.kt`, `PublicSuffix.swift`) must pass the same vectors. Add a case to `app-vectors.json`, never to a single platform's tests.

## Troubleshooting

- **Blank black app, no console errors.** Check for a Tauri command that is not `async` yet calls the plugin: it deadlocks the main thread. `sample <pid> 2` on the `OpenMedia` process shows the main thread inside the command. Fix by making the command `async`.
- **Port 1420 stuck.** A leftover Vite dev server from an earlier `tauri ios dev` makes the next run fail with "Port 1420 is already in use". Kill it (`lsof -ti :1420 | xargs kill`) and retry.
- **"outside of Vite serving allow list" in a worktree.** `node_modules` is a symlink to the main checkout, so Vite refuses to serve the fonts from it and the shell renders unstyled. Add the main checkout to `server.fs.allow` locally; do not commit that.
- **Two `tauri ios dev` sessions, one simulator.** Both install `surf.openmedia` and the later one overwrites the earlier build. Use a separate simulator device per session.
- **Plain `http://` sites on iOS.** An `http://127.0.0.1:<port>` fixture loaded in the release simulator build (iOS 26.5) with no exception, because App Transport Security does not apply to IP-literal hosts. Other plain `http://` hosts are expected to be blocked [INFERENCE: not observed]; for those, add a temporary `NSAllowsLocalNetworking` exception to `src-tauri/gen/apple/openmedia_iOS/Info.plist` and remove it afterwards.
