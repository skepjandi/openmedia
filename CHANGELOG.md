# Changelog

All notable changes to OpenMedia are documented here.

> **Format**: loosely based on [Keep a Changelog](https://keepachangelog.com/), grouped by date descending. Each entry references the originating PR (when available) and names the area from the conventional-commit prefix.
>
> **Wiki**: the [GitHub Wiki](https://github.com/skepjandi/openmedia/wiki) is the public-facing main wiki — architecture, recipe format, AI pipeline, security model, roadmap. Source-controlled editing surface is `docs/wiki/` in this repo; CI (`.github/workflows/sync-wiki.yml`) mirrors it to the GitHub Wiki on every merge to `main`. New single-PR changes belong here, not as new wiki pages.

### fix(video): the small player no longer hangs a page that restyles its video (YouTube)

**Area:** `fix(video)`

**Change:** The small player re-applied its styles to the lifted video on every change of the video's style. YouTube's player restyles its video on every change too, so the two fed each other without end: the page's content process sat at 96% CPU and the page, and with it the app, stopped responding after a tap on another video. The re-apply now waits 250 ms, runs only when the box's styles are gone, and gives up after 40 times. Found by sampling the spinning process on the simulator.

### feat(video): the float button opens a small player in the bottom right corner

**Area:** `feat(video)`

**Change:** The float button in the video controls no longer asks the system for a picture-in-picture window (which on a device froze the page and on the simulator showed nothing). It lifts the video out of the page into a small player in the bottom right corner, above everything, with its own close and play/pause buttons and a drag anywhere else on it; the page's own player is left empty. Close, the end of the video, or a site loading another video into the same player puts the video back where it was. It works on every platform. On iOS, tapping a link, Back or the address bar while it is up keeps the page alive as a small window of its own in the corner, so the video plays on over the next page until it is closed (`placeCorner`, `miniWindow`); a minimized app keeps the page out of suspension while the player is up. The failure line and the app-side float request are gone with the system window.

### fix(siteview): a cold start whose last page cannot load no longer sticks on the logo (iOS)

**Area:** `fix(siteview)`

**Change:** The launch logo came down only when a page painted. When the page restored at launch failed before it committed (offline, server down), nothing painted, so the logo stayed under the error with no spinner and no way forward. A failed load now takes the logo down, so the app shows its dark backdrop, the controls and the error.

### fix(siteview): a floating video keeps playing when the app is minimized, and the panel says why a video would not float (iOS)

**Area:** `fix(siteview)`

**Change:** Leaving the app now opens a floating window for the playing video on any site, not only those in the picture-in-picture list; the page stays alive (not suspended) while its window is open, and the flag resets when the app returns. When the float button cannot float a video, the panel shows a line (supported, mode, error) for nine seconds instead of closing silently. Not verified on hardware: the simulator has no picture-in-picture window.

### feat(siteview): a float button in the video controls, and a floating video that survives Back (iOS)

**Area:** `feat(siteview)`

**Change:** The video controls panel has a new button beside mute (a picture-in-picture icon). It takes the video out of the page into a floating player that plays until the reader closes it; pressed again, it puts the video back. The page tries first; if the engine refuses without a gesture it recognises, it asks the app, which runs the request from outside the page, where WebKit counts it as one. The button is shown only where the engine can float a video (iOS Safari's engine), so it is not there on Android or desktop.

A floating video now survives leaving its page. Before, Back and an address typed in the command bar loaded the next page in the same web view, which destroys the page and the window with it (only a favorite's Home kept it, by switching to another view). Now, when the page in front has a video floating (opened from the button, or a video with sound playing), the app puts a fresh view in the session for the next page and keeps the old page alive, hidden, for the window. The hidden page cannot navigate and sends the app nothing. It is dropped when its window is closed, or when the page in front plays a video of its own. One cost: the fresh view has no history, so the Back arrow is dim until the reader navigates again.

**Verified:** Vitest (`videoControls.test.ts`: the button, the page's own try, the app's fallback, no button where the engine cannot float), ESLint, `tsc`, `swiftc -parse`; on the iOS 26.5 simulator, with the float answer forced on because the simulator reports no picture-in-picture support (`webkitSupportsPresentationMode` is false): an address change swapped in a fresh view and the old page kept running (its log kept ticking), Back showed the earlier page, and opening a page that plays its own video ended the float. The button shows beside mute and the panel steps aside when it is pressed; the page reports the app's handler is present. **Not verified:** the floating window itself and any of this with real picture-in-picture, on a device; Android.

**PR:** n/a

### fix(siteview): no mute icon pops on a tap in Reels

**Area:** `fix(siteview)`

**Problem:** Since the press was given back to the site (so swiping works), Instagram's Reels showed their sound badge (a dark circle with a speaker) on every tap.

**Change:** After a press on the video, whatever small, visible thing sits near the video's centre (at most 35% of the video, 16 px or more) gets `opacity: 0` and `visibility: hidden` for 1.5 s, then its own values back. It is found by scanning the page, not by where it is hit or what it is made of: the badge takes no pointer and sits inside the site's big tap-catching button. The scan runs every 60 ms for that time and stops, giving everything back, the moment the press moves (a swipe) or the browser cancels it, so a swipe is never slowed or left with things hidden. The cancel this script sends the site after a tap is ignored.

**Verified:** Vitest (`videoControls.test.ts`), ESLint, `tsc`; on the iOS 26.5 simulator on Instagram Reels: 0.12 s and 0.3 s after a tap the badge is not shown (it was before this change), and three taps each followed by a swipe still landed on a new Reel. **Not verified:** other sites' tap icons; Android; a device; the cost of the scan on a very large page.

**PR:** n/a

### fix(siteview): swiping and dragging a Short or Reel works again

**Area:** `fix(siteview)`

**Problem:** After the tap-controls change, sliding to the next video or dragging one often did nothing in Shorts and Reels, and a Reel sometimes stopped with the next one showing a little at the bottom. A press on the video was hidden from the site until the touch was known to be a tap, so a page that drags with pointer events never saw the drag begin (and a replay of the press, tried as a fix, gave it a wrong start time, so its snap overshot). Separately, the touch of a swipe made within 0.7 s of a tap was swallowed with the tap's.

**Change:** The press is always the site's again. A tap is still found from the pointer and the touch and kept from the site (pointer release, touch end and click, once each); the sound is still put back if the press changed it. What a tap leaves waiting (its touch end and click) is dropped when the next press begins, so a swipe after a tap is never swallowed, and a site button tapped soon after a tap gets its click. A Reel's mute icon may flash on a tap again: that is the price of letting the site have the press.

**Verified:** Vitest (`videoControls.test.ts`), ESLint, `tsc`; on the iOS 26.5 simulator on Instagram Reels, six swipes (plain and right after a tap) each landed on a new, fully snapped Reel. **Not verified:** YouTube Shorts after this change (the run did not finish), Android, a device.

**PR:** n/a

### fix(siteview): a tap never mutes or unmutes a Reel, and Instagram's "Continue watching in the app" wall is hidden

**Area:** `fix(siteview)`

**Problem:** On Instagram Reels a tap showed the panel and also unmuted, and the tap that closed the panel muted the Reel again: Instagram toggles the sound on the press, before the app knows the touch is a tap. Separately, "Continue watching in the app" (with Sign up for Instagram and Open app) sometimes covered a Reel and nothing hid it: it is not a dialog, so the existing app-prompts rule missed it.

**Change:** The press on the video is no longer shown to the site (a press on one of the site's own buttons still is), so a player that toggles the sound on it, with an icon that pops in, never does; a touch that is a swipe reaches the page through its own touch events. As a safeguard the sound is also noted on the press and put back if it changed, so only the panel's mute button changes it. The Instagram recipe (2.0.2) gets `reel-app-wall` under the on-by-default app-prompts option: it hides the `div[role=group]` that holds the backdrop and the card, found by its `a[href*="/accounts/signup"]`. Found by driving headless Chrome with an iPhone user agent over CDP, logged out, on `/reels/` after scrolling to the next reel (it appears on some loads only); a fixture (`logged-out-reel-wall.html`) covers the rule.

**Verified:** Vitest (`videoControls.test.ts`), `cargo test --lib` (the fixture test), ESLint, `tsc`; on the iOS 26.5 simulator on a Reel: the sound state is the same after a tap, a second tap and a third, no mute icon shows 0.25 s after a tap, and a swipe still moves to the next Reel. **Not verified:** that the wall is hidden on a device (the simulator's Instagram is logged in; it showed in headless Chrome only).

**PR:** n/a

### fix(siteview): the panel no longer opens a site's menu, takes Instagram's tap catcher, and a leaving page's video floats (iOS)

**Area:** `fix(siteview)`

**Problem:** On Shorts a tap that showed the panel also opened YouTube's long-press menu (Description, Save to playlist, Captions, Playback speed) under it. The page saw the touch begin and never saw it end, so its hold timer ran out. (The same thing made a watch page show its hold-for-2× badge.) Taps on the panel's empty parts fell through to the site's buttons beneath it. On Instagram Reels a tap only muted, because the player puts one transparent `role=button` over the whole video and that was taken for one of the site's buttons.

**Change:** A tap the panel keeps is now followed by a `touchcancel` to the site, so no hold timer fires. The panel's card catches touches, and touches on it are kept from the site's handlers. A button that covers at least half the video is the site's tap catcher, not a button. A tap is also found from the pointer, which is cancelled for the site like the touch, because Instagram mutes when the pointer is released, before the touch ends. On iOS, leaving a page that is playing a video with sound (Back, an address, a favorite, Home) floats the video in a picture-in-picture window instead of suspending the page; the page stays alive, hidden, until the window is closed or the page in front plays a video of its own. This applies to every site, not only those with the picture-in-picture switch on (that switch still decides leaving the app).

**Verified:** Vitest (`videoControls.test.ts`), ESLint, `tsc`, `swiftc -parse`; on the iOS 26.5 simulator on YouTube Shorts: a tap shows the panel and no menu opens, and a tap on the panel over the Comments button does nothing; switching favorites and opening addresses still works with the float attempt in the path. **Not verified:** that Instagram no longer mutes on a tap (unit-tested only); the floating window itself (the simulator reports no picture-in-picture support, so the attempt always answers no there), Instagram Reels (no account), Android (no mini player is built there).

**PR:** n/a

### feat(siteview): tap a video for OpenMedia's own controls, with a height per favorite

**Area:** `feat(siteview)`

**Change:** In full-screen feeds (Shorts, Reels, TikTok) the controls are hidden until the video is tapped. A tap now shows OpenMedia's panel in place of the site's own tap: pause and play, back and forward 6 seconds, mute, speed, the time left and a seek bar. It goes away after a few seconds, but stays on a paused video. A tap on a button of the site's own is left to the site. A watch page keeps the site's own player, which has much more (captions, quality, hold for 2×); a switch, "Also on full videos", in Settings and per favorite, off by default, puts the panel there too. The remembered speed and sound are now applied only where the panel is in charge; before, a saved 2× was put on every video, which made YouTube show its own "2×" badge on a watch page. There is no volume bar: sites reset a volume a page sets, so it only snapped between muted and full; mute is a button. A tap is found from the touch, because the watch page's player cancels the click. The panel is on by default; Settings > Video controls can turn it off and sets how high it sits (16 px by default). Each favorite's edit form has the same two choices for that site alone: turn the panel off to get the site's own controls back, or give it its own height. The old always-visible seek bar and speed button switches are gone (their choices are not kept; the panel has both). The page script gets the per-site choices by registrable domain, so no site is named in the engine. A double tap to like no longer reaches a site while the panel is on there; turn the panel off for that favorite to get it back.

**Verified:** Vitest (`videoControls.test.ts`, `feedPlayer.test.ts`, the i18n catalog), `cargo test --lib`, clippy, ESLint, `tsc`; on the iOS 26.5 simulator (Shorts and a watch page) and an Android API 36 emulator (Shorts, before the watch-page and touch-tap changes): the panel shows on a tap and the site's own tap is kept from the site, pause, play, skip, mute and speed work, it hides after a few seconds and on a second tap, a per-site height moves it, a per-site off gives the site's own controls back, and the Settings and favorite forms save to `library.json`. **Not verified:** a physical device; Instagram, Reels and TikTok (no account); the translations are machine-made.

**PR:** n/a

### fix(siteview): the seek bar sits clear of the bottom edge

**Area:** `fix(siteview)`

**Problem:** The seek bar and its time-left and speed row were fixed at `bottom: 0` of the page, so on iOS they sat under the home indicator and on Android against the gesture bar.

**Change:** The controls are now 16 px above the bottom edge plus the page's bottom safe area (`env(safe-area-inset-bottom)`).

**Verified:** Vitest (`videoControls.test.ts`), the iOS 26.5 simulator (iPhone 17 Pro Max) and an Android API 36 emulator on YouTube Shorts: the bar sits above the home indicator and the gesture bar. **Not verified:** a physical device; a three-button Android navigation bar.

**PR:** n/a

### fix(ui): the loading spinner always spins

**Area:** `fix(ui)`

**Change:** `Spinner` used `motion-safe:animate-spin`, so with the system's reduced-motion setting on, the ring opened on a site stayed still and looked stuck. It now spins always.

**Verified:** Not run. Not checked on a device.
### fix(siteview): Instagram's home feed no longer lags, and Reels and Shorts start without a tap

**Area:** `fix(siteview)`

**Problem:** The home feed stuttered on pages with video. Every page ran two whole-document mutation observers (the feed player's, which searched each added node for videos, and the iOS picture-in-picture guard's), and Instagram changes the DOM constantly while scrolling. Shorts stopped on a still frame after a swipe until a tap: reproduced on the iOS 26.5 simulator, where YouTube now parks the paused video at `left: -9999px` as well as above the screen, and the player, which only undid the vertical park, found no video in view and never played. Reels sometimes stayed still until the reader swiped on and back: a site pause right after a tap on its tab bar was taken for the reader's and kept the video paused. A play refused even when muted (low power mode) was never sent to native play.

**Change:** The player places a parked video by its wrapper whichever way it was parked. The feed player ignores mutations outside a feed (videos still reach it through their own events). The picture-in-picture guard listens for `play` and `loadstart` instead of observing the document. A pause counts as the reader's only once the video has played for 600 ms. A refused muted play also asks native code to play. Pull to refresh is not swapped in or out while the page is still moving or pulled past its top.

**Verified:** Vitest (`feedPlayer.test.ts`: four new tests that fail on the old script; full suite), ESLint, `swiftc -parse`, and on the iOS 26.5 simulator on YouTube Shorts: before, the first swipe left a frozen frame until a tap; after, swipes through Shorts keep playing without a tap. **Not verified:** a device; Instagram (needs a logged-in account); whether the native refresh-control guard removes the snapping.

**PR:** n/a

### feat(ui): frosted, translucent title card on full-screen pages

**Area:** `feat(ui)`

**Change:** `Screen` (settings, favorites, tabs, history, library, stats, paywall and the other full-screen pages) now pins its title card to the top as translucent glass (`bg-ink/60`, `backdrop-blur-xl`, saturated) and the page scrolls underneath it. The page itself is the scroller and the header is `sticky`, so the body starts below the card and no height is measured; `scroll-padding-top` keeps `scrollIntoView` targets clear of the card.

**Verified:** `tsc`, ESLint, Prettier, Vitest. **Not verified:** how it looks on a device (iOS, Android, desktop), including Android's `backdrop-filter` and the light theme.

### chore(recipes): trim the official library from 320 to 142 recipes

**Area:** `chore(recipes)`

**Change:** Dropped the long tail: niche archives, regional news, obscure radio/music directories, free-TV aggregators, dev/productivity and tech-brand sites. Kept what people open daily: video and anime streaming, music, radio, podcasts, social, shopping/e-commerce, search, AI, major news, maps/travel. Removed the recipe, fixtures, bundled icon, category and discover entries for each; the Popular shelf now leads with media and shopping.

**Verified:** see PR. **Not verified:** on device.

**PR:** n/a

### fix(android): align 64-bit native libraries for 16 KB memory pages

**Area:** `fix(android)`

**Change:** Google Play rejected version code 1009: "Your app does not support 16 KB memory page sizes". NDK r27 links with a 4 KB maximum page size, so `libopenmedia_lib.so` had 4 KB-aligned LOAD segments. `src-tauri/build.rs` now passes `-Wl,-z,max-page-size=16384` when linking the cdylib for `aarch64` and `x86_64` Android (32-bit ABIs are exempt).

**Verified:** Built the arm64 release APK; `llvm-readelf` shows LOAD alignment `0x4000` (was `0x1000`), and `zipalign -c -P 16` passes. **Not verified:** x86_64 build, Play Console re-upload, on a 16 KB device.

**PR:** n/a

### feat(siteview): picture-in-picture for a favorite's videos, off by default (iOS)

**Area:** `feat(siteview)`

**Change:** A favorite's editor has a new switch, "Picture-in-picture video" (off by default, iOS only, not offered for incognito). When on, the site's video can float in a PiP window from its player, and a playing video with sound floats on its own when you leave the app and returns when you come back, as in YouTube. When off, every `video` on the site gets `disablepictureinpicture`. The list is saved in `library.json` (`pictureInPictureSites`, registrable domains) and passed through a Rust-only plugin method, `set_picture_in_picture`. The iOS app gains the `audio` background mode, which PiP requires. Android and macOS accept the list and do nothing. New strings `favorites.pictureInPicture` and `favorites.pictureInPictureNote` in every locale.

**Verified:** Vitest (`app`, `i18n`), `tsc`, ESLint, Prettier, `cargo test` (`library`), `cargo clippy --workspace -D warnings`, and the Swift plugin compiled for `aarch64-apple-ios-sim` at iOS 17 (`IPHONEOS_DEPLOYMENT_TARGET=17.0`). **Not verified:** on a device or simulator: that WebKit starts PiP when the app resigns active, that the video keeps playing while floating, and App Review's answer on the audio background mode.

**PR:** n/a

### feat(tabs): reset a tab to its start page

**Area:** `feat(tabs)`

**Change:** Each open tab on the Tabs page has a reset button beside close. It reopens the tab on the address it was opened with and drops its Back history, including pages restored from before a restart. The only open tab can now be closed too, leaving the empty page. New string `tabs.resetOne` in every locale.

**Verified:** `tsc`, Vitest (`app`, `i18n`, `tabs`). **Not verified:** on a device.

**PR:** n/a

### fix(adblock): YouTube video ads no longer leave a black screen, and Shorts ads are removed

**Area:** `fix(adblock)`

**Problem:** On YouTube the ad's video request was blocked but the ad stayed scheduled, so long videos showed a black screen. Shorts and feeds still carried ads. The uBlock Origin scriptlets in Brave's lists that remove ads from the player data never ran: the bundled resource set does not contain them, and Android had no YouTube rules.

**Change:** New scriptlet `openmedia-youtube-ads` (`blocklists/openmedia-youtube-ads.js`, enabled by `blocklists/openmedia-specific.txt`) strips ad lists and ad items from player, feed, search and Shorts responses on every platform, and a watchdog skips or reloads an ad that is already in the stream. Scriptlets now also match `www.`/`m.` forms of the starting host. YouTube recipe 2.2.0 hides ad slots in phone feeds and between Shorts.

**Verified:** `cargo test` (`ad_block`, `recipes`), Vitest (`youtubeAds.test.ts`). **Not verified:** on a device against live YouTube ads.

**PR:** n/a

### feat(favorites): the rest of the favorites get pages of their own

**Area:** `feat(favorites)`

**Change:** There is no telling how many favorites someone has, so the lists no longer grow in place. The Tabs page shows quick access and, past the first six, a *More favorites · N* button to a Favorites page that lists every favorite of the set in use (the incognito one while incognito); without Pro the entries past the fourth are locked and open the paywall. In Settings the *More favorites* disclosure became a button to a page with the same editing (reorder, edit, remove), and the incognito favorites section has the same page, which is loaded on open and forgotten on close or when the app goes to the background like the incognito recipes page. The Tabs page now follows the incognito set while incognito. No new strings. Replaces the previous Tabs-page section from #207.

**Verified:** `tsc`, ESLint, Prettier, Vitest (459, the sheet-parent test now covers both pages). **Not verified:** layout, and the incognito unlock/forget flow, on a device or simulator.

**PR:** n/a

### fix(siteview): short-video feeds play on their own

**Area:** `fix(siteview)`

**Problem:** In Shorts and Reels some videos sat on a still frame until tapped, and some never played. On iOS the site views required a tap for any playback with sound, so a Short or Reel that starts unmuted was refused. Nothing retried the refused play, and a video the app paused when the page was hidden could resume out of view.

**Change:** iOS site views no longer require a tap for playback. A new page script (`src-tauri/src/feed_player.js`, run on every platform after the accessibility script) finds the video that fills the screen in `/shorts`, `/reel(s)` and TikTok feeds once scrolling settles, plays it (muted if the engine still refuses sound), stops videos that scrolled out of view, retries on `canplay` and when the page returns, and leaves a video the reader paused alone until it leaves the screen. The background pause/resume scripts (Android, macOS) set a hold flag so the feed player does not fight them, resume only elements still on the page, and wake the player on resume. Epilepsy protection (calm mode) still stops autoplay and switches the feed player off.

**Not verified:** on a device. The player was run against a stub DOM only; autoplay on iOS, Android and the live sites still needs a manual check.

### feat(release): versioned release title and notes generated from commits

**Area:** `feat(release)`

**Change:** `yarn ota app` creates the `v<version>` release titled `OpenMedia <version>: <newest feature>`, with notes grouped into New / Fixed / Other with PR links and a compare link (`scripts/lib/release-notes.mjs`); the updater's `latest.json` uses the same notes. The rolling `ota` release is retitled and re-noted with the version and changes on every web publish. The app and manifest jobs fetch full git history so the notes can read tags and commits.

**Verified:** `vitest` on `scripts/lib`. **Not verified:** a real `yarn ota app` run.

**PR:** n/a

### fix(sessions): a subdomain favorite no longer opens the main site's session

**Area:** `fix(sessions)`

**Problem:** With YouTube as a quick action and open, tapping YouTube Music switched to the YouTube session, because both share the registrable domain `youtube.com`.

**Change:** A favorite now reuses a live session only when it was opened on, or shows, the same host, ignoring a leading `www.`, `m.` or `mobile.`. Other subdomains such as `music.` get their own session.

**Verified:** Vitest (new case in `sessions.test.ts`), `tsc`. **Not verified:** on a device.

**PR:** n/a

### feat(store): panoramic App Store and Google Play artwork

**Area:** `feat(store)`

**Problem:** The listing images were eight separate cards (a flat colour per slide, a boxed phone), so the gallery looked like a stack of unrelated posters.

**Change:** `scripts/render-store-assets.mjs` now draws each set (iPhone 6.1/6.3/6.9, iPad 13, Android phone and tablet, Mac) as one panorama and slices it into the 8 images: a continuous backdrop, a ribbon and ripples that cross every seam, a particle field that thins from left to right, glass-rimmed devices, a pill eyebrow, and one fan-menu zoom card that reaches from slide 2 into slide 3. Android sets are frameless, as Google advises. The Google Play feature graphic uses the same scene with frameless screenshot cards instead of phones. The Mac sizes other than 2880 × 1800 are downscales of it. Sizes, file names and copy are unchanged. `--panorama` writes the full strip for review.

**Verified:** every output has the store size and no alpha channel; checked by eye on each strip. **Not verified:** how the first three slides look in App Store Connect's preview or on a device.

**PR:** n/a

### feat(history): clear all and delete single entries on the History page

**Area:** `feat(history)`

**Change:** The History page has a Clear button (with a Cancel / Clear confirmation) and a remove button on each row. Single removal is a new `remove_history` command (`Library::remove_history`) that returns the remaining history and prunes unused icons. No new strings: it reuses `common.clear`, `common.cancel` and `common.remove`.

**Verified:** `tsc`, ESLint, Prettier, `cargo test --lib library` (65/65, new test for removing one entry). **Not verified:** the layout on a device or simulator.

**PR:** n/a

### fix(fab): the arrow on the collapsed button's tab is visible on light pages

**Area:** `fix(fab)`

**Problem:** The tab left at the screen edge when the floating button is hidden is clear glass with a white arrow, so on a white page (Google) the arrow could not be seen.

**Change:** `.fab-peek` has a dark tint behind the glass rim, so the white arrow reads on any page.

**Verified:** Prettier. **Not verified:** on a device or simulator.

**PR:** n/a

### fix(incognito): no second biometric check while incognito is on

**Area:** `fix(incognito)`

**Change:** Entering incognito already passes Face ID, Touch ID or the passcode, so while it is on the incognito recipes row, the incognito favorites section and *Add to incognito* in the recipe library open without another check, and their fingerprint icon is hidden. Outside incognito they still ask. `unlockIncognito` returns true when incognito is active (after the Pro check).

**Verified:** `yarn ts:check`, Vitest `src/app` (48). **Not verified:** on a device or simulator.

**PR:** n/a

### feat(onboarding): search and filters in the quick-access step

**Area:** `feat(onboarding)`

**Change:** The guide's "What do you need in quick access?" step now has the library's search box and Filters dialog (Discover, Type, Category, with live counts), so a list of 100+ official recipes can be narrowed. `onboarding_options` also returns `popularRank` and `isNew`. The library's filter logic is generic over any item with name, summary and tags, and `FilterDialog` takes an optional list of sections.

**Verified:** TypeScript, ESLint, library and onboarding unit tests, Rust recipe tests. **Not verified:** the step on a device or simulator.

**PR:** n/a

### feat(library): add Popular and New discovery shelves

**Area:** `feat(library)`

**Change:** The recipe library now surfaces *Popular* and *New* shelves for unadded recipes, with *See all* actions, a Discover filter section with live counts, popularity-ranked results, and a *New* badge. The editorial lists are bundled in `recipes/discover.json`; they are maintainer selections, not usage data. No telemetry or trending claims.

**Verified:** Library, i18n and shared-icon tests, TypeScript, ESLint, Rust recipe tests (114). **Not verified:** visual behavior on device or simulator.

**PR:** n/a

### feat(library): filter popup, status filter, faster list and 307 bundled icons

**Area:** `feat(library)`

**Change:** The recipe library's *Filters* button now sits beside the search box (it was the last chip in a scrolling row, off screen on a phone) and opens a popup with sections for source, platform, type, **status** (not added, added, update available) and category, each chip with a live count. The chips that are on show under the search as removable chips with the result count. The list is built for 300+ recipes: it is indexed once (tags, status, search text), the counts are one pass per kind instead of one filter pass per chip, the search is deferred while typing, rows are memoized, drawn thirty at a time as you scroll and skip layout when off screen, and tile images load lazily. Bundled site icons are now emitted as files instead of inlined, which takes 313 KB of base64 out of the entry chunk (1.65 MB to 1.34 MB). `yarn icons:fetch` reads each site's own files in parallel (homepage links, the bare and `www.` forms, the web app manifest, the Windows tile, `/favicon.*`), lets `google.com` and `duckduckgo.com` use their own files, remembers sites that offer nothing for 30 days, and **no longer fails the build when a site has no icon** (`--strict` restores that). It was exiting 1 with 46 misses, which broke `yarn build:web`. `--site <slug> --file <path> --source <url>` adds an icon a browser took from a page that turns scripts away. 307 of 319 recipes now ship an icon (273 before). The 60 recipe files from #180 are formatted so `yarn format:check` passes for them.

**Verified:** Library, i18n and icon unit tests (new tests for status, facet counts and the index), TypeScript, ESLint, `vite build`. **Not verified:** the popup and list on a device or simulator (no Tauri IPC in a browser preview). 12 sites still have no icon (`7plus`, `british-pathe`, `crackle`, `crunchyroll`, `epic-games`, `fandango-at-home`, `hulu`, `liveatc`, `pocket-casts`, `shudder`, `temu`, `xumo-play`): they block scripts and browsers from here, or redirect to another brand; they show the monogram or the icon the site serves when opened. The new locale labels are English in every language. `blocklists/brave-resources.json` also fails `format:check` and is not touched here.

**PR:** n/a

### feat(tabs): a New tab button on the Tabs page

**Area:** `feat(tabs)`

**Change:** The Tabs page has a New tab button above the open sites. It shows an empty page and opens the command bar on it; the open sites stay alive and listed. Opening an address, a search, a favorite, a history entry or an open site replaces the empty page. While it shows, the app treats the screen as having no page (Back, usage tracking and the assistant ignore the hidden site). One new string, `tabs.newTab`, in all 29 locales; the 28 non-English versions are mine and need a native-speaker review. Google was already the default search engine (Rust `SearchEngine::default` and `DEFAULT_SEARCH_ENGINE`); a library that saved another engine keeps it.

**Verified:** `tsc`, ESLint, Prettier, new store tests for the New tab flow. **Not verified:** the layout and the empty page covering a live site on a device or simulator.

### feat(recipes): 300 official recipes and category filters in the library

**Area:** `feat(recipes)`

**Change:** `recipes/official/` gains 300 recipes: a curated set of 150 popular general sites and 150 media, streaming, radio, podcast and video-archive sites inspired by FMHY (free services; piracy-focused sites left out), including `market.official.youtube-music`. Each hides cookie-consent dialogs, Google ad slots and app-install banners, one switch per group; YouTube Music hides its `ytmusic-*` promos and Premium upsell. Most fixtures are synthetic and prove only selector behavior on hand-written DOM. A subset now has dated live-check notes; some fixtures are sanitized site excerpts, while others minimally reproduce a live-observed selector and are not page captures. `recipes/categories.json` gives each bundled recipe one to three subject categories, shown as tags, and the library's new *Filters* dialog filters by source, platform, type and category with live counts. Site icons were bundled when the site exposed a fetchable image; the rest use the existing on-demand favicon path.

**Verified:** Rust recipe tests; TypeScript, lint, library, i18n and icon tests (existing PR evidence). A logged-out desktop Chromium sweep attempted 201 generic-recipe homepages: 44 rendered empty, region/error or anti-bot states; generic selectors matched on 29, but many hits were hidden helper elements. Only a small subset has manually confirmed visible matches and selector-specific fixture coverage. **Not verified:** complete live selector coverage, signed-in or mobile behavior, or the dialog on a device; 46 sites exposed no fetchable image icon; new locale labels use English text.
### feat(recipes): choice options and richer official recipes

**Area:** `feat(recipes)`

**Change:** A recipe option can now be a list of 2 to 4 states instead of an on/off switch (`choices` on the option, `choice` on its rules; the first choice leaves the page alone), so a thing can be shown, blurred, dimmed or hidden. Settings shows a row of states for such an option, the recipe review lists them, saved boolean choices keep loading, and a saved value an option no longer accepts falls back to its default. The assistant can set a choice option through `existingOption` with `choice`. The Worker validator accepts the same fields. The 18 official recipes were researched again (logged-out headless Chrome plus community filter lists) and gained many options, most of them blur/dim/hide choices for pictures, avatars, counters and suggestions; thin recipes (Discord, Messenger, Kuaishou, WhatsApp, Threads, Telegram) grew the most. Schema stays 1. Format: `docs/wiki/recipe-format.md#choice-options-more-than-on-or-off`.

**Verified:** Rust recipe, sites, library, AI and fixture tests; TypeScript check, ESLint and Vitest; Worker `tsc` and Vitest. **Not verified:** on a device, and logged-in selectors (marked `SOURCE`/`INFERRED` in `docs/wiki/site-playbooks.md`).

**PR:** n/a



### fix(back): Back survives a restart

**Area:** `fix(back)`

**Change:** After a restart the page had no history of its own, so the back button was greyed out. The shell now tracks the pages behind the current one (up to 20) and saves them with the last URL as `lastBack` in `library.json` (older files load empty; cleared with history; not saved while incognito). Once a page has no history of its own, Back opens the previous saved page in a new session. Forward history from before the restart is not kept.

**Verified:** `tsc`, ESLint, Prettier, `vitest` (434/434, new `trail.test.ts`), `cargo test library` (61/61). **Not verified:** the restart behaviour on a device or emulator.

### feat(accessibility): epilepsy protection and dyslexia aids

**Area:** `feat(accessibility)`

**Change:** Settings has an Accessibility section. Epilepsy protection stops animations and transitions, pauses video that starts without a tap, and freezes animated GIFs, in the app and on every page. The dyslexia aids are a reading font (OpenDyslexic or Atkinson Hyperlegible, bundled, SIL OFL), wider text spacing (WCAG 1.4.12 values) and a page tint. The choices are saved as `accessibility` in `library.json` and reach pages as a script appended to the recipe script; the floating back button and bottom margin moved into the same section. New `docs/wiki/accessibility.md`.

**Verified:** Rust unit tests for the script config and persistence, the i18n catalog test, TypeScript check, ESLint, and a stub-DOM run of the page script (autoplay guard, GIF still, teardown). **Not verified:** on a device or a real page; it cannot detect flashing inside a video the reader starts.

**PR:** n/a

### feat(share): remember the GitHub sign-in and show the account

**Area:** `feat(share)`

**Change:** After the first GitHub sign-in the Worker hands the app a random remember token (stored hashed, 90 days). The app keeps it with the login in the OS secure store, so the next share opens no browser. The share screen shows "Signed in to GitHub as @login" with a *Sign out* link that forgets the account here and at the Worker. Needs Worker migration `0008_remembered_sign_in.sql`.

**Verified:** Rust share tests, TypeScript check, ESLint, i18n catalog test. **Not verified:** on-device flow against a deployed Worker.

**PR:** n/a




### fix(recipes): clarify YouTube video ad limits

**Area:** `fix(recipes)`

**Change:** The YouTube ad-slot option now explains that it hides separate companion/promoted placements, not ads playing inside videos.

**Verified:** `cargo test --manifest-path src-tauri/Cargo.toml recipes::tests::` (29 passed); YouTube recipe JSON parses.

**PR:** n/a
### feat(ui): clarify recipe sharing and Pro value

**Area:** `feat(ui)`

**Change:** Share form guidance is grouped into a quiet, readable panel. The paywall now describes AI assistant, incognito, usage limits and expanded favorites before listing plans.

**Verified:** TypeScript check, changed-file ESLint and Prettier. **Not verified:** visual review inside Tauri; the browser preview cannot supply Tauri IPC.

**PR:** n/a


### fix(tabs): avoid showing the boot page twice

**Area:** `fix(tabs)`

**Cause:** React Strict Mode can run the startup effect twice. Both state requests return the same native boot-session ID, but startup appended it twice, so Tabs showed duplicate entries and could label both as showing.

**Change:** Startup now adopts a boot session only if that ID is not already in the live session list.

**Verified:** Concurrent startup regression test.

**PR:** n/a

### feat(ui): redesign usage and tighten app screens

**Area:** `feat(ui)`

**Change:** Usage now leads with a readable total and site-share bar, groups the ranked site list, and gives limit states semantic colors. Shared screen spacing, settings section labels, library filters, recipes guidance, and Pro plan cards receive visual polish.

**Verified:** `yarn ts:check`, focused lint/format checks, and browser review at phone width in dark and light themes. **Not verified:** native device rendering.

**PR:** n/a

## 2026-11-15

### chore(release): version 1.0.4

**Area:** `chore(release)`

**Change:** The app version is `1.0.4` (build 1009) in `package.json` and `src-tauri/tauri.conf.json`.

## 2026-11-14

### feat(siteview): video controls for Shorts, Reels and other feeds

**Area:** `feat(siteview)`

**Change:** Settings > Video controls adds a seek bar with the time left, a speed button, the last speed and sound remembered, no looping, and moving on when a video ends (scrolls; never clicks the site's own buttons). All are off until chosen. They run on the feeds the feed player knows, and the assistant can add another site's feed with one script rule naming its paths (`Symbol.for('openmedia.feedPaths')`); the prompt version is 4. The idea comes from browser extensions such as Better YouTube Shorts and Instagram Reels Controls; no code was copied from them.

**Verified:** Rust tests (`video_controls`, `library`, `ai::prompt`), Vitest (`videoControls.test.ts`, the i18n catalog), and on the iOS simulator on YouTube Shorts: the seek bar, the time left, the speed button, tap-to-seek, and looping off. **Not verified:** on a device; Instagram and Facebook feeds; moving on at the end does nothing on m.youtube.com Shorts, which swipes with touch handlers instead of scrolling (a scroll cannot move it, and the app never clicks or fakes touches); the translations are machine drafts.

**PR:** n/a

### fix(siteview): a Short opened from the home feed no longer waits for a tap

**Area:** `fix(siteview)`

**Problem:** On the iOS simulator a Short opened from the YouTube home feed stayed on a black or still frame until tapped. YouTube parks a video that is not playing about three screens above the top (`getBoundingClientRect().top` of -2682 on a 894 px screen), so the feed player saw no video in view and never called `play()`.

**Change:** The feed player measures a video that is off screen by its own wrapper when that wrapper is no taller than 1.5 screens (a taller one is a list, and is ignored). Opening a Short from the home feed now starts playing by itself on the simulator.

**Verified:** Vitest (`feedPlayer.test.ts`), and on the iOS simulator by opening a Short from the home feed (before: frozen, after: moving). **Not verified:** on a device, Instagram and Facebook.

**PR:** n/a

### fix(siteview): Shorts and Reels no longer stall on a still frame

**Area:** `fix(siteview)`

**Problem:** After the first feed player, Shorts still needed a tap and many Reels never played. The player took a site's own pause during a swipe for the reader's and then never retried; a feed that reuses one `<video>` spent its 8 attempts in a few swipes and kept the stale state; wide clips covered under half the viewport and were skipped; and Instagram `/<user>/reel/` pages and Facebook `/watch` were not feeds to it. On iOS the media suspend count could drift (blocking a page already suspended left it silent after unblock), and the page never learned of a suspend or resume.

**Change:** A pause counts as the reader's only after a tap, click or key, never a swipe. A new source resets the attempts and the pause. After 8 attempts one more is tried every 5 s, a video that plays without moving is kicked, and a wide clip on screen counts as in view. On a refusal iOS plays the video natively through `evaluateJavaScript`, which carries a gesture (new native-only `openmediaPlay` handler); other platforms mute. `FEED_PATH` also covers `/<user>/reel(s)`, Instagram `/p/` and `/tv/`, and Facebook `/watch`. iOS suspends and resumes media through one idempotent helper that also sets `__openmediaHold` and fires `openmedia-resume`.

**Verified:** Vitest (`feedPlayer.test.ts`, against a fake DOM), `swiftc -parse`. **Not verified:** on a device. Whether the iOS native play fallback unlocks sound, and how Instagram and Facebook behave on an iPhone, need a TestFlight check.

**PR:** n/a

### chore(release): version 1.0.3

**Area:** `chore(release)`

**Change:** The app version is `1.0.3` (build 1005) in `package.json` and `src-tauri/tauri.conf.json`.

## 2026-11-13

### fix(ui): teach the floating button hide gesture

**Area:** `fix(ui)`

**Change:** First-run onboarding now explains how to tuck the floating button away at an edge and restore it from the tab.

**PR:** n/a

### fix(adblock): add Brave filter-list scriptlets to native site views

**Area:** `fix(adblock)`

**Problem:** Native request and CSS filters cannot run filter-list scriptlets, so some ad-blocking rules had no effect in the embedded site views.

**Change:** Bundle Brave filter resources and rules, plus Brave's iOS-specific list. A cached Brave engine now matches scriptlets to the session's starting URL; iOS and Android inject them at document start when supported, guarded to the main frame and starting origin. The existing global switch controls registration. Brave's narrow YouTube fallback rules are included on iOS; video ads are not guaranteed to be blocked.

**Verified:** Rust adblock tests (11 passed), Android `BlockingRulesTest`, updater syntax/data validation, and an iOS Simulator debug build. **Not verified:** real-site or physical-device ad removal.

**PR:** #177


### fix(ui): remove repeated usage editor hints

**Area:** `fix(ui)`

**Change:** Unconfigured section editors no longer repeat their usage total or slider save hint when the parent row already shows the section's time.

**PR:** n/a

### fix(siteview): a sign-in redirect the page makes from script stays in the app

**Area:** `fix(siteview)`

**Cause:** a sign-in button that runs script after the tap (fetch, then `location = provider URL`) is an automatic cross-domain navigation, not a link click or `window.open`. On iOS and Android it was cancelled and sent to `SFSafariViewController` / a Custom Tab, which share no cookies with the profile, so the login finished there and the page stayed signed out.

**Change:** that navigation now opens in an in-app window in the session's own data store (`openRedirectWindow` on both). When the provider sends the user back to the session's domain, the page's own view loads that address and the window closes; a return that arrives as a form post (Apple) finishes in the window and the page's view then loads where it ended up. The window stays over the page until the page has loaded the returned address, so there is no blank page in between, and a navigation the app cancelled itself (`NSURLErrorCancelled`, -999) is no longer shown as an error. Back closes the window. The system browser is only the fallback if the window cannot be built.

**Verified:** iOS simulator (iPhone 17 Pro Max, iOS 26.5): a local fixture whose button redirects to another host from script opened no system browser, the provider and the callback both loaded, and the session's view ended on the callback with Back enabled; YouTube's Sign in showed Google's page inside the app. The Android plugin compiles. **Not verified:** Android at runtime, the form-post return, a completed login with a real provider. macOS never pinned the domain, so its redirects already stayed in the view.

**PR:** n/a

### feat(recipes): import and export of recipes as text are removed

**Area:** `feat(recipes)`

**Change:** Recipes no longer move as pasted text. The *Import and export* page, the three commands behind it and the Pro gate on export are gone; the recipe library and *Share a recipe* are the only ways recipes reach the app.


### feat(share): sharing a recipe has its own page, and the Recipes guide links sit in the description

**Area:** `feat(share)`

**Change:** *Share a recipe* is a separate row and page in Settings instead of a section under Import and export, which is now only import and export. The row appears only when the build has a share address. The "Create a recipe" and "Customize a site" guide links are inline at the end of the Recipes description.


### fix(shell): the site no longer flashes when a page opens from Settings on a cold launch

**Area:** `fix(shell)`

**Cause:** Settings, the page it opens (Recipes, Library, Share, incognito recipes) and Stats shared one `Suspense` boundary. The Library, Share and incognito pages were never preloaded, so the first open on a launch suspended the whole boundary: React hid the mounted Settings too, and the transparent shell showed the site until the chunk arrived.

**Change:** each lazy screen has its own boundary, so a loading page leaves Settings in place, and every lazy screen is preloaded once the first site has painted.

**Verified:** `yarn ts:check`, ESLint, Prettier. **Not verified:** on a device or simulator (the flash needs a cold launch with the chunk not yet cached).

### feat(fab): push the floating button off the edge to hide it

**Area:** `feat(fab)`

**Change:** Dragging the floating button into a screen edge (finger within 14 px of it) and lifting hides it: it slides off and a small arrow tab stays on the edge at the same height. Tapping the tab brings the button back. The button dims while the finger is in the hide zone. The hidden state is saved in `om.fab` (older saves load as visible), and the floating back button stops avoiding the hidden button's spot. New string `fab.show` is machine-drafted in non-English locales.

**Verified:** `ts:check`, ESLint, Prettier, Vitest (new: `pushedOffEdge`, `peekCenterY`, `loadPosition`). **Not verified:** the drag, slide animation and tab on a device or simulator; the floating back button cannot be hidden this way (it can be switched off in Settings).

### feat(library): "Add to incognito" on a recipe in the library

**Area:** `feat(library)`

**Change:** A recipe's page in the recipe library has an *Add to incognito* button. It asks for Face ID, Touch ID or the passcode (a crown and the paywall without Pro), then stars the recipe's site in the incognito favorites and, if the recipe was not added yet, installs it with its normal switches off so the incognito recipes start from its defaults. Cancelling the check changes nothing. Incognito does not have to be on.

**Verified:** `yarn ts:check`, ESLint, Prettier, 428 frontend tests. **Not verified:** the Face ID prompt and the flow on a device or simulator.

### fix(incognito): the first incognito session starts with Google and no recipe sites

**Area:** `fix(incognito)`

**Change:** Until the incognito favorites are first saved, the set is the default one: Google only, like a fresh normal set. Before, the quick-access menu was empty. An incognito set the user has emptied stays empty (`incognitoFavorites` in `library.json` is now `null` until first read or saved).

**Verified:** Rust library tests. **Not verified:** on a device.

### feat(recipes): the marketplace is gone; recipes ship in the app and are shared through GitHub

**Area:** `feat(recipes)`, `feat(ai)`, `feat(share)`

**Change:** The recipe marketplace (signed Cloudflare catalog, ratings, comments, reports, install counts, install review) is removed. Every recipe the project ships is inside the app: the official ones in `recipes/official/` and community ones in the new `recipes/community/`. *Add* in the recipe library copies one into the user's recipes (no network); earlier installs keep their `market.` ids. To share a recipe, a person continues with GitHub in the browser and the Worker opens a pull request for the OpenMedia team; the app tells them "Your recipe will be available in the next update after review and approval." Sharing needs no Pro and sends no purchase identifier. The `script` rule is new: scripts in bundled or imported recipes must pass the default-deny policy in `docs/wiki/script-policy.md` (Rust, Worker and CI); the assistant may write any script for the user's own recipe, shown with its code and the powers it uses, and it never runs before the user accepts. `meta.summary` is new.

**Not verified:** on a device or simulator; the GitHub login and pull request against real GitHub; the scanner on iOS and Android targets.


## 2026-11-12

### feat(onboarding): a new library starts with Google only, and Google is the default search engine

**Area:** `feat(onboarding)`

**Change:** A person who picks nothing in the guide no longer gets Instagram, Facebook, Twitter, Reddit and YouTube as favorites. A new library holds one favorite, Google, which is also the page the app opens first, and the default search engine is Google instead of DuckDuckGo. Libraries that already exist keep their favorites and their search engine (a saved library always records its engine). The version 2 upgrade still recognises the four original favorites.


### fix(media): the app no longer hangs on the splash on iOS

**Area:** `fix(media)`

**Cause:** the background-playback list was sent to the site views from the Tauri setup closure. On iOS the plugin answers on the main thread, which is the thread running that closure, so the call waited for itself and the shell never loaded.

**Change:** the list is sent from a background task instead.

**Verified:** the app starts on the iOS simulator again. Android was not affected.


### fix(app): the splash logo no longer jumps when it takes over from the launch screen

**Area:** `fix(app)`

**Change:** On iOS the splash's logo painted about 48 pt above the launch screen's logo and dropped back a moment later. The shell's web view lays out its first frame 96 px shorter than the screen (the safe areas are taken off) and grows to full height about 40 ms after, and the splash centred its logo in that short viewport. The splash is now sized and centred with the large viewport (`100lvh`, which is the screen's height from the first frame), so the logo stays where the launch screen put it.

**Verified:** on the iPhone 17 Pro Max simulator (iOS 26.5), a debug build logged the shell's viewport at the splash's first frame (`innerHeight` 860, then 956; `100lvh` 956 throughout), and a cold-launch video tracked the logo from the launch screen to the splash: before, it was drawn higher for the first frames and then moved; after, its position is the same on every frame. **Not verified:** a physical device, Android and a release build.
### feat(settings): the per-site bottom margin moves from the recipe card to the expanded favorite

**Area:** `feat(settings)`

**Change:** A site's own bottom margin is now set in Settings > Favorites, in the expanded favorite whose site has a recipe, and the Recipes card no longer shows it. Saved margins keep working: they are still stored per recipe id. The slider saves on release, not with Save. Incognito favorites and favorites with no recipe have no margin control. The shared margin stays in Accessibility. Only the English settings note was reworded; the other languages still say "a recipe".

**Issue:** #150
### feat(media): a site's audio and video pause when it is hidden or the app is left, unless the favorite keeps them playing

**Area:** `feat(media)`

**Problem:** Reels and other media kept playing after the user switched to another site or left the app, and nothing could stop it short of closing the page.

**Change:** A hidden page, or any page while the app is in the background, now has its media paused and resumed on return. A favorite's editor has a new switch, "Keep playing in the background" (off by default), for sites that should keep playing, such as music. It is one switch for audio and video: the platforms do not let the app tell them apart reliably. The list is saved in `library.json` (`backgroundMediaSites`, registrable domains) and passed to the site views through a Rust-only plugin method, `set_background_media`, so no page can reach it. Not offered for incognito favorites. iOS suspends playback natively; Android and macOS pause the main frame's `video` and `audio` elements with a script and resume only those.

**Verified:** `cargo test --workspace` (366 + 31 passed), the Android plugin compiles (`compileDebugKotlin`), the Swift plugin type-checks, `yarn ts:check`, `yarn lint`, `yarn test`. **Not verified:** any run on a device, simulator or emulator; media in iframes; Mac window close.

**Issue:** #151
### feat(tabs): a Tabs screen with open sites, quick access, history and per-site performance

**Area:** `feat(tabs)`

**Change:** The fan has a Tabs button directly above History (Usage and Incognito move up one place). It opens a page listing every open site, the quick-access favorites and the newest history. Open sites can be switched to without a reload, closed one by one, or closed all at once except the visible one; closing never removes a favorite or a history entry, and the last open site stays. Each open site shows time to first paint, last load time, foreground time today and time since last use. The measurements live in memory (`Session.paintMs`, `loadMs`) and today's time comes from `usage.json`; nothing new is stored or sent. Per-site memory use is not shown because the web views do not expose it.

**Issue:** #149
### fix(ios): a swipe down inside a video feed no longer pulls to refresh

**Area:** `fix(ios)`

**Problem:** In feeds that scroll inside a container (Reels, Shorts, TikTok) the page itself stays at its top, so swiping down to the previous video could start pull to refresh and reload the page mid-feed.

**Change:** The same document-start touch script as on Android reports whether each touch began inside a container scrolled away from its top; the refresh control is detached from the scroll view for that touch and restored for any other. Pull to refresh on the first item and on ordinary pages is unchanged.

**Not verified:** on a device or simulator. Autoplay policy, engine cost and session reloads in #152 are still to be reproduced and measured.

**Issue:** #152 (partial)

### fix(android): a swipe down inside a video feed no longer pulls to refresh

**Area:** `fix(android)`

**Problem:** In feeds that scroll inside a container (Reels, Shorts, TikTok) the page itself stays at its top, so swiping down to the previous video could start pull to refresh and reload the page mid-feed.

**Change:** A script injected at document start tells the app whether each touch began inside a container scrolled away from its top, and the refresh layer ignores the gesture then. Pull to refresh on the first item and on ordinary pages is unchanged.

**Not verified:** on a device or emulator. This addresses one suspect of #152 only: iOS autoplay policy (audio needs a tap), engine cost on a reel feed and session reloads are still to be reproduced and measured.

**Issue:** #152 (partial)
### fix(android): readable floating panels and status bar icons

**Area:** `fix(android)`

**Problem:** Two things were wrong on Android. The command bar, assistant dock, back button and error banner are translucent "glass", but Chromium's `backdrop-filter` cannot blur the native page view under the shell, so the page showed through them, sharp (the page's title ghosted across the command bar). And the status bar icons followed the device's theme, not the app's: with the app on Dark and the device on Light, the clock and battery were dark on the shell's dark strip.

**Change:** `<html data-platform="android">` makes `--glass` 98% opaque (`src/index.css`, `src/main.tsx`). The Android plugin sets the status bar icon colour from the resolved app theme in `setColorScheme` and again in `onConfigurationChanged` when the scheme is "system"; the theme check that three functions repeated is one `isDark()`. The wiki records the emulator drawing fault below.

**Verified:** debug build on the Android Emulator (API 37) with HWUI on Vulkan: command bar in Dark and Light, status bar icons with the app on Dark and on System while the device flips between day and night. `yarn ts:check`, ESLint, Prettier and the frontend tests pass. **Not verified:** a physical device. **Not fixed:** with the default OpenGL pipeline the Android Emulator draws stale rectangles over the fan (see Platform Support, "Android emulator drawing"); and about one cold start in six on the emulator ends with "get_state not allowed. Plugin not found" in the error banner, because the log shows the shell's first `event.listen` arriving with the URL `about:blank`; the code path is not touched here.

### feat(app): a splash screen that waits for the first site

**Area:** `feat(app)`

**Change:** The startup splash is rebuilt. The logo stays exactly where the native launch screen puts it (centred, 52% of the width, at most 240 px, so the handover from the launch screen changes nothing), with a soft halo behind it, the host of the site being opened and a hairline accent track that follows the launch: the web view booting, the shell up, the first site drawn. The splash no longer leaves when the first page merely starts loading: it stays until the site the app opened at launch has painted, because a page that commits early still shows an empty view until it draws. It lifts when there is no site to wait for, when the start page could not be opened, or after 12 s.

**Verified:** `yarn ts:check`, ESLint, Prettier, frontend tests, and the built first paint measured in a browser (logo centred at 52% of the width, status line and track in place, dark and light). **Not verified:** on-device iOS/Android cold start.

### fix(ui): one loading spinner

**Area:** `fix(ui)`

**Change:** The marketplace, the page-opening loader and the assistant's running step now share one `Spinner` (`src/shared/Spinner.tsx`), the page-opening ring. All three stop spinning under reduced motion; the marketplace one did not before.

**Verified:** `ts:check`, `lint` and `test` pass. Not checked on a device.

### fix(siteview): a sign-in window stays in the app, so the token reaches the page

**Area:** `fix(siteview)`

**Change:** A window a page opens with `window.open` (Google or Apple sign-in) now opens inside the app instead of the system browser. The window runs in the session's own profile, so the cookies the sign-in sets are the page's cookies, and it keeps the opener's link, so the token reaches the page that asked for it. On iOS it is a `WKWebView` built from the configuration WebKit hands over, which carries the opener's data store and `window.opener`; on Android it is a `WebView` in the same profile, and because Android's WebView gives a window no opener, the plugin gives it one that carries the message to the opening page over a write-only bridge. The window closes when the page closes it, when Back is pressed, when its session closes and when another session is shown. Automatic cross-domain navigation still opens in the system browser, unchanged.

**Why:** a sign-in that ran in the system browser shared no cookies with the app, so the page stayed logged out and the browser showed a blank page once the login finished. The in-app sign-in window had been built for iOS and was lost when the live-sessions merge landed on 2026-11-07.

**Verified:** the iOS app was built and run on the iPhone 17 Pro Max simulator (iOS 26.5) against a local fixture: the window opened inside the app (its request carried the app's user agent), it read the cookie the page had set (the profile's store is shared), its message reached the page through `window.opener`, and the window closed when the page closed it. The same check passes on macOS, where the popup window already existed, and on Android (a debug build on an emulator): the window opened inside the app, read the page's cookie, carried its message to the page over the bridge, and closed when the page closed it. The Android plugin's unit tests pass, including new ones for the message the window carries. **Not verified:** on a physical Android device, and a real Google or Apple sign-in.

**PR:** n/a

### chore(release): version 1.0.2

**Area:** `chore(release)`

**Change:** The app version is `1.0.2` (build 1004) in `package.json` and `src-tauri/tauri.conf.json`.

### fix(siteview): Android reports single-page-app route changes to the shell

**Area:** `fix(siteview)`

**Change:** The Android site view forwards `doUpdateVisitedHistory` to the shell's URL state, so a route change a site makes with `pushState` updates the address (hub bar, unread and limits follow the current page). The section-limit feature this PR first carried was dropped in favor of the per-part limits already on `main` (#143).

**Verified:** Not built or run on Android; whether a WebView reports every `pushState` is unverified.

### feat(usage): a daily limit for the parts of a site

**Area:** `feat(usage)`

**Change:** A site can now carry a daily limit for one of its parts — Reels inside Instagram, Shorts inside YouTube — next to the limit for the site itself. The Limits tab lists the parts of a site under its row with the time spent on each today and the same slider editor; the "Limits today" card counts site and part limits together, and the Activity tab's section breakdown links to a part's limit. A part that is over its limit stops the clock: its time is no longer counted and the app says so over the page, while the rest of the site keeps counting and stays open. Part limits live in `usage.json` next to the site limits, per host and per first path segment; `get_usage_limits`, `set_usage_limit` and `set_usage_section_limit` replace `get_usage_policies` and `set_usage_policy`.

**Verified:** `yarn ts:check`, ESLint, Prettier, 402 frontend tests, `cargo test --workspace` (364 tests) and clippy. **Not verified:** on a device.

### fix(hubs): a hub's quick-access favorite opens the hub

**Area:** `fix(hubs)`

**Change:** A favorite that stands for a hub (its homepage, the first page) now opens as a hub session, so the quick action for Messages Hub shows the whole bar (WhatsApp, Facebook, Instagram, LinkedIn) instead of a lone WhatsApp page. A single-site recipe with the same homepage still wins. The hub favorite's session is also kept from the idle sweep and badged and notified for unread messages like any other quick-access page.

**Verified:** `yarn ts:check`, ESLint and frontend tests. **Not verified:** on a device.

### fix(hubs): a hub page belongs to the hub it was opened from

**Area:** `fix(hubs)`

**Change:** A hub session now remembers its hub (`hubId`). The hub bar shows only on a hub session, and its pages and tabs come from that hub, not from matching the address against every installed hub. A single-site page (the Instagram favorite) no longer gets the Messages Hub bar or its navigation just because the hub has a tab on the same site, and two hubs sharing a site stay apart.

**Verified:** `yarn ts:check`, ESLint and 389 frontend tests. **Not verified:** on a device.


### fix(hubs): show the hub bar only on a hub page's own area

**Area:** `fix(hubs)`

**Change:** The Messages Hub bar appeared on every page of Instagram, Facebook, LinkedIn and WhatsApp, so a quick action such as Instagram opened the hub. A hub tab that points into one area of its site (`/direct/inbox/`) now claims only that area; the rest of the site is a plain page. Hub pages also open as sessions of their own, so the Instagram quick action is never answered with the hub's open inbox, and a hub tab never lands on the feed.

**Verified:** `hubs.test.ts`, TypeScript, ESLint. **Not verified:** on a device.

### fix(settings): list hub pages on the incognito recipes page

**Area:** `fix(settings)`

**Change:** A hub card (Messages Hub) on the Incognito recipes page now lists its pages like the normal Recipes page; before, it showed the "Hub" badge and an empty body. The Marketplace "Experimental" tag is unchanged.

**Verified:** `yarn ts:check`, `yarn lint`, Prettier. **Not verified:** on a device or simulator.

## 2026-11-11

### fix(settings): ask for the check on the incognito recipes row

**Area:** `fix(settings)`

**Change:** The "Incognito recipes" row in Settings now carries the biometric icon and asks for Face ID, Touch ID or the passcode itself, then opens the page, which lists the recipes as plain cards like the normal Recipes page. The page no longer holds a second collapsible gate inside it, and it closes itself when the app goes to the background.

**Verified:** `yarn ts:check`, ESLint, Prettier and 385 frontend tests. **Visual check:** on iPhone 17 Pro Max the page lists the recipes as plain cards, with the Pro check bypassed locally because a simulator build cannot unlock Pro. **Not verified:** the Face ID prompt on a device.

### fix(hubs): center hub tabs and route combined-page requests

**Area:** `fix(hubs)`

**Change:** Hub tabs center when they fit and stay horizontally scrollable when they do not. Chat routes combined-page requests through the existing hub builder.

**Verified:** 17 focused routing tests, `yarn ts:check`, and Prettier. **Visual check:** iPhone 17 Pro Max shows all four hub buttons centered.

### feat(settings): open incognito recipes on a dedicated page

**Area:** `feat(settings)`

**Change:** Incognito recipes now open on a biometric-gated page. Normal and incognito favorites offer "Custom favorite" plus "Add from recipes"; recipe stars update the matching favorite set.

**Verified:** 41 focused navigation and localization tests; TypeScript and changed-file formatting; browser-preview navigation and control labels. **Not verified:** native biometric unlock on a device.

### fix(settings): distinguish recipe guide links (#137)

**Area:** `fix(settings)`

**Change:** Give the recipe and site-customization guides distinct, localized labels.

**Verified:** i18n catalog tests (34) and TypeScript check.

### fix(siteview): keep clicked links in the embedded browser

**Area:** `fix(siteview)`

**Change:** User-activated HTTP(S) links in a site stay in its embedded view, including search results. Redirects follow that navigation, then the session adopts the destination domain; back/forward remains in the embedded history. Automatic cross-domain navigation still opens in the system browser. Links in the app shell continue to open in the system browser.

**Verified:** Android plugin unit tests and the iOS standalone domain-scope check. **Not verified:** a device; a full Android app build (blocked by an unrelated generated TypeScript icon import).


### fix(command-bar): route hub requests through Chat (#128)

**Area:** `fix(command-bar)`

**Change:** Keep “Experimental” on the Marketplace hub tag only, restore “Hub” elsewhere, and remove the separate Hub command mode. Chat routes hub, site-combination, and multi-site messaging-recipe requests through the existing validated hub builder.

**Verified:** 71 focused route, localization, and marketplace tests; TypeScript and changed-file Prettier checks. Browser DOM smoke confirmed the command bar exposes Auto, Link, Search, and Chat only.


### fix(marketplace): label hubs experimental

**Area:** `fix(marketplace)`

**Change:** The Marketplace hub tag and recipe badge now read “Experimental” in every supported language. Hub listings use tab labels instead of the generic “Quieter” fallback.

**Verified:** The official Messages Hub is live in signed catalog sequence 86 with the `hub` tag and tab-derived summary. Locale tests and the official-recipe validator passed.


### feat(recipes): official Messages Hub

**Area:** `feat(recipes)`

**Change:** new official hub `market.official.messages-hub` with one tab each for the WhatsApp, Facebook, Instagram and LinkedIn inboxes, matching only their message pages. No rules. The fixture-driven official-recipe tests skip rule-less hubs, and the homepage-ownership test resolves a page to its site's own recipe rather than to a hub that also covers it.

**Verified:** 358 Rust library tests; the Worker's official-mode `parseRecipe` accepts the file. **Not verified:** the four inbox addresses in a logged-in browser or on a device; Facebook may redirect its inbox on mobile web.

### feat(ai): build and publish multi-site hubs

**Area:** `feat(ai)`

**Change:** Users can ask the BYOK assistant to build a tabbed launcher from signed marketplace recipes, review each site, and accept or reject it. Accepted hubs launch independent site sessions and can be submitted through the existing marketplace flow; no inbox scraping, account merging or auto-publication. The recipe schema, Worker index tag, marketplace discovery UI and landing page recognize hubs.

**Verified:** Rust formatting, clippy and 349 library tests; frontend `ts:check`, formatting, ESLint (excluding the unrelated existing `scripts/render-store-assets.mjs` warning) and 381 tests across 39 files; marketplace hub-filter tests (21 passed); Worker hub tests (37 passed); landing marketplace tests (35 passed). **Not verified:** final shell UI on a device or live Worker deployment.

### fix(macos): site views refuse permission prompts and bound what they report

**Area:** `fix(macos)`

**Problem:** with no permission handler wry grants camera/microphone requests, and a page could report a multi-megabyte title or address to the shell every 400 ms.

**Change:** the site-view builder denies every permission request; titles are cut at 256 characters and addresses over 4 KiB are not reported.

**Verified:** `clippy -D warnings`, `fmt`. **Not verified:** on a Mac (a normal site still loads and downloads). **Not fixed:** downloads still need no user gesture, and page-opened popups are not tracked per session.
### fix(ai): a job stays on the page it was prepared on, and Cancel stops it

**Area:** `fix(ai)`

**Problem:** `LivePage` evaluated against whichever site view was active, so approving a request on site A and switching to site B previewed A's selectors on B and, when they matched nothing, read B's page and sent it to the provider; Cancel only removed the job, so a send in flight still touched the page and could make two more paid repair calls.

**Change:** `prepare` names the job inside the page (a random token in the page's symbol registry); before every preview and repair read, `send` checks the token and stops with "The page changed since this request was prepared". `send` also stops after the model answers when the job was cancelled. Not fixed: the recipe scope still comes from the snapshot's host (a hostile page can misreport it on Android/macOS).

**Verified:** `cargo test` (new tests: moved page, cancel during the model call), `clippy -D warnings`. **Not verified:** on a device.
### fix(android): ad blocking follows WebKit's rules, and BlockingRules has tests

**Area:** `fix(android)`

**Problem:** wildcard-host rules (`||facebook.com*/impression.php`) were filed under a host that never matched, so they never fired; `if-domain`/`unless-domain` were compared with the request host although WebKit reads them against the document being browsed (every `$domain=` rule behaved backwards); the two bundled lists were merged, so an EasyList exception could cancel an EasyPrivacy block; `BlockingRules` had no tests because it used `android.net.Uri`.

**Change:** a host-anchored rule is filed by host only when the host is fully captured, otherwise it is evaluated for every request; domain conditions use the top document's host (a main-frame load is its own document); each list keeps its own blocks and exceptions; URL parsing is plain string work. New `BlockingRulesTest` covers case, wildcard hosts, domain conditions and per-list exceptions.

**Verified:** `./gradlew :tauri-plugin-siteview:testDebugUnitTest` (all Android unit tests pass). **Not verified:** on a device.
### fix(shell): open the shell's own links in the system browser

**Area:** `fix(shell)`

**Problem:** "Read the guide" and the paywall's Privacy and Terms links opened the website in a new page session, using the app's site view, which is for the sites the user customizes.

**Change:** a Rust-only `open_external` command (https only, via `tauri-plugin-opener`, no capability granted to any webview) opens them in the system browser. No other shell link opens an outside address.

**Verified:** `tsc`, `cargo check`. **Not verified:** at runtime on a device.

### fix(release): unique temp files, keep an unreadable marketplace state, keep secrets off the command line, restrict OTA signing

**Area:** `fix(release)`

**Problem:** `write_atomically` used one temp name per destination, so concurrent writers could persist the wrong content; an unreadable `catalog-state.json` was silently replaced, losing edit tokens that cannot be issued again; `yarn ota keygen --github` printed the OTA private key and the updater password in the echoed command line; the OTA workflow exposed a `contents: write` token to `yarn install` and `yarn test`, and a manual run from any branch could sign and publish.

**Change:** each write gets its own exclusively created, fsynced temp file; an unparsable state file is renamed to `catalog-state.json.corrupt` before defaults are used; secrets go to `gh secret set` on stdin and the password by environment; `GH_TOKEN` is scoped to the steps that publish, and the signing jobs run only from `main` or a `v*` tag.

**Verified:** `cargo test`, `clippy -D warnings` (new tests: concurrent writers, corrupt state). **Not verified:** the workflow (Actions is currently blocked by billing), `yarn ota keygen`.
### fix(android): arm ad blocking on open, pin POST navigations, safer favicons and memory handling

**Area:** `fix(android)`

**Problem:** the Android plugin ignored the rule lists sent with `open`, so nothing was blocked until the user toggled the setting; `shouldOverrideUrlLoading` is not called for POST navigations, so a page could post a form to another domain inside the logged-in view; a small favicon could decode to gigabytes and kill the app; every backgrounding (`TRIM_MEMORY_UI_HIDDEN`) closed all hidden sessions; blocking rules matched case-sensitively while WebKit's `url-filter` does not; `sessions` was read from the WebView request thread while the UI thread changed it; the biometric prompt threw on Android 9/10.

**Change:** `open` loads the rule lists (once per list set); `shouldInterceptRequest` refuses out-of-scope main-frame POSTs after the first load settles; favicon size is read before decoding and `fetch` catches `Throwable`; only real pressure levels report a memory warning; rules compile `CASE_INSENSITIVE`; `sessions` is a synchronized map; the pre-Android-11 prompt gets a negative button.

**Verified:** `./gradlew :tauri-plugin-siteview:compileDebugKotlin` builds. **Not verified:** on a device or emulator; unit tests could not resolve `org.json` offline. **Not fixed here:** wildcard-host rules in the host index, `if-domain` semantics, per-list exceptions, `WebChromeClient` gaps (upload, dialogs, `window.open`), bridge size cap.
### fix(ai): keep keys, previews and incognito state where they belong

**Area:** `fix(ai)`

**Problem:** `ai_save_provider` could repoint a provider at a new host while keeping its stored key, so any script in the shell could send the key elsewhere; `ai_send` used the currently active provider rather than the one the preview named; unsent drafts in `contenteditable` boxes were included in snapshots; the open assistant turn survived leaving incognito; the command-bar star wrote to the normal favorites while incognito; the shell webview was allowed to emit events, so it could forge `billing:snapshot` and become Pro.

**Change:** changing a provider's base URL or kind deletes its key; `ai_send` resolves the provider from the prepared job and refuses if it changed; `snapshot.js` skips editable content; mode switches cancel the assistant; the star uses the active favorites set; the main capability lists the `core:*` defaults it needs and only `core:event:allow-listen`/`allow-unlisten`.

**Verified:** `cargo test`, `clippy -D warnings`, `ts:check`, Vitest (new incognito/assistant test). **Not verified:** on a device; the snapshot change has no DOM test. **Not fixed here:** pinning an in-flight AI job to the session it started in (A1-01), deriving the recipe scope from native navigation (A1-03), cancelling an in-flight `ai_send` (A1-06).
### fix(recipes): bound match patterns, refuse suffix-wide and page-wide recipes, stop writing nulls

**Area:** `fix(recipes)`

**Problem:** a path glob with many `*` becomes a backtracking `.*` regex in the injected page script (7 stars froze a page for 8 s); the device accepted `https://*.com/*` and selectors such as `body:not(.x)` that hide the whole page; the app serialized unset `meta` fields as `null`, which the marketplace Worker refused, so uploads always failed.

**Change:** `Matcher::parse` allows at most 4 `*` in a path and lower-cases the host; a pattern that is a public suffix, or a wildcard over one or over a bare TLD, is refused. `targets_page_root` (shared with the AI patch validator) recognises `html > body`, `body:not()`, `:is(body)`, `html *` and similar; hide rules on the page root, and css rules that hide it, are refused. The `:has(` cap ignores case. `Recipe.meta` and its fields are skipped when unset. ESLint ignores nested `.worktrees`, and the unused `shadow` in `render-store-assets.mjs` is gone.

**Verified:** `cargo test` (321 pass, new tests for each rule), `clippy -D warnings`. **Not verified:** on a device.
### fix(shell): the start page loads under the saved theme

**Area:** `fix(shell)`

**Problem:** in dark mode, Instagram's login page sometimes showed a white bar behind its footer text. The page opened at launch (`boot.rs`) before the shell had told the native view the theme, so it first read `prefers-color-scheme` from the system and was flipped to the saved theme mid-load, leaving parts of the page in the old scheme.

**Change:** `open_session` now sets the saved theme on the site view (`set_color_scheme`) before every `open`, so no page loads under a scheme it will later lose. `Library::theme` reads it.

**Verified:** not built or run: the disk was full (`No space left on device` building the Swift plugins), and the cause is inferred from the startup order, not reproduced. `cargo fmt --check` is clean.

### perf(android): read exception rules only after a block matched

**Area:** `perf(android)`

**Change:** `BlockingRules` keeps blocking rules and exceptions in separate buckets. A request is checked against the blocking rules first, stopping at the first match, and against the exceptions only when one matched. The verdict is the same as before (blocked and not excepted); unblocked requests no longer touch the exceptions and blocked ones stop scanning early.

**Verified:** `./gradlew :tauri-plugin-siteview:compileDebugKotlin` builds. **Not verified:** the speed gain (not timed), blocking on a device or emulator; `BlockingRules` has no unit test because it uses `android.net.Uri`.

### feat(settings): favorites star and recipe button, Accessibility group, guide links; fix(back): the edge swipe follows the finger

**Problem:** removing a favorite meant going to Recipes; an expanded favorite had no way to its recipe; the back button and bottom margin sat among the browsing options; the edge-swipe back closed a page instantly; the website's guides were not reachable from the app.

**Change:** every favorite row in Settings has the filled star Recipes uses, and a tap removes it. An expanded favorite whose site has a recipe shows "Open recipe", which opens Recipes with that card expanded (`openRecipe`, `recipeFocus`, `recipeForFavorite`). Browsing gains an Accessibility group holding the floating back button and the global bottom margin. The shell's edge swipe (`useEdgeSwipeBack`) now drags the page with the finger; past 40% of the width, or on a flick, it slides off and closes, otherwise it springs back (`commitsBack`). Guide links (`GuideLink`, opens `https://openmedia.surf/guides/<slug>/` in the page view) sit in AI, Recipes and the Marketplace.

**Verified:** `ts:check`, Vitest (new: `recipeForFavorite`, drag and commit rules). **Not verified:** the drag animation, star and Accessibility layout on a device or simulator; the guide pages must be live on the website (they are on the landing `guides` branch). New strings (`settings.accessibility`, `favorites.openRecipe`, `guides.read`) are machine-drafted in non-English locales.

### chore(store): Mac App Store screenshots

**Area:** `chore(store)`

**Change:** Added the Mac slot (`assets/store/macos/`, 8 slides at each of 1280 × 800, 1440 × 900, 2560 × 1600 and 2880 × 1800) rendered by `scripts/render-store-assets.mjs` from window captures of the macOS app in `assets/store/captures/macbook-pro/`. Captures use a fresh profile and synthetic usage data. The 1920 × 1080 app preview video is not included.

### fix(release): ship waits for CI to register, documents the maintainers-only release flow

**Area:** `fix(release)`

**Change:** `yarn release ship` polls until GitHub has registered the PR's checks before watching them (it failed on "no checks reported"). The release guide says releasing is a maintainer task needing store credentials, and `AGENTS.md` now states that the repository is public and what must never be committed or written in a PR or doc.

### chore(release): one release CLI with signing discovery

**Area:** `chore(release)`

**Problem:** Releasing meant exporting identity names, profile paths and a team ID by hand, importing `.p12` files in the right keychain, bumping versions in two files and merging a PR, then running three builds; a missing piece surfaced only partway through a build.

**Change:** `yarn release` is now a CLI: `doctor` (checks with a fix per problem), `setup` (imports certificates, installs the iOS profile), `build` (the default), `bump` and `ship` (version PR, merge, build). Certificates and profiles are discovered from the login keychain and the signing folder (`scripts/lib/signing.mjs`); the version files are edited by `scripts/lib/version.mjs`. The build number 1003 used for the 1.0.1 packages is recorded. Docs: `store-builds.md#releasing-yarn-release`, `AGENTS.md#releasing`.

### chore(release): version 1.0.1

**Area:** `chore(release)`

**Change:** The app version is `1.0.1` in `package.json` and `src-tauri/tauri.conf.json`.

## 2026-11-10

### fix(onboarding): re-read recipes and favorites even when the install step reports an error

**Area:** `fix(onboarding)`

**Problem:** Recipes picked in the guide could be installed and favorited while Settings > Recipes did not list them, because the lists were only re-read when the whole apply call succeeded.

**Change:** The guide re-reads recipes and favorites after the apply call whether it succeeds or fails.

### fix(marketplace): add button on top, loading spinners, matching bottom buttons

**Area:** `fix(marketplace)`

**Change:** Add/Update and Remove now sit at the top of a recipe page, equal width and height. The list and the recipe preview show a spinner while loading. The buttons at the bottom of the list and recipe pages (share, blocked commenters, report reasons, post) share one full-width size.

### feat(incognito): star a recipe to add it to the incognito favorites

**Area:** `feat(incognito)`

**Change:** Each card in Settings > Incognito recipes now has the same star as Recipes. It adds the site to, or removes it from, the incognito favorites (and so its quick-access menu), instead of only typing one in by hand.

### fix(app): keep the splash logo still

**Problem:** When the splash's animation started, the logo jumped up and down before settling, which looked buggy.

**Change:** The logo no longer floats; it stays exactly where the launch screen draws it. The glow and the expanding rings behind it still animate.

### feat(ota): over-the-air updates, from the CLI or GitHub Actions

**Area:** `feat(ota)`

Signed web-layer bundles reach every platform without a store release: the app downloads one for its own version from a GitHub release, verifies its Ed25519 signature, and serves it from the next launch, falling back to the embedded shell if it fails to load twice. Direct-distribution desktop builds can also replace themselves through `tauri-plugin-updater` (Cargo feature `self-update`; store builds never include it). Settings gets an Updates section.

`yarn ota keygen|web|app|manifest|all` builds, signs and publishes from your machine; `.github/workflows/ota.yml` runs the same commands (web on pushes to `main`, desktop on `v*` tags). The release assets must be public for the app to download them. See [Updates](docs/wiki/updates.md).

**Verified:** `cargo test --lib ota` (19), `cargo clippy --workspace --all-targets -- -D warnings` with and without `--features self-update`, Vitest, and a macOS debug build that activated and confirmed a hand-placed bundle. Not verified: a real publish, a signed desktop installer, and any mobile device.

### fix(shell): keep floating back and main buttons apart

**Problem:** Dragging both controls to the same edge and height let them overlap.

**Change:** The back button moves to the nearest safe vertical position when it would collide with the main floating button, and follows the main button's saved position as it moves.

**Verified:** `yarn ts:check`, `yarn vitest run src/features/fab/geometry.test.ts` (63 tests), `yarn eslint` on changed TypeScript files, and Prettier on changed files.

### fix(ai): accept safe CSS restyles and classify malformed answers

**Problem:** The assistant only generated hide rules, so style requests such as grayscale were rejected; exhausted schema retries surfaced as an unexplained raw error.

**Change:** AI rules can now use the recipe validator's existing safe CSS allowlist for restyling, through preview and save. The prompt describes the hide/restyle contract; “not in the expected form” maps to the localized invalid-answer message.

**Verified:** `cargo test --lib ai::` (79 passed), `cargo fmt --all`, focused Vitest (3 passed), ESLint and Prettier on edited files.

**PR:** #96

### chore(ci): keep CI lint-only and move other web checks to pre-commit

**Problem:** Formatting and tests ran on every CI build, although CI only needs to enforce linting.

**Change:** CI now runs `yarn lint` only. Husky runs `yarn format:check` and `yarn test` before each commit.

**Verified:** `yarn lint`, `yarn format:check`, and `yarn test` (351 Vitest tests); the pre-commit hook runs formatting and tests.

**PR:** #95

### fix(marketplace): render recipe notes as Markdown, in a faded preview

**Problem:** Official recipes ship their verification log as `notes`, one unbroken paragraph that the recipe review printed whole, pushing "Works on" and the switches below the fold.

**Change:** Notes are Markdown (headings, lists, paragraphs, bold, inline code; no links, images or HTML) rendered as React elements by `Markdown.tsx` and `parseMarkdown.ts`. The review shows a faded preview and expands on tap. `notes` may now contain line feeds in the Rust validator (`share.rs`); other text fields and control characters are unchanged. The Discord recipe's notes are rewritten as Markdown. The Worker needs the same line-feed allowance (`openmedia-worker`, `fix/notes-markdown-newlines`) before a recipe with line feeds can be published, and app versions without this change refuse such a recipe.

**Verified:** `tsc`, ESLint, Prettier, Vitest on the parser, `cargo test --lib recipes`. **Not verified:** on-device rendering.

### feat(ai): the assistant is a chat, with its steps, its history and its own clear button

**Problem:** A request showed one line ("Asking <provider>…") and then nothing: the user could not see what the assistant was doing, and the conversation ended with the bar. Reopening the assistant started over, so a follow-up ("and the end screen too") had no context.

**Change:** The assistant is a chat (`src/features/ai/ChatPane.tsx`). Every request reports its steps while it runs — reading the page (with the token estimate after redaction), asking the provider, checking the answer against the safety rules, previewing the rules on the page, counting what matched, asking again when a rule matched nothing — counted in Rust (`src-tauri/src/ai/activity.rs`) and sent over the `ai_send` channel; only counts and fixed kinds travel, so nothing from the page or the model is shown as a step. Turns are saved per site (registrable domain) and per recipe in `chats.json` (`src-tauri/src/ai/chats.rs`, shell-only commands `chat_list`, `chat_save`, `chat_delete`, `chat_clear`), so reopening the assistant on a site continues that site's chat and the next request tells the model what the earlier turns did. The header has *Chat history* and *New chat*; Settings > Data has "AI chats" with a *Clear chats* button. Incognito chats live in the shell only: Rust writes nothing while incognito is on.

**Verified:** `yarn ts:check`, `yarn lint`, `yarn format:check`, `yarn test` (345 Vitest tests), `cargo fmt --check`, `cargo clippy --workspace -D warnings` and `cargo test --workspace` (291 app + 29 siteview Rust tests). **Not verified:** the chat on a device; a live provider call with the new channel.

**PR:** n/a

### chore(paywall): drop the simulator-only Pro override

**Problem:** `EXPO_PUBLIC_FORCE_ENABLE_PRO_ON_SIMULATOR` duplicated `OPENMEDIA_DEV_ENTITLEMENT=pro`, and its `EXPO_PUBLIC_` prefix is an Expo convention this Tauri app does not follow.

**Change:** Removed the variable (`build.rs`, `.env.example`, paywall wiki), the runtime override in `entitlement.rs`, and the native `isSimulator` probe in the billing plugin (Rust desktop/macOS/mobile, Swift, Kotlin). `OPENMEDIA_DEV_ENTITLEMENT=pro|free` is now the only debug override. The 2026-11-08 entry below is left as history.

**Verified:** `cargo fmt --check`, `cargo test --lib entitlement` (15/15) on the host. **Not verified:** iOS and Android builds of the billing plugin.

**PR:** n/a

### docs(marketplace): tags, official recipes, ratings, Pro comments, Pro upload and export, abuse rules

**Problem:** The marketplace had no way to tell our recipes from users', shipped its best recipes inside the app, and had no ratings, comments or limits for contributors; the wiki did not describe any of this.

**Change:** The wiki now carries the contract as built (Design where noted, not deployed): platform `tags` inside every recipe and an origin tag (`official`/`community`) added only by the Worker; no bundled recipes and no recipe forks (origins are `user`, `ai`, `imported`; the assistant writes a separate `custom.<domain>` recipe beside an installed one); official recipes in `recipes/official/`, published as `market.official.<site>` by an operator SQL script through the Worker's official mode, and onboarding that replaces the favorites with the user's installed quick-access picks (4 free, 6 Pro); 1 to 5 star ratings and Pro-only comments with the abuse rules and the Worker's real limits (IPv6 /64 limiter keys, 60 RevenueCat lookups per minute, 24-hour identity age, caps checked atomically); Pro-verified uploads and comments (the Worker checks RevenueCat; export and onboarding slots are client-side only); the privacy change (RevenueCat app user id on Pro actions, stored only as a SHA-256 hash and a bearer secret for those actions, plus a random device token and Turnstile on the landing page); new threat-model rows; and the store-policy status for user comments (filtering, reporting and blocking only partly addressed, no human moderation, still an open risk). `AGENTS.md` invariant 1, the paywall, security, architecture, UI, AI, recipe-format and roadmap pages are updated to match; the roadmap decision log has the 2026-11-10 row.

**Verified (all local):** `yarn verify` in the app (type check, lint, format, 323 Vitest tests incl. every locale’s keys, `cargo fmt --check`, `clippy -D warnings`, 284 app and 29 siteview Rust tests); the macOS Swift billing package builds; Worker 335 tests, type check and format check; landing 29 tests, format check and build, plus a headless-browser run with stubbed fetch and a stubbed Turnstile; an end-to-end run of the real Worker under `wrangler dev --local` (migrations 0001-0004, the official-recipes SQL, the cron publisher) read by the real Rust client, which accepted the signed index with 18 official entries, installed one recipe, and refused a catalog signed by another key. **Not verified:** the iOS and Android native `appUserId` code; anything on a device; RevenueCat, Turnstile, Cloudflare, D1 and R2 behaviour; deployment; the new screens rendered in the real app.

**PR:** #88 (app), openmedia-worker #4, openmedia-landing #8

### refactor(marketplace): publish automatically, drop the curator and the manual approval step

**What:** A submitted recipe is now checked by the Worker itself, held for 14 days in a public Upcoming feed and published automatically afterwards. There is no approval queue and no person in the loop, and the catalog signing key is a Cloudflare Worker secret.

**Change:** `src-tauri/tools/curator/` is deleted; the Cargo workspace loses its `tools/*` member and `Cargo.lock` loses the curator crate and `clap`. The app is unchanged where it matters: it still verifies the Ed25519 signature, the SHA-256 pin and the recipe schema, and the shell still shows the rule-by-rule review before an install, so nothing is applied without the user seeing every rule. The marketplace copy in all 29 languages now says the check is automatic and the recipe is published 14 days after it is sent, instead of claiming a person checks it. The wiki's marketplace, security and roadmap pages, `AGENTS.md` and `.env.example` describe the automatic flow, the Worker-held key and the limits: no policy can prove a recipe is benign and a selector can hide important page content, and the stores' user-generated-content rules (Apple 1.2, Play UGC) expect filtering and user blocking that this design does not provide.

**Verified:** by inspection only — no build, test or lint was run for this change; the reviewer should run `yarn verify`. **Not verified:** the new copy on a device; the Worker's 14-day hold, scheduled promotion and Upcoming feed; any deploy.

**PR:** n/a

### feat(favorites): a notify switch for each quick-access favorite

**Problem:** every quick-access favorite raised a local notification when its unread count rose, and the only way to stop one site was to turn the app's notifications off in iOS Settings.

**Change:** `Favorite` and `FavoriteInput` gain `notify` (Rust `library.rs`, `serde` default on, so existing `library.json` files and older callers keep notifying). The favorite's editor in Settings shows a "Notify me of new activity" switch for quick-access favorites. The watcher in `WebLayer` still tracks the count and the fan badge still shows, but raises no notification when the switch is off. The choice survives reordering, editing, and starring or unstarring other sites (`asInput`, `toggleSiteFavorite`, `with_site_favorite`). New string in all 29 languages; the non-English text is machine-drafted.

**Verified:** `tsc`, ESLint, Prettier, 301 Vitest tests (new: the choice survives toggling another site), Rust fmt, clippy and tests (new: persists across reload and defaults on for old data; kept when a recipe's site is starred). **Not verified:** the switch rendering in Settings on a device or simulator, and a suppressed notification end to end (no notification was seen to fire or not fire).

### feat(recipes): import, export and a curated recipe marketplace

**What:** Recipes can be copied to another device as text, and an opt-in Marketplace lists recipes other people made and a person checked. Both end in the same review: every rule is shown before anything is added.

**Change:** `recipes/share.rs` (import/export, forces `origin: imported`, `imported.` ids, rejects spoofing text and uncovered homepages), `catalog/` (Ed25519-signed index verified against keys compiled into the app, SHA-256-pinned downloads, replay and expiry checks, revocation list, state in `catalog-state.json`), shell screens under `features/marketplace/`. The server is a separate Cloudflare Worker repo; the signing key never lives on Cloudflare. This amends the "no backend" invariant (`AGENTS.md`, `security.md`): the marketplace is the one optional server, untrusted by the app.

**Verified:** `cargo test --lib` (all recipe, catalog and share tests), clippy and rustfmt. **Not verified:** any run against a deployed Worker, on a device, or in the simulator; the marketplace stays hidden until a build sets `OPENMEDIA_MARKET_URL` and `OPENMEDIA_CATALOG_KEYS`.

**PR:** n/a

### fix(siteview): sign-in popups close when the sign-in finishes on macOS

**What:** The in-app sign-in popup stayed open after the sign-in was done, because the page's `window.close()` did nothing.

**Change:** The script that turns `window.close()` into a navigation the popup closes on was given to the popup as its own initialization script, but a popup shares its opener's user content controller and wry skips a popup's own scripts, so it never ran. It is now injected with every site view's scripts, which the popup inherits. The address it navigates to is refused in site views too, so a page that is not a popup stays where it is.

**Verified:** debug build against a local fixture (a page that opens a cross-host popup, which posts to `window.opener` and calls `window.close()`): the popup window closed about 1.4 s after it appeared and the opener received the message; on the previous code the popup stayed open after the page had finished. Unit test for the refused address. **Not verified:** a real Google or Apple sign-in on the Mac; popups that lose `window.opener` to a Cross-Origin-Opener-Policy.

**PR:** n/a

### fix(recipes): the recipes work on the Mac, with more toggles

**Problem:** the bundled recipes were written against an iPhone user agent. The Mac app sends Safari's desktop user agent, and sites answer that with another DOM (`ytd-*` instead of `ytm-*` on YouTube, a sidebar and chat column on Twitch, a different TikTok layout), so on the Mac most rules matched nothing: with every option on, the old YouTube recipe hid 0 of its 17 rules on the home page.

**Change:** every recipe that differs now carries desktop rules beside the mobile ones under the same option. Checked in the running Mac app with every option on (each rule's match count against its computed `display`): YouTube, Reddit, Twitch and TikTok hide everything they match; Pinterest, LinkedIn, Snapchat, Instagram and Threads were checked logged out; Facebook and X could not be reached past the login page, so their desktop rules come from the markup those sites serve and are marked as such in each recipe's notes. New toggles: YouTube (Premium prompts, More from YouTube, end-screen cards, live chat, merch, Create and voice search, notification bell), Reddit (Games, Recent, custom feeds, Resources, right sidebar, chat, image posts, crossposts), Twitch (Prime and Bits, featured carousel, left sidebar, stream information), TikTok (LIVE and Explore, sidebar footer, For You feed, captions), X (right column, trends, Who to follow, counts, messages drawer, Jobs and Lists, verified badges), Facebook (sponsored posts, right and left column, Watch and Marketplace tabs), Instagram (Highlights, verified badges, footer), LinkedIn (feed sidebars, messaging pop-up, promoted posts, Premium prompts, Google One Tap), Pinterest and Snapchat (Google One Tap, parents banner). The YouTube and Twitch home pages are `www.`; an iPhone is sent to `m.` from there. The fixture test now lists every rule that matches nothing instead of stopping at the first.

**Mobile:** the same recipes were run in the iOS Simulator (iPhone user agent, WKWebView) with the new build: the mobile rules still match and hide (Reddit, YouTube `m.`, Twitch `m.`, Facebook `m.`, Threads, Snapchat, Pinterest), and the new Google One Tap rule hides the prompt on Pinterest. Added for phones: YouTube's Subscriptions and You tabs, Reddit's Join buttons.

**Verified:** `cargo test` (workspace), clippy, `yarn check:web`, and the Mac app run end to end (options saved, rules hidden) for YouTube, Reddit, Twitch and TikTok. **Not verified:** a signed-in Facebook, X, Instagram feed or LinkedIn feed; a real device.

### feat(siteview): a switch in Settings applies to the open page at once

**Problem:** changing a site option rebuilt the page's web view on the Mac and reloaded it on the phone, so the page lost its scroll position and history for a change of one stylesheet.

**Change:** `set_document_start_script` now swaps the document-start script for the pages each view loads next and runs the new script on the page showing now, after removing the old `style[data-openmedia]` (iOS and Android evaluate it in the page; macOS swaps its own `WKUserScript` among the ones Tauri adds, and rebuilds the view only if it cannot find it). The Settings text no longer says the page reloads.

**Verified:** macOS in the running app and the iOS Simulator (a variable set on the page survived the toggle, the rules showed or hid at once, and a reload afterwards used the new script); the Kotlin compiles (`compileDebugKotlin`). **Not verified:** Android at runtime; frames inside the page keep the old script until they load again.

### fix(settings): mark the Incognito sections as Pro when they are

**Problem:** without Pro, "Incognito favorites" and "Incognito recipes" in Settings looked like the Pro versions (fingerprint icon, "Locked. Tap to unlock with Face ID…"), and a tap opened the paywall with no warning.

**Change:** without Pro both sections show the crown, no chevron and "Pro feature" (`paywall.locked`, already translated) instead of the Face ID hint (`needsPro` on `LockedSection`). With Pro nothing changes. No new strings.

**Verified:** `ts:check`, ESLint, Prettier, 300 frontend tests. **Not verified:** rendering on a device or simulator.

### fix(siteview): sign-in popups open inside the app on macOS

**What:** A page's `window.open` to another domain (Google sign-in) or a `target=_blank` link out of the session's domain opened the Mac's default browser, so the sign-in could never report back to the page.

**Change:** Those requests now open a popup window inside the app (`open_popup` in `macos/mod.rs`), built on the opener's web view configuration: same data store and `window.opener`, Safari user agent, http/https only. `window.close()` in the popup closes the window (WebKit does not report it, so a script turns it into a refused navigation the popup closes on). Links within the session's domain still load in the page. If the popup cannot be built, the link falls back to the browser.

**Verified:** compiles, clippy clean, plugin unit tests pass. **Not verified:** a real Google sign-in on the Mac; popup behavior at runtime.

## 2026-11-09

### chore(release): version 1.0.0 and Mac App Store packaging

**Change:** the app version is `1.0.0` (the App Store Connect version records are 1.0). `scripts/package-mac-app-store.sh` signs the release `.app` with the new sandbox entitlements (`src-tauri/macos/OpenMedia.entitlements`) and a Mac App Store profile and builds the installer `.pkg` Transporter takes (see the store-builds wiki). The Mac icon (`icons/icon.icns`) is now a macOS-style rounded tile with a shadow, made from the iOS icon; it was the bare mark on a transparent background.

**Release command:** `yarn release` builds the iOS `.ipa`, Mac `.pkg` and Android `.aab` into `release/<version>-<build>/` and bumps the build number itself (iOS and macOS `bundleVersion`, Android `versionCode`, from `tauri.conf.json` and the latest App Store Connect build). The build number is now 1001: Google Play had already used 1000. The Mac package carries the icon as an asset catalog (`Assets.car` plus `AppIcon.icns`, `CFBundleIconName`), as Xcode ships it.

**Verified:** a signed iOS `.ipa` and Mac `.pkg` (built by `yarn release`) passed `altool --validate-app`; a signed release AAB built (with #79). **Not verified:** the sandboxed Mac app beyond launching to onboarding, and any upload or review.

### feat(shell): Face ID icon on devices that have Face ID

**Problem:** the biometric gates (the locked incognito sections, the Incognito button) always showed a fingerprint, but most iPhones use Face ID.

**Change:** new Rust-only plugin method `biometryKind` (Swift: `LAContext.biometryType == .faceID`; Kotlin and the Mac report a fingerprint, since Android does not say face or finger) behind a new app command `biometry_kind` that returns `face` or `fingerprint`, raises no prompt and is free for every user. `BiometricIcon` (`features/incognito/`) draws Face ID's face glyph for `face` and the fingerprint otherwise, and shows the fingerprint until Rust answers. See [UI Design](docs/wiki/ui-design.md) and [Security](docs/wiki/security.md).

**Verified:** `tsc`, ESLint, Prettier, frontend tests, `cargo fmt`, `clippy -D warnings` on the Mac, and `cargo check --target aarch64-apple-ios-sim` with `IPHONEOS_DEPLOYMENT_TARGET=17.0` (compiles the Swift); the Face ID glyph rendered in a standalone SVG. **Not verified:** on an iPhone with Face ID and one with Touch ID (the SE), the Kotlin method (no Android build), Windows and Linux.

### fix(shell): no text-selection magnifier when holding the floating button

**Problem:** on iPhone, holding the floating button showed the text-selection magnifier. The shell sets `user-select: none` on the root only, and WebKit on iOS does not reliably inherit it, so the hold started a text selection.

**Change:** `user-select: none` and `-webkit-touch-callout: none` are set on every element (`*`) in `index.css`; inputs and the payload preview keep `select-text`. The floating button also cancels the context menu.

**Verified:** `tsc`, ESLint, Prettier, frontend tests. **Not verified:** on an iPhone. I could not reproduce the magnifier here, so this follows WebKit's known behavior; if it still appears, the cause is in the native shell view's text-interaction gesture, and the fix moves to `SiteViewPlugin.swift`.

### fix(shell): a crown for Pro, a fingerprint for biometric checks

**Problem:** the same padlock marked what the paywall unlocks (Usage, Incognito, Chat, the extra favorites slots, the AI card) and what asks for Face ID, Touch ID or the passcode (the locked incognito sections in Settings), so the two could not be told apart.

**Change:** `LockIcon` is gone. `ProIcon` (a crown) marks every paywall gate; `BiometricIcon` (a fingerprint) marks the locked incognito sections. The Incognito fan button shows the crown without Pro, and a fingerprint badge once Pro is active, because entering then asks for the check. See [UI Design](docs/wiki/ui-design.md).

**Verified:** `tsc`, ESLint, Prettier, frontend tests; both icons rendered in a standalone SVG and read as a crown and a fingerprint. **Not verified:** how they read at 12 px in the fan and in Settings on a device.

### feat(shell): floating back button always visible and closes sheets; history records sites opened from a search

**Problem:** the optional floating back button disappeared when Settings or any sheet was open, and only went back in the page. Sites opened from search results were never in History, because only typed addresses were recorded.

**Change:** the button is shown whenever it is enabled, above every sheet (`z-[80]`). A tap does what system Back does: it dismisses the newest thing on screen (Settings, paywall, the fan, a list, a guide step) through the back stack, and with nothing on screen goes back in the page. It is dimmed instead of hidden when a tap would do nothing. History now also records a site when a session moves from a search engine's page to a site (`leftSearchForSite`, `recordVisit`); the search itself is still never recorded, and neither is browsing inside the site afterwards. Incognito still records nothing.

**Strings:** `settings.backButtonNote` is reworded in all 29 locales (it said the button shows only when the page can go back); the 28 non-English versions are mine and need a native-speaker review.

**Verified:** `tsc`, ESLint, Prettier, frontend tests (new: `searchVisit.test.ts`). **Not verified:** the button over each sheet on a device, and the history recording against real search-result redirects (Google and DuckDuckGo link through their own redirect pages); no test drives `WebLayer`.

### feat(siteview): site views on macOS, with Mac trackpad gestures and shortcuts

**Problem:** the macOS app opened with "site views are not implemented on desktop yet" and showed no page.

**Change:** `tauri-plugin-siteview` has a macOS implementation (`src/macos/`): one Tauri child webview per session with a data store per profile, the recipe script as its document-start script, the iOS ad-blocking rule lists, state events (`siteview:state`) read from the `WKWebView`, back/forward/reload/navigate, `evaluate` for the assistant, downloads (saved to Downloads and revealed in Finder), favicon fetching, the owner check (`LAContext`, so incognito works) and local notifications (`UNUserNotificationCenter`).

**Mac input:** a two-finger swipe goes back and forward in a page and pinch or two-finger double-tap zooms (`WKWebView` gestures); a two-finger swipe closes Settings, History and Usage; a Navigate menu (Cmd `[`, `]`, R, L, Y, `,`) and a Page menu (Cmd `=`, `-`, 0) carry the shortcuts, because the page view takes key presses before the shell does; Escape closes sheets. Keyboard focus moves to the shell while an overlay is open.

**Layout:** the model is mobile's. Pages sit under a transparent shell; the floating button, fan and sheets draw over the full-window page, with no bar beside it. Natively (`shell.rs`) the shell's `WKWebView` stops painting a background (the private `drawsBackground` key; an App Store review risk, noted in the wiki), is kept above the pages, and answers `hitTest:` only inside the interactive regions it reports, so every other click reaches the page. The window opens at 1100 x 760 with a 560 x 480 minimum.

**Purchases:** the paywall is live on the Mac. `tauri-plugin-billing` has a macOS side (RevenueCat over StoreKit 2, a Swift package linked by `build.rs`), and `Entitlement::from_build` no longer forces Pro on macOS (`OPENMEDIA_RC_KEY_MACOS`, defaulting to the iOS key; Windows and Linux still force Pro).

**Also:** `site.rs` (Public Suffix List matcher) moved into the plugin, which needs it for `scope`. The capability names the `main` webview instead of the window, so site views are in no capability. The macOS bundle requires 14.0, the first version with per-profile data stores.

**Not on macOS:** domain pinning (Tauri's navigation callback has no frame information, and pinning would break OAuth redirects), a page-to-Core bridge, `siteview:closed` and `siteview:memory`, JavaScript `alert`/`confirm`/`prompt`. Windows and Linux still return `DesktopUnsupported`.

**Verified:** debug builds run on one Mac (macOS 26, Apple Silicon) with a fixture server: load, state events, back/forward and reload through the menu, zoom, address and settings shortcuts, Escape, session switch, overlay hiding, light/dark, script swap, ad-block rule, download, favicons, user agent, refusal of page-side IPC calls, and the gesture flags read back (see [platform support](docs/wiki/platform-support.md#the-macos-site-view)); `cargo fmt --check`, `clippy -D warnings`, `cargo test`, `ts:check`, `lint`, `format:check` and `test`. **Not verified:** any purchase, restore or offering (no RevenueCat key or signed build here; the app only showed Pro locked with a placeholder key), real clicks on the page under the shell, a finger on the trackpad (swipe, pinch), notifications (the system refused the ad-hoc signed debug bundle), the Touch ID prompt, macOS 14/15, Intel, a release or signed build, two profiles with separate cookies, Google sign-in, `target=_blank`, and the iOS and Android builds: `cargo check --target aarch64-apple-ios-sim` stops in the Swift package build here (no Swift file was touched; whether it fails on `main` too was not checked), so the edit to `mobile.rs` (event names moved to `events.rs`) was not compiled.
### fix(settings): call the shared bottom margin "Global bottom margin"

**Change:** the Browsing slider's title (`settings.bottomMargin`) now reads "Global bottom margin" in every language, to set it apart from the per-site margin on each recipe card.

**Verified:** catalog tests, `tsc`, ESLint, Prettier. **Not verified:** native-speaker review of the 28 non-English strings; rendering.

### feat(paywall): free users get four quick-access slots; slots 5 and 6 and More favorites need Pro

**Problem:** every user had six quick-access slots and an unlimited favorites list.

**Change:** without Pro the fan opens only the first four favorites and always shows two more slots grayed out with a lock (the fifth and sixth favorite, or empty), which open the paywall. In Settings, those two slots are grayed rows, "More favorites" is a locked row and "Add favorite" opens the paywall once four exist (`FavoritesEditor`, `quickSlots`, `usableQuickAccess`). Unread badges, notifications and session retention follow the four usable slots. The gate is in Rust: `set_favorites` and `set_site_favorite` return `pro-required` when a save would grow the list past four (`favorites_need_pro`); a longer list can still be edited, reordered and shortened. New string `favorites.moreLocked` in all 29 locales (the existing "More favorites" without its count).

**Verified:** `tsc`, ESLint, 289 frontend tests (new: `quickSlots`, `usableQuickAccess`), Rust library tests (new: growth gate), clippy. **Not verified:** the fan and Settings rendering on a device; the Rust commands against a real free entitlement; native-speaker review of the new string. Note: the five default favorites exceed the free limit, so on a fresh install YouTube, the fifth, is a grayed slot.

### feat(settings): Recipes page, search engine setting; fix(shell): paywall and picker dismissal

**Problem:** closing the paywall opened from Settings also closed Settings; the language list had no close button and could not be dragged down; the Pro hint in the AI section was a plain outlined pill; the command bar always searched DuckDuckGo.

**Change:** Recipes moved from a collapsed Settings section to its own page, opened from a row in Settings (`RecipesSection` is now `RecipesScreen`). Pages opened from Settings (Recipes, paywall) return to Settings on close; Settings stays mounted underneath (`sheetParent`, `selectSettingsOpen`). The list sheet (`Picker`) has a close button and drags down to dismiss. The AI section shows a Pro card (lock, title, subtitle, chevron) instead of "This needs OpenMedia Pro. Tap to see the plans." (`paywall.lockedHint` removed). In the command bar, Chat is grayed out with a lock for free users and opens the paywall. New Settings > Browsing > Search engine (DuckDuckGo, Google, Bing, Brave Search, Ecosia, Startpage, Yahoo), stored as `searchEngine` in `library.json`; one new string `settings.searchEngine` in all 29 locales.

**Verified:** `tsc`, ESLint, 285 frontend tests (new: sheet return, per-engine search URLs), the Rust library tests (new: search engine default and persistence). **Not verified:** rendering, the drag-to-dismiss gesture and the Chat lock in the running app; native-speaker review of "Search engine" in the 28 non-English languages.

### fix(shell): label the paywall retry button "Retry"; keep ESLint out of `.worktrees/`

**Problem:** when offerings failed to load, the paywall showed "Something went wrong. Try again." twice: as the error line and as the retry button's own label. `yarn lint` also parsed every file under `.worktrees/` and failed with an ambiguous `tsconfigRootDir` once a second worktree existed.

**Change:** the retry button uses `common.retry` (already translated in every locale). `eslint.config.js` ignores `.worktrees`.

**Verified:** `ts:check`, `lint`, `format:check` and `test` from a worktree. **Not verified:** the paywall on a device after the change; found on the iOS simulator and Android emulator, where the store has no products.

### fix(deps): build with sha2 0.11 and merge the Dependabot updates

**Change:** merged the open Dependabot PRs (Rust `sha2` 0.10 to 0.11, Android Gradle, Kotlin, AndroidX, RevenueCat 9 to 11, `org.json`, coroutines). `sha2` 0.11 digests no longer implement `LowerHex`, so `ad_block.rs` builds the 16-character source id from the first 8 digest bytes by hand; the ids are unchanged.

**Verified:** `cargo fmt --check`, `clippy -D warnings`, `cargo test --workspace` (Rust only). **Not verified:** the Android and iOS builds with AGP 9, Kotlin 2.4 and RevenueCat 11; CI does not build them, so run `yarn build android` before a release.

### chore(ci): reduce CI to lint, format check and tests

**Change:** `ci.yml` is one Ubuntu job running `yarn lint`, `yarn format:check` and `yarn test`. The macOS Rust and Swift job, `cargo deny`, the Android build and tests, `ts:check` and `vite build` are removed from CI. Sync Wiki and Dependabot are unchanged. Docs that said CI runs everything now point to `yarn verify` as the local full check.

**Not run in CI any more:** type errors, Rust fmt/clippy/tests, Swift and Android plugin tests, dependency advisories and licenses. Run `yarn verify` before pushing.

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
