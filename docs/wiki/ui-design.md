# UI Design

> **Status: Implemented on iOS.** Source lives in `src/` (`features/fab`, `features/sheet`, `features/settings`, `features/onboarding`, `features/web`). Gestures were exercised with synthetic pointer events, not a real finger; see [Platform Support](./platform-support.md#verified-results).

## Idea

The web is the product. The screen is one full-bleed page, from under the status bar to the bottom edge (no bar below it); everything else is a single floating button that stays out of the way. The button is the logo.

| Gesture | Result |
|---------|--------|
| Tap the button | Command bar slides in from the top. Addresses open directly; requests use the active AI provider with a redacted payload preview before sending |
| Hold the button (about 380 ms) | The favorites fan out. Settings, History, Tabs and Usage form a column on one side of the button, Settings farthest. Incognito and the video controls switch form a column on the other side. Tapping the video controls switch turns the tap panel on or off for every site (`videoControls.panel`; solid white is on, a slash through the icon is off); holding it opens the Video controls page. Where the other side has no room (the button near the top or bottom of the screen) all six join the one column, with Incognito and the switch above Usage |
| Hold, slide onto an item, lift | Opens that favorite, Usage, Tabs, History or Settings, or toggles Incognito |
| Hold, lift, then tap an item | Same, in two steps |
| Drag the button | Moves it; on release it snaps to the nearer left or right edge and remembers its place |
| Drag the button into a screen edge (the finger within `HIDE_REACH`, 14 px, of it) and lift | Hides it: the button slides off the edge and a small glass tab with an arrow (`PEEK_WIDTH` x `PEEK_HEIGHT`) stays there, at the same height. While the finger is in that zone the button dims. Tap the tab to bring the button back. The state is saved with the position (`hidden` in `om.fab`); the floating back button then ignores the main button's spot |
| Pull the page down from the top | Native pull-to-refresh: `UIRefreshControl` on iOS, `SwipeRefreshLayout` around each page view on Android; only where the page's own scroll view is at the top |
| Swipe in from the screen edge on a page | iOS: the web view's own back swipe (and forward from the opposite edge). Android: the system back gesture or Back button, which goes back in the page |
| Swipe in from the screen edge on Settings, History, Usage or the paywall | Closes it. iOS: the shell's own swipe (`useEdgeSwipeBack`, left edge, right edge in right-to-left languages); the page follows the finger and slides off past 40% of the width or on a flick, else springs back. Android: the system back gesture |
| Back (Android button or gesture) | Dismisses the newest thing on screen first: the open fan, a sheet, an onboarding step. With nothing on screen it goes back in the page; at the first page, or with a page closed by a usage limit, it leaves the app |
| Tap the floating back button (when enabled in Settings) | Same as Back: dismisses the newest thing on screen (a sheet such as Settings or the paywall, the fan, a list, a guide step), and with nothing on screen goes back in the page. The button stays on screen above every sheet; it is dimmed when a tap would do nothing (no page history, the guide's first step, a page closed by a usage limit). Drag it to move it to an edge |

The only default favorite is the default search engine, Google: onboarding sets the favorites to the sites the user picked, and a person who picks nothing keeps Google, which is also the page the app opens first. Each fan item shows the site's icon when known, otherwise a monogram. The command bar has back, forward, reload and a favorite star for the current page; History rows also have independent favorite stars. Browsing alone never changes favorites. The first six favorites (`QUICK_ACCESS_LIMIT`) form the quick-access menu for Pro; without Pro only the first four (`FREE_QUICK_ACCESS_LIMIT`) open, and the fan always shows two more slots grayed out with a crown (holding that favorite, or empty), which open the paywall. Settings can reorder an unlimited list for Pro.

Two kinds of gate, two icons. A crown (`ProIcon`, in a navy badge) means the paywall: Usage, Incognito, the assistant's Chat mode and the extra quick-access slots show it without Pro. A biometric icon (`BiometricIcon`) means Face ID, Touch ID or the passcode: Face ID's face glyph on a device that has Face ID, a fingerprint on Touch ID devices, Android and the Mac (Rust's `biometry_kind` asks the plugin, which reads `LAContext.biometryType` on iOS; Android cannot tell a face from a finger). It appears on: the locked incognito section in Settings, the Incognito recipes row, and the Incognito button in the fan once Pro is active (it asks for the check before entering). Without Pro, Incognito shows the crown, because the paywall comes first; the incognito section in Settings shows the crown, no chevron and "Pro feature" in place of the Face ID hint, and a tap opens the paywall (`needsPro` on `LockedSection`); the Incognito recipes row shows the crown, and its tap opens the paywall too.

### Unread badges and notifications

A page that has unread items usually says so in its title: `(3) Messenger`. For each quick-access favorite's live session the shell reads that leading `(N)` or `[N]` (`unreadCount`, `src/shared/unread.ts`; a generic title convention, not per-site code). The count appears as a badge on the fan item, and a dot on the floating button when any hidden favorite has one. The page on screen is never badged.

When a hidden quick-access session's count rises, the shell asks the plugin for a local notification (`notify`): the favorite's name as title, "New activity" as body. Page text never reaches the notification, so a page can only choose *whether* to raise one, not what it says. Rules (`observeTitle`, `src/features/web/unreadWatch.ts`):

- The first title a session reports is a baseline; a page that loads already showing `(3)` raises nothing.
- Only a rise raises one, only while the user is on another page, and at most once per session per 30 seconds (a page controls its own title).
- Tapping a notification shows that session (`siteview:notification-tap`, `openSession`) if it is still alive.
- iOS asks for notification permission the first time one is due. If refused, nothing is posted.
- Each favorite has a "Notify me of new activity" switch in its Settings editor (`Favorite.notify`, on by default, so favorites saved before it existed keep notifying). Only quick-access favorites show it. Off stops the notification only: the count is still tracked and the badge still shows, so turning it back on does not replay old activity.

iOS Settings still has the master switch. No push: see [Platform Support](./platform-support.md).

**Opening a site:** a small accent spinner sits in the page area until the active session first paints or finishes loading. It uses the existing native page state, stays out of the touch router, and stops on errors; switching to a ready session shows no loader. The ring spins even under reduced motion, since a still ring reads as a hang. The startup splash still covers the first load (see [The startup splash](#the-startup-splash)).

## The startup splash

The launch screen is native (iOS: `LaunchScreen.storyboard`, the logo at 52% of the width, at most 240 px, on the app's ink or paper). The splash in the shell continues it exactly: the same colour, the same logo in the same place, so nothing changes when the web view takes over. Around the logo sit a soft halo, the host of the site being opened and a hairline accent track that follows the launch: the web view booting, the shell up, the first site drawn.

The splash lifts only when that first site has **painted** — a page that commits early still shows an empty view until it draws, and that frame is what the splash exists to hide — or when there is no site to wait for, or when the start page could not be opened, or after 12 s. Fade-out is 320 ms. Reduced motion keeps the halo still and the track's steps instant.

The splash is sized and centred with `100lvh`, not the layout viewport: on iOS the shell's web view lays out its first frame 96 px shorter than the screen (the safe areas are taken off) and grows about 40 ms later, so a logo centred in that viewport painted above the launch screen's logo and then moved. `lvh` is the screen's height from the first frame.

The splash is drawn by `index.html` itself, with the logo and the stylesheet inlined by the Vite plugin `inlineFirstPaint`, so it is on screen with the first HTML instead of after two more requests.

## Settings

Settings uses one scrolling screen for collapsible sections, with Incognito favorites as its one locked section. Normal and Incognito Recipes each open their own page. Settings and History share the `shared/Screen.tsx` page frame. Expand a section by tapping its heading or using the keyboard. Closing and reopening Settings restores the compact default.

Pages opened from Settings (Recipes, Incognito Recipes, Recipe library, Share, and the paywall) sit on top of it. Closing a page returns to Settings with its scroll position and open sections intact; Incognito favorites are cleared and relocked when entering or leaving the Incognito Recipes page.

- **Appearance:** System, Light or Dark. Stored in `library.json` and applied to the app and, through the native view's `overrideUserInterfaceStyle`, to sites that follow `prefers-color-scheme`.
- **Browsing:** the global ad-blocking switch for the bundled filter lists (changing it reloads the open pages).
- **Bottom margin** (in Accessibility): the shared bottom margin, a slider (0 to 200 px, saved when released) that keeps the bottom of every page clear, for sites whose menus slide under the screen edge. An expanded favorite whose site has a recipe can override the margin (stored per recipe id); "Use the shared margin" removes the override. The shell asks Rust which site the current page belongs to (`bottom_margin_for`) and shrinks the native view's rectangle from the bottom; the strip underneath shows the app background.
- **Search engine** (in Browsing): which engine the command bar searches with. Stored in `library.json` as `searchEngine` (`set_search_engine`); the addresses live in `src/shared/searchEngines.ts`.
- **Accessibility:** epilepsy protection, the dyslexia aids (reading font, wider text spacing, page tint) and the touch aids (the floating back button switch and the shared bottom margin). `AccessibilitySection.tsx`; the choices are stored in `library.json` as `accessibility` and reach the pages as an injected script. See [Accessibility](./accessibility.md).
- **Recipes:** a row that opens the Recipes page (`RecipesScreen`, with a back arrow in its header). The page has one card per installed recipe (the official ones ship in the app and are added from the recipe library: Instagram, Facebook, X (Twitter), Reddit, YouTube, Threads, Telegram, Douyin, Messenger, Discord, Kuaishou, LinkedIn, WhatsApp, Snapchat, Pinterest, Weibo, TikTok, Twitch; WeChat and QQ have none because their logged-out pages offer nothing to hide). Each card lists its options as switches, annoyances first and then content, each with a one-line description. A switch ON means the thing is hidden. Annoyances (install prompts, pop-ups that block the page, ad slots) start ON; content (Reels, Shorts, Stories, suggestions, whole feeds) starts OFF. Changing a switch saves it and reloads the open page under the recompiled recipe script. The card also holds the recipe's bottom margin. A star on each card adds the recipe's site (its `meta.homepage`) to the favorites or removes every favorite that opens it (`set_site_favorite`); a site counts as favorited when any favorite matches the recipe's `match` patterns. Hub cards additionally list each tab's label and host and provide an open action; each site keeps its own session. See [Site Playbooks](./site-playbooks.md) for what each option covers.
- **Video controls:** a row that opens the Video controls page (`VideoControlsScreen`, a back arrow in its header). The page holds every video choice: the tap panel switch, full videos, panel height, remember speed and sound, stop looping and move on at the end. The page also opens straight from the fan (hold the video controls button), and then closes back to the page that was showing.
- **Recipe library** and **Share a recipe:** up to two rows in one group under Recipes (the last only in builds with a share address). Each opens a page on top of Settings (`features/library/`), and closing it returns to Settings. *Recipe library* lists the recipes bundled in the app (official first, then community) under a search box with a *Filters* button beside it (the default is official recipes for the current platform). The button opens a popup with a section per kind (source, platform, type, status, category), a live count on each chip and *Clear all*; the chips that are on show under the search as removable chips, with the result count. The list is built for hundreds of rows: the library is indexed once (tags, status and search text per recipe), counts are one pass per kind, the search is deferred while typing, rows are memoized and drawn thirty at a time as the reader scrolls (`PAGE_SIZE`), and rows outside the screen skip layout (`content-visibility`). Each row shows author, summary and whether it is added or has an update; a row opens the rule-by-rule review that import uses (`RecipeReview`: sites, switches, every rule with its selector, the code of every script) with Add / Update / Remove. Nothing on the page touches the network. **Share a recipe** is its own page (`ShareRecipeScreen`): pick one of your own recipes, describe it in a few words, continue with GitHub, and read the thank-you message (see [Recipe Library and Sharing](./recipe-library.md)).
- **Favorites:** (an expanded favorite also has a "Keep playing in the background" switch, off by default: audio and video of that site pause when another site is shown or the app is left, and resume on return; it saves at once and is not offered in incognito) a "Quick access" group (the first six, four without Pro) and a "More favorites" group below it. Tap a row to edit its name, address and landing page or remove it; the landing page (`Favorite.landing`, empty by default) is the page a new session of that favorite starts at instead of its address, an address or `/path` on the same site only, saved with Save, and "Use the address" clears it (incognito favorites use the same editor and rules). A favorite that is already open is switched to, not reloaded; arrows reorder, and moving across the boundary moves a favorite in or out of quick access. Without Pro, slots 5 and 6 are two grayed rows with a crown, "More favorites" is a locked row, and "Custom favorite" opens the paywall once four exist; all of them open the paywall. "Add from recipes" opens the matching recipe list, where starring a site adds it to that favorites set. Every change saves at once, so the list never disagrees with the stars above it.
- **Incognito favorites:** see [Incognito](#incognito). Always collapsed and locked until a biometric check passes.
- **Incognito recipes:** a Settings row asks for the biometric check and then opens its own page, which lists the recipes as plain cards, like the normal Recipes page, with no second gate inside it. Without Pro, both Incognito entries show a crown and open the paywall.
- **AI assistant:** bring-your-own-key providers. See [AI Assistant](./ai-assistant.md#implemented-provider-settings).
- **Data and help:** "Clear" next to History (with a confirm step) empties the searched addresses and forgets the last page, like a browser; favorites, open sessions and logins are untouched. "AI chats" shows how many chats are saved and has "Clear" (with a confirm step) that erases them all. "Replay" marks the first-run guide unseen and shows it again.

## Incognito

The Incognito button (hat-and-glasses icon) sits on the opposite side of the floating button from the page buttons, nearest to it, with the video controls switch beyond. It swaps the whole quick-access set for a second, separate one and the recipe switches for a second, separate set.

- **Entering** asks for Face ID, Touch ID or, when the system offers it, the device passcode. A cancelled or failed check changes nothing. Only the check's success turns incognito on (`enter_incognito`) and covers the page that was showing with the blank page (`blankTab`), so nothing from the other mode stays on screen. Leaving does the same.
- **While on:** the fan lists the incognito favorites (the first six, like the normal set); every icon in the shell turns gray (`html[data-incognito="true"]`, a CSS `grayscale(1)` on `img` and `svg`; pages are native views and are untouched); the floating button wears a small dark badge with the filled hat-and-glasses icon; and in the fan the toggle turns solid white, its lenses fill, `aria-pressed` is set, and a label reads "Incognito · tap to leave". The color is never the only cue.
- **Leaving** is the same button again, with no check, since leaving only returns to the normal set. The state is not saved: every launch starts in the normal set, and an incognito page is never remembered as the last page. While on, typed addresses are not added to History either.
- **Settings:** "Incognito favorites" (the same editor as Favorites) starts collapsed with a fingerprint icon. "Incognito recipes" has a Settings row and a dedicated page; the row asks for the biometric check and opens the page, which lists the recipes as plain cards; a hub card lists its pages too, which open as ordinary sessions in whichever mode is in play. Collapsing favorites, closing the recipes page or Settings, or sending the app to the background locks access. A failed check leaves the page closed. The recipes page loads favorites for its stars and clears them when it locks unless Incognito is active; recipe switches are cleared whenever the page locks, and the page closes itself when the app goes to the background.
- **Recipes in incognito:** choices are kept apart (`incognitoSiteOptions` in `library.json`) and start from each recipe's defaults. Entering or leaving recompiles the page script from the set now in play; open pages reload only when the two sets compile to different scripts. A change made in one set never touches the other, and the assistant's accepted switches go to the set in play. Adding a recipe from the recipe library while incognito stars its site in the incognito favorites and turns its normal-set switches off, so it only acts in incognito; the incognito set starts from the recipe defaults.
- **Not private storage:** the incognito favorites and choices are plain fields in `library.json`, like everything else, and their icons share the site-icon cache. The check is a screen lock for whoever is holding the phone, not encryption. Incognito does not isolate cookies or logins: sessions still use the profile's data store. Usage time is still counted, so daily limits still apply.

## Usage

The Usage button (bars icon) sits directly above History. The sheet shares the `shared/Screen.tsx` frame with Settings and History and has two tabs. It always reopens on Activity; the in-page notices below open it on Limits.

- **Activity** (`ActivityTab.tsx`): Today / 7 days / 30 days (7 by default), the total (with a daily average over 7 and 30 days), a "Limits today" card, and one row per site with its icon and an expandable section breakdown. In the Today range a site with a limit shows a meter and the time left instead of a plain bar; the expanded row links to that site's limit. The "Limits today" card counts site limits and part limits together, closest to the limit first, and a part is named after its site ("Instagram · Reels"). The expanded breakdown lists each part with its own meter when it has a limit and a link to that part's limit. With no limits set, the card invites the user to set one.
- **Limits** (`LimitsTab.tsx`, `LimitEditor.tsx`): every favorite is a row (name, summary, "left today" chip); tapping it opens the editor. Other sites that have a limit follow, and "Add another site" takes an address or a one-tap suggestion (today's busiest sites, then recent addresses). Nothing is typed to set a time. A site with no limit offers presets (30 m, 1 h, 2 h, 3 h) that set the limit and a reminder at about three quarters of it. A site with a limit has two switches, "Pause the site after" and "Remind me at", each with a `DurationSlider` over uneven stops (5-minute steps to 30 m, then 15 m, 30 m, hours, up to 24 h; a saved value that is not a stop is added so the thumb can sit on it). Dragging updates a live meter, with a tick at the reminder; the value is saved when the finger lifts (native `change`). The reminder and the limit cannot disagree: moving one pulls the other to the neighbouring stop (`reconcile` in `limits.ts`), so there is no error state. Turning both switches off removes the limit. Thresholds are whole minutes, 1 to 1440, and Rust validates them again.
- **Parts of a site.** Under a site's row, the parts it has (its sections, see below) are listed with the time spent on each today, and each part has its own limit: the same editor, with "Stop counting after" instead of "Pause the site after" and a reminder of its own. The parts offered are the ones the site has used in the last 30 days, plus the ones that already carry a limit. A part limit is separate from the site's own limit: the site's limit covers the whole site, a part's limit covers that part alone.
- **What a part limit does.** When a part is over its limit, its time stops counting — the shell does not add the seconds and Rust refuses to record them — and the app says so over the page ("Reels on Instagram is over its daily limit. Time here is no longer counted.") with "Adjust limit" and "Dismiss". The rest of the site keeps counting and stays open. The part is **not** closed by the native shield: the shield covers the whole site and refuses every navigation, so using it for a part would trap the user inside the part they wanted to leave. Closing a part natively needs per-path blocking in the site view plugin, which does not exist yet.
- **In-page notices** (`UsageGuard.tsx`): a reminder slides in at the top once per site, local day and threshold, with the site icon, time today, a meter and time left, and "Adjust limit" (opens Limits on that site) and "Dismiss". A part has its own reminder and its own notice when it is over its limit; the notice names the part and says that its time is no longer counted, and "Adjust limit" opens Limits on that part. At the limit, a native blur shield covers every live session for that site, stops loading, suspends media playback and prevents interaction/navigation; the in-app notice names the site, says when it opens again (midnight, counted down) and offers "Adjust limit" and "See usage". Other sites remain usable. Editing/removing the limit or reaching local midnight re-evaluates the block. This is not a JavaScript-process suspension or a parental-control lock.
- **What counts.** Foreground seconds on an active site with no sheet or guide in front. The shell checks every second, caps a delayed tick at 10 seconds, keeps fractional seconds and flushes about every 30 seconds or on leaving. Blocked sites accrue no further time. An ordinary midnight tick is split between the two dates.
- **Sites** are keyed by the session's registrable domain (`scope`), so `m.youtube.com` and `www.youtube.com` are one row.
- **Sections** come from the first path segment of the page address only, generic for every site: `/watch`, `/shorts`, `/reels`, `/explore`, `/messages` show as Watch, Shorts, Reels, Explore, Messages. A segment is kept only when it is 1-24 characters of `a-z 0-9 _ -` (lowercased) and not all digits; an empty path is **Home**, and anything else (a `@handle`, an id, non-Latin text) is **Other**. Rust validates the same rule again. A section is the unit a **part limit** is set on; the section name is all that is stored.
- **Privacy statement** (shown on the sheet): this information stays on this phone and is never sent anywhere; OpenMedia keeps no copy; only site names, section names and seconds are stored, never full addresses, searches or page titles. **Clear stats** (with a confirm step) wipes it.

## The assistant chat

The floating button opens the assistant, which is a chat (`features/ai/ChatPane.tsx`), not a
one-shot form. The bar shows the site and recipe the chat is about, the turns so far, and the
request in flight.

- **Turns.** What the user asked sits on their side of the chat, what the assistant answered on
  its own. Between them, the steps of the request: reading the page, asking the provider, checking
  the answer, previewing the rules, counting what matched, and asking again when something did
  not. A finished turn keeps its steps behind a "What it did" toggle.
- **The card.** A proposal shows the switch it would add or turn on, with the rules it hides and
  how many elements each rule found on the page, and the Accept / Reject / Ask again buttons. The
  page behind already shows the preview.
- **Header.** *Chat history* opens the list of the site's chats (each with its recipe and date,
  and a button to delete one); *New chat* starts a blank one for the site.
- **While it works.** The bar keeps the steps visible as they come in, so the wait shows what is
  happening. The dock over the page shows the same card while the bar is closed.

## Tabs

The Tabs button sits directly above History in the fan and opens a full-screen page (`features/tabs/TabsSheet.tsx`) with three sections: **Open sites** (every live session, the visible one first, then by last use), **Quick access** (the quick-access favorites, each marked open or not) and the newest addresses of **History** (the History page has the rest). Tapping an open site switches to it without a reload. Each open site has a close button, and "Close the other sites" ends every hidden one; the last open site is never closed, so the app always has a page. Closing only ends the live session: favorites and history are never touched (`closeSession`, `closeOtherSessions` in the store). A **New tab** button above the list (`openNewTab`) shows an empty page and opens the command bar: `blankTab` in the store covers the open sessions with the empty-state page (`WebLayer`), and `selectPage` returns null while it shows, so Back, usage tracking and the assistant treat it as no page. Opening an address, search, favorite, history entry or open site clears it; dismissing the command bar leaves the empty page, and the open sites stay in the list.

Each open site shows measurements kept in memory only, never saved or sent: time to first paint (opening to the first drawn content), the duration of its last load (sampled from state events, so approximate, coarser on macOS where state is polled every 400 ms), foreground time today on its site (from `usage.json`, the same figures as Usage) and how long ago it was used. Memory use per site is not shown: the platform web views do not expose it.

## History

The History button sits above Settings and below Tabs. It lists up to 100 addresses, newest first, with cached/bundled site icons and an independent favorite star: addresses the user typed, and sites reached from a search (the first page a session loads after leaving a search engine's results; `leftSearchForSite`). The search itself is never listed, and neither is moving around inside the site afterwards. Repeated addresses move to the top. Tapping an entry follows the session rules below.

## Onboarding

A full-screen guide shows on first launch: the four illustrated steps below, then two more: Whether it has been seen is stored in `library.json` (`onboarded`). Each step has a looping illustration and a short line:

1. **The web, minus the noise.** What the app is, and that it hides things like app prompts.
2. **One button.** Tap to open an address or request a change; connect a provider in Settings and preview the redacted payload before sending.
3. **Hold for favorites.** An animated fan pops out of a pulsing button: five favorites in an arc, with Usage, Tabs, History and Settings stacked on one side of the button and Incognito and the video controls switch on the other.
4. **Make it yours.** Drag to either edge; change favorites in Settings.

5. **What do you need in quick access?** Checkbox rows for the official recipes of the current platform (site icon, name, one-line summary), a counter `n/limit` (4 free, 6 with Pro; a larger selection is refused), the library's search box and *Filters* dialog (Discover, Type and Category sections only, since every option is already official, for this platform and not added; ticked picks stay ticked while hidden), and loading, error with retry, and skip states. Apply installs the picks through the normal verified install path, replaces the favorites with exactly the installed picks (names cut to 20 characters; favorites are left alone if nothing installed), then completes onboarding. A pick that is not an official option for this platform, or fails to install, is reported back and gets no favorite. More than 6 picks, or a repeat, is refused; 5 or 6 picks without Pro open the paywall. Offline-safe: skipping is always allowed.
6. **The recipe library.** What *official* and *community* recipes are; that every recipe ships inside the app and you review every rule (and every script) before anything applies; that exporting needs Pro and sharing a recipe goes through GitHub.

The two new steps are Design: not built or driven on a device yet. The guide can be skipped at any step. Under `prefers-reduced-motion` the illustrations stay still.

## Aesthetic brief

- **Tone:** brutally minimal. One translucent control over the page, hairline borders, one accent.
- **Button:** 64 px, clear glass with a faint white gradient, bright rim and inner highlight; no backdrop blur. The logo stays at 40 px. A thin progress ring hugs the border during a hold; the button stays anchored at its normal edge position.
- **Glass panels (command bar, assistant dock, usage notice, error banner, back button):** `.glass` with `--glass` as the tint. The page is a native view under the shell, and Chromium's `backdrop-filter` only blurs what the shell draws itself, so on Android a translucent panel would show the page through it, sharp. `<html data-platform="android">` (set in `main.tsx`) makes the tint 98% opaque there.
- **Fan items:** the favorites, stats, history and settings use the same clear glass as the button (`.fab-glass`), with no solid or white background. Icons and monograms are white over the dimmed page.
- **Color:** from the logo (`assets/logo.svg`): cyan `#06aff8` accent, navy `#021669`, and ink/paper tokens. The light theme swaps the same tokens on `<html data-theme="light">`, so components do not know which theme is active. Text on the accent is a fixed dark (`--color-on-accent`) so it reads in both. Fan labels are always white with a shadow, because they sit on the dimmed page.
- **Type:** Schibsted Grotesk (variable), bundled through `@fontsource-variable/schibsted-grotesk`. No CDN: the app makes no third-party requests. Tabular figures for addresses.
- **Motion:** the hold ring and the fan (spring out, staggered about 35 ms, folds back in reverse). Everything else is a plain ease. `prefers-reduced-motion` removes the stagger.
- **Layout:** asymmetric and edge-hugging. Nothing is centered except onboarding.

Tokens are in `src/index.css` (`@theme`).

## Logo and icons

`assets/logo.svg` is the source and is not edited. Its own `viewBox` has wide built-in margins, so two derived files crop to the artwork:

- `assets/icon-source.svg`: a square 1024 master (artwork about 78% of the width, centered, on white) used by `yarn tauri icon assets/icon-source.svg` to generate every platform icon (`src-tauri/icons/`, `src-tauri/gen/apple/Assets.xcassets`).
- `src/assets/logo-mark.svg`: the same paths with a tight `viewBox`, so it scales uniformly inside the button and onboarding.

## Favicons

`yarn build` first runs `yarn icons:fetch`: missing catalog icons are downloaded and converted to compact PNGs, while the committed cache lets ordinary builds run offline. The 18 site icons live under `src/assets/site-icons/`; the generated domain map comes from the recipes, and `manifest.json` records source URLs and hashes. Refreshing assets requires macOS `sips` or ImageMagick. Catalog icons make no runtime network requests.

Other sites are fetched natively when added as favorites or entered/opened from History, never on every startup. The downloader uses the site's icon links, then touch-icon/favicon defaults, restricts links and redirects to the site's domain, accepts at most 400 KB and renders a 96 px PNG. Rust caches by host with domain fallback in `library.json`; History and favorites share it. Startup reads only the local cache; missing icons use monograms.

The build-time fetch reads each site's own files only: its homepage icon links (and those of its bare and `www.` forms), the icons its web app manifest lists, its Windows tile image, then `/apple-touch-icon.png`, `/favicon.ico`, `/favicon.png` and `/favicon.svg`. Icon services are never asked, except that a site whose own domain is such a service (`google.com`, `duckduckgo.com`) may use its own files. Fetches run eight at a time. A site that offers nothing is remembered in `manifest.json` (`missing`, 30 days) so builds do not ask it again, and it never fails the build: pass `--retry` to ask again or `--strict` to fail on any miss. Bundled icons are emitted as files (`assetsInlineLimit` is off for `src/assets/site-icons/`), not inlined into the entry chunk.

## Sessions

Every site the user opens is a **session**: its own native web view, kept alive underneath the one that is visible. Opening another page does not reload existing pages; hidden sessions may be closed by the policy below.

| User action | Result |
|-------------|--------|
| Tap a favorite | Switches to the live session on that favorite's site if there is one (no reload, scroll and form state kept); otherwise opens a new session |
| Type an address in the command bar | Always a new session, so a favorite's session is never replaced. The address is added to history |
| Type a search in the command bar | Opens the search engine chosen in Settings > Browsing (Google by default; also DuckDuckGo, Bing, Brave Search, Ecosia, Startpage, Yahoo) with the text as the query in a new session. The search is not added to history, but a site opened from its results is. Free |
| Pick Auto, Link, Search or Chat in the command bar | Auto: an address opens, text starting with a change verb (hide, remove, block, …; English only) goes to the assistant, anything else is searched. Link: opens only addresses. Search: always searches. Chat: always the assistant. Only the assistant route is Pro: without Pro the Chat button is grayed out with a crown and opens the paywall instead of selecting; a request typed in Auto shows the paywall on submit, before any provider or page check |
| Tap a history entry | Switches to the live session typed with exactly that address; otherwise opens a new one |
| Tap a link to another domain, or a `target=_blank` / `window.open` to one | The session stays where it is; the page opens in a popup browser (see below) |

**A session never leaves its domain.** Each session is pinned to the registrable domain of its address, by the Public Suffix List (`www.instagram.com` and `m.instagram.com` are both `instagram.com`; `news.bbc.co.uk` is `bbc.co.uk`; `alice.github.io` and `bob.github.io` are different sites). One data file, `shared/public-suffix/resources/public_suffix_rules.txt`, feeds the Rust, TypeScript, Kotlin and Swift matchers, which all pass the same vectors; `yarn suffix:update` refreshes it. A main-frame navigation outside it is cancelled and shown in a popup browser, an `SFSafariViewController` presented over the app, with its own Close button. The popup shares nothing with the profile's cookies or recipes. One popup at a time. Until a session's first load finishes, redirects may change its domain (`twitter.com` to `x.com`) and the session adopts the final one. Subframes (ads, embeds) are not blocked. Same-domain `target=_blank` loads in place.

**Which sessions stay alive.** The shell (`features/web/sessions.ts`, unit-tested) keeps one reusable session for each of the first six favorites warm once opened. These sessions are exempt from routine idle and count eviction; matching uses the same domain and session preference as a favorite tap, including typed or restored sessions. Duplicate favorites can share one retained session. Nothing is preloaded.

- Other hidden sessions close after 20 minutes idle.
- The usual cap is 5 total sessions, expanded only enough for the retained quick-access sessions plus the visible page: at most 7. Unprotected typed and restored sessions go before unprotected favorite sessions, oldest first.
- Editing or reordering favorites immediately reconciles retention against the new first six.
- The OS memory warning still closes **every hidden session**, including quick-access sessions. The visible page is never closed by the shell's sweep.

A hidden session whose web content process dies is dropped natively and the shell is told. Reopening anything that was closed starts it fresh. A sweep runs every minute and after each open or switch. Startup restores the last page; if it is on a favorite's site it counts as that favorite's session.

## How it works

- **Layering.** The native site view is *below* the transparent shell, so the button draws over the page. A native `TouchRouter` sends a touch to the shell inside the rectangles the shell reports (`[data-hit]` elements), and to the page everywhere else. Details: [Platform Support](./platform-support.md#layout-model-mobile).
- **Gesture logic** is a pure state machine (`features/fab/gesture.ts`) and the layout math is pure (`features/fab/geometry.ts`), both unit-tested. The fan layout searches rotations, side flips and a compacting arc until every item fits on screen, for 0 to 6 favorites at any height; the edge column holds settings, history and stats.
- **Persistence.** Favorites, history, theme, cached icons, provider settings, AI preview preference and onboarding remain in `library.json` (format v4, preserving v2/v3 upgrades). Local usage is separate in `usage.json`: date -> host -> section -> seconds, plus optional daily policies. Totals retain 30 days; clearing totals preserves policies. All usage commands are shell-only. Day changes reload that date's persisted totals before enforcement resumes. Button position and warning-dismissal bookkeeping are local UI preferences.

## Not connected yet

- **Multiple profiles.** One hidden profile owns the site's cookies. Profile management is deferred.
- **Android and desktop.** Android implementation exists but is not device-verified; desktop site views are deferred.

## Known gaps

- The command bar opens from the top so the keyboard cannot cover it; keyboard behavior on a device is unverified.
- Page scrolling, inertia, pull-to-refresh, long-press and sheet scrolling were verified on the simulator; pinch, hold-slide-lift and edge-swipe back could not be driven with `idb`, and nothing was tried on a device ([Platform Support](./platform-support.md#verified-results)).
- With no bottom bar the page runs under the home indicator; a site's own bottom controls may sit close to it.
- The fan has no sound or haptics.
- Closing sessions for memory is by count, idle time and the OS memory warning, not by measured memory or CPU: WebKit has no public per-page CPU or memory figure that this app could read [INFERENCE: not exhaustively checked]. See [Sessions](#sessions).
- Usage counts foreground time only, not background audio/video. Generic path segments define sections; sites that never change their path show as one area. Native blocking prevents interaction, navigation, loads and media playback, but does not suspend arbitrary page JavaScript.
- History stores addresses only (typed, or reached from a search), without page titles or timestamps; icons are cached separately by host. Per-entry delete is not implemented. Only engines listed in `searchEngines.ts` count as searches, matched by host.
