# Changelog

All notable changes to OpenMedia are documented here.

> **Format**: loosely based on [Keep a Changelog](https://keepachangelog.com/), grouped by date descending. Each entry references the originating PR (when available) and names the area from the conventional-commit prefix.
>
> **Wiki**: the [GitHub Wiki](https://github.com/skepjandi/openmedia/wiki) is the public-facing main wiki — architecture, recipe format, AI pipeline, security model, roadmap. Source-controlled editing surface is `docs/wiki/` in this repo; CI (`.github/workflows/sync-wiki.yml`) mirrors it to the GitHub Wiki on every merge to `main`. New single-PR changes belong here, not as new wiki pages.

## 2026-11-09

### fix(paywall): keep the command bar, links and search free; paywall only the assistant

**Problem:** the floating button opened the paywall for free users, so typing a link or a search was blocked along with the AI.

**Change:** the command bar opens for everyone and has an Auto / Link / Search / Chat selector. Link opens addresses, Search opens a DuckDuckGo query (kept out of history), Chat is the assistant and shows the paywall to free users. Auto opens addresses, sends text that starts with a change verb to the assistant (paywalled when free) and searches everything else. The lock badge on the main button is gone; Usage and Incognito stay Pro. New strings are in all 28 locales. Rust gating is unchanged.

**Limits:** Auto's request detection is an English verb list; other languages use Chat. Search is hardcoded to DuckDuckGo. Not run on a device or simulator; `ts:check`, `eslint`, `yarn test` (280/280) pass.

### fix(siteview): decide which site a host belongs to with the Public Suffix List

**Cause:** "Which site is this host?" was answered by a hand-written rule (last two labels, three after a country code and a 12-word list) copied seven times: `library.rs`, `ai/patch.rs` (with a different list), `site.ts`, `fetch-site-icons.mjs`, and the Kotlin and Swift `DomainScope`. The copies disagreed, and all of them treated `alice.github.io` and `bob.github.io` as one site and `foo.com.br` as `com.br`. That reached session pinning (a session on one could navigate to the other), favorites, usage limits and recipe names.

**Change:** One data file, `shared/public-suffix/resources/public_suffix_rules.txt` (the Public Suffix List, ICANN and private sections, 8,971 rules), maintained by `yarn suffix:update` with the official test vectors beside it. Four thin matchers read it: `src-tauri/src/site.rs`, `src/shared/site.ts` (via `shared/public-suffix/match.mjs`, which the icon script also uses), `PublicSuffix.kt` (packaged as a Java resource) and `PublicSuffix.swift` (compiled in as generated `PublicSuffixRules.swift`, because a static Swift package cannot reliably ship a resource). Every matcher passes the same `vectors.json` (the official ones) and `app-vectors.json`. `yarn suffix:check` fails when the generated Swift file is stale. On startup `Usage::retire_public_suffix_sites` drops usage rows stored under a public suffix (`github.io`, `com.br`) and moves a limit set under one to each favorite beneath it; other data keeps its keys, since every site the old rule got right is unchanged.

**Verified:** the 77 official and 23 app vectors on all four matchers (Rust 200 tests, vitest 273, Kotlin 11, Swift script), including the migration (limit moved, rows dropped, a second run writes nothing). **Not verified:** pinning on a device or simulator (only the matcher and the unit-tested verdict rules ran), the first-launch migration on a real `usage.json`, and the startup cost of parsing the 140 KB rule list on a low-end phone.

### chore: standards audit of the build, CI, dependencies and store metadata

**Cause:** Release checks lived in a seven-command list nobody ran as one; `yarn build` only knew iOS; CI never built Android, ran the Swift domain-scope checks or audited dependencies; the plugins were three loose Cargo manifests (an untracked `Cargo.lock` appeared in the billing plugin); the `.env` reader in `build.rs` was hand-rolled and kept `# comments` in values; the production CSP allowed the dev HMR socket; the iOS app had no privacy manifest and no export-compliance key (App Store Connect asks on every upload); the Android domain-scope rules, the twin of the Swift ones, had no tests.

**Change:** `yarn verify` (and `check:web`, `check:rust`, `test:swift`, `test:android`) replace the manual list; `yarn build ios|android|macos [--production]` and `dev:ios|dev:android|dev:desktop` wrap the Tauri CLI. `src-tauri` is one Cargo workspace (app + both plugins, one lockfile, `rust-version` 1.90). `build.rs` uses `dotenvy`. `deny.toml` + a `cargo deny` job enforce licenses, advisories and sources. CI gets least-privilege permissions, concurrency, timeouts, an Android build with the new JUnit domain-scope tests, and the Swift checks. Dependabot also covers Gradle and Swift. `keyring` is no longer compiled for Android. The dev-only `ws:` source moved to `devCsp`; `tauri.conf.json` gains bundle metadata (category, publisher, license, macOS 13 minimum). iOS: `PrivacyInfo.xcprivacy` (file timestamps and UserDefaults, the required-reason APIs the binary links), `ITSAppUsesNonExemptEncryption=false`, `LSApplicationCategoryType`. Android: dropped the deprecated `databaseEnabled` WebView setting.

**Also:** AGENTS.md's "no `unwrap()`/`expect()` outside tests" rule is now a clippy `deny` (`[workspace.lints]`, tests exempt via `clippy.toml`); the only exception is the unrecoverable startup `expect` in `run()`. `@vitejs/plugin-react` 6.2.1 to 6.3.0.

**Verified:** `yarn verify` (269 web tests, 195 Rust tests plus 12 plugin tests, clippy `-D warnings`), `cargo deny check`, 7 Kotlin tests (`yarn test:android`), macOS `.app` release build (11 MiB, launches, Info.plist carries the new metadata), iOS development-signed IPA (7.7 MB, contains `PrivacyInfo.xcprivacy`), Android debug APK and R8-minified release APK (15 MB, debug-signed and launched on an API 36 emulator: the shell renders, no crash). **Not verified:** the new CI jobs on GitHub runners, signed store builds, App Store Connect acceptance of the privacy manifest and the export-compliance answer (confirm it applies before upload), plugin behavior on the emulator or a device beyond startup, desktop site views (still `DesktopUnsupported`).

### fix(settings): draw choice lists in the app instead of the system's dialog

**Cause:** The language, AI provider and model pickers were native `<select>` elements. Android's WebView opens those in its own light dialog (white, with radio buttons), which ignores the app's theme and looked out of place on the dark Settings screen.

**Change:** A new `Picker` shows the current choice in a field and opens a themed bottom sheet: one row per option, the selected one in the accent colour with a check, Back and the backdrop close it. The three selects now use it, so iOS and Android look the same.

**Verified:** `yarn ts:check`, `yarn lint`, `yarn test` (269/269). **Not verified:** the sheet on a device or emulator (touch routing through `data-hit`, safe-area padding, a 29-language list scrolling).

### fix(android): use the OpenMedia launcher icon

**Cause:** `tauri icon` had written the OpenMedia icons to `src-tauri/icons/android/`, but `src-tauri/gen/android` was created afterwards by `tauri android init` with Tauri's default icons, and the build only reads `gen/android/app/src/main/res`. The adaptive-icon files (`mipmap-anydpi-v26`, `values/ic_launcher_background.xml`) were never copied either.

**Change:** Copied the OpenMedia mipmaps and the adaptive-icon definition into the Android resources and removed the template's default vector drawables. The adaptive foreground is scaled to 46% of its canvas, leaving clear padding inside the launcher mask instead of the logo being cropped or touching its edge (the same files are updated in `icons/android/`).

**Verified:** rebuilt and installed on an API 36 emulator; the launcher shows the OpenMedia logo, uncropped, in a circular mask. **Not verified:** other launcher mask shapes, themed (monochrome) icons, the Play Store listing icon.

### fix(onboarding): show the whole fan in the hold-for-favorites step

**Change:** The step-3 illustration still showed five favorites and a lone Settings button. It now pops out the same five favorites plus the Incognito, Usage, History and Settings column above the button, as the real fan does; the existing animation, ring and stagger (now 70 ms so all nine are open together) are unchanged otherwise. English step-3 text names the four controls.

**Verified:** `yarn ts:check`, `yarn lint`, `yarn format:check`, `yarn test`. **Not verified:** the layout on small devices. Other locales still carry the old step-3 sentence ("Settings is the small button set apart"); it needs a native-speaker pass.

### feat(gestures): Android Back, pull to refresh and edge swipes on both platforms

**Gap:** Android had no handling for the Back button or gesture: any press left the app, even with page history or a sheet open, and Android had no pull-to-refresh. iOS already had the web view's edge-swipe back and forward and pull to refresh on pages, but the app's own full-screen pages had no back swipe.

**Change:** Back now dismisses the open fan, then a sheet, then an onboarding step, then goes back in the page, and only then leaves the app (a stack in `features/back/backStack.ts`, a Tauri `back-button` listener registered only while a press is wanted). Pages get pull-to-refresh through `SwipeRefreshLayout`. Regions at a screen edge are excluded from the system back gesture so dragging the floating button does not trigger it. Settings, History, Usage and the paywall close on an edge swipe (right edge in right-to-left languages) where the platform gives none.

**Verified (Android API 36 emulator):** Back goes back in the page, closes Settings, closes the fan, and leaves the app when there is nothing left; the system edge-swipe goes back in the page; a pull-down reloads the page; dragging the button from the edge moved it without going back. `yarn ts:check`, `eslint src`, `prettier --check src`, `yarn test` (269/269). **Not verified:** the iOS edge swipe on a simulator or device (WebKit's own gesture was already enabled; the shell swipe's thresholds are unit-tested but the touch hook was not driven), Android three-button navigation, predictive back animation, pull-to-refresh on pages that scroll inside an inner container.

### fix(fab): readable Pro lock and clearance around the open floating button

**Change:** The Pro lock badge used the theme's `ink` token with a white icon, which is near-white in light mode and dark on dark pages in dark mode. It now has its own navy fill, white icon and white rim (`.pro-badge`) in both themes, and the badges sit above the ring animation instead of under it (`z-10`). Fan badges are smaller so they stop covering the item's icon. The fan geometry now measures clearance from the button as it looks while open (scaled by `HOLD_SCALE`, plus its badge), not its resting size, so the settings column no longer touches the button; an exact-distance placement was also being rejected by float rounding and silently shrinking the arc, which a new test covers.

**Verified:** `yarn ts:check`, `eslint src`, `prettier --check src`, `yarn test` (261/261); light and dark themes with the fan open on an API 36 emulator. **Not verified:** other screen sizes on a device.

### fix(android): keep shell content clear of the system bars

**Change:** Android's WebView reports `env(safe-area-inset-*)` as 0 under edge-to-edge, so headers, the command bar and the page slot sat under the status bar. The shell now reads `--safe-top` and `--safe-bottom` (defaulting to `env()` on iOS); the siteview plugin sets them on the root element from the window insets (system bars and display cutout, in CSS pixels) and re-applies them to every document the shell loads.

**Verified:** `yarn ts:check`, `eslint src`, `prettier --check src`; on an API 36 emulator the variables read `24px` and survive a shell reload, and Settings' header sits below the status bar. **Not verified:** a device with a display cutout, landscape, gesture vs three-button navigation.

### fix(android): fix WebView threading and touch routing

**Change:** Android runs `shouldInterceptRequest` off the UI thread. Cache the current page URL in volatile session state instead of calling `WebView.url` from a worker. Convert shell DOM rectangles from CSS pixels to density-scaled Android pixels so shell hit regions match native touch coordinates.

**Verified:** `yarn tauri android dev "Medium_Phone"` built, installed and launched on `sdk_gphone64_arm64`; tapping onboarding's Next control advanced to step 2, and tapping the floating control opened the Pro screen. Broader Android behavior and physical devices remain unverified.

**PR:** [#41](https://github.com/skepjandi/openmedia/pull/41)

### docs: simplify project docs and add store release instructions

**Change:** Shorten the README, correct stale wiki status and implementation claims, add iOS App Store and Google Play build/signing instructions, declare Android's version code, add license metadata to both native plugin crates, and align checked-in iOS build metadata.

**Not verified:** Signed store builds, Android runtime behavior, and store submission.

### fix(release): align Apple build numbers with Android

**Change:** Set iOS and macOS `CFBundleVersion` to `1000` for marketing version `0.1.0`, matching Android's version code. Increment both Apple build numbers for each subsequent upload.

**Verified:** `yarn tauri info` parsed the config. **Not verified:** iOS or macOS archive/signing builds.

### fix(build): restore Rust formatting check

**Change:** Apply `rustfmt` import ordering in the siteview plugin and avoid a desktop-only unnecessary `mut` warning while preserving mobile initialization.

**Verified:** Both Rust formatting checks; `cargo clippy --all-targets -- -D warnings`.

### fix(build): avoid DOM.Iterable requirement for hit regions

**Change:** Use `Array.from` to iterate DOM query results without depending on the `DOM.Iterable` TypeScript library.

**Verified:** `yarn build:web`, `yarn tauri android build --aab --ci` (universal AAB across four ABIs), and `jarsigner -verify` (`jar verified`).

### fix(store): add iPhone 6.1-inch screenshots

**Change:** Render the eight existing App Store screens at 1179 × 2556, accepted for iPhone 6.1-inch uploads. The screenshots use the existing simulator captures and are reproducible with `scripts/render-store-assets.mjs`.

**Verified:** Rendered the 6.1-inch set and checked pixel dimensions and PNG alpha channels.

**PR:** [#36](https://github.com/skepjandi/openmedia/pull/36)

## 2026-11-08

### feat(paywall): add anonymous RevenueCat entitlements for iOS and Android

**What:** AI features, Incognito and Usage are Pro; opening sites remains free. Plans are lifetime ($18.99), yearly ($10) and monthly ($2, with a 14-day trial).

**Change:** Native StoreKit / Google Play Billing adapters feed one RevenueCat `pro` entitlement; Restore Purchases supports the same store account on another device. Rust gates paid commands, desktop remains unchanged, and live HTTPS Terms and Privacy pages are required before purchases activate. Debug builds can set `EXPO_PUBLIC_FORCE_ENABLE_PRO_ON_SIMULATOR=true`; native code grants Pro only after confirming an iOS Simulator or Android Emulator.

**Verified:** `yarn ts:check`, `yarn lint`, `yarn format:check`, `yarn test` (260/260), and `cargo fmt --check`. Rust host tests/check passed earlier but were not rerun after final Rust edits because of disk pressure. **Not verified:** native iOS/Android builds, simulator override on device/emulator, store transactions, restore on another device, Android site-view build/runtime. Billing keys, store products, trial and legal URLs remain release prerequisites.

**PR:** n/a

### chore(store): App Store and Google Play artwork from simulator captures

**What:** The store listings needed screenshots and a feature graphic at the sizes Apple and Google accept.

**Change:** `assets/store/` holds 8 portrait shots each for iPhone 6.3" (1206 × 2622, the required slot), iPhone 6.9" (1320 × 2868), iPad 13" (2064 × 2752), Android phone (1080 × 1920) and Android tablet (1440 × 2560), plus the 1024 × 500 Play feature graphic, all alpha-free PNG. They are composed by `scripts/render-store-assets.mjs` from unedited iPhone 17 Pro Max and iPad Pro 13" (M5) Simulator captures kept in `assets/store/captures/`. Sizes, capture method and how to regenerate are in `assets/store/README.md`.

**Limits:** Usage and Limits screens show synthetic sample data. The Android sets reuse the iOS captures in a neutral frame, because there is no Android build yet; recapture on Android before submitting to Google Play.

### fix(shell): disable pinch zoom on the app's own screens

**What:** Settings, Usage, onboarding and the other shell screens could be pinched and zoomed like a web page.

**Change:** The shell's viewport meta now pins scale to 1 (`user-scalable=no`), `body` sets `touch-action: pan-x pan-y`, and the iOS plugin fixes the shell web view's zoom range at 1 and disables its pinch recognizer. Site views are separate web views and keep their own zoom.

**Verified:** Diff only. **Not verified:** on a device or simulator (iOS pinch, Android WebView); the Swift change was not compiled here.

### feat(fab): unread badges and local notifications for quick-access sites

**What:** Quick-access sites (messages and the like) gave no sign of new activity while another page was showing.

**Change:** The shell reads the leading `(N)` in each quick-access session's title. A badge shows the count on the fan item (and a dot on the floating button); when a hidden session's count rises the plugin posts a local notification (`notify`, title = favorite name, body = "New activity" in the user's language). Tapping it shows that session (`siteview:notification-tap`). Page text never enters a notification, and each session is limited to one per 30 s. iOS permission is requested when the first one is due.

**Limits:** Local only: no push, so nothing arrives once iOS suspends the app; sites without a count in the title raise nothing; Android is not implemented. Non-English notification text is machine-drafted.

**Verified:** Vitest (title parsing, rise/baseline/rate-limit rules, badge lookup), Rust validation test, all JS and Rust checks, and the plugin's Swift compiles for the iOS Simulator. **Not verified:** the permission prompt, banner and tap on a simulator or device, and real sites' titles.

### feat(incognito): second quick-access set behind a biometric check

**What:** A new Incognito button sits above Usage in the fan. Pressing it asks for Face ID, Touch ID or the passcode, then swaps the quick-access favorites and the recipe switches for a separate incognito set and grays every icon in the app. Pressing it again leaves, with no check.

**Change:** Settings gains collapsed, locked "Incognito favorites" and "Incognito recipes" sections that ask for the check each time they open. The incognito set is never persisted as active, is kept out of `get_state`, and while on it records neither history nor the last page. The check is a Rust-only plugin method (`authenticate`), with no capability reachable from a site. See [UI Design](docs/wiki/ui-design.md#incognito) and [Security](docs/wiki/security.md).

**Unverified:** The real Face ID prompt and passcode fallback on a simulator or device (the Swift builds for `aarch64-apple-ios-sim`; the shell flow ran against a mocked `invoke`); native-speaker review of the new strings. Incognito does not isolate cookies.

**PR:** n/a

### fix(settings): rename "Pre-made recipes" to "Recipes"

**What:** The Settings section lists bundled recipes and the user's changed copies of them, but its name called them all pre-made.

**Change:** The section is now "Recipes" in every language (title, the assistant's "Find it in Settings" hint, and the sentences that mention it); `PremadeRecipesSection` is now `RecipesSection`. README, wiki pages and code comments follow.

**Unverified:** Native-speaker review of the 28 non-English strings; rendering in the running app.

**PR:** n/a

### feat(i18n): app-wide translations

**Change:** The shell UI is translated into 29 languages: English plus German, French, Spanish, Portuguese, Italian, Dutch, Swedish, Polish, Czech, Romanian, Greek, Russian, Ukrainian, Turkish, Arabic, Urdu, Chinese (Simplified and Traditional), Japanese, Korean, Thai, Vietnamese, Indonesian, Malay, Hindi, Bengali, Tamil and Sinhala. Settings > Language picks one or follows the device; the choice persists as `locale` in `library.json`. Arabic and Urdu lay out right to left.

**Unverified:** Native-speaker review of the translations, and on-device rendering of each script. Recipe names and option labels are not translated; see [Internationalization](docs/wiki/i18n.md).

### feat(settings): collapse only Pre-made recipes and More favorites by default

**Change:** Settings sections now start open; only the long Pre-made recipes section starts collapsed, via a new `defaultOpen` prop on `Section`. "More favorites" is a collapsible block, collapsed by default.

**Verified:** TypeScript, ESLint, Prettier, 178 frontend tests. Rendering in the running app not exercised.

**PR:** n/a

### feat(usage): slider-based limits for favorites, and a clearer Usage page

**Change:** Usage now has Activity and Limits tabs. Limits lists every favorite; tap one, pick a preset or drag a slider for "Pause the site after" and "Remind me at". Drags show a live meter against today's time and save on release; the reminder and limit can never cross, so there is no validation message. Other sites are added from suggestions or an address. Activity gains site icons, a daily average, a "Limits today" card and per-site meters. The in-page reminder and the limit-reached screen show the site icon, a live meter, time left and "Adjust limit" (opens Limits on that site); the block screen counts down to midnight. The old minutes form is removed. All new strings are in the i18n catalog (43 keys, 29 languages; the 28 non-English translations are machine-drafted and need native review), and the slider and meter lay out right to left. Limits storage, validation and native blocking are unchanged.

**Verified:** TypeScript, ESLint, Prettier and the frontend suite, including new tests for stops, reconcile, presets, status and site lists. Real `StatsSheet` and `UsageGuard` driven in a browser with mocked IPC: presets, slider drags in both directions, both switches, removal, adding a site, reminder deep link, blocking and unblocking after raising the limit.

**Unverified:** Touch dragging, slider look and the Limits tab on a physical iOS/Android device; light theme was not inspected.

### perf(web): keep quick-access sites warm after opening

**Change:** Retain one reusable session per first-six favorite across routine idle sweeps and other browsing, so favorite taps switch pages rather than reload them. The usual five-session budget expands only as needed, to at most six quick-access pages plus the visible page; favorite edits reconcile retention immediately. Memory warnings still release every hidden page. No preloading or extra speculative requests.

**Verified:** Retention regressions and a real-store smoke with mocked IPC: all six pages survive an idle sweep and 12 typed opens, favorite taps reuse the original sessions, removal immediately releases a stale page, and memory pressure releases hidden pages before a fresh reopen. Native switching latency, memory and battery costs remain unmeasured on-device.

### feat(browsing): favorites, connected assistant, site icons and daily usage controls

**Change:** Favorite stars on the current page and History, offline icons for all 18 bundled recipes, shared cached icons for custom sites/history, and collapsed-by-default Settings sections. The command bar now uses the active BYOK provider through redacted preview, validated proposals and explicit accept/reject instead of always reporting it disconnected.

**Usage:** The fan's Usage button sits above History. Configure warnings and daily limits for any site; top notices warn, while native iOS blur shields stop exhausted sessions' interaction, navigation, loads and media. Other sites remain usable; midnight and policy changes re-evaluate blocks.

**Verified:** TypeScript, ESLint, Prettier, 172 frontend tests, 172 app Rust tests plus 10 plugin tests, Clippy, production build, iOS Swift compilation and domain checks. Production-shell smoke with in-memory IPC exercised favorite stars, History icons, provider preview/send/accept, collapsed Settings, warning display, per-site blocking and policy removal. All 18 PNGs decoded at 96×96 and match their recorded hashes; the icon pipeline reuses its cache offline and a mocked redirect smoke confirmed icon services are rejected before contact.

**Unverified:** Physical-device interactions and authenticated calls to a real provider. Native media suspension and shields compiled but were not exercised on a device. Limits do not suspend arbitrary page JavaScript.

**PR:** [#23](https://github.com/skepjandi/openmedia/pull/23)

### feat(web): simple loader while a site opens

**Change:** Show a small accent spinner in the page area until the active session paints or finishes loading; errors dismiss it and ready sessions switch without it. Uses existing page events, follows the app theme, and respects reduced motion.

**Verified:** Browser smoke with the real `WebLayer` and simulated native state: opening, first paint, hidden-session events, ready-session switching, errors and open-failure recovery; light/dark themes and reduced motion. Native/on-device rendering was not checked.

### perf(startup): no empty screens, page opens at launch

**What:** Launching showed an empty screen, then the splash, then an empty screen again (about 0.5 s or more on script-rendered sites) before the page.

**Change:** The launch screen and the splash show the same logo in the same place, and the splash's logo and stylesheet ride in the first HTML, so no frame is empty. The splash now stays until the page has painted (native `painted` flag on `siteview:state`, from the page's first contentful paint) instead of leaving at the first address. Core opens the start page from `setup`, in parallel with the shell's boot (`boot.rs`, `adopt_boot_session`, optional rect on the native `open`), and resolves its host first. The shell requests `get_state` before React renders, runs its hot commands off the main thread, loads Settings, Stats and the guide as separate chunks, and fetches site options and favicons after the first page shows; the library file is no longer rewritten at every launch. On the simulator, empty frames after the app appears went from 1.4-2.9 s to 0 over three alternating runs; time to page has a wide spread and is not claimed beyond its direction. Real devices and real sites were not measured. See [Platform Support](docs/wiki/platform-support.md#startup).

### feat(stats): on-device usage stats sheet

**What:** There was no way to see how much time goes to which site or to which part of it (Shorts, Reels, Watch).

**Change:** A Stats button in the fan, directly above History, opens a sheet with Today / 7 days / 30 days, total time, per-site time with bars and, per site, time per first-path-segment area (`/watch`, `/shorts`; handles and ids are filed as Other, the root as Home). The shell counts foreground seconds (`features/stats`) and flushes batches to Rust (`record_usage`, `get_usage`, `clear_usage`), which keeps them in `usage.json` (30 days, capped, validated). Nothing leaves the device; only site names, section names and seconds are stored; "Clear stats" wipes it. See [UI Design](docs/wiki/ui-design.md#stats) and [Security](docs/wiki/security.md).

### fix(siteview): no white or black flashes, no blocked first page

**What:** Cold start, opening a page and the first launch after an install showed a blank white or black screen, up to 7 s.

**Change:** Themed launch screen and a themed backdrop under every page; a new page is shown only after it paints (fade-in); `open` no longer waits for content rule lists to compile (they attach later without a reload) and Rust converts them at launch; the splash waits for the first page. On the simulator, unthemed frames went from 1.5-8 s to none (before/after table in [Platform Support](docs/wiki/platform-support.md#verified-results)), and scroll, inertia, pull-to-refresh, long-press, keyboard, button drag and sheet scrolling were checked there; pinch, hold-slide-lift and edge-swipe back were not.
### feat(settings): rework Settings and History, unlimited favorites, star pre-made recipes

**What:** Settings and History looked flat and crowded, favorites were capped at six, and pre-made sites could not be added to favorites.

**Change:** Both pages share a new frame (large title, grouped rows with hairlines, site tiles). Settings is regrouped into Appearance, Browsing, Pre-made recipes, Favorites, AI assistant and Data and help; the Sites section is now Pre-made recipes, and each recipe has a star that adds or removes its site (`set_site_favorite`, `meta.homepage` on bundled recipes). Favorites no longer have a limit: the first six are the quick-access menu in the fan, the rest list under More favorites, and every edit saves at once. `TooManyFavorites` is removed.

**PR:** n/a

## 2026-11-07

### fix(ui): reduce app icon padding

**What:** The padded icon master left too much empty space around the logo.

**Change:** Scale the logo in `assets/icon-source.svg` from 62% to 86% of the square and regenerate the platform icons.

### feat(ui): new logo, padded app icon, draggable back button

**What:** The logo was replaced; the app icon needed more padding and the optional back button was pinned to the bottom instead of floating.

**Change:** Update `assets/logo.svg`, regenerate `assets/icon-source.svg` (logo at 62% of a 1024 square) and all platform icons, and use the new mark for the floating button and first-run guide. The back button is now draggable, snaps to the nearer edge and remembers its position (`om.back`).

### feat(app): splash screen while the shell loads

**What:** The webview showed a black screen until the JS bundle booted and app state loaded.

**Change:** `index.html` paints a themed splash (logo mark on the ink background) before any script runs; `App` fades it out once `load()` settles (`src/app/splash.ts`). Large logo with pop-in, float and expanding-ring animations; honors `prefers-color-scheme` and reduced motion. Dev builds can set `VITE_SPLASH_MIN_SECONDS` (see `.env.example`) to keep the splash visible for a minimum time; ignored in production builds.

**Verified:** TypeScript, ESLint, Prettier and 94 frontend tests pass. **Not verified:** on-device iOS/Android cold start.

### feat(settings): free and paid model recommendations for BYOK

**What:** The AI assistant settings gave no hint where to get a key or which providers have free models.

**Change:** Add a recommendations card with provider websites (OpenRouter, OpenCode Zen / Console, local Ollama or LM Studio) and an OpenCode Zen preset. Distinguish free variants, paid usage and local hosting; note that OpenCode's free-tier chat models are not available to external clients. Update the AI assistant wiki page and README.

**Verified:** TypeScript, ESLint, Prettier and all 94 frontend tests pass in the feature worktree. Browser smoke at 390px with in-memory app/AI state: recommendation text, no horizontal overflow, and selecting Zen fills its name and URL. Provider terms and URL checked against official docs; the model-list endpoint returned HTTP 200. **Not verified:** native/on-device rendering or authenticated model generation.

**PR:** [#13](https://github.com/skepjandi/openmedia/pull/13)

### feat(recipes): pre-made recipes for 13 more platforms and update-safe forks

**What:** Only five sites had pre-made recipes, and a changed recipe would have been overwritten by the next app update.

**Change:** (1) New bundled recipes, each with a `meta.homepage` so the star in Settings > Pre-made recipes adds the site to favorites, for Threads, Telegram, Douyin, Messenger, Discord, Kuaishou, LinkedIn, WhatsApp, Snapchat, Pinterest, Weibo, TikTok and Twitch (annoyances such as install sheets, sign-in pop-ups and cookie bars default ON; suggestions, comments, counters and similar default OFF). WeChat and QQ have none: their logged-out pages offer nothing to hide. (2) Forks: a changed copy of a bundled recipe is saved in `<app_data>/recipes/<id>.json` with the same id and `forkedFrom`, replaces the bundled one while it exists, and survives app updates; the recipe card says so and offers "Restore the original". New Rust commands `save_recipe_fork` (validated, origin user/ai) and `restore_recipe_original`; the recipe store is now `Recipes::load(dir)`.

**Verified:** Rust tests for fork save, replace, reload after restart, restore, refusals (bundled/imported origin, unknown id, invalid selector, oversize writes nothing), damaged fork files ignored, and the listing flags (`customized`, `originalUpdated`); every new rule matches its DOM fixtures, no `hide` rule touches a `data-keep` element, and every homepage belongs to its own recipe (existing tests). Selectors were counted on the real logged-out pages in headless Chromium with an iPhone user agent, except LinkedIn, whose counts come from server-rendered HTML fetched with curl. **Not verified:** any logged-in selector; WebKit rendering and the switches on a simulator or device; `save_recipe_fork` has no UI caller yet (the assistant's accept step will call it); the Restore button was not rendered; Kuaishou and Douyin were reached only from a non-China network; TikTok's cookie rule, Twitch's ad slot and Discord's recipe are thin or best-effort.

**PR:** n/a

### fix(siteview): sign-in popups and a Safari user agent

**What:** On the iPhone 17 Pro Max simulator, Reddit's Continue with Google did nothing, and Continue with Apple's popup was loaded over the page or dropped.

**Change:** Pages that call `window.open` (Google and Apple sign-in) now get a real popup view above the site view, sharing its data store, closed when the page closes it; link clicks with `target=_blank` still load in the page. `javaScriptCanOpenWindowsAutomatically` is on. The site view and popups report a Mobile Safari user agent (with a `Safari` token) instead of WebKit's default, which Google treats as an embedded browser.

**Verified:** on the simulator, Reddit's Log In sheet: Continue with Apple opened its popup (`createWebView` logged), Continue with Google opened "Choose an account" with the already signed-in Google account, and choosing it logged Reddit in (header shows the account and notifications). Reddit's Open App button was gone in the same build. **Not verified:** other sign-in flows, that the new user agent changes nothing on Instagram, Facebook and X, a physical device.

**PR:** n/a

### feat(recipes): per-site options for the default favorites, bottom margin, favorites only in Settings

**What:** The five default sites could only be customized by editing code, Reddit's prompt removal could not be turned off, and the command bar could add to the favorites while browsing.

**Change:** Recipes gain `options` (named switches) and a per-rule `option`; annoyances default on, content off (tested). Bundled recipes for Instagram, Facebook, X (Twitter), Reddit and YouTube, one switch per thing worth hiding (Reels, Shorts, Stories, suggested posts, all posts, app prompts, sign-in pop-ups, Premium upsells, promoted posts, Grok, comments, related videos and more). Settings gets a Sites section with a card per site, a shared Bottom margin slider and a per-site override. Choices persist as overrides in `library.json` (no migration). `set_site_option` recompiles the script and the new plugin command `set_document_start_script` swaps it and reloads; it is Rust-only, not granted to the shell. The bottom margin shrinks the native view; Rust resolves which site a URL belongs to. The command bar's "add this page to favorites" button is removed. New wiki page `site-playbooks.md` records what every selector matched (`LIVE`, `SOURCE` or `INFERRED`), pitfalls, what CSS cannot do, and selector-writing rules for the in-app assistant.

**Verified:** Rust tests for option defaults, saved choices, per-site script compilation, matcher-based site lookup, margin bounds and persistence, and old library files loading; DOM fixtures for every rule, plus a check that no `hide` rule touches elements a fixture marks `data-keep`. Selectors were run against the real logged-out pages with an iPhone user agent in Chromium. The Swift plugin compiles for the iOS Simulator SDK. **Not verified:** any logged-in selector (Instagram feed, Stories and suggested posts; Facebook Stories; X premium, promoted and Grok rules; YouTube promos and ads); WebKit rendering; the switch, reload and margin on a device or simulator.
### feat(siteview): live sessions, domain pinning with a popup browser, and history

**What:** Opening a site closed the one before it, and going back to it reloaded it. A page could navigate away from its own domain. Favorites in the fan had solid white tiles.

**Change:** Every opened site is now a session, its own native view kept alive under the visible one. A favorite switches to its live session without reloading; a typed address always opens a new session, so a favorite's is never replaced. The shell closes hidden sessions that sit idle for 20 minutes, beyond a cap of 5 (typed before favorite, oldest first), or all of them on an OS memory warning. A session is pinned to its registrable domain: outside links, `target=_blank` and `window.open` open in an `SFSafariViewController` popup and the session stays put (redirects during the first load may still move the domain, e.g. `twitter.com` to `x.com`). New History button in the fan, directly above settings, lists typed addresses (newest first, up to 100); Settings has a confirmed "Clear history", which also forgets the last page. Library format v4 adds `history` and reads v2 and v3 files. Fan items now use the button's clear glass. Plugin API: `open` takes a `session`, new `activate` and `close(session)`, state events carry `session` and `scope`, new `siteview:closed` and `siteview:memory` events. [Security](docs/wiki/security.md#sessions-and-the-popup-browser), [UI Design](docs/wiki/ui-design.md#sessions) and [Platform Support](docs/wiki/platform-support.md) are updated.

**Verified:** unit tests for the session policy, history, fan geometry and the v3 to v4 migration; `scripts/test-domain-scope.sh` for the Swift domain rules. On a throwaway iOS 26.5 simulator against a local request-logging server: a live favorite and a live history entry switched with no new request; an external link and a `target=_blank` link opened the popup without moving the session; a closed (evicted) history entry reloaded; a posted memory warning (temporary hook, removed) closed hidden sessions; Clear history left `history: []` and `lastUrl: null` with favorites intact. **Not verified:** a physical device, the real Simulator memory-warning menu, the 20-minute idle sweep end to end, a dying web content process, and CPU. iOS gives this app no per-page CPU or memory figure [INFERENCE], so "too heavy" is bounded by idle time, count and memory warnings, not measured. Cross-domain sign-in (for example Google) now happens in the popup and cannot hand its cookies back to the session.

**PR:** n/a

### docs: MPL-2.0 license and open-source community files

Area: `docs`. Adds `LICENSE` (MPL-2.0), `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, issue/PR templates, Dependabot config, and license metadata in `package.json` and `Cargo.toml`.

### feat(shell): optional floating back button

**Change:** Some sites have no back control. Settings gets a "Back button" switch (default off, persisted as `backButton` in `library.json`; older files load with it off). When on, a floating button appears on the edge opposite the main button whenever the page `canGoBack`, and calls the existing `go_back` siteview command. New `set_back_button` app command; no native or capability changes.

**Verified:** `cargo test library` (default off, persistence), `ts:check`, `lint`, `format:check`, `vitest`. Not verified: on-device appearance and touch pass-through of the new hit region.

**PR:** n/a

### feat(shell): button-edge hold ring and YouTube favorite

**Change:** Keep the progress ring on the floating button's border instead of outside it, and remove the inward jump during a hold. Update the onboarding illustration to match. Add YouTube as the fifth default favorite; library v3 upgrades v2 files with the original four defaults without changing their IDs, and leaves customized lists and later removals alone.

**Verified:** browser geometry checks: the ring and button bounds match at rest (64 px) and during hold (83.2 px), without shifting the button's center. On the iOS 26.5 simulator, a native long press opened the fan and tapping YouTube navigated to `https://m.youtube.com/`. Physical-device appearance remains unverified.

**PR:** n/a

### feat(siteview): ad and tracker blocking from bundled EasyList and EasyPrivacy

**What:** Pages loaded every ad and tracker the site served.

**Change:** Add Brave's `adblock` crate (MPL-2.0) to convert `blocklists/easylist.txt` and `easyprivacy.txt` (compiled into the binary; no downloads) to WebKit content rule lists. `src-tauri/src/ad_block.rs` writes the JSON once per list version to the app cache; `tauri-plugin-siteview` looks each list up in `WKContentRuleListStore` by id, compiles it only on a miss, attaches it to the site view and removes stale ones. `open_site` passes the lists; the new `set_ad_block` command (and a Settings switch, default on) swaps them on the open page and reloads. Bare `if-domain` entries from the converter get a `*` prefix because WebKit matches them against the exact host only. A failure to build or compile the lists opens the page unblocked and shows a banner. See [Ad Blocking](docs/wiki/ad-blocking.md).

**Verified:** on the iOS 26.5 simulator against a local fixture page: Google Analytics and AdSense scripts blocked, the page's own script loaded, an `#ad_banner` element hidden; the switch off then on reloaded the page loaded-then-blocked (driven by timers in a temporary patch, not by tapping the switch); a changed list replaced the stored one; a list WebKit rejected left the page loading, the other list blocking, and a banner shown. **Not verified:** a physical device, real sites' look and breakage, cold-compile time on a device. Not built: Android, desktop, a per-site allowlist.

**PR:** n/a

### feat(shell): calmer button, favicons, themes, pull-to-refresh, and BYOK provider settings

**What:** The icon and button logo were small, the hold animation was too flashy, a thumb hid the ring, the fan had no site icons, a black bar sat under the page, settings had a confusing icon and no theme, API key or onboarding reset, and the page could not be pulled to refresh.

**Change:** Crop the logo to its artwork for the app icon and the button (the SVG's own `viewBox` had wide margins). The button is 64 px, translucent, with a 40 px logo; holding grows it about 30% and fills a ring outside it (shifted inward at the edge); the halo and hue animation are gone. The fan shows each site's icon, fetched natively from the site itself and cached by host. Remove the bar under the page. Settings is now four sections: Appearance (System, Light, Dark; also sets the site view's color scheme), Favorites, AI assistant, and Guide (Reset onboarding), with a sliders icon. Add native pull-to-refresh. Add BYOK groundwork: provider list with presets (Anthropic, OpenAI, Gemini, OpenRouter, custom), keys written to the Keychain through Rust (`SecretStore` trait over `keyring`) and never returned to the shell, and a connection test that lists models over `reqwest` with no redirects and fixed error messages. Dev builds use line-tables-only debuginfo to keep `target/` small.

**Verified:** on the iOS 26.5 simulator, by eye and through a temporary harness: favicons for three of four sites, a key saved to and removed from the Keychain with no key in the provider JSON or the error, theme and onboarding reset persisting, light and dark settings rendering, the ring staying on screen, and a Reddit video playing inline. **Not verified:** pull-to-refresh, a real provider accepting a key, Instagram's icon, a real device.

**PR:** [#1](https://github.com/skepjandi/openmedia/pull/1)

### feat(shell): logo, hold animation, onboarding, and a Reddit app-prompt recipe

**What:** The button was a plain dot, holding gave no feedback, there was no guide, and Reddit's "Open App" prompts got in the way in the web view.

**Change:** Use `assets/logo.svg` for the app icon (new square master `assets/icon-source.svg`, icons regenerated) and for the floating button, and move the palette to the logo's cyan. Holding fills a ring and pulses a halo whose hue drifts. Add a four-step first-run guide, replayable from Settings (`onboarded` in `library.json`). Add the first slice of the recipe engine in Rust (schema subset, selector and declaration validation, URL matching, CSS compile, one document-start script) and a bundled `reddit.no-app-nag` recipe with a DOM fixture test; the shell now opens pages through the async `open_site` command, and the plugin's `open` is no longer granted to it. Enable inline video playback. Verified on the iOS 26.5 simulator by eye: the Open App button is gone on live Reddit, the logo and hold animation render, and onboarding renders. Not verified: the 30-second blocking modal, inline video, a real device.

**Fix:** the first build of `open_site` was synchronous, which deadlocked the app on the main thread (black screen, no errors). It is `async` now and the rule is in the development guide.

**PR:** n/a

### feat(shell): floating-button UI over a native site view

**What:** The first UI was a home list plus a browser screen with a toolbar; the page was never the whole screen.

**Change:** Replace it with one full-screen page and a draggable, edge-snapping floating button. Tap opens a command bar (addresses; the AI prompt is not connected yet), hold fans out favorites (Instagram, Facebook, Twitter, Reddit by default) with settings set apart, and settings edits the favorites. The native site view now sits below a transparent shell with a native `TouchRouter` and shell-reported interactive regions. Library v2 keeps one hidden profile, favorites and the last page; profiles UI, home/tabs and the Android Kotlin code are removed. Fixes a React crash from an unstable Zustand selector and an invalid `Info.plist` left by an earlier cleanup. Verified on the iOS 26.5 simulator with synthetic pointer events and a native hit-test log; not with a real finger or device.

**PR:** n/a

### feat(shell): iOS-first app foundation

**What:** The repository had docs only.

**Change:** Add the Tauri v2 + React/TS app, a Rust library for profiles and saved sites (`library.json`, atomic writes), the in-repo `tauri-plugin-siteview` (iOS `WKWebView` host with per-profile data stores, state events, http/https-only navigation, a write-only page bridge; Android Kotlin source included but never run), a home view and a browser view, ESLint/Prettier/Vitest/clippy tooling, and `ci.yml`. Verified on the iOS 26.5 simulator against a local fixture only. Desktop site views and Android verification are deferred; iOS 17 is the minimum.

**PR:** n/a

### docs(wiki): mobile-first priorities and corrections

**What:** The wiki ranked macOS as a first platform, overstated the SocialLite comparison, and left the bridge decision open.

**Change:** Make iOS and Android first-class and defer desktop, hedge the SocialLite mechanism claim, label unverified prior-art and advisory claims, record the iOS verification results, and settle the mobile bridge, iOS 17 minimum, and Android profile-isolation requirement.

**PR:** n/a

### docs: bootstrap agent rules, changelog, wiki, and roadmap

**What:** The repository had no contributor guidance, no documentation surface, and a generic Node `.gitignore`.

**Change:** Add `AGENTS.md` (wiki-first, worktree-only, architecture invariants for a no-backend BYOK app), this changelog, the `docs/wiki/` source tree with its sync workflow, and a phased roadmap. Extend `.gitignore` for Tauri/Rust, iOS/Android, signing material, and agent worktrees.

**PR:** n/a (initial bootstrap)

### docs: add logo and README

**What:** The project had no brand mark or README content.

**Change:** Add `assets/logo.svg`, reference it from `README.md` and the wiki index (absolute raw URL there, since relative paths do not resolve in the flattened GitHub Wiki), and plan icon generation in Phase 1.

**PR:** n/a
