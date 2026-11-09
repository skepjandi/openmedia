# Site Playbooks

> **Status: Implemented for 18 sites.** The first five (Instagram, Facebook, X, Reddit, YouTube) are the default favorites; Threads, Telegram, Douyin, Messenger, Discord, Kuaishou, LinkedIn, WhatsApp, Snapchat, Pinterest, Weibo, TikTok and Twitch were added later from logged-out research only. WeChat and QQ have no recipe: their logged-out pages offer nothing to hide. The recipes are `recipes/bundled/<site>.json`; their DOM fixtures are in `recipes/fixtures/`. This page is the knowledge behind them, written so that a weaker model (the in-app assistant, see [AI Assistant](./ai-assistant.md)) can write correct selectors for these sites and for new ones. When a selector here stops matching, fix the recipe and this page together.

Researched 2026-11-07 with an iPhone user agent at 390×844 in headless Chromium (not WebKit, so iOS rendering of these selectors is untested), logged out, plus community filter lists. **Nobody on this team could log in during research, so every logged-in selector below is `SOURCE` or `INFERRED`, not `LIVE`.** On-device checks on a real, logged-in account remain the user's.

Evidence tags used everywhere:

| Tag | Meaning |
|-----|---------|
| `LIVE` | Run with `document.querySelectorAll` against the real page in this research session; the match count is recorded. |
| `SOURCE` | Taken from a named, current community list or extension (URL in the sources). Not run by us. |
| `INFERRED` | Reasoned from naming patterns or memory. Not seen. Shipped only where being wrong is harmless (a hide rule for a nag that may never appear). |

## How options and defaults work

