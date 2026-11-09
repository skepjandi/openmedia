# UI Design

> **Status: Implemented on iOS.** Source lives in `src/` (`features/fab`, `features/sheet`, `features/settings`, `features/onboarding`, `features/web`). Gestures were exercised with synthetic pointer events, not a real finger; see [Platform Support](./platform-support.md#verified-results).

## Idea

The web is the product. The screen is one full-bleed page, from under the status bar to the bottom edge (no bar below it); everything else is a single floating button that stays out of the way. The button is the logo.

| Gesture | Result |
|---------|--------|
| Tap the button | Command bar slides in from the top. Addresses open directly; requests use the active AI provider with a redacted payload preview before sending |
| Hold the button (about 380 ms) | The favorites fan out with Incognito, Usage, History and Settings in the edge column, top to bottom: Incognito directly above Usage, Usage directly above History, Settings last |
| Hold, slide onto an item, lift | Opens that favorite, Usage, History or Settings, or toggles Incognito |
| Hold, lift, then tap an item | Same, in two steps |
| Drag the button | Moves it; on release it snaps to the nearer left or right edge and remembers its place |
| Pull the page down from the top | Native pull-to-refresh (`UIRefreshControl`); only where the page's own scroll view is at the top |

Defaults: Instagram, Facebook, Twitter, Reddit, YouTube. Each fan item shows the site's icon when known, otherwise a monogram. The command bar has back, forward, reload and a favorite star for the current page; History rows also have independent favorite stars. Browsing alone never changes favorites. The first six favorites (`QUICK_ACCESS_LIMIT`) form the quick-access menu; Settings can reorder an unlimited list.

### Unread badges and notifications

A page that has unread items usually says so in its title: `(3) Messenger`. For each quick-access favorite's live session the shell reads that leading `(N)` or `[N]` (`unreadCount`, `src/shared/unread.ts`; a generic title convention, not per-site code). The count appears as a badge on the fan item, and a dot on the floating button when any hidden favorite has one. The page on screen is never badged.

When a hidden quick-access session's count rises, the shell asks the plugin for a local notification (`notify`): the favorite's name as title, "New activity" as body. Page text never reaches the notification, so a page can only choose *whether* to raise one, not what it says. Rules (`observeTitle`, `src/features/web/unreadWatch.ts`):

- The first title a session reports is a baseline; a page that loads already showing `(3)` raises nothing.
- Only a rise raises one, only while the user is on another page, and at most once per session per 30 seconds (a page controls its own title).
- Tapping a notification shows that session (`siteview:notification-tap`, `openSession`) if it is still alive.
- iOS asks for notification permission the first time one is due. If refused, nothing is posted.

There is no setting to turn this off in the app; iOS Settings controls it. No push: see [Platform Support](./platform-support.md).

**Opening a site:** a small accent spinner sits in the page area until the active session first paints or finishes loading. It uses the existing native page state, stays out of the touch router, and stops on errors; switching to a ready session shows no loader. Reduced-motion mode keeps the ring still. The startup splash still covers the first load.

## Settings

Collapsible sections in one scrolling screen, plus two locked incognito sections that start collapsed. Settings and History share the `shared/Screen.tsx` page frame. Expand a section by tapping its heading or using the keyboard. Closing and reopening Settings restores the compact default.

- **Appearance:** System, Light or Dark. Stored in `library.json` and applied to the app and, through the native view's `overrideUserInterfaceStyle`, to sites that follow `prefers-color-scheme`.
- **Browsing:** the global ad-blocking switch for the bundled EasyList and EasyPrivacy rules (changing it reloads the open pages); the floating back button switch; and the shared bottom margin, a slider (0 to 200 px, saved when released) that keeps the bottom of every page clear, for sites whose menus slide under the screen edge. A recipe can override the margin; "Use the shared margin" removes the override. The shell asks Rust which site the current page belongs to (`bottom_margin_for`) and shrinks the native view's rectangle from the bottom; the strip underneath shows the app background.
- **Recipes:** one collapsible card per bundled recipe (18: Instagram, Facebook, X (Twitter), Reddit, YouTube, Threads, Telegram, Douyin, Messenger, Discord, Kuaishou, LinkedIn, WhatsApp, Snapchat, Pinterest, Weibo, TikTok, Twitch; WeChat and QQ have none because their logged-out pages offer nothing to hide). Each card lists its options as switches, annoyances first and then content, each with a one-line description. A switch ON means the thing is hidden. Annoyances (install prompts, pop-ups that block the page, ad slots) start ON; content (Reels, Shorts, Stories, suggestions, whole feeds) starts OFF. Changing a switch saves it and reloads the open page under the recompiled recipe script. The card also holds the recipe's bottom margin; a recipe that runs on the user's own changed copy (a [fork](./recipe-format.md#forks)) says so and offers "Restore the original". A star on each card adds the recipe's site (its `meta.homepage`) to the favorites or removes every favorite that opens it (`set_site_favorite`); a site counts as favorited when any favorite matches the recipe's `match` patterns. See [Site Playbooks](./site-playbooks.md) for what each option covers.
- **Favorites:** a "Quick access" group (the first six) and a "More favorites" group below it. Tap a row to edit its name and address or remove it; arrows reorder, and moving across the boundary moves a favorite in or out of quick access. Every change saves at once, so the list never disagrees with the stars above it.
- **Incognito favorites** and **Incognito recipes:** see [Incognito](#incognito). Always collapsed and locked until a biometric check passes.
- **AI assistant:** bring-your-own-key providers. See [AI Assistant](./ai-assistant.md#implemented-provider-settings).
- **Data and help:** "Clear history" (with a confirm step) empties the searched addresses and forgets the last page, like a browser; favorites, open sessions and logins are untouched. "Replay" marks the first-run guide unseen and shows it again.

## Incognito

The Incognito button (hat-and-glasses icon) is the top item of the edge column, directly above Usage. It swaps the whole quick-access set for a second, separate one and the recipe switches for a second, separate set.

- **Entering** asks for Face ID, Touch ID or, when the system offers it, the device passcode. A cancelled or failed check changes nothing. Only the check's success turns incognito on (`enter_incognito`).
- **While on:** the fan lists the incognito favorites (the first six, like the normal set); every icon in the shell turns gray (`html[data-incognito="true"]`, a CSS `grayscale(1)` on `img` and `svg`; pages are native views and are untouched); the floating button wears a small dark badge with the filled hat-and-glasses icon; and in the fan the toggle turns solid white, its lenses fill, `aria-pressed` is set, and a label reads "Incognito · tap to leave". The color is never the only cue.
- **Leaving** is the same button again, with no check, since leaving only returns to the normal set. The state is not saved: every launch starts in the normal set, and an incognito page is never remembered as the last page. While on, typed addresses are not added to History either.
- **Settings:** "Incognito favorites" (the same editor as Favorites) and "Incognito recipes" (the same switches as Recipes, without the star, margin and changed-copy controls). Both start collapsed with a lock icon. Expanding one asks for the check; collapsing it, closing Settings or sending the app to the background locks it again, and the next look asks again. A failed check leaves it collapsed. The incognito favorites live in the shell only while incognito is on or a section is unlocked.
- **Recipes in incognito:** choices are kept apart (`incognitoSiteOptions` in `library.json`) and start from each recipe's defaults. Entering or leaving recompiles the page script from the set now in play; open pages reload only when the two sets compile to different scripts. A change made in one set never touches the other, and the assistant's accepted switches go to the set in play.
- **Not private storage:** the incognito favorites and choices are plain fields in `library.json`, like everything else, and their icons share the site-icon cache. The check is a screen lock for whoever is holding the phone, not encryption. Incognito does not isolate cookies or logins: sessions still use the profile's data store. Usage time is still counted, so daily limits still apply.

## Usage

The Usage button (bars icon) sits directly above History. The sheet shares the `shared/Screen.tsx` frame with Settings and History and has two tabs. It always reopens on Activity; the in-page notices below open it on Limits.

- **Activity** (`ActivityTab.tsx`): Today / 7 days / 30 days (7 by default), the total (with a daily average over 7 and 30 days), a "Limits today" card, and one row per site with its icon and an expandable section breakdown. In the Today range a site with a limit shows a meter and the time left instead of a plain bar; the expanded row links to that site's limit. With no limits set, the card invites the user to set one.
- **Limits** (`LimitsTab.tsx`, `LimitEditor.tsx`): every favorite is a row (name, summary, "left today" chip); tapping it opens the editor. Other sites that have a limit follow, and "Add another site" takes an address or a one-tap suggestion (today's busiest sites, then recent addresses). Nothing is typed to set a time. A site with no limit offers presets (30 m, 1 h, 2 h, 3 h) that set the limit and a reminder at about three quarters of it. A site with a limit has two switches, "Pause the site after" and "Remind me at", each with a `DurationSlider` over uneven stops (5-minute steps to 30 m, then 15 m, 30 m, hours, up to 24 h; a saved value that is not a stop is added so the thumb can sit on it). Dragging updates a live meter, with a tick at the reminder; the value is saved when the finger lifts (native `change`). The reminder and the limit cannot disagree: moving one pulls the other to the neighbouring stop (`reconcile` in `limits.ts`), so there is no error state. Turning both switches off removes the limit. Thresholds are whole minutes, 1 to 1440, and Rust validates them again.
- **In-page notices** (`UsageGuard.tsx`): a reminder slides in at the top once per site, local day and threshold, with the site icon, time today, a meter and time left, and "Adjust limit" (opens Limits on that site) and "Dismiss". At the limit, a native blur shield covers every live session for that site, stops loading, suspends media playback and prevents interaction/navigation; the in-app notice names the site, says when it opens again (midnight, counted down) and offers "Adjust limit" and "See usage". Other sites remain usable. Editing/removing the limit or reaching local midnight re-evaluates the block. This is not a JavaScript-process suspension or a parental-control lock.
- **What counts.** Foreground seconds on an active site with no sheet or guide in front. The shell checks every second, caps a delayed tick at 10 seconds, keeps fractional seconds and flushes about every 30 seconds or on leaving. Blocked sites accrue no further time. An ordinary midnight tick is split between the two dates.
- **Sites** are keyed by the session's registrable domain (`scope`), so `m.youtube.com` and `www.youtube.com` are one row.
- **Sections** come from the first path segment of the page address only, generic for every site: `/watch`, `/shorts`, `/reels`, `/explore`, `/messages` show as Watch, Shorts, Reels, Explore, Messages. A segment is kept only when it is 1-24 characters of `a-z 0-9 _ -` (lowercased) and not all digits; an empty path is **Home**, and anything else (a `@handle`, an id, non-Latin text) is **Other**. Rust validates the same rule again.
- **Privacy statement** (shown on the sheet): this information stays on this phone and is never sent anywhere; OpenMedia has no server and keeps no copy; only site names, section names and seconds are stored, never full addresses, searches or page titles. **Clear stats** (with a confirm step) wipes it.

## History

The History button sits above Settings and below Usage. It lists up to 100 typed addresses, newest first, with cached/bundled site icons and an independent favorite star. Repeated addresses move to the top. Tapping an entry follows the session rules below.

## Onboarding

A four-step full-screen guide shows on first launch. Whether it has been seen is stored in `library.json` (`onboarded`). Each step has a looping illustration and a short line:

1. **The web, minus the noise.** What the app is, and that it hides things like app prompts.
2. **One button.** Tap to open an address or request a change; connect a provider in Settings and preview the redacted payload before sending.
3. **Hold for favorites.** An animated fan pops out of a pulsing button; settings sits apart.
4. **Make it yours.** Drag to either edge; change favorites in Settings.

It can be skipped at any step. Under `prefers-reduced-motion` the illustrations stay still.

## Aesthetic brief

- **Tone:** brutally minimal. One translucent control over the page, hairline borders, one accent.
- **Button:** 64 px, clear glass with a faint white gradient, bright rim and inner highlight; no backdrop blur. The logo stays at 40 px. A thin progress ring hugs the border during a hold; the button stays anchored at its normal edge position.
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

`yarn build` first runs `yarn icons:fetch`: missing catalog icons are downloaded and converted to compact PNGs, while the committed cache lets ordinary builds run offline. The 18 bundled icons live under `src/assets/site-icons/`; the generated domain map comes from the recipes, and `manifest.json` records source URLs and hashes. Refreshing assets requires macOS `sips` or ImageMagick. Catalog icons make no runtime network requests.

Other sites are fetched natively when added as favorites or entered/opened from History, never on every startup. The downloader uses the site's icon links, then touch-icon/favicon defaults, restricts links and redirects to the site's domain, accepts at most 400 KB and renders a 96 px PNG. Rust caches by host with domain fallback in `library.json`; History and favorites share it. Startup reads only the local cache; missing icons use monograms.

## Sessions

Every site the user opens is a **session**: its own native web view, kept alive underneath the one that is visible. Opening another page does not reload existing pages; hidden sessions may be closed by the policy below.

| User action | Result |
|-------------|--------|
| Tap a favorite | Switches to the live session on that favorite's site if there is one (no reload, scroll and form state kept); otherwise opens a new session |
| Type an address in the command bar | Always a new session, so a favorite's session is never replaced. The address is added to history |
| Tap a history entry | Switches to the live session typed with exactly that address; otherwise opens a new one |
| Tap a link to another domain, or a `target=_blank` / `window.open` to one | The session stays where it is; the page opens in a popup browser (see below) |

**A session never leaves its domain.** Each session is pinned to the registrable domain of its address (`www.instagram.com` and `m.instagram.com` are both `instagram.com`; a short built-in list handles `co.uk`-style suffixes instead of the full public suffix list). A main-frame navigation outside it is cancelled and shown in a popup browser, an `SFSafariViewController` presented over the app, with its own Close button. The popup shares nothing with the profile's cookies or recipes. One popup at a time. Until a session's first load finishes, redirects may change its domain (`twitter.com` to `x.com`) and the session adopts the final one. Subframes (ads, embeds) are not blocked. Same-domain `target=_blank` loads in place.

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
- History stores typed addresses only, without page titles or timestamps; icons are cached separately by host. Per-entry delete is not implemented.
