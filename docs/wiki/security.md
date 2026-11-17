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
| Share Worker session (recipe, hashed tokens, result) | Held for at most 15 minutes while a GitHub login completes; never a GitHub token, never a purchase identifier |
| Share Worker remember token (SHA-256, GitHub login and id) / app-side token | Worker: 90 days or until *Sign out*; app: OS secure store, read only in Rust, never sent to the shell (the shell sees the login name only). Lets a returning user share without a browser sign-in |

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
4. **AI output and bundled recipes are untrusted** and validated before use ([Recipe Format](./recipe-format.md#validation-rust-before-anything-reaches-a-webview)).
5. **Scripts are tiered by who wrote them.** The assistant may write any script for the user's own recipe, but the user sees the code and the powers it uses first and nothing runs before they accept. A script that comes from outside (a bundled community recipe) runs only if it passes the [Script Policy](./script-policy.md), which Rust enforces on every `imported` recipe before it is saved or compiled; the share Worker and CI check it again before a pull request is opened or merged.
6. **Profile isolation.** Each profile has its own cookie/storage store. The shell webview has none of their data.
7. **No telemetry; one small server.** The only server of ours is the share Worker ([Recipe Library and Sharing](./recipe-library.md)). It is reached only when the user taps *Share on GitHub*, only from Rust, and it is treated as untrusted by the app: the app sends it one recipe the user chose and gets back a session id, a poll token and a pull-request address it validates strictly. The Worker uses the user's GitHub login only to say who submitted the pull request and creates it with its own GitHub App token, so it never holds a user write token. Recipes are never downloaded at runtime; they ship inside the app. No purchase identifier, device token or AI key ever reaches it.
8. **Redact before send; preview by default.**

## The bridge

**Decided for mobile: option B.** On macOS no page script uses a bridge yet, so none exists; a desktop bridge (A or a native channel) stays open. The macOS site view relies on the ACL, not on a missing IPC object: see below. Candidates considered:

| Option | How | Concerns |
|--------|-----|----------|
| **A. Tauri remote-capability IPC** | A capability with `remote.urls` allowing a *single* custom command (`bridge_post`) to site-view webviews | Tauri does not inject IPC into remote URLs by default; this deliberately opens a narrow door. Any script on the page can call `bridge_post`. Mitigate: per-load nonce, per-webview-label capability, message schema validation, rate limiting, command can only enqueue data. Must verify behavior on mobile. |
| **B. Native message channel (mobile plugin)** | `WKScriptMessageHandler` (iOS) and `addWebMessageListener` with origin rules / `addJavascriptInterface` (Android), owned by our plugin | Strongest control; no Tauri IPC on the page at all. Android `addJavascriptInterface` exposes to all frames unless using `addWebMessageListener` with origin allowlist. |
| **C. Custom URI scheme / navigation interception** | Engine navigates or fetches a private scheme that Core intercepts | Page CSP (`connect-src`, `navigate-to`) can block it. Fragile. |

Direction: **B on mobile**, implemented in `tauri-plugin-siteview`. A native message handler (`WKScriptMessageHandler` on iOS, `addWebMessageListener` on Android) hands each message to a Rust-created `Channel`; Rust parses it with a 64 KiB cap and forwards it as the `siteview:bridge` event. The site webview is a separate native webview with no Tauri IPC. It also has a second, native-only handler, `openmediaPaint`, that a document-start script calls after the page's first frames; it carries no data and only makes the view visible, so a page that fakes it harms nothing. A third, `openmediaPlay` (iOS), carries no data either: the page asks for the video in view to be played, and the plugin runs a fixed script for the page in front that calls the feed player's own play function. It can do only what a tap on that page could, and a page that fakes it can start its own video, which it could do after any tap. The no-IPC behavior is verified on the iOS simulator; Android behavior has not been verified on a device or emulator. For desktop, A is only acceptable if it can be scoped to one command with a nonce; otherwise desktop adopts a native channel too. Either way, invariant 3 holds.

A fourth, `openmediaVolume` (iOS: a `WKScriptMessageHandlerWithReply`; Android: a web message listener with a reply port), lets the page's own volume control in the panel read and set the device's media volume, because a page cannot set a video's volume on iOS and a site's player resets it elsewhere. Its whole vocabulary is `get` and `set:<0 to 1>` as text; the plugin clamps the number, touches nothing but the media volume (an `MPVolumeView` slider, `AudioManager` `STREAM_MUSIC`) and answers with the volume. It is open to every frame of a site, so a hostile page can move the phone's volume, as the page's own `video.volume` or the hardware keys could; it can read nothing but that number. Desktop has no such handler and uses the video's own volume.

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

**Scripts.** A `script` rule runs in the page's own JavaScript realm, like any userscript: it can do whatever the page can, including read what the page can read. Two things follow. For the user's own recipes the user is the authority, and the proposal shows the code and the powers it uses (network, storage, navigation, dynamic code, automation) in plain words before anything runs. For anything that comes from outside, safety rests on the [Script Policy](./script-policy.md): a default-deny static subset in which no script can send data anywhere, so there is nothing to steal even from a logged-in session. The policy is a source-text check, not a sandbox: it does not stop a script from wasting CPU or from misleading the user, which human review of the pull request is for ([Recipe Library and Sharing](./recipe-library.md#threat-model)). The scanner exists twice (Rust on the device, TypeScript in the Worker) and both run `shared/script-policy/vectors.json`.

Even with scripts held to the policy, a recipe can mislead (hide a security warning, hide a "this is not the real site" banner, redirect within origin). Mitigations: schema validation; no cross-origin redirect; broad `match` patterns refused for AI/imported recipes; imported recipes get a rule-by-rule review; recipes apply only to URLs they `match`, and the address/origin indicator is in shell UI the site cannot touch.

Shared recipes are untrusted until validated on the device. **Bundled recipes** (official and community) are compiled into the app from `recipes/official` and `recipes/community`, parsed as `imported` (so scripts in them pass the [Script Policy](./script-policy.md)), shown rule by rule before they are added, and reach the app only through a reviewed pull request and a release; see [Recipe Library and Sharing](./recipe-library.md#threat-model).

**Commands and the network.** The app commands (`library_*`, `share_*`, `ai_hub_*`) are shell-only: a site view is a remote origin and the capability names only the `main` webview, as for every other app command. The hub builder accepts only the user's request and proposal id; Rust calls the configured provider and reads only the bundled recipes through bounded, read-only tools. No shell command accepts a provider key, a URL, a token or a GitHub address: the share address is a compile-time constant (`OPENMEDIA_SHARE_URL`), the poll token stays in Rust memory, and the pull-request address the Worker returns is accepted only in the `https://github.com/<owner>/<repo>/pull/<n>` shape and opened only from Rust.

**Updates.** `ota_status`, `ota_confirm`, `ota_check`, `app_update_check` and `app_update_install` are shell-only app commands like the rest; none takes a URL or a key. The web bundle is accepted only with a valid Ed25519 signature from the key compiled into the app, built for the app's own version, and is served in place of the embedded shell, so the signing key is as sensitive as the app's store signing: whoever holds it can change what the shell does. The desktop updater's Minisign key is the same kind of secret, and the plugin's own JS commands have no capability. Both fetch from GitHub releases over HTTPS and send nothing about the user ([Updates](./updates.md)).

### Prune rules

A `prune` rule ([Recipe Format](./recipe-format.md#the-prune-rule)) may be in any recipe, including bundled and shared ones, though a `script` that wraps `fetch` may not ([Script Policy](./script-policy.md)). Why that is consistent with the invariants:

- **Invariant 7 (customize, never automate).** The rule changes only what the page reads from responses to requests the page itself makes: the same effect a `hide` rule has on what the user sees, applied earlier. It starts no request, does not change a request (URL, method, headers, body, credentials), does not read a request body, clicks nothing and navigates nowhere. The page's own code decides what to ask for; it merely gets fewer items back.
- **Invariants 1 and 3 (no egress, hostile site).** The runtime has no way to send data: it holds no network call of its own (it calls only the page's original `fetch`, with the page's own arguments, which the page would have made anyway), no bridge handle, and no storage access. The rule is data in a closed grammar (paths on the page's own origin, keys, `[*]`, `[n]`, one `key == scalar` condition), validated in Rust (`recipes/prune.rs`) and in the Worker, with caps (8 rules, 8 urls and 8 removals each, 120-character paths, no control or direction-override characters). The site's code can see that `fetch` is wrapped, as with any content blocker; that tells it nothing it could not learn from its own responses.
- **Same origin only.** `urls` are paths, so a host cannot be written; the runtime also compares the origin of the request and of the final response with the page's. A cross-origin response is never read or changed.
- **Fail open.** Any parse failure, shape mismatch, size over 2 MiB or unexpected exception returns the original response; five unexpected exceptions switch the runtime off.
- **What it can still do wrong.** A recipe can remove items the user needs (an unread message, a security notice), as a `hide` rule can; rule-by-rule review shows the paths and conditions before a shared recipe is saved, and a rule belongs to an option the user can switch off.



## Ad blocking

Blocking combines WebKit content rule lists (network/CSS rules) with URL-matched filter-list
scriptlets at document start where the native webview supports them ([Ad Blocking](./ad-blocking.md)).
It adds no path from a site to native code:

- Native content rules run outside the page's JS realm; a page cannot read, list or remove them.
- Scriptlets intentionally run in the page's JS realm and are visible to page code. They are derived
  from bundled filter data, restricted to the main frame and guarded by the starting origin. They
  are not a sandbox or a guarantee against a hostile site overriding them.
- The link cleaner (`openmedia-link-cleaner.js`) runs the same way, in the main frame on every
  page. It only rewrites the `href` of a link the user is following, using bundled data, and has
  no way to navigate, click, request or reach native code. A hostile page can read the cleaned
  link, which it could read anyway.
- The site view gets no new message, event or capability. The plugin commands that swap content
  rules (`set_content_rule_lists`) and recipe scripts (`set_document_start_script`) are registered
  but absent from `siteview:default`; only Rust calls them. The shell never supplies adblock script
  text. Filter-list data and scriptlet resources are bundled and never downloaded at runtime.
- A blocking failure is reported through the existing site-view error path; browsing remains
  available.

## Sessions and the popup browser

Each opened site is a session (a separate native web view) scoped to its current registrable domain, determined by the Public Suffix List (`bob.github.io` and `alice.github.io` are different sites). A user-activated top-level HTTP(S) link stays in that embedded view; the session follows redirects and adopts the destination domain once the load settles. Back/forward history also remains in the embedded view. Automatic cross-domain navigation is cancelled in the session's view and opened in an in-app window that shares the session's profile (a sign-in redirect needs the cookies it sets); a system popup browser is only the fallback. This adds no path from a site to native code:

- The popup is a separate process. It shares no cookies, storage, recipe script or bridge with the profile's views. Only `http` and `https` addresses open (`DomainScope.verdict`); one popup at a time.
- A window the page opens with `window.open` is **not** that popup: it is a sign-in window, and it opens inside the app. Google and Apple sign-in run in one, and a system browser shares no cookies with the profile, so a sign-in that ran there could never hand its token back to the page that opened it. The sign-in window is a native web view above the page, in the session's own profile, and it keeps the opener's link: `window.opener` on iOS and macOS, and on Android a bridge that carries the message to the opening page, because Android's WebView gives a window no opener. It is the one place where a third-party page runs inside the app with the profile's storage, and it is held to the same rules as any other page view:
  - No Tauri IPC. It reaches the app only through the write-only bridge, and on Android only through the `openmediaOpener` channel, which carries a message to the page that opened the window and nothing else.
  - It shares the profile's data store, so the cookies the sign-in sets are the profile's cookies. Storage stays per origin, as in any browser: the window cannot read another origin's cookies.
  - Only `http`, `https` and `about:` load in it. It follows its own redirects, because the identity provider and the site it returns to are different domains.
  - It closes when the page closes it, when Back is pressed, when its session closes and when another session is shown.
- The shell's `siteview:default` set gains `activate` and `close` (both take a UUID session id, validated in Rust). `open` stays ungranted; `open_site` and `adopt_boot_session` are the only shell-reachable ways to create a session, and both end in the same validated `open_session` (session id is a UUID, address is `http(s)`). At launch Core opens the start page itself (`boot.rs`), before the shell exists; `adopt_boot_session` only takes over that one session, by the id Core generated.
- The plugin sends the shell two new events: `siteview:closed` (a session id the native side dropped) and `siteview:memory` (the OS asked for memory). `siteview:state` now carries the session id, its domain and whether the page has painted (`painted`, set by native code when the page's own first-paint report arrives; a page that fakes it only makes itself visible). They flow native to shell only; a page cannot raise or read them.
- A hostile page cannot silently navigate a settled session to an arbitrary new off-domain URL; an explicit user-activated link can, and browser history can revisit an earlier domain. The redirect chain may change the session's scope until the load settles. This is not a sandbox; subframes are not restricted.

History (the addresses the user typed) is stored in `library.json` on the device, like favorites, and holds no page content. "Clear history" removes it and the remembered last page.

Usage stats (seconds per site and first path segment, per local day, 30 days) and daily policies are stored locally in `usage.json`. Shell-only app commands `record_usage`, `get_usage`, `clear_usage`, `get_usage_limits`, `set_usage_limit` and `set_usage_section_limit` validate dates, hosts, sections, seconds and policy bounds (1–86400 seconds, warning below limit, at most 200 policies per host and 60 parts per host). A policy may be set for a whole site or for one part of it (a first path segment), and both are stored under the host they belong to. Clearing stats preserves policy settings. No full address, query, title or page content is stored or sent. The same file holds per-site downtime schedules (`set_usage_schedule`), pause-screen delays (`set_usage_pause`, `set_usage_pause_enabled`) and the settings lock (`get_usage_lock`, `enable_usage_lock`, `request_usage_unlock`, `cancel_usage_unlock`, `lift_usage_lock`, `protect_usage_option`, `unprotect_usage_option`). All of them are shell-only app commands: none is in a capability, none is reachable from a site view, and all need Pro. The settings lock is enforced in Rust, not by the shell: `Usage` refuses any change that relaxes a limit, schedule, pause or protected recipe option while the lock is on (`set_site_option` and accepting an assistant change run the check before they save), and the 24 hour cooling-off start is a Unix timestamp in `usage.json` read from Rust's clock. The request and cancel commands raise the same Rust-only `authenticate` prompt as incognito and return nothing when it is declined. Schedules carry only weekdays and minutes of the local day; Rust never sees a time zone, the shell passes the local date and reads its own clock. The lock is a commitment device for the device owner, not a boundary against them: reinstalling or clearing app data removes it. Legacy files without these fields load with schedules, pauses and lock empty (pause screens default on; a site has none until a delay is set). `schedules`, `pauses`, `pauseEnabled` and `lock` do not change the recipe format.

Assistant chats (the user's own requests, the steps of each request and its outcome) are stored
locally in `chats.json`. The shell-only app commands `chat_list`, `chat_save`, `chat_delete` and
`chat_clear` validate the site (a registrable domain), the recipe id and the turn shapes, and cut
every string to a fixed length; unknown fields are refused. A chat never holds the page snapshot,
the exact payload or the provider's answer. Nothing in it leaves the device, and nothing is
written while incognito is on.

The shell requests `set_usage_blocked` for a validated session UUID. It calls a Rust-only plugin method with no Tauri command, permission or capability of its own. iOS adds a native blur shield, stops loads, suspends media playback and refuses navigation/interaction; a website cannot remove the shield or lift its own block. Other sessions remain usable. Limits are user-editable self-management controls, not tamper-proof parental controls, and they do not suspend arbitrary page JavaScript.

`set_site_background_media` (shell-only app command) saves which sites may keep playing media while hidden and passes the list to a second Rust-only plugin method, `set_background_media`, again with no Tauri command, permission or capability. The native side pauses and resumes the media of its own sessions with a fixed script; no page can call either, and the page learns nothing from the list. The list is kept in `library.json` as registrable domains only. Incognito favorites do not offer the setting, so an incognito site is never written there.

`set_site_picture_in_picture` (shell-only app command) saves which sites may use picture-in-picture and passes the list to a Rust-only plugin method, `set_picture_in_picture`, with no Tauri command, permission or capability. The native side injects a fixed script that carries the list as data, in its own `WKContentWorld` that shares the page's DOM and nothing else: a page cannot read the list (which would show it which other sites the user favorited) or call into the script, and the script only sets or clears a `disablepictureinpicture` attribute the page already controls. Floating a video on leaving the app is a fixed native script that takes no input from the page. Incognito favorites do not offer the setting, so an incognito site is never written there.

Unread notifications: the plugin command `notify` (granted to the shell in `siteview:default`) posts a local iOS notification for a session id. It takes a UUID, a title of 1 to 40 and a body of 1 to 120 characters, with no control characters. The shell builds both from the user's own favorite name and a fixed translated phrase; nothing from the page is in them. The page contributes only its title, which the shell parses for a leading count: a hostile page can make a notification appear for its own session (at most once per 30 s), not choose its text or reach other sessions. The native side adds one event, `siteview:notification-tap` (a session id, validated as a UUID in Rust, native to shell only).

Incognito mode (a second favorites and recipe-choice set) is gated by a biometric check raised from Rust. The plugin's `authenticate` method (`LAContext.evaluatePolicy(.deviceOwnerAuthentication)`: Face ID or Touch ID, with the passcode as the system's own fallback) is Rust-only: it has no Tauri command, permission or capability, so neither the shell nor a site view can raise or answer the prompt. `biometryKind` is Rust-only the same way; the app command `biometry_kind` returns only `face` or `fingerprint` so the shell can draw the right icon, raises no prompt and reveals nothing else. The shell reaches it only through the app commands `unlock_incognito` (check only, for Settings) and `enter_incognito` (check, then switch); both pass a prompt sentence that Rust validates (1–120 characters, no control characters). `exit_incognito` needs no check. Whether incognito is on lives in Rust memory and is never persisted. The incognito data is stored unencrypted in `library.json` and is not part of `get_state`; the check is a UI-level lock against someone holding the phone, not a defense against a rooted device or a backup reader. Without a passcode or biometrics, or on desktop, the check fails closed and incognito cannot be entered. `NSFaceIDUsageDescription` is set in `Info.plist` and `project.yml`.

Custom/history favicons are fetched with an ephemeral, cookie-free native URLSession. Icon links and redirects must remain on the page's registrable domain; responses are capped at 400 KB, images at 4096 px per dimension and output at 96 px PNG. Site icons for the official recipes are packaged assets, with no runtime icon-service requests.

## Privacy

- The snapshot is the only page-derived data that leaves the device, only on explicit user action, only to the endpoint the user configured. See [AI Assistant](./ai-assistant.md#privacy-what-is-sent).
- The app never reads site credentials. Users log in to the real site inside the view.
- App logs are local, scrubbed, and never include page content, URLs with query strings, or keys.

## Legal and store-policy risks (not code, but they shape scope)

| Risk | Notes | Posture |
|------|-------|---------|
| **Site Terms of Service** | Platforms may object to modified clients. We alter only the user's own rendering of their own session; we do not scrape, automate, or act for the user (invariant 7). | Customization only. Keep it that way. |
| **App Store review (iOS)** | Web-wrapper apps risk rejection for "minimum functionality". SocialLite ships on the App Store with the same core mechanism ([Prior Art](./prior-art.md)), which suggests it is approvable when the app adds real native functionality (profiles, recipes, AI editor, picker). | Make the native value obvious; confirm against current guidelines before submission. [INFERENCE] |
| **"Sign in with Google" in embedded webviews** | Google blocks OAuth in embedded browsers (`disallowed_useragent`). The sign-in window runs inside the app, in the profile's own store, so it is an embedded view like any other. | The site views and the sign-in window report Mobile Safari's user agent, which Google accepts; without it the sign-in is refused. Do not spoof user agents by default. |
| **Anti-bot / fingerprint heuristics** | Unusual webviews may trigger challenges. | Use the platform webview unmodified; no stealth tricks. |
| **Play Store policy** | Generally permissive for webview apps; no Accessibility Service use planned. | Avoid the Accessibility route SocialLite uses on Android. |

## Reporting vulnerabilities

Add `SECURITY.md` with a private contact before first public release (Phase 6).

## See Also

[Architecture](./architecture.md) · [Site Runtime](./site-runtime.md) · [AI Assistant](./ai-assistant.md) · [Platform Support](./platform-support.md)
