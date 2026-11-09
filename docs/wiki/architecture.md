# Architecture

> **Status: Partially implemented.** The React shell, Rust core, iOS and Android native site-view plugins, bundled recipes, BYOK assistant, and local usage controls exist. iOS has simulator verification; Android device/emulator behavior is unverified. Desktop site views, profile selection, and parts of the planned runtime remain unimplemented. See the component pages for exact boundaries.

## Overview

OpenMedia has three trust zones:

| Zone | What runs there | Trust |
|------|-----------------|-------|
| **Shell** | Our React UI in the Tauri main webview | Trusted. Has IPC to Rust. |
| **Core** | Rust (`src-tauri`): recipe store, validation, AI providers, secret store, site-view control | Trusted. Only place that sees API keys. |
| **Site view** | A separate native webview showing a third-party site, plus our injected engine | **Hostile.** Arbitrary remote code. No IPC except the bridge. |

```mermaid
flowchart LR
  subgraph Device
    Shell["Shell (React, main webview)"]
    Core["Core (Rust)"]
    Site["Site view (native webview)\n+ injected engine"]
    Keys[("OS secure store")]
    Files[("Recipes + settings\nJSON in app data")]
  end
  LLM["User-chosen LLM endpoint"]
  Web["Target website"]

  Shell <-->|"Tauri IPC"| Core
  Core -->|"inject recipes, request snapshot"| Site
  Site -->|"bridge: snapshot, match reports"| Core
  Site <-->|"HTTPS (the user's own session)"| Web
  Core --- Keys
  Core --- Files
  Core -->|"HTTPS, key read here only"| LLM
```

## Why a native webview, not an iframe or a proxy

- **iframe:** Instagram, YouTube, X and most targets send `X-Frame-Options` / `frame-ancestors`. They refuse to render in a frame.
- **Proxy/rewriting server:** would be a backend (rejected), and would route the user's credentials through it.
- **Native webview loading the real site directly:** the user logs in to the real origin, cookies stay in the webview's own store, and we inject our engine into the page. SocialLite's FAQ describes the same user-visible shape (the account opens inside its own app with a session cookie kept on device); that it is an injected webview is inferred, not stated by them (see [Prior Art](./prior-art.md)).

## Components

### SiteView (Rust API, native iOS/Android implementations)

The Rust API is shared; Swift on iOS and Kotlin on Android provide the native web views. Desktop currently returns `DesktopUnsupported`.

| Operation | Purpose |
|-----------|---------|
| `open(session, profile, url, rect?)` | Create a site view for a new session with the profile's isolated data store, below the transparent shell, and show it. Earlier sessions stay alive, hidden. Without a `rect` the view fills the screen under the top safe area until the shell reports one; this is how Core opens the start page before the shell has loaded ([Launch](#launch)) |
| `activate(session)` / `close(session)` | Show a live session without reloading it / tear one down. The shell decides which to close |
| `set_rect(rect)` / `set_interactive_regions(rects)` | The shell owns layout: where the page draws, and which regions of the screen belong to the shell rather than the page |
| `navigate`, `back`, `forward`, `reload` | Browser controls on the visible session |
| `set_recipes(bundle)` | Push the resolved recipe bundle for this site; engine re-applies live |
| `request_snapshot(opts)` | Ask the engine for a pruned, redacted DOM snapshot |
| `events` | Stream: navigation, title, load state, match reports, picker results |

- **Desktop** (macOS/Windows/Linux): site views are deferred; no child-webview implementation exists.
- **Mobile** (iOS/Android): the in-repository Tauri plugin hosts a native `WKWebView` / Android `WebView` and exposes the shared API. See [Platform Support](./platform-support.md).

### Recipe store (Rust)

Recipes are JSON files in the app data dir, one per recipe. Bundled recipes ship inside the binary. The store resolves "which recipes apply to this URL" and merges them into one bundle for the engine. See [Recipe Format](./recipe-format.md).

### AI service (Rust)

Rust has an Anthropic adapter and an OpenAI-compatible adapter (including Gemini, OpenRouter, OpenCode Zen, Ollama, LM Studio, and compatible endpoints). Requests run in Rust, so the key never enters a webview. See [AI Assistant](./ai-assistant.md).

### Secret store (Rust)

The in-repository `SecretStore` uses the iOS Keychain and Android Keystore-backed storage. Desktop credential stores are not implemented. See [Security](./security.md).

### Recipe page script (Rust-generated)

Rust compiles the implemented recipe subset (`hide` and `css`) into a self-contained document-start script in `src-tauri/src/recipes/compile.rs`. It matches the page URL and injects a stylesheet. This is not a standalone TypeScript engine; SPA observers and the richer runtime described in [Site Runtime](./site-runtime.md) remain design work.

### Shell (React)

