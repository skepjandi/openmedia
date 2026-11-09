<p align="center">
  <img src="assets/logo.svg" alt="OpenMedia logo" height="120">
</p>

<h1 align="center">OpenMedia</h1>

<p align="center">
  Browse the real web, minus the parts you did not ask for.<br>
  Customize sites with recipes, ad blocking, and your own AI provider.
</p>

<p align="center">
  <a href="https://github.com/skepjandi/openmedia/actions/workflows/ci.yml"><img src="https://github.com/skepjandi/openmedia/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/iOS-17%2B-lightgrey.svg" alt="iOS 17+">
  <img src="https://img.shields.io/badge/Tauri-v2-24C8DB.svg" alt="Tauri v2">
</p>

OpenMedia is an open-source mobile browser built with Tauri, Rust, React, and TypeScript. It loads websites directly in native web views and applies local, user-controlled recipes. No account or OpenMedia-operated backend; purchases use RevenueCat.

## Features

- Favorites, history, themes, usage limits, and local notifications.
- Bundled recipes and EasyList/EasyPrivacy ad and tracker blocking.
- Optional AI recipe assistant using a provider and API key you choose.
- Separate site web views with isolated profile storage.

## Status

iOS is the verified platform. Android Kotlin site-view and billing code and an Android bundle build path exist, but Android device/emulator behavior and a signed Play release are not verified. macOS has site views (a child webview beside the shell, with trackpad gestures and shortcuts, run by hand on one Mac in debug builds); Windows and Linux do not. See [platform support](docs/wiki/platform-support.md).

## Build and contribute

Install Node.js 22+, Yarn 1.x, Rust, and the platform toolchain, then:

```bash
yarn install
yarn dev:ios        # iOS simulator or device (set APPLE_DEVELOPMENT_TEAM for a device)
yarn dev:android    # Android emulator or device
yarn build macos    # OpenMedia.app (macOS 14 or later; Windows and Linux have no site views yet)
yarn verify         # the full local check: web and Rust (CI runs only lint, format and tests)
```

Store builds, signing, and prerequisites are in the [store build guide](docs/wiki/store-builds.md); all development commands are in the [development guide](docs/wiki/development-guide.md).

Read [CONTRIBUTING.md](CONTRIBUTING.md) and the [wiki](docs/wiki/index.md) before changing code. CI checks the frontend and Rust code and builds the Android app.

## License

[MPL-2.0](LICENSE).