See [Recipe Format: Options](./recipe-format.md#options-user-facing-toggles). In short: Settings → Recipes shows one switch per option; ON means hidden. **Annoyances** (install prompts, pop-ups that block the page, scroll locks, ad slots) default ON; **content** (Reels, Shorts, Stories, suggestions, feeds) defaults OFF. A test enforces the policy for every bundled recipe. Changing a switch recompiles the script and applies it to the page at once, without a reload. The user's choices are stored as overrides, so a release can change a default without migrating anyone who never touched the switch.

## Desktop and mobile are different pages

A site picks its DOM from the user agent, not from the viewport. The Mac app sends Safari's desktop user agent, so `www.youtube.com` serves `ytd-*` elements where an iPhone gets `m.youtube.com` and `ytm-*`, Twitch serves the full site with a sidebar and a chat column, and TikTok serves a left sidebar and a full-size player. The mobile selectors above match nothing there. Every recipe that differs carries both: the desktop rules sit beside the mobile ones under the same option (a `-desktop` suffix or a name of their own), so the switch in Settings is one switch on both platforms and the family that is absent matches nothing.

Desktop was checked on 2026-11-10 in the running Mac app, with every option on, comparing each rule's match count with its computed `display`:

| Site | Checked | Not reachable (hand-written fixture, `INFERRED`) |
|------|---------|--------------------------------------------------|
| YouTube | signed in: home, watch, search | end-screen cards, live chat, shopping shelves, playlist cards, Shorts items outside the home feed |
| Reddit | signed in: home, post | none (the lazy left sidebar is transcribed in `desktop-left-nav.html`) |
| Twitch | logged out: home, channel | none |
| TikTok | logged out: For You | profile pages (bot-check page on a direct load) |
| Instagram | logged out: public profile | the signed-in feed |
| Threads, Snapchat, Pinterest, LinkedIn | logged out home | LinkedIn's signed-in feed |
| Facebook, X | login page only | every desktop rule |

When you add a desktop rule, capture its fixture from the real page rather than writing one by hand where you can: the structure with text and personal attributes removed, the ancestors the selector needs, and the `data-keep` marks. A hand-written fixture is allowed for a rule that the page cannot show you, and the recipe's `meta.notes` must say which rules those are.

## Rules for writing a selector (for the in-app assistant)

What the validator allows: one CSS selector (comma lists fine) per rule; at most 300 characters, 19 commas and **2 `:has(` in the whole string**; no `{ } ; \ < @`, backtick or comments; balanced brackets. An option that needs more uses several rules. The `css` rule type takes only `display`, `visibility`, `opacity`, `overflow`, `overflow-x`, `overflow-y`, `position`, `pointer-events`, `filter`, `height`, `min-height`, `max-height`, `touch-action`, `backdrop-filter`. There is no text matching, no JavaScript, no redirect and no XPath.

1. **Find the stable anchor first.** In order of preference: custom-element tag name (YouTube `ytm-*`), `data-*` hook (`data-interaction`, `data-testid`, `data-log-comp-type`), `href` path (`a[href="/reels/"]`), `role` plus `aria-label`, `id`. Never a class that looks generated (`x1i10hfl`, `css-175oi2r`, `r-…`, Tailwind strings, `wbloks_*`); they rotate or sit on everything.
2. **Hide the smallest container, climbing from a child with `:has()`.** `div:has(> a[href="/reels/"])` hides the tab cell, not just the link, so the bar re-flows with no gap. Use `>` chains so the selector matches exactly one element per target.
3. **Count matches before shipping.** Run `document.querySelectorAll(selector).length`. One (or the number of items you expect) is good. Many means you picked a container. Never hide an element as tall as the screen, `main`, `#screen-root`, `ytm-browse`, a feed wrapper, or the player.
4. **Scope risky selectors.** A selector that is harmless logged out can break logged-in pages that reuse the markup. `[role="dialog"][aria-modal="true"]` is the "use the app" sheet logged out and the comment or share sheet logged in; scope it by something that only exists in the unwanted state (a login link on the page, a label prefix).
5. **Hide, don't remove,** and undo scroll locks with a `css` rule scoped to the state that sets them. Do not touch `body{overflow:hidden}` on pages that scroll inside an inner element (YouTube watch).
6. **Say when CSS cannot do it.** Text ("Suggested for you", "Sponsored", "For you"), routes (`/reels/`, `/shorts/ID`), clicks and cookies are outside CSS. Offer the nearest structural proxy (hide the tab, the shelf, the link) and say what remains.
7. **Labels are English.** `aria-label` and `tab-title` values are translated. Prefer `href`, `data-*` or tag names; if a label is the only hook, say it works for English accounts only.
8. **Ship families together.** When a site is mid-redesign (X), put both selector families in one rule; the absent family matches nothing.
9. **SPA pages mutate.** The stylesheet stays valid across pushState navigation, so write selectors that describe the thing, not the page load.

## Instagram (`instagram.default`)

- **Where it lands.** `www.instagram.com`, no redirect to `m.`. One React app for phone and desktop; an iPhone UA at phone width gets a mobile layout. SPA (pushState). Logged out, `/reels/` rewrites itself to `/reels/<shortcode>/`. Logged-out home `/` is a splash, not a feed; every deep link is an app or login funnel.
- **Classes are atomic hashes** (`x1i10hfl …`); only hrefs, roles, aria-labels, `main`, `header`, `article` are stable.
- **Logged-out bottom bar** is plain `div`s (fixed, 44 px, five `div > a` cells), not a `nav`. `nav a[href="/reels/"]` matches nothing.

| Option (default) | Rules and evidence |
|---|---|
| `app-prompts` (on) | `body:has(a[href^="/accounts/login"]) div:has(> div > div > div > [role="dialog"][aria-modal="true"])` `LIVE` 1 match on a profile and on `/reels/`: the fixed overlay that holds the dialog, the dimmed backdrop and the close button. Hiding only the dialog leaves a backdrop that eats taps; hiding it with `div:has([role=dialog])` matches 11 ancestors and blanks the page. The login-link prefix limits it to the logged-out state, so a logged-in share sheet is untouched (the full selector, prefix included, was re-run on a profile: 1 match, and 1 login link on the page). `header:has(a[href^="/accounts/login"]) a[href*="applink.instagram.com"]` `LIVE` 1: the Open app pill. |
| `reels` (off) | `div:has(> a[href="/reels/"])` `LIVE` 1 on `/`: the tab cell (the bar re-laid out cleanly). `div:has(> span > div > a[href="/reels/"])` `SOURCE` (Instagram Purified 2025-07; Hacker News 2025-08), the logged-in wrapper. `article:has(div[aria-label="Video player"])` `SOURCE` (Nuke Insta Slop, updated 2026-09): every video post, Reels **and ordinary videos**. `div[role="tablist"] > div:has(svg[aria-label="Reels"])` the SVG label is `LIVE` (1), the wrapper is `INFERRED`. |
| `explore-tab` (off) | `div:has(> a[href="/explore/"])` `LIVE` 1; wrapped form `div:has(> span > div > a[href="/explore/"])` `SOURCE`. Removes the search entry too. |
| `stories` (off) | `[aria-label="Stories"], [aria-label^="Story by"]` `SOURCE` (Instagram Unhook, 2025). Logged in only. |
| `suggested-posts` (off) | `main article + div:has(img[src*="illo-confirm-refresh"])` and the same followed by ` ~ article` `SOURCE` (Instagram Purified 2025-07-25). A structural proxy: the "You're all caught up" illustration; everything after it is hidden. Image path may rotate. |
| `feed-posts` (off) | `main article` `INFERRED/SOURCE`. Also hides a post opened by address, because CSS cannot tell the feed from a post page. |

**CSS cannot:** block `/reels/` (hide the entry points; a redirect rule does not exist yet); match "Suggested for you" or "Sponsored" by text; hide the splash "Open Instagram / Log In / Sign Up" buttons (hashed classes only, no stable attribute; they only appear logged out); dismiss the cookie dialog (never shown to the research session, no validated rule); Notes (not visible logged out, no selector).

**Pitfalls.** `a[href*="applink.instagram.com"]` unscoped matches 18 elements on a profile, including every grid tile. `header:has(a[href*="applink.instagram.com"])` also matches the profile's own `header`. `[role=dialog]` alone is 1 match but leaves the backdrop. No scroll lock was seen on these overlays (`html` `overflow: auto scroll`, `body` visible), so there is no unlock rule. The Threads link rule seen in a list was dropped: undated, and Threads moved domains in 2025.

**Examples.** *"Remove the Reels tab"* → `div:has(> a[href="/reels/"])`: the href is stable and `:has` removes the wrapper so no empty slot remains. *"Get rid of the 'Watch this reel in the app' popup"* → the overlay selector above, not `[role=dialog]`, because the dim backdrop sits beside the dialog. *"Hide Open app but keep the profile grid"* → scope under the header that holds the login link.

## Facebook (`facebook.default`)

- **Where it lands.** `www.facebook.com` redirects an iPhone UA to `m.facebook.com`, which is Meta's **Bloks** layout (`<html class="wbloks_10">`, `#screen-root`, `#app-body`, `data-mcomponent`, `data-type`), not the desktop Comet UI. `/marketplace/` stays on `www` but still serves Bloks. Desktop selectors (`[role=feed]`, `[aria-posinset]`, `div[role=banner]`, hashed `x…` classes) match nothing here. `wbloks_N`, `m` and `bg-sN` classes sit on almost every element; never use them. Bloks likely navigates inside `#screen-root` without reloads (`INFERRED`).
- Logged out: a login screen with an app banner; public pages (profile, Watch, Marketplace, a Reel) with a sticky Log In and Open app bar, and on Watch and Reels a bottom sheet "Get the full experience".

| Option (default) | Rules and evidence |
|---|---|
| `app-prompts` (on) | `div:has(> div > [aria-label^="Get Facebook"])` `LIVE` 1: the 42 px banner on the login page, login form intact. `[data-log-comp-type="navbar:open_app"]` `LIVE` 1 on `/facebook`, `/marketplace/`, `/watch/`, `/reel/`: the sticky Open app button; the attribute is language-independent. |
| `login-wall` (on) | `[role="dialog"][aria-modal="true"][aria-label^="Get the full experience"]` `LIVE` 1 on `/watch/`: hiding it let Watch scroll. Scroll unlock (`css`, `overflow: auto`) on `html:has(…)` and `body:has(…)` with the same dialog selector: the sheet sets `html{overflow:hidden}` on `/reel/` and `body{overflow:auto hidden}` on `/watch/`. Scoped so pages without the sheet keep their own overflow. |
| `reels` (off) | `[role="tab"][aria-label="Reels"]` `LIVE` 1 on `/facebook` (profile tab). `[role="button"][aria-label^="Reels"]` `LIVE` 1 on `/watch/` (the "Reels , 2 of 5" chip; prefix because of the counter). `[aria-label^="View reel video"]` `LIVE` (thumbnails; leaves an empty "Reels" header row, no stable parent found). |
| `stories` (off) | `div[aria-label="Stories"]` `SOURCE` (kurtnettle/uBO-filters-fb, undated). |

**CSS cannot:** block `/reel/` or `/stories/` (network rules only); match "Suggested for you", "Sponsored", "People you may know" by text (Facebook splits "Sponsored" into one-character spans). No Bloks selector was found for suggested or sponsored posts, People you may know, Groups suggestions, or the Marketplace/Watch/Gaming tabs, so there are no options for them: `INFERRED` tab labels would be English-only guesses. The cookie dialog (`[data-testid="cookie-policy-manage-dialog"]`, a second-hand summary) and a Messenger prompt were not seen and are not shipped.

**Pitfalls.** Never hide `[role="dialog"]` or every `aria-modal` dialog: a logged-in comment or share sheet is one too (`INFERRED`), and `[role=dialog]` alone matched 0 on some pages and 1 on others. On the login page a 844 px `div.wbloks_115` sits four levels above the banner and wraps the whole form: never climb that far. `:has()` over `[data-mcomponent]` can match the feed container itself and hide every post. `[aria-label="Open app"]` matches 2 (the bar and the sheet button); prefer the data attribute. Search-engine-suggested filters like `[data-type*="reel" i]` match nothing (`data-type` is `container` or `text`). The 2020 `m.facebook.com###login_top_banner` rule is for a different DOM and reportedly broke login.

**Examples.** *"Remove the 'Get Facebook for iOS' bar"* → `div:has(> div > [aria-label^="Get Facebook"])`: stable label text on a deep child, climb to the 42 px wrapper and stop. *"Stop the sign-in popup on Watch"* → hide the labelled dialog **and** unlock `html`/`body`.

## X / Twitter (`twitter.default`)

- **Where it lands.** `twitter.com` → `x.com`; iPhone UA stays on `x.com`. The match patterns cover both hosts.
- **Two front ends.** X announced a rebuilt web app on 2026-11-04 (The Verge, 2026-11-05). Logged-out visitors get it now; signed-in users move one country at a time. The rebuilt one has **no `data-testid` at all** (checked on `/`, a profile, a post, the login page, mobile and desktop); it uses `data-interaction`, `data-slot`, `data-engagement-action`, `role`, `href`, and Tailwind-style classes. The classic app keeps `data-testid` and hashed classes. SPA (pushState) in both. Same DOM for phone and desktop width. **Each option ships both families in separate rules; whichever is absent matches nothing.**
- Logged out, every action link on a profile or post is `https://m.x.com/…?launch_app_store=true&ct=engagement_*`; following one aborts and ends at the login page. No bottom sign-up bar, no cookie banner and no scroll lock on the rebuilt app in the research session.

| Option (default) | Rules and evidence |
|---|---|
| `app-prompts` (on) | `[data-interaction="app-store-obstruction"]` `LIVE` 1 on a profile and a post: the dialog wrapper; hiding it removed the dialog, dim and close button. `a[data-slot="xds-button"][href$="launch_app_store=true"]` `LIVE` 2: the header Open app pills. |
| `premium-upsells` (on) | `SOURCE` (FreekyCreep list 2026-09-27; AdGuard X filter 2025.1229; char gist 2025-02): `[data-testid="premium-signup-tab"]`, `[data-testid="verified_profile_visitor_upsell"]`, `[data-testid="TopNavBar"] a[href="/i/premium_sign_up"]`, and `nav a[href="/i/premium_sign_up"]` / `/i/verified-choose` / `/i/premium-business` / `/i/verified-orgs-signup`. Classic app only. |
| `promoted` (on) | `SOURCE`: `[data-testid="placementTracking"]:has(article)`; `[data-testid="cellInnerDiv"]:has([data-testid="top-impression-pixel"])` (hides the timeline cell, not the timeline; the second is from an undated gist). Default on as an in-feed ad the network blocker cannot see. |
| `grok` (off) | `SOURCE` (FreekyCreep): `a[href="/i/grok"]`, `a[href^="/i/grok-redirect"]`, `[data-testid="GrokDrawer"]`, `[data-testid="grokImgGen"]`, and `button[aria-label]:has(svg[viewBox="0 0 33 32"])` (the Grok logo, locale-independent). |
| `explore-tab` (off) | `a[data-testid="AppTabBar_Explore_Link"]` `INFERRED` (from memory of the classic tab bar). Trending lives on Explore on a phone, so this is the practical way to remove it. |

**CSS cannot:** hide only "For you" or force "Following" (no href or text to tell the tabs apart, and `[role=presentation]:first-child` would also hide "Posts" on profiles); hide "Discover more", "Today's News" or "Trending now" by text (all published rules use `:has-text`); block `/explore` or `/i/grok`; rewrite the logged-out `launch_app_store` links (`pointer-events:none` on them would make the page inert); dismiss the classic cookie banner (needs the `d_prefs` cookie). Sidebar rules (`sidebarColumn`, "Who to follow", `news_sidebar`) do nothing at phone width because the sidebar is not rendered, so they are not shipped.

**Pitfalls.** `a[href*="launch_app_store"]` matches 50 elements on a profile (every tab, like and status link). `[data-slot]` matches 33. Never hide `a[data-interaction="mobile-top-bar-log-in"]` (the only log-in link), `[data-testid="loginButton"]`, `article`, or an unscoped `[data-testid="BottomBar"]` (the classic logged-in tab bar). `:upward()` and `:has-text()` in the community lists are uBlock-only: use `X:has(> Y)`. A `svg[viewBox="0 0 22 22"]` verified-badge rule hides real check marks.

**Examples.** *"Stop the open-in-app popup"* → `[data-interaction="app-store-obstruction"]` plus the narrow `$=` pill rule: semantic markers, and the suffix excludes the 48 other `launch_app_store` links. *"Hide Grok everywhere"* → href, test id and the logo-`viewBox` form together.

## YouTube (`youtube.default`)

- **Where it lands.** `m.youtube.com` stays on `m.youtube.com` (adds `?ra=m`). An iPhone UA gets a DOM made of `ytm-*` custom elements plus newer view-model elements (`yt-lockup-view-model`, `grid-shelf-view-model`, `yt-tab-shape`, `chip-shape`, `lazy-list`, `yt-video-metadata-carousel-view-model`). **`ytd-*` elements never appear.** SPA. Paths: `/`, `/results?search_query=`, `/watch?v=`, `/shorts/ID`, `/@handle`, `/playlist?list=`, `/feed/you`, `/feed/subscriptions`; `/feed/explore` and `/feed/trending` redirected to `/`.
- Logged-out bottom bar: Home, Shorts, You (Subscriptions appears logged in, `INFERRED`). A fresh logged-out Home can be an empty "Try searching" page; later loads showed a feed. "Open App" appears only on `/watch`. No overlay and no scroll lock anywhere; `body{overflow:hidden}` on the watch layout is normal, do not override it.
- Lazy loading: Shorts cards appear after scrolling (0 → 3 → 9); CSS applies as nodes arrive.

| Option (default) | Rules and evidence |
|---|---|
| `open-app` (on) | `ytm-mobile-topbar-renderer ytm-button-renderer:has(> a[href^="vnd.youtube://"])` `LIVE` 1 on `/watch`: the header pill (height 40 → 0, nothing else changed). The mic button is also a `ytm-button-renderer`, so the `vnd.youtube://` link anchors it. |
| `promos` (on) | `ytm-mealbar-promo-renderer, ytm-statement-banner-renderer, ytm-upsell-dialog-renderer, ytm-brand-video-singleton-renderer` `INFERRED` from the `ytd-*` names in mjones.network and yt-neuter; none rendered logged out. |
| `ads` (on) | `ytm-companion-slot` `LIVE` 1 (empty companion container). `ytm-promoted-sparkles-web-renderer, ytm-promoted-video-renderer, ytm-ad-slot-renderer, ytm-masthead-ad-renderer` `INFERRED` (no ads were served to the logged-out sessions). |
| `shorts` (off) | `ytm-pivot-bar-item-renderer:has(.pivot-shorts)` `LIVE` 1 (`.pivot-shorts` alone matches 2 nodes). `ytm-rich-section-renderer:has(ytm-shorts-lockup-view-model)` `LIVE` 2 of 3 Home sections (the community-post section stays). `grid-shelf-view-model:has(ytm-shorts-lockup-view-model)` `LIVE` 4–5 on search. `ytm-video-with-context-renderer:has(a[href^="/shorts/"])` `LIVE` 3 after scrolling. `ytm-reel-shelf-renderer` `LIVE` 1 on `/watch`. `yt-tab-shape[tab-title="Shorts"]` `LIVE` 1 on a channel (English label). `ytm-chip-cloud-chip-renderer:has([aria-label="Shorts"])` `SOURCE` (gijsdev/ublock-hide-yt-shorts v2026.4.29; 0 in the tested chip bar, chips are personalised). |
| `home-feed` (off) | `ytm-rich-grid-renderer .rich-grid-renderer-contents` `LIVE` 1 (the feed container; `ytm-rich-grid-renderer` is only used on Home). Counted, not visually tested as hidden. |
| `home-chips` (off) | `ytm-feed-filter-chip-bar-renderer` `LIVE` 1 (leaves a blank gap of about the bar's height). |
| `comments` (off) | `ytm-item-section-renderer:has(> lazy-list > yt-video-metadata-carousel-view-model[aria-label="Comments"])` `LIVE` 1 (113 px → 0). English label. |
| `related` (off) | `.related-items-container` `LIVE` 1: player, title, actions and comments unaffected. |
| `playlists` (off) | `ytm-compact-playlist-renderer`, `ytm-compact-radio-renderer` `LIVE` (present on some pages only). |

**CSS cannot:** block `/shorts/ID` (hide every entry point; direct links still open the player; a request-level redirect is the known workaround, not available here); hide the "Open App" entry in the More sheet (an unmarked `<button>`, identical to "Feedback"); match by length or text; show only subscriptions; disable autoplay or video ads. The consent page (`consent.youtube.com`, EU) is another origin and was not reachable.

**Pitfalls.** Never hide `ytm-app`, `ytm-browse` (shared by Home, channels, playlists), `ytm-search`, `ytm-watch`, a bare `ytm-item-section-renderer` (also holds comments and all search results), `lazy-list`, `ytm-pivot-bar-renderer`, `#player` or `#movie_player`. A blanket `ytm-rich-section-renderer` hides the community posts and nudges too: scope with `:has(ytm-shorts-lockup-view-model)`. Endscreen cards (`.ytp-ce-element`) are `INFERRED` and sit inside `#movie_player`.

**Examples.** *"Hide Shorts everywhere"* → the `shorts` rules: each is the smallest container of an anchor unique to Shorts. *"Stop recommended videos on the watch page"* → `.related-items-container`. *"Empty my Home but keep search"* → `ytm-rich-grid-renderer .rich-grid-renderer-contents`.

## Reddit (`reddit.default`)

- **Where it lands.** `www.reddit.com` serves an iPhone UA the new **shreddit** web-component site (`<shreddit-app app-name="mweb3x" devicetype="mobile">`). `m.`, `i.` and bare `reddit.com` redirect there; `old.reddit.com` redirects to a login page when logged out, so only the shreddit DOM matters. The DOM is chosen by user agent, not viewport. Navigation is mixed: in-site links are SPA, but after the first navigation feed and logo links are `https://applink.reddit.com/…?utm_source=app_first_navigation`, which load a full page.
- **Anatomy.** Feed rows are `article > shreddit-post[post-type="video|image|gallery|link|multi_media"]` followed by a sibling `hr`; `shreddit-ad-post` is a direct child of `shreddit-feed` (not inside an `article`), also followed by an `hr`. Post pages put "People also ask", related posts and translations in `main > div#mosaic-pdp-feed`, separate from the comment tree. Feeds are virtualized (`div.virtualized-placeholder`), so never use `:nth-child`. Many components have shadow roots (`reddit-search-small`, parts of `shreddit-post`); injected CSS cannot reach inside them.
- **The blocking pop-up.** About 28 seconds into a feed (reproduced twice; trigger `global_feeds_30_sec`, experiment `mweb3x_feeds_blocking_xpromo_lo_page_fade`), `div#configured-xpromo-<experiment>.rpl-bottom-sheet.configured-xpromo` is added under `shreddit-app` and `body` gets the class `rpl-scroll-lock`, which the page styles `overflow: hidden !important`. The experiment name changes between releases (another author saw `global_direct_blocking` on 2026-10-17), so only the **id prefix** is matched.

| Option (default) | Rules and evidence |
|---|---|
| `app-prompts` (on) | `#xpromo-small-header, #open-app-header-cta` `LIVE` 1 each on the home feed, a subreddit and a post (`#open-app-header-cta` is the orange link, `#xpromo-small-header` its wrapper; **no banner under the header was found**, the old label was wrong). `div[id^="configured-xpromo-"]:not([id*="nsfw"])` `LIVE` 1 once the sheet is open, 0 before; hiding it removed card and backdrop. `html, body, body.rpl-scroll-lock` with `overflow-y: auto` (`css` rule), see pitfalls. |
| `google-sign-in` (on) | `#credential_picker_container, #credential_picker_iframe, auth-flow-google-one-tap-prompt`. The `position:fixed` 144 px `iframe#credential_picker_iframe` was seen `LIVE` once on a post page and did not return (intermittent); `auth-flow-google-one-tap-prompt` is `LIVE` 1 and empty; the container is `INFERRED` (Google Identity Services' standard wrapper). |
| `ads` (on) | `shreddit-ad-post, shreddit-ad-post + hr` `LIVE` 4 on `/`, 1 on a subreddit (the `hr` must go too or a stray divider stays). `shreddit-comments-page-ad` `LIVE` 1 on a post page (empty). `shreddit-sidebar-ad`, `shreddit-comment-tree-ad` `SOURCE` (Reddit UI Enhancer userscript dumps 2026-09/10), 0 matches logged out. |
| `advertise-links` (on) | `li:has(> a[href*="ads.reddit.com"])`, `li:has(> a[href^="/reddit-pro"])` the links were counted `LIVE` (1 each, in the account drawer); the `li` rows were not applied. |
| `video-posts` (off) | `article:has(> shreddit-post[post-type="video"])` and `… + hr` `LIVE` 7 of 7 on `/`. The same pattern works for `image` (6), `gallery` (1), `link`. |
| `suggested-communities` (off) | `in-feed-community-recommendations` `LIVE` 4 on `/explore/`; 0 in the home feed. |
| `related-posts` (off) | `#answers-suggested-queries-mosaic, div[id$="_related"], div[id$="_translations"]` `LIVE` on a post page: 1 each; hiding all three took `#mosaic-pdp-feed` to 0 px and the 5 comments stayed. |
| `comments` (off) | `div[id^="comment-tree-content-anchor"]` `LIVE` 1 (the post body is a separate sibling). |

**CSS cannot:** reach the search overlay's "Trending" and "Ask" (shadow DOM; hiding `reddit-search-small` breaks search); rewrite the `applink.reddit.com` links; stop the 30-second sheet from being created (hide and unlock only); tell suggested posts from normal ones (`shreddit-post[recommendation-source]` matches every post: 16 of 16 logged out); unblur NSFW posts; style old Reddit. A route block for `/answers/` or `/explore/` needs a redirect.

**Pitfalls.**

- *Scroll-lock specificity (measured).* `html, body { overflow-y: auto !important }` **loses** on `body` to `.rpl-scroll-lock { overflow: hidden !important }`, which is more specific; wheel scrolling only worked because `html` became `auto`, so `body`'s overflow stopped propagating. The rule must name `body.rpl-scroll-lock`. This is the "page would not scroll" bug the first recipe had. Fixture check, in Chromium: with the lock rule present, the compiled script gives `body` a computed `overflow-y` of `auto`.
- Hiding the sheet without the unlock leaves a frozen page; hiding the sign-up drawer also leaves `body.rpl-scroll-lock`.
- `.configured-xpromo` also matches the **18+ confirmation** on `/r/nsfw/` (`div#configured-xpromo-bypassable_xpromo_nsfw_bypassable`); hiding it would leave posts blurred with no way to confirm. Hence `:not([id*="nsfw"])`, and a fixture marks it `data-keep`.
- `configured-xpromo-modal` is only a template host (a `<template>` and a `display:none` `rpl-bottom-sheet`); hiding it does nothing.
- Never hide `rpl-bottom-sheet`, `.rpl-bottom-sheet` or `[role="dialog"]` generically (12 `rpl-bottom-sheet` on the home page, including the account menu `#hui-user-drawer` and the share menu; `div#reddit-search-dialog-content` is the search dialog), nor `faceplate-*` or `shreddit-async-loader` (74 data loaders), `shreddit-app`, `main`, `shreddit-feed`, `[recommendation-source]` or `[data-testid]` (92, none documented as stable).
- `#signup-drawer` matches twice (an empty `display:none` template and the rendered `div#signup-drawer`). It is not an option: it is the sheet that carries the log-in link, so hiding it would leave a logged-out user with no way in from there.
- Not seen: a cookie banner (`reddit-cookie-banner`, `SOURCE` JobcenterTycoon/cookie-auto-decline 2025-09; none appeared from a Sri Lanka address, consent applies to EU, UK and CA) and the Chat and Answers entries (not in the logged-out header). Not shipped.

**Examples.** *"Stop the pop-up that blocks scrolling"* → hide `div[id^="configured-xpromo-"]:not([id*="nsfw"])` and add the `css` rule on `html, body, body.rpl-scroll-lock`. *"Remove ads"* → `shreddit-ad-post` plus its `+ hr`. *"Hide all video posts"* → hide the article from its child with `:has(> shreddit-post[post-type="video"])`, and its divider.

## Bottom margin

Some sites draw fixed bars at the very bottom that sit under the screen edge or under the floating button. Settings → Bottom margin shrinks the native site view from the bottom (0–200 px, shared), and a site card can override it. It is a native layout setting, not CSS, so it works the same on every page and needs no selector. See [UI Design](./ui-design.md#settings).

## Discord (`discord.default`)

Matches `https://*.discord.com/*`. Checked 2026-11-07, logged out, headless Chromium as iPhone (390x844).

**Where it lands.** `/app` redirects to `/login`, which is only a login form: nothing to hide (the QR panel is already `display`-less at phone width). The recipe therefore only touches the marketing home `https://discord.com/`. The logged-in app was not reachable, so it has no rules.

| Option (default) | Rules and evidence |
|---|---|
| Hide download-the-app prompts (on) | `a[href*="/api/downloads/distributions/"]` LIVE 3 (hero and bottom buttons visible, hamburger one in a closed menu). `.banner-top` LIVE 1 but `hiden`, 0px high at phone width, INFERRED to show elsewhere. `.discord_banner` LIVE 1 (closing "go chat" section, 631px). |
| Hide cookie consent banner (on) | `#onetrust-consent-sdk` LIVE 1 as a container; the banner itself never rendered in this session (region/consent), so what it holds is INFERRED from OneTrust's standard markup. |

**Left alone on purpose.** The "Open Discord in your browser" button (it is the way into the web app), the footer and nav "Download" links to `/download`.

**Not verified / CSS cannot do.** Anything in the logged-in app: server/DM lists, Nitro and Quests promos, in-app pop-ups. Class names there are hashed (`name_hash`), so recipes would need stable anchors seen while signed in. The `/download` page was not inspected. No community filter list was consulted.

## Douyin (`douyin.default`)

- **Where it lands.** `www.douyin.com` serves an iPhone UA a React app that renders logged out (no captcha wall was seen; an invisible `#nocaptcha-container` iframe exists). Home is a vertical video feed: `[data-e2e="slideList"]` holding `[data-e2e="feed-item"]` slides with xgplayer controls, under a header (`#douyin-mobile-header`) with search, Log in, Get APP.
- **Classes are hashed**; stable hooks are `data-e2e`, ids and a few readable classes (`disturb-login-panel`, `ai-douyin-entry`).

| Option (default) | Rules and evidence |
|---|---|
| `guide-overlay` (on) | `[data-e2e="recommend-guide-mask"]` `LIVE` 1: the "scroll for more videos" tutorial with a confirm button. |
| `login-nag` (on) | `.disturb-login-panel` `LIVE` 3 (empty or 0 px until triggered). That it is the login nag is `INFERRED` from the name; never saw it populated. |
| `ai-features` (off) | `.ai-douyin-entry` `LIVE` 2; `[data-e2e="chapter-container"]` `LIVE` 1; `#chapterVideoSideCard` `LIVE` 1 (AI chapter summary card, labelled "generated by AI"). |
| `follow-buttons` (off) | `[data-e2e="feed-follow-icon"]` `LIVE` 5: the badge on avatars. |
| `video-info` (off) | `[data-e2e="video-info"]` `LIVE` 2: author, date, co-creators and caption overlay. |

- **Not done.** The Get APP / Log in header buttons have only hashed classes and text, so CSS cannot target them without guessing by position; left alone.
- **Not verified.** Logged-in pages, WKWebView, search/user/live routes, and what the login panels look like when they fire. Headless showed an empty dark player, so the visual effect of the hides is unconfirmed.

## Kuaishou (`kuaishou.default`)

Lands on `https://m.kuaishou.com/` (the mobile UA is redirected there from `www`). Logged out this is a static brand landing page whose only job is to push the app; the feed and videos could not be reached, so the recipe is deliberately small.

| Option (default) | Rules and evidence |
| --- | --- |
| Hide app download prompts (on) | LIVE: `.com-download-bar` = 1 (fixed bottom carousel); `a.open-or-download-app-main, .cover .arrrow-wrapper` = 2 (big CTA button and scroll arrow); `.open-in-browser-dialog, .open-app-confirm-dialog` = 2 (in the DOM, `display:none` until an app-open attempt, so best-effort) |
| Hide the Top up link (off) | LIVE: `.com-header li.nav.highlight` = 1 (recharge link in header menu) |

Fixture: `recipes/fixtures/kuaishou/landing.html` (header, hero and content marked `data-keep`).

What CSS cannot do: stop the page's own app-open redirect attempts; the dialogs are only shown by script.

Not verified: feed, video, profile and live pages (`www.kuaishou.com/brilliant` timed out; the app is required), desktop layout, logged-in state, ads, comments, counters.

## LinkedIn (`linkedin.default`)

Matches `https://*.linkedin.com/*`. Logged-out pages are server-rendered with stable BEM class names and `data-*` attributes, so selectors are plain class/attribute anchors.

**Evidence caveat:** the automation browser would not start in this session, so there is no rendered-page (LIVE) evidence. Every count below comes from the HTML `www.linkedin.com` returned to curl with an iPhone UA, logged out, 2026-11-08 (HTTP 200): `/`, `/jobs/`, `/in/williamhgates`, a `/pulse/` article, a job view, job search, `/company/microsoft`. Tagged HTML.

| Option (default) | Rules and evidence |
|------------------|--------------------|
| App prompts (on) | `.promo-bottom-sheet`: 1 on `/jobs/` (HTML; ships with class `hidden`, script shows it; "LinkedIn is better on the app"). Absent from the other pages' HTML. |
| Sign-in pop-up (on) | `.contextual-sign-in-modal[data-show-on-page-load]`: 1 on profile, article, job view, job search, company (HTML; overlay starts `opacity-0 invisible`, script opens it). Tap-to-open wrappers (Follow, Connect, Apply) lack the attribute and stay. |
| Join banners (on) | `.bottom-cta-banner` 1 (profile); `.aside-section-container:has(.top-content-cta)` 1 (profile, job); `.find-a-referral` 1 (job); `[data-id="conversion-prompt"]` 1 (company, hidden by default). |
| Suggestions (off) | `.browsemap`, `.related-posts` (profile); `.articles-content-card`, `.top-content-categories` (article); `.people-also-viewed` (job); `data-test-id` affiliated-pages / similar-pages / browse-jobs (company); 1 each (HTML). |
| Similar jobs and searches (off) | `.similar-jobs` 1, `.similar-searches` 1, `[data-test-id="more-searches"]` 1 (job page, HTML). |
| Comments and reactions bar (off) | `.comments__container` 1 (5 `.comment`), `.article-social-activity` 1 fixed bottom bar (article, HTML). |
| Posts and activity (off) | `section.activities` 1 (profile), `section.updates` 1 (company, HTML). |
| Promo sections and footer (off) | `.explore-top-content`, `.top-product-categories`, `.game-hub-banner`, `section.directory` 1 each on `/`; `footer.li-footer` 1 on every page (HTML). |

**CSS cannot do:** stop the page script from re-opening the sign-in wall on a tap, dismiss pop-ups it counts as shown (cool-off is stored by the site), or unlock body scroll if the pop-up sets it (none was shipped; unverified).

**Not verified:** any rendered layout, the pop-up and bottom sheet while shown, timed pop-ups after 30 s, cookie/consent banners (none in the HTML; the generic `#toasts` template is deliberately left alone), the logged-in app, routes that answer 999 to curl, and any community filter list.

## Messenger (`messenger.default`)

Matches `https://*.messenger.com/*`. Observed 2026-11-07/08 logged out from a Sri Lanka address: iPhone UA at 390×844, and a desktop UA at 1280×800 for `/login/`.

**Where it lands.** `www.messenger.com/` serves a marketing landing page to a phone UA (`/login/` redirects there): header with a hamburger (menu already hidden at this width), the headline, three download badges, a footer with the language list. The login form appears only with a desktop UA: email, password, Continue, "Keep me signed in", then a row "Not on Facebook? | Forgotten password | Privacy Policy". No cookie banner, "Get Messenger" or "Continue as" prompt was seen in either layout. The logged-in chat UI was not reachable.

| Option (default) | Rules and evidence |
|---|---|
| Hide app download badges (on, annoyance) | `span:has(> a[href^="https://lm.messenger.com/l.php"])`: `LIVE` 3 (Android `#messenger_markerting_android_button`, iOS `#messenger_markerting_ios_button`, a third desktop-app badge span without an id) |
| Hide the "Not on Facebook?" link (on, annoyance) | `a[href^="https://www.facebook.com/r.php"]`: `LIVE` 1 on desktop `/login/`, outside `#login_form` |

**Notes.**
- The badges are wrapped in outbound-link redirector anchors (`lm.messenger.com/l.php?u=…`); the host prefix is a stable anchor where the classes (`_3n-0`) are generated.
- Not shipped, because nothing could be observed: anything inside the signed-in app (chat list, stories, suggested contacts, ads, banners) and the EU/UK consent banner (a required consent dialog must not be hidden anyway).
- Not hidden on purpose: `header[role="banner"]`, `footer[role="contentinfo"]`, `[aria-label="Main content"]`, the "Keep me signed in" checkbox (a user choice), the empty `#header-notices`, the `display:none` `#modalDialog` template and the aria-hidden `#Features_subnav`.
- Fixtures: `landing.html` (phone landing) and `login.html` (desktop login), both distilled from the live pages.

## Pinterest (`pinterest.default`)

Matches `https://*.pinterest.com/*`. Logged out, a phone UA gets the mobile web app (React, hashed classes, stable `data-test-id`). The home page is itself a sign-up screen; every other route (pin, profile, board, search) shows the content behind a modal sign-up dialog.

Evidence: LIVE = seen on the real page (iPhone UA 390x844, logged out, 2026-11-08, pages `/`, `/pin/<id>/`, `/<user>/`, `/<user>/<board>/`, `/search/pins/?q=test`). SOURCE and INFERRED: none used.

| Option (default) | Rules and evidence |
| --- | --- |
| `signup-popup` (on) | LIVE: `div[role="dialog"]:has([data-test-id="mobile-signup-mask"])`, 1 match on pin, profile, board and search, 0 on home. Holds backdrop, card, "Get Pinterest app", email and Google buttons. With it hidden the grid scrolls and no second pop-up came back in 25 s. |
| `home-promo` (on) | LIVE, home only: `[data-test-id^="homepage-section-"]` 3, `bottom-signup-header` 1, `unauth-homepage-redesign-footer` 1. The hero sign-up block stays (`data-keep`). |
| `related-pins` (off) | LIVE: `related-pins-without-drawer` 1 and `more-like-this-button` 2 on a pin; `more-ideas-container` 1 on a board ("More like this"). |
| `comments-button` (off) | LIVE: `comment-button` 1 on a pin. Only the button exists logged out. |
| `follower-counts` (off) | LIVE: `follower-count` 1 on a pin, `div:has(> [data-test-id="profile-followers-count"])` 1 on a profile. |

CSS cannot do:
- Open the real comments or pins: gated cards are not links logged out and need a login anyway.
- Remove sponsored pins: none were shown logged out, so nothing to target.

Not verified: logged-in pages (promoted pins, shopping/"Shop" modules, comment threads, notification prompts, boards with collaborators), non-US regional hosts (`nz.`, `uk.` etc. share the `*.pinterest.com` match but were not opened), cookie banners, and the Google One Tap card that showed once over the search page.

## Snapchat (`snapchat.default`)

Lands on `https://*.snapchat.com/*`. Checked live on 2026-11-08 (headless Chromium, iPhone 390x844 UA, logged out): home, `/spotlight` (redirects to a video at `/@<user>/spotlight/<id>`), a public profile (`/@<user>`, `/add/<user>` redirects there), `/discover` (Stories), `/topic`. The site is a Next.js app with `data-testid` anchors; it asks for the app on every page but shows no cookie banner, sign-in wall or timed pop-up (30 s on home and Spotlight).

| Option (default) | Rules and evidence |
|---|---|
| Hide "better on the app" pop-up (on) | `[data-testid="mobileExpandedCtaBanner"]` and `-backdrop`: 1 each on profile, `/discover` (fixed bottom sheet, Open in Snapchat / Continue). LIVE |
| Hide Open Snapchat bars (on) | `[data-testid="mobileCTAHeader"]` 1 (profile, Stories, topic); `[data-testid="mobile-nav"] a[class*="downloadButton"]` 1 (home, Spotlight); `a[data-testid="home-install-link"]` 1 (home); `div[class*="EndOfFeedPrompt_inlineContainer"]` 1 (profile, "Get the full app experience"). LIVE |
| Hide home page download promo (on) | `a[data-testid="home-hero-download"]` 1, `[data-testid="home-mobile"] div[class*="mobileSlides"]` 1 (looping feature videos), `section[aria-labelledby="home-mobile-closing-heading"]` 1. LIVE |
| Hide the Comment button (off) | `[data-testid="spotlight-engagement-rail"] button:nth-of-type(3)`: 2 (active and next slide). LIVE; position based (Like, Recommend, Comment, Share). |
| Hide like, share and view counts (off) | `[data-testid="spotlight-engagement-rail"] span[class*="__count"]` 7; `[data-testid="content-tile"] div[class*="CountCard_card"]` 24 (12 tiles x views+shares). LIVE |
| Hide local and topic lists (off) | `[data-testid="home-explore"]` 1 (local favorites, popular now, funny topics). LIVE |
| Hide the bottom tab bar (off) | `[data-testid="mobile-tab-bar"]` 1 (home, Spotlight); `[data-testid="mobile-nav-bottom"]` 1 (profile, Stories). Both only deep-link to the app. LIVE |
| Hide footer links (off) | `[data-testid="global-footer"]` 1 (home); `div[class*="Footer_entertainmentBar"]` 1 (profile). LIVE |

Class-substring anchors (`downloadButton`, `mobileSlides`, `__count`, `CountCard_card`, `EndOfFeedPrompt_inlineContainer`, `Footer_entertainmentBar`) use the CSS-module name before the hashed suffix, not the hash; a rebuild could rename them.

What CSS cannot do: the Comment button is found by position, not by label; the "Add" button on profiles (opens the app) and the Spotlight player are left alone; counts cannot be hidden per kind on profile tiles (views and shares share one class).

Not verified: logged-in app, desktop layout (desktop nav Download / Snapchat Ads buttons, whether the desktop footer shows at mobile widths), Stories player pages beyond the landing list, the official `/@snapchat` profile (returned "content not found"), any sign-in wall or timed pop-up beyond 30 s. The empty `mobile-cta-bottom-sheet` placeholder on home has no rule.

## Telegram (`telegram.default`)

Matches `https://*.telegram.org/*` and `https://t.me/*`. In practice it lands on two logged-out pages: the `t.me/<name>` landing page and the `t.me/s/<name>` public channel preview. The logged-out `web.telegram.org/a/` shows only the QR/phone login; no rule targets it. Verified 2026-11-07 at 390x844 with an iPhone user agent, logged out.

| Option (default) | Rules and evidence |
|---|---|
| `app-nags` (on) | `.tgme_channel_join_telegram` (preview header Join, LIVE, 1); `.tgme_head_right_btn` (landing Download, LIVE, 1); `.tgme_page_additional` (landing "If you have Telegram" blurb, LIVE, 1) |
| `link-previews` (off) | `a.tgme_widget_message_link_preview` (LIVE, 4 on t.me/s/telegram) |
| `media` (off) | `a.tgme_widget_message_photo_wrap` (LIVE, 3); `a.tgme_widget_message_video_player` (LIVE, 13) |
| `view-counts` (off) | `.tgme_widget_message_views` (LIVE, 20) plus the ` views` label `.tgme_widget_message_info .copyonly` (LIVE) |

Selectors use the stable `tgme_*` class family, which is hand-written (not hashed) and has been stable for years. No INFERRED or SOURCE rules.

**Not hidden on purpose:** the "View in Telegram" button and "Preview channel" link on the landing page are its only navigation.

**Not verified / CSS cannot do:** logged-in web app (needs an account), reactions, polls, stickers, voice, documents, round videos, sponsored posts. The preview's "Join" and Download links open the app store or `tg://`; CSS only hides them, it cannot stop a deep link a post contains.

## Threads (`threads.default`)

- **Where it lands.** `www.threads.com` serves an iPhone UA the mobile web app: `#barcelona-header` (logo, Log in, Get app), a bottom `nav` (Home, Search, Create, Notifications, Profile) and `#scrollview` holding `#barcelona-page-layout`. Logged out, every fresh load puts a modal sheet over the page. Post pages add a "Related threads" section; profiles add a "Log in to see more from ..." banner.
- **No stable classes**; the hooks are ids (`#barcelona-header`), `data-pagelet` names and `href`s. The desktop layout is a different DOM (it shows the login sheet, not the open-app sheet).
- **No scroll lock** was seen behind the sheet (`html` overflow auto, `body` visible), so no unlock rule is needed.

| Option (default) | Rules and evidence |
|---|---|
| `app-prompts` (on) | `body > div:has(a[download][href*="applink.threads.com"])` `LIVE` 1 on `/`, `/@zuck` and a post: the body-level wrapper of the "Thread on Threads" sheet, which holds the dim backdrop and the card. `#barcelona-header div:has(> a[href*="apps.apple.com"])` `LIVE` 1 on the same three pages: the "Get app" button. |
| `login-wall` (on) | `div:has(> span + div > a[href^="/login"])` `LIVE` 1 on a post ("Log in to see more replies.") and 1 on a profile ("Log in to see more from ..."). The login link is `/login` on a profile and `/login?show_choice_screen=false&variant=username` on a post, so the rule keys on the span+div shape and an href starting with `/login`. The nav entry `a[href="/login/"]` and the header Log in button are not matched. |
| `related-threads` (off) | `div:has(> [data-pagelet^="threads_logged_out_related_posts"])` `LIVE` 1 on a post: the section with the heading and the five `threads_logged_out_related_posts_*` pagelets; 0 on `/` and on profiles. |

- **Left alone on purpose.** The "Say more with Threads" login sheet: its Open Threads link carries `aria-label="Open Threads"` and no `download` attribute, and the sheet sits in its own body-level wrapper, so the login path survives while the open-app sheet is hidden.
- **CSS cannot:** dismiss the sheet in the page's own state (it can only be hidden), match the sheet text, unlock posts or replies behind the login wall, or tell a post from a reply.
- **Not verified.** Logged-in pages (no account was available), WKWebView rendering, the desktop layout, ads and suggested accounts (none were served to the logged-out session), and the other routes (search, notifications, post composer).

## TikTok (`tiktok.default`)

- **Where it lands.** `www.tiktok.com` with an iPhone UA serves the mobile web app (feed `/foryou`, `/discover`, `/@user`, `/@user/video/<id>`); `/explore` redirects to `/foryou`. React/styled-components: classes are `css-<hash>-<hash>--DivName eXXXX`, so rules use `data-e2e` hooks, ids and custom elements. Match pattern `https://*.tiktok.com/*`. Checked logged out on 2026-11-08, headless Chromium, 390x844.
- **Timed pop-ups are session dependent.** The "Get the full app experience" modal showed on first load of `/` and again after the first swipe, but not on every later load; the video-page "Watch this video on TikTok" sheet showed only on the first video load.

| Option (default) | Rules and evidence |
|---|---|
| `app-prompts` (on) | LIVE: `body > div:has(#login-modal)` modal + mask (1 on `/`); feed header "Open app" pill `div:has(> div > button[class*="CTAOpenApp"])` (1); video page: top bar `div:has(> div > [data-e2e="top-banner-open"])` (1), bottom bar via `bottom-banner-open` (1), "Watch on TikTok" section via `bottom_banner` (1), sheet `.launch-popup-sheet-host` (1) and its "Continue on web" wrapper (1); profile: in-flow cover under the grid (1) and the fixed `bottom-cta-container` popup (1, in DOM, not visible); Discover "Discover more" float button (1). |
| `cookie-banner` (on) | INFERRED: `tiktok-cookie-banner` custom element exists on every page but is empty (height 0, shadow root holds an empty `cookie-setting-modal`) from the research region. EU banners not seen. |
| `suggested-videos` (off) | LIVE: video page "You may like" wrapper via `ul[data-e2e="recommend-list"]` (1, 24 items); Discover "Selected by TikTok" heading (1) and list scoped by `video-user-item` (1, 4 items; the same `video-item` on profiles is not matched). |
| `discover-genres` (off) | LIVE: `div:has(> a[href^="/discover/"])` = the genre card row (1). |
| `counters` (off) | LIVE: feed `like-count`/`comment-count`/`share-count` (2 each); video page `play-side-*` spans (1 each); profile stat blocks via `following-count`/`followers-count`/`likes-count` (1 each); `video-views` (24 on `/@tiktok`) and `video-likes` on Discover. |

**Caveat.** `CTAOpenApp` and `DivFloatButtonWrapper` are readable styled-components names matched with `[class*=]`; there is no `data-*` hook. The hash part is never used.

**CSS cannot:** stop the app from re-showing the modal on swipe (it is hidden, not dismissed), block `/live`, or remove the red `+` follow badge without also hiding the avatar link.

**Not verified:** logged-in pages; comments (none rendered logged out); ads or sponsored items (none in the logged-out feed); notification prompts; TikTok Shop; desktop layout; search (results area blank logged out); `/live` shelves left alone on purpose (it is a catalogue); EU cookie banner.

## Twitch (`twitch.default`)

Matches `https://*.twitch.tv/*`. A phone UA lands on `m.twitch.tv`, a React app whose classes are hashed styled-components (`Layout-sc-…`, `ScCoreLink-sc-…`) and unusable; selectors use `data-a-target`, `data-test-selector`, `aria-label`, `href` paths and structure around `h2 > a[href]`.

Checked 2026-11-08 with headless Chromium (iPhone UA 390x844), logged out: `/`, `/directory`, `/directory/all`, a category page, `/directory/following`, `/activity`, `/home`, a live channel (~35 s wait), its `/videos` tab and a VOD.

| Option (default) | Rules and evidence |
|---|---|
| `app-nags` (on) | `nav a[href*="tt_medium=mweb"]` Open App, and `nav > div:has(> a[href*="tt_medium=mweb"]) > button` Sign Up. LIVE: 1 each, top bar of Home, `/directory/following` and category pages. |
| `ad-overlays` (on) | `[data-test-selector="sda-wrapper"]` display-ad slot over the player. LIVE: 1 on a live channel, but empty when seen; harmless best-effort. |
| `suggested-rows` (off) | `div:has(> div > h2 > a[href="/directory"])` ("Categories we think you'll like", LIVE 1) and `div:has(> div > h2 > a[href^="/directory/collection/"])` (themed rows, LIVE 4 at top of Home; more load while scrolling). "Live on Twitch" (`/directory/all`) stays. |
| `stream-tags` (off) | `[aria-label^="Tag, "]` language, genre and DropsEnabled pills on cards. LIVE: 108 on Home. |
| `chat` (off) | `[data-a-target="chat-scroller"]` message list on a live channel. LIVE: 1. The "Send Chat" launcher stays. |
| `subscribe` (off) | `button[aria-label="Subscribe"]`. LIVE: 1 on a channel page and on its profile. Follow stays. |

## What CSS cannot do

- Pre-roll and mid-roll video ads play inside the player (the VOD showed "Ad 1 of 2", Learn More); hiding that overlay would break playback, so no rule.
- Viewer and follower counts have no stable anchor (plain text in hashed containers), so there is no counter option.
- Home shelves are virtualised and lazy-loaded; rows that scroll in later are matched by the same selectors only once they exist.
- `/activity` is only an "Open App for Activity" prompt; there is nothing to hide separately from the page.

## Not verified

No cookie/consent banner, notification prompt, Drops or Prime promo, shopping or AI module appeared logged out, so no rules exist for them. Logged-in views, other regions' consent dialogs, clips/schedule tabs and desktop `www.twitch.tv` are untested. Whether `sda-wrapper` ever shows a visible ad was not observed.

## Weibo (`weibo.default`)

Matches `*.weibo.cn` and `*.weibo.com`. Only the mobile site `m.weibo.cn` was observed (logged out, iPhone UA, 2026-11-08). It opens via `visitor.passport.weibo.cn` and then serves a Vue app: home feed, `/search?containerid=231583` (hot search) and `/status/<id>` (post page).

| Option (default) | Rules and evidence |
|---|---|
| `login-button` (on) | `div.login-box:has(> a.login-btn)`: LIVE, 1 match, fixed button at the bottom of every feed view |
| `follow-buttons` (on) | `header.weibo-top > div.m-followBtn`: LIVE, 20 matches on the Charts tab, 0 on Hot; leads only to sign-in |
| `trending` (off) | `div.card.card16.m-col-2` (2) and `div.card.card11.ctype-3` (1) on the search page: LIVE |
| `feed-tabs` (off) | `.lite-topbar > div.nav-main`: LIVE, 1 match (Hot, Charts, Local, ... tabs) |
| `counters` (off) | `footer.f-footer-ctrl > div.m-diy-btn` (45 on 15 posts) and `div.lite-page-tab div.tab-item > i + i` (3): LIVE |
| `comments` (off) | `div.comment-content` (1), `div.lite-page-tab` (1), `div.lite-page-editor` (1): LIVE on a post page |
| `media` (off) | `div.weibo-media.f-media`: LIVE, pictures and video players in posts |

Classes are Weibo's own layout names (not hashed); `data-v-*` attributes are never used.

What CSS cannot do:
- After several scrolls or reloads, logged out, Weibo redirects the whole tab to `passport.weibo.com/sso/signin`; nothing on the page is hideable.
- `/profile/<uid>` redirected to the same sign-in page immediately, so no profile rules exist.
- The search box placeholder ("大家都在搜: ...") is a trending topic, but it sits inside the search field, so it is left alone.

Not verified: logged-in views, desktop `weibo.com`, `video.weibo.com`, super-topic pages, in-app variant, mainland-China-only prompts. A `div.ad-wrap` exists on post pages but was `display:none` and empty, so no ad rule ships. No cookie banner, app-install sheet or notification prompt appeared in 30 s of waiting.

## WhatsApp (`whatsapp.default`)

Matches `https://*.whatsapp.com/*`. On iPhone UA `web.whatsapp.com` redirects to `/mobile/`, a static "use WhatsApp Web on your computer" page with nothing to hide. Rules therefore land on the `www.whatsapp.com` marketing pages and the desktop-UA WebMessenger login screen. Chats are behind phone/QR login and are not touched.

| Option (default) | Rules and evidence |
|---|---|
| `app-nags` (on) | LIVE: header `a[href*=itunes.apple.com]` in `[data-testid=whatsapp_www_header]` (2, mobile icon + nav dropdown); hero `article a[href*=...ct=website_cta]` (1); footer itunes links (3); desktop web `[data-testid=download-native-client-button]` and `-inline` (1 each). The primary Download button on `/download` is in a `section`, so it stays |
| `promo-sections` (off) | LIVE: `section[data-testid=waui_section]:has(a[href="https://web.whatsapp.com/"])` (1, "Call on WhatsApp Web"); `:has(a[href^="https://whatsappbusiness.com"])` (1, "Transform your business") |
| `footer` (off) | LIVE: `footer[data-testid=whatsapp_www_footer]` (1) |

CSS cannot do: the "Download WhatsApp for Mac" banner card on web.whatsapp.com has only generated classes, so just its button is hidden and the title/blurb text stays.

Not verified: logged-in app (chats, Status, Channels, ads), cookie/consent prompts (none seen in ~20 s), faq.whatsapp.com, other marketing sections. Selectors use `data-testid` and `href` only; the `_au07`-style classes on www are hashed and avoided.

## Sources

- Live pages (iPhone UA, 390×844, logged out, 2026-11-07): instagram.com `/`, `/reels/`, `/explore/`, `/instagram/`, a missing `/p/…`; `m.facebook.com` `/`, `/facebook`, `/watch/`, `/reel/`, `/groups_browse/`, `www.facebook.com/marketplace/`; x.com `/`, `/home`, `/explore`, `/NASA`, a status page, `/i/flow/login`; m.youtube.com `/`, search, watch, a Short, a channel, a playlist, `/feed/*`; www.reddit.com `/`, `/r/popular/`, a subreddit, a post, `/r/nsfw/`, `/explore/`, `/answers/`, search, a user page.
- Instagram: gist.github.com/viki53/74ab17ce5eb3c30699aae5620ad031e0 (Instagram Purified, 2025-07); gist.github.com/shraiwi/009c652da6ce8c99a6e1e0c86fe66886 (Nuke Insta Slop, 2026); greasyfork.org/en/scripts/551825 (Instagram Unhook); news.ycombinator.com/item?id=44941909 (2025-08); github.com/BevizLaszlo/UBlock-Filters-for-Social-Media (undated); secure.fanboy.co.nz/fanboy-mobile-notifications.txt.
- Facebook: github.com/kurtnettle/uBO-filters-fb (undated); gist.github.com/mustafamohsen/bede2bc01f5ddc310af023a490e3aab9 (2025-12, desktop only); greasyfork.org/en/scripts/548145 (desktop only); github.com/easylist/easylist/issues/6018 (2020, stale).
- X: theverge.com/tech/1027113/x-says-its-updated-web-app-is-way-faster (2026-11-05); pastebin.com/raw/Z2Tum43r (FreekyCreep, updated 2026-09-27); github.com/hgsanguk/adguard-x-filter (v2025.1229.0); gist.github.com/char/2b992f69eadafa94c78af30bf2cfda9e (2025-02); github.com/DandelionSprout/adfilt (TwitterPureReadingExperience); github.com/uBlockOrigin/uAssets commit 99deccb (2023-09, `d_prefs` cookie, possibly stale).
- Reddit: greasyfork.org/en/scripts/602031 (Reddit UI Enhancer, dumps 2026-09/10); github.com/zenstorage/Reddit-NSFW-Unblur (filters/ublock.txt, 2026-05); github.com/JobcenterTycoon/cookie-auto-decline commit ae1a88d (2025-09); reddit.com/r/Adguard/comments/1nsjorl (2025-09); sh.itjust.works/post/64935602 and the 2022/2024 r/uBlockOrigin threads on scroll lock (undated or stale; generic selectors rejected).
- YouTube: github.com/gijsdev/ublock-hide-yt-shorts (list.txt v2026.4.29; PR 58, 2025-07); github.com/insin/control-panel-for-youtube issue 187 (2026); mjones.network/ublock-filters.html and github.com/mchangrh/yt-neuter (desktop `ytd-*` names, undated).

## See Also

[Recipe Format](./recipe-format.md) · [AI Assistant](./ai-assistant.md) · [Site Runtime](./site-runtime.md) · [UI Design](./ui-design.md)