One full-screen page with floating controls ([UI Design](./ui-design.md)): tap opens addresses or AI requests, hold opens favorites, Incognito, Usage, History and Settings. Current pages and history entries have favorite actions; Settings edits and reorders the list in collapsed disclosures. Incognito (`src/features/incognito`, `src-tauri/src/incognito.rs`) swaps in a second favorites set and a second set of recipe choices after a biometric check that only Rust can raise; the on/off state lives in Rust memory and is never saved. Daily per-site warnings and limits reuse foreground usage accounting (`src/features/stats`, `src-tauri/src/usage.rs`); native iOS shields enforce exhausted sessions without changing other sites. The shell owns session lifetime; native code opens, shows, closes and pins each session to its domain. AI requests run in Rust with redacted payload preview, validated proposals and explicit acceptance. Keys stay in the secure store.

## Core data flows

### Open a site and apply recipes

```mermaid
sequenceDiagram
  participant U as User
  participant S as Shell
  participant C as Core
  participant V as Site view
  U->>S: pick Instagram from the favorites fan
  S->>C: open(session, profile, url, rect)
  C->>C: resolve recipes matching URL
  C->>V: create view with isolated data store + engine + recipe bundle (init script)
  V->>V: engine applies CSS rules before first paint
  V-->>C: match report (rule -> count)
  C-->>S: events (loaded, rule health)
```

### Launch

The page does not wait for the shell. Core opens the start page (the last page, else the first favorite) from its own `setup`, in parallel with the shell's boot; the shell adopts it once it can listen for its events.

```mermaid
sequenceDiagram
  participant C as Core
  participant V as Site view
  participant S as Shell
  Note over C,S: launch screen (logo) is up
  C->>V: open(boot session, no rect) at setup
  V->>V: create view, start loading, mount when the window exists
  S->>S: HTML splash paints (same logo), JS boots
  S->>C: get_state (prefetched before React renders)
  C-->>S: state + boot session id
  S->>C: adopt_boot_session(id, rect) once its event listeners exist
  C->>V: set_rect, activate (re-announces state)
  V-->>S: state { painted: true } after the page's first contentful paint
  S->>S: splash fades into the page
```

If the start page could not be opened, `adopt_boot_session` opens the address as `open_site` would. Details and measurements: [Platform Support](./platform-support.md#startup).

### Ask the AI to customize

```mermaid
sequenceDiagram
  participant U as User
  participant S as Shell
  participant C as Core
  participant V as Site view
  participant L as LLM endpoint
  U->>S: "remove the reels tab and suggested posts"
  S->>C: ai_customize(request, view)
  C->>V: request_snapshot
  V-->>C: pruned snapshot
  C->>C: redact; show preview to user if enabled
  C->>L: prompt + schema + snapshot (key read here)
  L-->>C: structured rule patch
  C->>C: validate against recipe schema
  C->>V: apply as ephemeral preview
  V-->>C: match report
  alt a rule matched nothing
    C->>L: feedback, one repair round (max 2)
  end
  C-->>S: preview ready
  U->>S: accept
  S->>C: save recipe
```

## Persistence

| Data | Location | Notes |
|------|----------|-------|
| Favorites, settings, history and provider configuration | `<app_data>/library.json` | No API keys |
| Usage records and policies | `<app_data>/usage.json` | Local data |
| User recipe forks | `<app_data>/recipes/` | Bundled recipes are embedded from `recipes/bundled/` |
| API keys | OS secure storage | iOS Keychain; Android Keystore-backed plugin; never returned to the shell |
| Site cookies/storage | Native webview profile store | Android behavior is not device-verified |

There is no cross-device sync. Recipe export/import is not implemented yet.

## Current stack

| Layer | Implementation |
|-------|----------------|
| App framework | Tauri v2 |
| Shell | React 19, TypeScript, Vite, Tailwind CSS v4 |
| State | Zustand |
| Core | Rust; `serde`, `reqwest`, `thiserror`, `keyring`, `adblock` |
| Native site view and billing | In-repository Tauri plugins: Swift/iOS and Kotlin/Android |
| Tests | Vitest and Rust tests |
| Package manager | Yarn 1 |

The current dependencies are listed in `package.json` and `src-tauri/Cargo.toml`. The AI and recipe formats evolve with the implementation; this page does not describe planned crates or generated schema tooling as present.

## Repository layout

```text
src/
  app/                  React app state and composition
  features/             UI grouped by feature (AI, web, settings, stats, ...)
  shared/               Shared frontend state, IPC helpers, and components
  i18n/                 Localized UI messages
src-tauri/
  src/                  Rust app, commands, recipes, AI, storage, usage
  plugins/
    tauri-plugin-siteview/  Swift and Kotlin native site views
    tauri-plugin-billing/   Store billing adapters
  gen/                  Generated Apple and Android native projects
recipes/
  bundled/              JSON recipes embedded by Rust
blocklists/              Bundled EasyList and EasyPrivacy files
assets/store/            Store listing artwork and source captures
docs/wiki/               Source-controlled wiki, synced to GitHub Wiki
```

## See Also

[Recipe Format](./recipe-format.md) · [Site Runtime](./site-runtime.md) · [AI Assistant](./ai-assistant.md) · [Security](./security.md) · [Platform Support](./platform-support.md)
