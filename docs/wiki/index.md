<p align="center">
  <img src="https://raw.githubusercontent.com/skepjandi/openmedia/main/assets/logo.svg" alt="OpenMedia logo" height="96">
</p>

# OpenMedia Wiki

> Project knowledge base for contributors and AI agents. All pages are automatically synced to the [GitHub Wiki](https://github.com/skepjandi/openmedia/wiki) on every merge to `main`.

**Project status: implemented, with platform verification limits.** iOS is the verified platform; Android implementation and build support exist but are not device-verified. Desktop site views remain deferred. The wiki describes current behavior and labels unverified work.

OpenMedia is a Tauri v2 app for browsing websites in native web views and customizing them with user-controlled recipes. It includes ad blocking, an optional AI assistant, and a built-in recipe library (official and community recipes ship inside the app; new ones arrive as GitHub pull requests). No analytics or telemetry; the only OpenMedia-operated server is a small Worker that opens a GitHub pull request when a user shares a recipe; purchases use RevenueCat.

## Pages

| Page | Description |
|------|-------------|
| [Architecture](./architecture.md) | Current components, data flow, stack, and repository layout |
| [Recipe Format](./recipe-format.md) | The declarative customization format: targets, rules, matching, versioning, trust levels |
| [Site Runtime](./site-runtime.md) | Runtime design: injection, SPA navigation, picker, snapshots, and reporting |
| [AI Assistant](./ai-assistant.md) | BYOK providers, snapshot redaction, structured generation, repair loop |
| [Security](./security.md) | Threat model, invariants, IPC boundary, key storage, legal and store-policy risks |
| [Paywall](./paywall.md) | Pro entitlement via RevenueCat: what is paid, plans, Rust-side gate, no-login restore, store setup |
| [Platform Support](./platform-support.md) | iOS and Android implementation status, desktop support, and verification limits |
| [UI Design](./ui-design.md) | The floating-button interface: tone, tokens, gestures, layering, what is and is not connected |
| [Site Playbooks](./site-playbooks.md) | Per-site options for the official recipes, what every selector matched and how it was checked, what CSS cannot do, and the selector-writing rules for the in-app assistant |
| [Internationalization](./i18n.md) | 29 UI languages, message catalog, plurals, right-to-left, adding a language |
| [Ad Blocking](./ad-blocking.md) | Bundled EasyList and EasyPrivacy as WebKit content rule lists: engine choice, caching, limits |
| [Prior Art](./prior-art.md) | SocialLite and others: what they do, what we copy, where we differ |
| [Roadmap](./roadmap.md) | Phased build plan with exit criteria, spikes, decision log, risks |
| [Recipe Library and Sharing](./recipe-library.md) | The bundled recipes, adding and updating them, and sharing a recipe as a GitHub pull request through the Worker: flow, limits, privacy, threat model |
| [Script Policy](./script-policy.md) | The `script` rule contract: the three trust tiers, the default-deny subset of JavaScript that bundled community recipes and imports may run, finding codes, conformance vectors |
| [Development Guide](./development-guide.md) | Toolchain, commands, and conventions |
| [Updates (OTA)](./updates.md) | Over-the-air updates: signed web bundles for every platform and desktop self-update, published by `yarn ota` or GitHub Actions |
| [Store Builds](./store-builds.md) | iOS App Store and Android Google Play build, signing, and release steps |

## Quick Start

Install the prerequisites in the [Development Guide](./development-guide.md), then run `yarn install`. For mobile release builds and signing, see [Store Builds](./store-builds.md).

## AI Agent Note

If you are an AI agent modifying this repository, read [Architecture](./architecture.md) and [Security](./security.md) before making significant changes, and find the current phase in the [Roadmap](./roadmap.md). See `AGENTS.md` for the wiki-first rule and the architecture invariants.

## Documentation Philosophy

- **For contributors:** `docs/wiki/` is the source of truth; `CHANGELOG.md` records individual changes.
- **For AI agents:** names, paths, and schema fields are precise. Intent is labelled as intent.
- **Wiki sync:** edit `docs/wiki/*.md` and open a PR. `.github/workflows/sync-wiki.yml` mirrors changes to the GitHub Wiki.

## See Also

- [GitHub Wiki](https://github.com/skepjandi/openmedia/wiki)
- [CHANGELOG.md](../../CHANGELOG.md)
- [AGENTS.md](../../AGENTS.md)
