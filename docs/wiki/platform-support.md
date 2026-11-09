# Platform Support

> **Status: Partially implemented.** The iOS site view exists (`src-tauri/plugins/tauri-plugin-siteview`, Swift) and the Android one now exists too (`.../android`, Kotlin). iOS checks under [Verified results](#verified-results) ran on one simulator; an Android debug startup smoke check ran on one emulator ([details](#android-site-view)). Broader Android behavior, physical devices and all remaining checks marked **verify** are unproven. Desktop is deferred.

## The core constraint

Tauri's multi-webview API (`Window::add_child`) is gated behind the `unstable` Cargo feature and **desktop-only**; upstream tracks mobile support in [#11794](https://github.com/tauri-apps/tauri/issues/11794) and [#11528](https://github.com/tauri-apps/tauri/issues/11528), both open. A mobile app has one Tauri webview, and navigating it to a site would destroy the shell. So:

- **Mobile (iOS, Android) — first-class:** site view = native webview hosted by our own Tauri plugin (`tauri-plugin-siteview`; Swift today, Kotlin to come), positioned over a rectangle the shell reports. iOS first.
- **Desktop — deferred:** site view = Tauri child webview. The plugin's desktop build returns `DesktopUnsupported` until this is built.

The shell talks to one plugin API (`open`, `set_rect`, `navigate`, …); desktop will implement the same surface ([Architecture](./architecture.md#siteview-rust-two-implementations)).

## Matrix

| Capability | macOS | Windows | Linux | iOS | Android |
|------------|-------|---------|-------|-----|---------|
| Webview engine | WKWebView | WebView2 | WebKitGTK | WKWebView | Android System WebView |
| Site view mechanism | Tauri child webview | Tauri child webview | Tauri child webview | Native plugin | Native plugin |
| Document-start injection | `initialization_script` | `initialization_script` (also subframes) | `initialization_script` | `WKUserScript` | `addDocumentStartJavaScript` if supported, else `onPageStarted` (late) |
| Isolated profiles | `data_store_identifier` (**verify** min OS) | `data_directory` | `data_directory` | `WKWebsiteDataStore(forIdentifier:)` (iOS 17+; **verify** fallback for older) | One global `CookieManager` per app; per-profile needs androidx.webkit multi-profile (feature-gated, **verify**) |
| Page → Core channel | Bridge A (**verify**) | Bridge A (**verify**) | Bridge A (**verify**) | Bridge B (script message handler) | Bridge B (web message listener) |
| Secret store | Keychain | Credential Manager | Secret Service | Keychain | Keystore-backed |
| Ad and tracker blocking | Not built (deferred with desktop) | Not built | Not built | `WKContentRuleList` from bundled lists ([Ad Blocking](./ad-blocking.md)) | Request interception (`shouldInterceptRequest`) over the same rule JSON ([Ad Blocking](./ad-blocking.md)) |
| Auto-update | updater plugin | updater plugin | updater plugin | App Store | Play Store |
| Priority | 3 | 4 | 4 | **1** | **1** |

iOS and Android first. macOS next (same engine as iOS, fastest desktop path), then Windows/Linux after the engine and format settle; Linux WebKitGTK is the most likely to need per-site workarounds.

## Verified results

Runs on the iPhone 17 Pro Max simulator (iOS 26.5). The first used a throwaway spike (not kept); later ones drove the real app's components, partly against a local fixture page over `http://localhost`. Not verified: a real device, a real finger for the earlier rows (those gestures were synthetic pointer events), rotation, any login, and anything on Android or desktop. See the gesture table below for what `idb` touches covered.

| Check | Result |
|-------|--------|
| `WKUserScript` at `.atDocumentStart` runs before `<body>` exists | Yes (`readyState: "loading"`, no body) |
| CSS injected at document start hides an element with no flash | Yes: hidden at parse time, at first frame, and for an element inserted after a `pushState` |
| Page → Rust via script message handler and a Rust-created `Channel` (no Tauri IPC on the page) | Works; origin is delivered with the message |
| Site view sees Tauri objects (`__TAURI_INTERNALS__`, `__TAURI__`, `webkit.messageHandlers.ipc`) | No; fetches to `ipc://` and `tauri://` are rejected |
| Native frame equals the rect the shell reported, and follows a resize | Yes |
| Per-profile isolation with `WKWebsiteDataStore(forIdentifier:)` | Yes: a second profile saw no cookie or localStorage; the first kept both. The real app also creates a `WebsiteDataStore/<profile uuid>` directory |
| Real app: add a site, open it, native title and URL reach the shell as `siteview:state` events | Yes |
| Real app: page-initiated navigation enables Back; Back returns to the first page | Yes |
| Real app: `navigate("javascript:alert(1)")` | Rejected in Rust: "only http and https urls can be opened" |
| Real app: page message reaches the shell as `siteview:bridge` with origin `http://localhost`; the page sees no `__TAURI_INTERNALS__` or `ipc` handler | Yes |
| Real app: a real HTTPS site loads in the native view | Yes: the Reddit mobile site loaded (logged out) when the app restored its last page. An earlier `example.com` attempt failed; the host's own `curl` also failed at that moment, so it was likely a transient network problem, not an app fault |
| Site view below a transparent shell: native hit test sends touches inside reported regions to the shell and everything else to the page | Yes, from a native log: the button's centre went to the shell and the screen centre to the page; with the fan, command bar or an error banner open, the corresponding regions went to the shell |
| Gestures on the floating button (synthetic pointer events through the real components): tap opens the assistant; hold opens the fan; sliding onto a favorite and lifting selects it; lifting then tapping selects it; a drag snaps to the nearer edge and the position persists; sliding onto settings opens it; saving favorites persists to `library.json` | Yes |
| Real app: the Reddit recipe's document-start script is injected, and the orange "Open App" button in the header is gone (compare with the same page before) | Yes, by eye on a screenshot of the live mobile site. The blocking "use the app" modal appears after about 30 seconds in a feed and could not be reproduced on demand, so hiding it and the scroll unlock are untested against the live blocking state |
| Real app: the hold feedback (the button grows about 30% and a ring fills outside it, shifted inward at the screen edge so it is not cut off) and the fan over a real page, with the logo on the button | Yes, by eye on screenshots taken during a synthetic hold |
| Site options: toggling a switch swaps the document-start script and reloads the page (`setDocumentStartScript` in the plugin; the Swift target compiles for the iOS Simulator SDK) | Compiles only. Not run on a device or simulator: the swap, the reload under the new script, and the bottom-margin rectangle are unverified |
| Real app: onboarding renders (steps 1 and 3 seen, with the animated fan demo) | Yes, by eye; steps 2 and 4 and the Skip and Start buttons were driven by the test harness but not inspected |
| Video playing inline (`allowsInlineMediaPlayback`) | Yes, by eye: a Reddit video played inside the page with the shell's button drawn above it (before the setting, one went fullscreen and covered the controls). Not tested: unmuting, fullscreen by the user |
| Favicons: fetched natively from the site itself, cached by host, shown in the fan | Yes for Facebook, Twitter and Reddit. Instagram returned no usable icon and shows its monogram |
| API key flow on the simulator: save a key through Rust to the Keychain, read back `hasKey`, remove it | Yes. The provider JSON handed to the shell did not contain the key, and a failed connection test returned "Could not reach the provider." without it. A test against a real provider that accepts the key was **not** run |
| Theme: Light, Dark and System apply to the app and persist; Light and Dark render cleanly in settings | Yes, by eye. Sites following `prefers-color-scheme` through `overrideUserInterfaceStyle` were not checked |
| Reset onboarding: the guide opens again and `onboarded` is false in `library.json` | Yes |
| Sessions on a throwaway simulator (`iPhone 17`, iOS 26.5) against a local fixture server that logged every request, with the shell driven by real taps: a typed address opens a new session; tapping a favorite whose session is live switches to it with no new request; a history entry whose typed session is live switches with no new request | Yes |
| Pinning: tapping a link to another host, and a `target=_blank` link to another host, each opened the popup browser and left the session's page unchanged; a same-host link loaded in place | Yes (the popup's own load reached the fixture server; the session's did not navigate) |
| Cap: after opening 10 typed sessions on top of the restored one, a history entry for an old one made a new request (its session had been closed), and a recent one made none | Yes |
| Memory warning: posting `UIApplication.didReceiveMemoryWarningNotification` from a temporary debug hook (removed afterwards) closed the hidden sessions: the favorite's page was requested again. The Simulator's own "Simulate Memory Warning" menu could not be driven without accessibility permission | Yes for the chain from the notification to closing. The 20-minute idle sweep was only unit-tested, and a web content process dying was not exercised |
| History: the fan's history button lists the typed addresses newest first; "Clear history" with confirm left `history: []` and `lastUrl: null` in `library.json` with favorites intact | Yes, by eye and by reading the file |

**Flashes and gestures (iPhone 17 Pro Max simulator, iOS 26.5, debug build, loopback fixture server).** Video of the screen from `simctl io recordVideo`, sampled at 30 fps; a frame counts as unthemed when the page region averages pure black or white. "Before" is `origin/main`, "after" is this change. Slow page = the fixture delays its response 4 s.

| Scenario | Before | After |
|----------|--------|-------|
| Cold start, dark | black for 1100 ms (launch screen), then black again 433 ms between splash and page | 0 ms (launch screen and splash are both the app's ink) |
| Cold start, light | white 1167 ms + white 467 ms | 0 ms |
| First launch after install (no compiled rule lists), dark | black 6.97 s, page at about 8.3 s | 0 ms unthemed, page at about 2.3 s; lists compile in the background (about 4 s) |
| Open a new session, page answers in 0.5 s, dark | black 500 ms | 0 ms (ink until the page paints) |
| Open a new session, slow page, dark / light | black 5.77 s / white 4.53 s | 0 ms; ink / paper for the whole wait |
| Switch to a live session (5 switches) | no unthemed frame, no reload | same |

A single black or white frame at the moment a new page is revealed remained after the first fix (reveal on `didCommit`, then on the page's first two animation frames); a 0.15 s fade-in removed it. Not measured: a real device, a release build, Instagram-sized pages, a web content process killed by the OS.

| Gesture | Result |
|---------|--------|
| Page scroll | Verified: a 400 pt drag moved `scrollY` by 390 (page log) |
| Inertia | Verified: a 400 pt fast flick ended at `scrollY` 1006 |
| Tap a link | Verified: click and navigation seen by the fixture server |
| Pull to refresh | Verified: the page was requested again after a slow pull at the top |
| Text input focus and keyboard | Verified: focus event on the field; the bottom band went from 3% to 100% non-page pixels |
| Long-press a link | Verified: no click; 84% of the page pixels changed (menu and preview) |
| Floating button tap, hold (fan), drag to either edge | Verified (screenshot pixel checks; the left-to-right drag by a screenshot) |
| Hold, lift, then tap a favorite | Verified earlier (see above) and by switching sessions in the measurements |
| Settings sheet scrolls, page below does not | Verified: 14% of the sheet's pixels moved, no `scrollY` event from the page |
| Hold-slide-lift on the fan | **Not verified**: `idb` cannot hold a touch and then move it; the state machine is unit-tested |
| Pinch zoom | **Not verified**: `idb` sends one finger |
| iOS edge-swipe back and forward | **Not verified**: `idb`'s edge swipes did nothing in Mobile Safari either (control), so the tool, not the app, is the limit |
| History sheet and command bar scrolling | **Not verified** |

**Causes found.** The launch storyboard used the system background (white or black). A new `WKWebView` draws its own white or black until its first frame, and `open` also awaited the WebKit compile of the content rule lists (seconds on the first run) and, in Rust, the list conversion, before the view existed. The shell is transparent, so the window showed through. The splash faded out when state loaded, not when a page existed.

**Fixes.** `SiteViewPlugin` puts a themed backdrop view under every page and keeps a new page at alpha 0 until its first frames are reported (native-only `openmediaPaint` handler, `didFinish`, or 1.5 s after commit), then fades it in. `open` looks lists up in WebKit's store and loads at once; missing lists compile in the background and attach to open pages without a reload (so the very first page after an install or list update is not blocked; its next navigation is). Rust converts the lists at launch. The launch storyboard uses a `LaunchBackground` color (ink / paper). The splash waited for the first page address, at most 4 s; see [Startup](#startup) for what replaced that.

**Not pursued.** Pre-warming a `WKWebView`: a second open took the same 470 ms to commit as the first, so there is no process start to hide. Launch-screen color follows the system appearance, not the in-app theme override.

**Found while testing:** a synchronous Tauri command that calls into the plugin deadlocks the app (it blocks the main thread waiting for native code that needs the main thread). Commands that reach native code must be `async`; see `open_site`.

**Usage controls (iOS):** daily blocking is a native blur shield attached to each affected session. It stops loading, persistently suspends media playback, blocks navigation and touch interaction, and preserves deferred recipe reloads until the session is unblocked. The Rust-only plugin method adds no webview capability. Native Swift compilation and standalone domain checks are automated; physical-device behavior remains unverified.

**Incognito (iOS):** the biometric check is a Rust-only plugin method (`authenticate` in `SiteViewPlugin.swift`) on `LocalAuthentication`. `.deviceOwnerAuthentication` tries Face ID or Touch ID first and lets the system offer the passcode after failures or when nothing is enrolled; a device with neither fails closed. The Swift code compiles for `aarch64-apple-ios-sim` and the shell flow was exercised in a browser with a mocked `invoke`; the real Face ID prompt has not been run on a simulator or device. Desktop and Android return an unsupported error.

**Decisions that follow:**

- **iOS 17 is the minimum.** `forIdentifier:` is iOS 17+, and the Tauri iOS template defaults to 15, so `tauri.conf.json` sets `bundle.iOS.minimumSystemVersion` to 17.0. This resolves the roadmap's open question on older iOS versions.
- **Android must require `WebViewFeature.MULTI_PROFILE` and `WEB_MESSAGE_LISTENER`** (decided, not built). If either is missing, `open` should fail with a message asking the user to update System WebView. A silent single-profile fallback would break the profile-isolation invariant.

## Startup

Cold start used to show an empty screen (launch screen), then the splash, then an empty screen again until a heavy page painted. Measured and fixed in `perf/startup-handoff`.

**Causes.** (1) The launch screen was a plain colour and the splash's logo arrived a request later, so the first second showed nothing. (2) The splash left when the page reported an address, which is at commit; a page that commits long before it paints (a script-rendered site) was then hidden at alpha 0 over an empty backdrop. (3) The page was opened only after the shell had booted, rendered, called `get_state`, rendered again and called `open_site`; the page's web process, DNS lookup and request all queued behind that. (4) The first-paint signal fired after two animation frames at document start, which is before any content exists.

**What changed.**

| Area | Change |
|------|--------|
| Launch screen | `LaunchScreen.storyboard` shows the logo (`LaunchLogo` image set, 52% of the width, at most 240 pt: the splash's size and place). `SiteViewPlugin.installBackdrop` keeps the same logo under the shell until the first page is revealed, so the gap between the launch screen and the shell's first paint is not empty either |
| Splash | The logo and the stylesheet are inlined into `index.html` by a Vite plugin (`inlineFirstPaint`), so the splash paints with the first HTML, not after two more requests. It starts at the launch screen's state (solid colour and the logo at full size; the radial glow fades in) and no longer animates the logo in from nothing. Fade-out is 250 ms |
| Splash to page | The splash stays until the page has painted. Native sends `painted` in `siteview:state` when it reveals the view; `pageShowing` in `splash.ts` lets the splash go on `painted`, on a finished load, on an error, or after 4 s |
| First paint | The injected script reports the page's first contentful paint (`PerformanceObserver`, two frames as a fallback) instead of two frames at document start. A view that is not in the window yet never reveals |
| Page opens at launch | `boot.rs`: in `setup`, Core opens the start page (`Library::start_url`: the last page, else the first valid favorite) with `open_session`, before the shell has loaded, and resolves its host so the DNS answer is cached. `get_state` returns the session id (`bootSession`); the shell calls `adopt_boot_session` once its event listeners exist, which sets the real rectangle and re-announces the state it could not hear. If the start page failed to open, the same call opens it as `open_site` would. The native `open` takes an optional rect and may run before the shell's view is in the window: it creates the view and starts loading, then mounts it (`attachShell`) |
| Shell boot | `get_state` is requested before React renders (`prefetchStartup`); `get_state` and the hot commands (`set_last_url`, `add_history`, `record_usage`, `get_sites`, `bottom_margin_for`) run off the main thread; Settings and Stats are separate chunks fetched after the splash is gone, and the guide only when it opens; site options and favicons are fetched after the first page shows. The library file is rewritten at launch only when it was migrated |
| Build | Vite targets Safari 17 and drops the modulepreload polyfill |

**Measured.** iPhone 17 simulator (iOS 26.5), release build, loopback fixture whose response takes 0.3 s and whose content is drawn by script 1.5 s after commit (a stand-in for a script-rendered site). Video from `simctl io recordVideo`, 60 fps; "empty" is a frame whose centre is one flat colour. Baseline (`origin/main`) and this change installed fresh and alternated, three rounds. Another process was filling the disk during the runs, which made the simulator's process starts slow and uneven.

| Metric | Before (3 runs) | After (3 runs) |
|--------|-----------------|----------------|
| Empty frames after the app appears | 2867 / 2033 / 1433 ms | 0 / 0 / 0 ms |
| App appears to page visible | 5.37 / 4.47 / 3.87 s | 2.57 / 4.38 / 3.17 s |

The empty-frame result is clear. The time-to-page spread is wide (one "after" round was slowed by a late app start), so the three-run medians, 4.47 s to 3.17 s, show a direction and no more. What the logs show directly (release build, simulator, ad blocking on): Rust `setup` takes 15 ms; the page view is created and loading 0.17 s after the shell's view exists, where before it waited for the shell's JavaScript, two renders and two commands; the page's first request then leaves 0.6 to 0.9 s later, the same moment the shell's own JavaScript starts, because the simulator needs that long to start each web process (this floor is the simulator's; a device is expected to be shorter, not measured). One run with ad blocking off did not shorten that wait (0.87 s), so the rule lists are not what it is.

**Not measured.** A real device, real sites, dark mode (the launch screen colour follows the system appearance), iPad, and the first launch after an install (Rust still converts the filter lists before the start page opens; unchanged). DNS warm-up is a design effect, not a measured one.

**Not pursued.** Inlining the module script (one request; the cost is parsing, not the fetch); replacing React with a smaller runtime (about 190 KB of the 256 KB main chunk, a rewrite risk for this change); caching the compiled page script and rule-list handles in memory (not on the measured path).

## Layout model (mobile)

The site view is a native view *below* the Tauri shell, so the shell's floating controls draw over the page:

- The shell webview is transparent (`isOpaque = false`, clear backgrounds). The shell reserves a full-screen rectangle inside the safe area and reports it with `set_rect`; the native site view fills it.
- A transparent `TouchRouter` view sits above both. The shell reports the rectangles of its interactive elements (`[data-hit]`) with `set_interactive_regions`; a touch inside one goes to the shell, any other touch goes to the page. With no site view open, the shell gets every touch.
- Opening the fan, the command bar or settings adds a full-screen interactive region, so the page cannot be touched underneath them.
- **Sessions.** The plugin keeps one `WKWebView` per session (a dictionary keyed by the shell's session UUID), all stacked below the shell, all but the active one `isHidden`. `open` adds a view and shows it; `activate` shows an existing one without reloading; `close` removes one. Every session uses the same profile data store, so logins are shared. The touch router points at the active view only. A session's content rule lists are swapped on all views; hidden ones reload when next shown. A backdrop view (the app's ink or paper) sits under every page, and a new page stays invisible until it has painted. Lifetime policy lives in the shell ([UI Design](./ui-design.md#sessions)); the plugin only reports `siteview:memory` (from `UIApplication.didReceiveMemoryWarningNotification`) and `siteview:closed` (a hidden session's web content process died).
- **Domain pinning and the popup.** `decidePolicyFor`, `createWebViewWith` and the first-load rule all go through `DomainScope.verdict` (`ios/Sources/DomainScope.swift`, pure Foundation, checked by `scripts/test-domain-scope.sh`). Outside-domain main-frame navigations are cancelled and shown in an `SFSafariViewController` presented from the top view controller.
- Native gestures (iOS edge-swipe back) stay on the site view; state changes are mirrored to the shell via `siteview:state` events.
- Tap-to-pick, AI chat, and the rule list live in the command bar and settings; the picker highlight lives in the page (engine).

Fallback if the native-plugin approach fails: navigate the main webview to the site and inject shell UI as an overlay in the page. Much weaker (shell dies on navigation, UI shares a realm with the hostile page), so treated as a last resort and not planned.

## The Android site view

`src-tauri/plugins/tauri-plugin-siteview/android` (Kotlin, package `surf.openmedia.siteview`, class `SiteViewPlugin`) is the Android twin of the Swift plugin and speaks the same Rust API (`src/models.rs` is the source of truth; the JSON is camelCase, and `setBlocked`, `authenticate` and `evaluate` stay Rust-only).

- **Layout.** Tauri puts the shell webview straight into the activity's content view, so the plugin adds its own `PageLayer` (a `ViewGroup`) as the first child of that content frame: the page views live in the layer, below the shell, and the layer lays them out at the rectangle the shell reports with `set_rect`. The shell is made transparent (`setBackgroundColor(Color.TRANSPARENT)`) so the page shows through it, and a backdrop in the layer holds the app's own colour until a page has painted.
- **Touch routing.** Android has no hit-test fall-through between sibling views, so the shell webview keeps an `OnTouchListener`: a touch inside a region the shell reported goes to the shell, every other touch is copied to the page webview with its coordinates moved into the page's space and dispatched there. The page view is the target, so the shell never sees a page touch.
- **Profiles.** `open` refuses to run unless the System WebView reports `MULTI_PROFILE` and `WEB_MESSAGE_LISTENER`, and the page is put in the profile named by the shell's profile id (`WebViewCompat.setProfile`). There is no single-profile fallback: the profile-isolation invariant would break.
- **Document start.** The recipe script and the first-paint reporter go in with `WebViewCompat.addDocumentStartJavaScript`. Without that feature the scripts are injected when the page starts instead, which is late: a CSS-first rule may flash.
- **Bridge.** `WebViewCompat.addWebMessageListener` gives the page a write-only `openmedia` object. Only the main frame's messages are taken, the body must be a JSON object or array, and the message's own origin travels with it. No Tauri IPC reaches a page view.
- **Popups.** A navigation outside the session's domain is cancelled and opened in a Custom Tab, which shares nothing with the profile.
- **Blocking.** A closed site is covered by a native shield, its load stops, its timers stop (the closest Android has to suspending media) and every navigation it asks for is refused.
- **Owner check.** `BiometricPrompt` with `BIOMETRIC_WEAK`, plus `DEVICE_CREDENTIAL` on Android 11 and above; a device with neither fails closed.
- **Notifications.** A local notification for a hidden session, with the session id in the intent; the tap is reported back as `siteview:notification-tap`. `POST_NOTIFICATIONS` is requested the first time one is due.
- **Secrets.** Android has no `keyring` backend, so the plugin's Kotlin side keeps a key in the Android Keystore (AES-GCM) and writes only the ciphertext to the app's preferences, which the app's backup rules exclude. Rust reaches it through a Rust-only plugin command, so no webview can ask for a key.

**Build verification.** `yarn tauri android build --aab --ci` produced `src-tauri/gen/android/app/build/outputs/bundle/universalRelease/app-universal-release.aab` (25 MB), with release Rust libraries for all four Android ABIs and compiled Kotlin plugins. The AAB is unsigned because no upload key was configured; `jarsigner -verify` reported it unsigned. Release signing reads the ignored `src-tauri/gen/android/keystore.properties` (`keyAlias`, `password`, `storeFile`) when present. **Emulator smoke:** `yarn tauri android dev "Medium_Phone"` installed and launched `surf.openmedia` on the `sdk_gphone64_arm64` emulator; its main activity remained foreground with no new Android runtime exceptions. This verifies startup only, not broader Android behavior or physical devices. Never commit the keystore properties file.

## Known platform constraints

- **Android late injection.** Without document-start-script support, injection can run after page scripts. CSS-first rules flash briefly; mitigated by hiding the view until the first inject, and by feature-detecting support (most current WebViews support it).
- **iOS WKWebView isolation.** `WKWebsiteDataStore(forIdentifier:)` requires iOS 17+. Older targets get a single shared store (one profile) unless a fallback is found.
- **Web versions are not native apps.** Mobile web Instagram/Facebook lack features (SocialLite documents: posting, one-time-view DMs, sending video, poll stickers, some music). Our product inherits these limits; communicate them rather than promising parity.
- **No push notifications.** Push for a third-party site needs a server relaying APNs/FCM. Out of scope by design (no backend). What exists instead: unread badges and **local** notifications for quick-access sites ([UI Design](./ui-design.md#unread-badges-and-notifications)). The page's title is read natively, so they work only while the app runs: iOS suspends it, and its web views, shortly after it is backgrounded, and a site that does not put a count in its title raises nothing. Android is not implemented.
- **Cannot modify native apps.** iOS forbids altering other apps; Android can only via Accessibility Service (SocialLite's approach). We do neither: we replace the native app with the customized web view. A shell shortcut/URL-handler experience is a possible later step.
- **Background behavior.** A backgrounded site view may be suspended by the OS; do not rely on live observers while hidden.

## Open verifications

Tracked in [Roadmap](./roadmap.md#phase-0--feasibility-spikes). Each needs a recorded result.

| # | Question | Spike |
|---|----------|-------|
| V1 | Does `add_child` + `initialization_script` inject reliably into `https://www.instagram.com` and `https://m.youtube.com` on macOS? | S1 |
| V2 | Can a remote-capability bridge command be scoped to exactly one command per webview label, on desktop and mobile? | S2 |
| V3 | Can the native plugin keep a `WKWebView` / `WebView` aligned to a shell-reported rect through rotation, keyboard, and safe areas? | S3, S4 |
| V4 | Does `addDocumentStartJavaScript` cover subframes and SPA navigations as needed on current Android WebView? | S4 |
| V5 | Per-profile isolation on each platform (see matrix) | S5 |
| V6 | Secret-store options on iOS/Android meet the invariants | S6 |
| V7 | Does Instagram web log in and function in each embedded webview (2FA, passkeys)? | S1, S3, S4 |

## See Also

[Architecture](./architecture.md) · [Site Runtime](./site-runtime.md) · [Security](./security.md) · [Roadmap](./roadmap.md)
