# Security

> **Status: Implemented in part.** The mobile bridge and secret-store implementations exist, but only selected iOS behavior has simulator verification; Android runtime/security behavior remains unverified. This page states the security invariants as requirements; implementation claims and verification status are called out separately.

## Assets

| Asset | Why it matters |
|-------|----------------|
| LLM API key | Direct financial exposure for the user |
| Site sessions (cookies, storage) | Account takeover on Instagram/Google/etc. |
| Page content in the site view | Private messages, personal feeds |
| Recipes | Integrity: a malicious recipe could hide warnings, mislead, or redirect |
| App-shell IPC | A route from a website into native capabilities |

## Trust boundaries

```
 [Shell: trusted] <--IPC--> [Core: trusted] <--bridge (narrow)--> [Site view: HOSTILE]
                                  |
                            [Secure store]
```

The site view loads third-party code we do not control, and our injected engine shares its JS realm. Assume the page can read and call anything the engine can.

## Invariants

1. **Keys never leave Rust.** Not to the shell, not to a site view, not to logs.
2. **Site views have no general IPC.** No capability grants a site-view webview access to Tauri core, plugins, filesystem, shell, http, or store commands. The shell itself is not granted the plugin's `open`; pages are opened by Rust (`open_session`, reached through the app's `open_site` and `adopt_boot_session`, and by Core itself at launch), which attaches the recipe script and rule lists.
3. **The bridge is write-only and low-privilege.** The only thing a site view can invoke is "deliver this message to Core", where Core treats it as untrusted data and the message set cannot trigger actions (it can't open files, read keys, or call the LLM).
4. **AI output and imported recipes are untrusted** and validated before use ([Recipe Format](./recipe-format.md#validation-rust-before-anything-reaches-a-webview)).
5. **No `script` rule from AI.** Script rules need explicit per-recipe user confirmation, keyed by content hash.
6. **Profile isolation.** Each profile has its own cookie/storage store. The shell webview has none of their data.
7. **No backend, no telemetry.** The app has no server of ours to leak to; do not add one. The single third-party exception is RevenueCat, reached only from `tauri-plugin-billing` for purchases and restore, with an anonymous app-user ID and no page, URL, key or recipe data ([Paywall](./paywall.md#privacy-and-invariants)).
8. **Redact before send; preview by default.**

## The bridge

**Decided for mobile: option B.** On macOS no page script uses a bridge yet, so none exists; a desktop bridge (A or a native channel) stays open. The macOS site view relies on the ACL, not on a missing IPC object: see below. Candidates considered:

| Option | How | Concerns |
|--------|-----|----------|
| **A. Tauri remote-capability IPC** | A capability with `remote.urls` allowing a *single* custom command (`bridge_post`) to site-view webviews | Tauri does not inject IPC into remote URLs by default; this deliberately opens a narrow door. Any script on the page can call `bridge_post`. Mitigate: per-load nonce, per-webview-label capability, message schema validation, rate limiting, command can only enqueue data. Must verify behavior on mobile. |
| **B. Native message channel (mobile plugin)** | `WKScriptMessageHandler` (iOS) and `addWebMessageListener` with origin rules / `addJavascriptInterface` (Android), owned by our plugin | Strongest control; no Tauri IPC on the page at all. Android `addJavascriptInterface` exposes to all frames unless using `addWebMessageListener` with origin allowlist. |
| **C. Custom URI scheme / navigation interception** | Engine navigates or fetches a private scheme that Core intercepts | Page CSP (`connect-src`, `navigate-to`) can block it. Fragile. |

Direction: **B on mobile**, implemented in `tauri-plugin-siteview`. A native message handler (`WKScriptMessageHandler` on iOS, `addWebMessageListener` on Android) hands each message to a Rust-created `Channel`; Rust parses it with a 64 KiB cap and forwards it as the `siteview:bridge` event. The site webview is a separate native webview with no Tauri IPC. It also has a second, native-only handler, `openmediaPaint`, that a document-start script calls after the page's first frames; it carries no data and only makes the view visible, so a page that fakes it harms nothing. The no-IPC behavior is verified on the iOS simulator; Android behavior has not been verified on a device or emulator. For desktop, A is only acceptable if it can be scoped to one command with a nonce; otherwise desktop adopts a native channel too. Either way, invariant 3 holds.

Tauri has reportedly had an advisory where remote-origin iframes could reach IPC without being explicitly allowed (GHSA-57fm-592m-34r7) **[not verified; look it up before relying on this]**. Pin to a patched Tauri and treat IPC scoping as a regression-test target: an integration test must prove a site view **cannot** call a non-bridge command. Today that proof is the iOS simulator check above; an automated on-device test does not exist yet.

**macOS.** Tauri injects `window.__TAURI_INTERNALS__` into every webview, including the child webviews that show sites, so a page can see the IPC object. What stops it is the ACL: a site is a remote origin and the only capability (`src-tauri/capabilities/default.json`) lists the `main` webview, not the window, so a child webview is in no capability at all. On a debug build, page-side `invoke` of `get_state`, `plugin:siteview|reload` and `plugin:event|listen` was refused ("not allowed on window main, webview site-…"), and a raw `ipc://` request failed for lack of the invoke key. That was run by hand with a fixture page and is not an automated test. The Rust-only plugin methods (`set_blocked`, `evaluate`, `authenticate`) have no command and no permission on any platform.

## Key storage

- **iOS:** an in-repo `SecretStore` trait (`src-tauri/src/secrets.rs`) with a `KeychainStore` on the `keyring` crate (v3, `apple-native`) and an in-memory store for tests. Items use service `surf.openmedia` and account `ai-provider:<provider id>`.
- **Android:** the same Rust trait calls the siteview plugin's `AndroidSecretStore`; Kotlin uses Android Keystore-backed AES-GCM and stores ciphertext in app preferences. The code exists; runtime and backup behavior have not been device-verified.
- **How a key moves:** the shell sends it once to the `ai_set_key` command, which validates it and writes it straight to the store. No command returns it; the shell only learns `hasKey`. Provider settings (name, kind, base URL, model) are in `library.json`, which never contains a key (tested). Deleting a provider deletes its key.
- **Where it is read:** Rust reads the key for provider connection tests and AI requests; it is not sent back to the shell. Requests disable redirects, build no URL containing the key, and map failures to fixed messages that never include a header or body. Base URLs must be HTTPS, or HTTP to this device for local models, with no credentials, query or fragment.
- **Known gap:** the shell never receives a masked tail of the key. Showing a tail would mean reading the key for display, so the UI shows "Key saved" only. The request holds a zeroizing key in Rust for the duration of a call.
- Desktop (Keychain / Credential Manager / Secret Service) secret storage is not implemented. The third-party Tauri plugins for this (`tauri-plugin-keyring` and others) were not adopted; the in-repo trait keeps that choice open.
- Optional biometric gate to *reveal/replace* the key (not required for use). Not built.
- Backups: ensure the secure-store item is excluded from cloud backup where the platform allows.

## Recipes as an attack surface

Even without scripts, a recipe can mislead (hide a security warning, hide a "this is not the real site" banner, redirect within origin). Mitigations: schema validation; no cross-origin redirect; broad `match` patterns refused for AI/imported recipes; imported recipes get a rule-by-rule review; recipes apply only to URLs they `match`, and the address/origin indicator is in shell UI the site cannot touch.

Shared community recipes (Phase 5) are static files from a GitHub repo. Integrity: pinned commit hash or signed index, shown author, and review UI before first apply. No dynamic server.

## Ad blocking

Blocking uses WebKit content rule lists attached to the site view's `WKUserContentController` ([Ad Blocking](./ad-blocking.md)). It adds no path from a site to native code:

- The rules run inside WebKit, outside the page's JS realm; a page cannot read, list or remove them.
- The site view gets no new message, event or capability. The plugin commands that swap the lists (`set_content_rule_lists`) and the document-start script (`set_document_start_script`) are registered but absent from `siteview:default`, like `open` and `fetch-favicon`; only Rust calls them. The script is compiled in Rust from bundled recipes and the user's saved toggles; the shell can change a toggle (`set_site_option`, which validates the recipe and option ids) but never supplies script text. It takes an id and an absolute `.json` path produced by Rust, and the plugin re-validates both (`validate_rule_lists`).
- The filter lists are compiled into the binary and never downloaded, so invariant 1 (no new network destinations) holds. Lists change only with an app release.
- A blocking failure is shown to the user and the page still loads unblocked; it never silently pretends to block.

## Sessions and the popup browser

Each opened site is a session (a separate native web view) pinned to the registrable domain it was opened on, by the Public Suffix List (`bob.github.io` and `alice.github.io` are different sites). The plugin cancels a main-frame navigation outside that domain, and `target=_blank` / `window.open` to one, and shows the address in a system popup browser (`SFSafariViewController`) instead. This adds no path from a site to native code:

- The popup is a separate process. It shares no cookies, storage, recipe script or bridge with the profile's views. Only `http` and `https` addresses open (`DomainScope.verdict`); one popup at a time.
- The shell's `siteview:default` set gains `activate` and `close` (both take a UUID session id, validated in Rust). `open` stays ungranted; `open_site` and `adopt_boot_session` are the only shell-reachable ways to create a session, and both end in the same validated `open_session` (session id is a UUID, address is `http(s)`). At launch Core opens the start page itself (`boot.rs`), before the shell exists; `adopt_boot_session` only takes over that one session, by the id Core generated.
- The plugin sends the shell two new events: `siteview:closed` (a session id the native side dropped) and `siteview:memory` (the OS asked for memory). `siteview:state` now carries the session id, its domain and whether the page has painted (`painted`, set by native code when the page's own first-paint report arrives; a page that fakes it only makes itself visible). They flow native to shell only; a page cannot raise or read them.
- Pinning also limits what a hostile page can do with a session: it cannot navigate the profile's logged-in view to an unrelated site after load, only offer it in a throwaway popup. It is not a sandbox: until the first load finishes, redirects may change the domain, and subframes are not restricted.

History (the addresses the user typed) is stored in `library.json` on the device, like favorites, and holds no page content. "Clear history" removes it and the remembered last page.

Usage stats (seconds per site and first path segment, per local day, 30 days) and daily policies are stored locally in `usage.json`. Shell-only app commands `record_usage`, `get_usage`, `clear_usage`, `get_usage_policies` and `set_usage_policy` validate dates, hosts, sections, seconds and policy bounds (1–86400 seconds, warning below limit, at most 200 policies). Clearing stats preserves policy settings. No full address, query, title or page content is stored or sent.

The shell requests `set_usage_blocked` for a validated session UUID. It calls a Rust-only plugin method with no Tauri command, permission or capability of its own. iOS adds a native blur shield, stops loads, suspends media playback and refuses navigation/interaction; a website cannot remove the shield or lift its own block. Other sessions remain usable. Limits are user-editable self-management controls, not tamper-proof parental controls, and they do not suspend arbitrary page JavaScript.

Unread notifications: the plugin command `notify` (granted to the shell in `siteview:default`) posts a local iOS notification for a session id. It takes a UUID, a title of 1 to 40 and a body of 1 to 120 characters, with no control characters. The shell builds both from the user's own favorite name and a fixed translated phrase; nothing from the page is in them. The page contributes only its title, which the shell parses for a leading count: a hostile page can make a notification appear for its own session (at most once per 30 s), not choose its text or reach other sessions. The native side adds one event, `siteview:notification-tap` (a session id, validated as a UUID in Rust, native to shell only).

Incognito mode (a second favorites and recipe-choice set) is gated by a biometric check raised from Rust. The plugin's `authenticate` method (`LAContext.evaluatePolicy(.deviceOwnerAuthentication)`: Face ID or Touch ID, with the passcode as the system's own fallback) is Rust-only: it has no Tauri command, permission or capability, so neither the shell nor a site view can raise or answer the prompt. `biometryKind` is Rust-only the same way; the app command `biometry_kind` returns only `face` or `fingerprint` so the shell can draw the right icon, raises no prompt and reveals nothing else. The shell reaches it only through the app commands `unlock_incognito` (check only, for Settings) and `enter_incognito` (check, then switch); both pass a prompt sentence that Rust validates (1–120 characters, no control characters). `exit_incognito` needs no check. Whether incognito is on lives in Rust memory and is never persisted. The incognito data is stored unencrypted in `library.json` and is not part of `get_state`; the check is a UI-level lock against someone holding the phone, not a defense against a rooted device or a backup reader. Without a passcode or biometrics, or on desktop, the check fails closed and incognito cannot be entered. `NSFaceIDUsageDescription` is set in `Info.plist` and `project.yml`.

Custom/history favicons are fetched with an ephemeral, cookie-free native URLSession. Icon links and redirects must remain on the page's registrable domain; responses are capped at 400 KB, images at 4096 px per dimension and output at 96 px PNG. Bundled recipe icons are packaged assets, with no runtime icon-service requests.

## Privacy

- The snapshot is the only page-derived data that leaves the device, only on explicit user action, only to the endpoint the user configured. See [AI Assistant](./ai-assistant.md#privacy-what-is-sent).
- The app never reads site credentials. Users log in to the real site inside the view.
- App logs are local, scrubbed, and never include page content, URLs with query strings, or keys.

## Legal and store-policy risks (not code, but they shape scope)

| Risk | Notes | Posture |
|------|-------|---------|
| **Site Terms of Service** | Platforms may object to modified clients. We alter only the user's own rendering of their own session; we do not scrape, automate, or act for the user (invariant 7). | Customization only. Keep it that way. |
| **App Store review (iOS)** | Web-wrapper apps risk rejection for "minimum functionality". SocialLite ships on the App Store with the same core mechanism ([Prior Art](./prior-art.md)), which suggests it is approvable when the app adds real native functionality (profiles, recipes, AI editor, picker). | Make the native value obvious; confirm against current guidelines before submission. [INFERENCE] |
| **"Sign in with Google" in embedded webviews** | Google blocks OAuth in embedded browsers (`disallowed_useragent`). Sites that only offer Google sign-in may not be loggable-in. | Document as a known limitation; consider system-browser auth handoff for specific flows later. Do not spoof user agents by default. |
| **Anti-bot / fingerprint heuristics** | Unusual webviews may trigger challenges. | Use the platform webview unmodified; no stealth tricks. |
| **Play Store policy** | Generally permissive for webview apps; no Accessibility Service use planned. | Avoid the Accessibility route SocialLite uses on Android. |

## Reporting vulnerabilities

Add `SECURITY.md` with a private contact before first public release (Phase 6).

## See Also

[Architecture](./architecture.md) · [Site Runtime](./site-runtime.md) · [AI Assistant](./ai-assistant.md) · [Platform Support](./platform-support.md)
