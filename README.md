<p align="center">
  <img src="assets/logo.svg" alt="OpenMedia logo" height="220">
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

OpenMedia is an open-source mobile browser built with Tauri, Rust, React, and TypeScript. It loads websites directly in native web views and applies local, user-controlled recipes. No account, no analytics; the only OpenMedia-operated server is a small Worker that opens a GitHub pull request when you share a recipe, and purchases use RevenueCat.

## Features

- Favorites, history, themes, usage limits, and local notifications.
- Site recipes that ship inside the app (official ones from the maintainers, community ones merged from pull requests; see the [recipe library page](docs/wiki/recipe-library.md)) and EasyList/EasyPrivacy ad and tracker blocking.
- Optional AI recipe assistant using a provider and API key you choose.
- Separate site web views with isolated profile storage.

## Status

iOS is the verified platform. Android Kotlin site-view and billing code and an Android bundle build path exist, but Android device/emulator behavior and a signed Play release are not verified. macOS has site views (a child webview beside the shell, with trackpad gestures and shortcuts, run by hand on one Mac in debug builds); Windows and Linux do not. See [platform support](docs/wiki/platform-support.md).

## Build and contribute

Store builds, signing, and prerequisites are in the [store build guide](docs/wiki/store-builds.md); all development commands are in the [development guide](docs/wiki/development-guide.md).

Read [CONTRIBUTING.md](CONTRIBUTING.md) and the [wiki](docs/wiki/index.md) before changing code. CI checks the frontend and Rust code and builds the Android app.

## License

[MPL-2.0](LICENSE).
