# Site Playbooks

> **Status: Implemented for 18 sites.** The first five are Instagram, Facebook, X, Reddit and YouTube; Threads, Telegram, Douyin, Messenger, Discord, Kuaishou, LinkedIn, WhatsApp, Snapchat, Pinterest, Weibo, TikTok and Twitch were added later from logged-out research only. WeChat and QQ have no recipe: their logged-out pages offer nothing to hide. The recipes are `recipes/official/<site>.json` (published to the marketplace as `market.official.<site>`, not embedded in the app); their DOM fixtures are in `recipes/fixtures/`. This page is the knowledge behind them, written so that a weaker model (the in-app assistant, see [AI Assistant](./ai-assistant.md)) can write correct selectors for these sites and for new ones. When a selector here stops matching, fix the recipe and this page together.

Researched 2026-11-07 with an iPhone user agent at 390×844 in headless Chromium (not WebKit, so iOS rendering of these selectors is untested), logged out, plus community filter lists. **Nobody on this team could log in during research, so every logged-in selector below is `SOURCE` or `INFERRED`, not `LIVE`.** On-device checks on a real, logged-in account remain the user's.

Evidence tags used everywhere:

| Tag | Meaning |
|-----|---------|
| `LIVE` | Run with `document.querySelectorAll` against the real page in this research session; the match count is recorded. |
| `SOURCE` | Taken from a named, current community list or extension (URL in the sources). Not run by us. |
| `INFERRED` | Reasoned from naming patterns or memory. Not seen. Shipped only where being wrong is harmless (a hide rule for a nag that may never appear). |

## How options and defaults work

See [Recipe Format: Options](./recipe-format.md#options-user-facing-toggles). In short: Settings → Recipes shows one control per option. An **on/off switch** hides what its rules point at when it is ON. A **choice option** lists 2 to 4 states instead (Show / Blur / Hide, Show / Dim / Hide), the first of which leaves the page alone, and each of its rules names the states in which it applies. **Annoyances** (install prompts, pop-ups that block the page, scroll locks, ad slots) default to hiding themselves; **content** (Reels, Shorts, Stories, suggestions, feeds) defaults to being left alone. A test enforces the policy for every official recipe. Changing a control recompiles the script and applies it to the page at once, without a reload. The user's choices are stored as overrides, so a release can change a default without migrating anyone who never touched the control.

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
| `app-prompts` (on) | unchanged: overlay `body:has(a[href^="/accounts/login"]) div:has(> div > div > div > [role="dialog"][aria-modal="true"])` `LIVE` 1; `header:has(a[href^="/accounts/login"]) a[href*="applink.instagram.com"]` `LIVE` 1. |
| `reels` (off) | unchanged: `div:has(> a[href="/reels/"])` `LIVE` 1; wrapped form, `article:has(div[aria-label="Video player"])`, `div[role="tablist"] > div:has(svg[aria-label="Reels"])` `SOURCE`/`INFERRED` as before. |
| `explore-tab` (off) | unchanged (`LIVE` 1 direct, `SOURCE` wrapped). |
| `stories` (off) | unchanged (`SOURCE`, logged in only). |
| `suggested-posts` (off) | unchanged (`SOURCE`). |
| `feed-posts` (off) | unchanged (`INFERRED/SOURCE`). |
| `verified-badges` (off) | `svg[aria-label="Verified"]` `LIVE` 1 on `/nasa/`. |
| `footer` (off) | `footer` (desktop fixture). |
| `thumbnails` (choice, show) | blur `css` `filter: blur(14px)` or hide, same selector: `hr ~ div a img` `LIVE` 12 on `/nasa/` (logged-out grid; tiles link to `applink.instagram.com`); `main a[href*="/p/"] img, main a[href*="/reel/"] img` `INFERRED` (logged-in profile and Explore grid links). |
| `post-media` (choice, show) | blur 14 px or hide: `article img[srcset], article video` `INFERRED` (logged in; `srcset` is assumed to separate photos from avatars). Style follows Nuke Insta Slop (`SOURCE`, 2026-03: opacity .2, blur, grayscale on suggested and video posts). |
| `avatars` (choice, show) | blur 10 px or hide: `header section img, header section canvas, article header img`. `LIVE` 1 img and 1 canvas (the avatar and its story ring) on `/nasa/`; `article header img` `INFERRED`. |
| `counts` (off) | `header section a[href="#"]` `LIVE` 2 logged out (followers, following; the links have no real href); `header section a[href$="/followers/"], … $="/following/"` `INFERRED` logged in; `a[href*="/liked_by/"]` `INFERRED` (like count link). Instagram's own Hide like and share counts setting is the safer route for your own account. |
| `direct-messages` (off) | `div:has(> a[href^="/direct/"]), div:has(> a[href^="/u/direct"])` `LIVE` 1 for `/u/direct/` in the logged-out bottom bar (`a[href^="/u/direct"]`, aria-label "Direct"); wrapped form `div:has(> span > div > a[href^="/direct/"])` `INFERRED`. |

**CSS cannot:** block `/reels/` (hide the entry points; a redirect rule does not exist yet); match "Suggested for you" or "Sponsored" by text; hide the splash "Open Instagram / Log In / Sign Up" buttons (hashed classes only, no stable attribute; they only appear logged out); dismiss the cookie dialog (never shown to the research session, no validated rule); Notes (not visible logged out, no selector).

**Pitfalls.** `a[href*="applink.instagram.com"]` unscoped matches 18 elements on a profile, including every grid tile. `header:has(a[href*="applink.instagram.com"])` also matches the profile's own `header`. `[role=dialog]` alone is 1 match but leaves the backdrop. No scroll lock was seen on these overlays (`html` `overflow: auto scroll`, `body` visible), so there is no unlock rule. The Threads link rule seen in a list was dropped: undated, and Threads moved domains in 2025.

**Examples.** *"Remove the Reels tab"* → `div:has(> a[href="/reels/"])`: the href is stable and `:has` removes the wrapper so no empty slot remains. *"Get rid of the 'Watch this reel in the app' popup"* → the overlay selector above, not `[role=dialog]`, because the dim backdrop sits beside the dialog. *"Hide Open app but keep the profile grid"* → scope under the header that holds the login link.

Re-checked 2026-11-13 (headless Chrome, iPhone UA 390x844, logged out: `/nasa/`, a `/p/` page). Choice options (Show / Blur / Hide) are marked `choice`: the first state is the untouched one and no rule lists it.

**CSS cannot:** (added) tell a photo post from a video post except through `Video player`; hide the like count by text; match avatars inside comments (no stable attribute).

**Pitfalls.** Logged-out bottom bar links are `/u/direct/` and `/u/profile/`, not `/direct/inbox/`; the logged-out 404 page (`/p/<bad>/`) shows `nav` with only Log in and Open app, `footer` and `main`. `a[href*="applink.instagram.com"] img` also matches the avatar-sized tile link (13 in all, 12 tiles): scope grids with `hr ~ div`. `header section` is the profile header only; the site's top `header` has no `section`. The avatar sits inside an `a > object > a > img` chain with a sibling `canvas` story ring.

Re-checked 2026-11-13 (headless Chrome, iPhone UA 390x844, logged out: `/nasa/`, a `/p/` page). Choice options (Show / Blur / Hide) are marked `choice`: the first state is the untouched one and no rule lists it.

**CSS cannot:** (added) tell a photo post from a video post except through `Video player`; hide the like count by text; match avatars inside comments (no stable attribute).

**Pitfalls.** Logged-out bottom bar links are `/u/direct/` and `/u/profile/`, not `/direct/inbox/`; the logged-out 404 page (`/p/<bad>/`) shows `nav` with only Log in and Open app, `footer` and `main`. `a[href*="applink.instagram.com"] img` also matches the avatar-sized tile link (13 in all, 12 tiles): scope grids with `hr ~ div`. `header section` is the profile header only; the site's top `header` has no `section`. The avatar sits inside an `a > object > a > img` chain with a sibling `canvas` story ring.

## Facebook (`facebook.default`)

- **Where it lands.** `www.facebook.com` redirects an iPhone UA to `m.facebook.com`, which is Meta's **Bloks** layout (`<html class="wbloks_10">`, `#screen-root`, `#app-body`, `data-mcomponent`, `data-type`), not the desktop Comet UI. `/marketplace/` stays on `www` but still serves Bloks. Desktop selectors (`[role=feed]`, `[aria-posinset]`, `div[role=banner]`, hashed `x…` classes) match nothing here. `wbloks_N`, `m` and `bg-sN` classes sit on almost every element; never use them. Bloks likely navigates inside `#screen-root` without reloads (`INFERRED`).
- Logged out: a login screen with an app banner; public pages (profile, Watch, Marketplace, a Reel) with a sticky Log In and Open app bar, and on Watch and Reels a bottom sheet "Get the full experience".

| Option (default) | Rules and evidence |
|---|---|
| `app-prompts` (on) | unchanged (`LIVE`: `div:has(> div > [aria-label^="Get Facebook"])`, `[data-log-comp-type="navbar:open_app"]`). |
| `login-wall` (on) | unchanged (`LIVE`: full-experience dialog plus `overflow: auto` unlock). |
| `sponsored` (on) | unchanged (`SOURCE`/desktop: `[data-pagelet^="FeedUnit"]:has(a[href*="/ads/about"])`, right-rail box). |
| `reels` (off) | unchanged (`LIVE`: tab, chip, thumbnails; `SOURCE`: feed units and nav links). |
| `stories` (off) | unchanged (`SOURCE`). |
| `right-rail`, `left-rail`, `video-tabs` (off) | unchanged (desktop `data-pagelet` / banner links, hand-written fixture). |
| `reaction-counts` (off) | `[role="button"][aria-label$=" reactions"]` `LIVE` 8 on `/watch/` (English label, "12,345 reactions"); `[data-log-comp-type="feed_post:ufi_blingbar"]` `LIVE` in one server dump, absent after hydration in the next load. |
| `post-buttons` (off) | `[data-log-comp-type$="ufi_like_button"], …"ufi_comment_button"], …"ufi_share_button"]` `LIVE` 8 each, 24 together. The attribute is language-independent; both `seed_post:` (Watch) and `feed_post:` prefixes exist. |
| `videos` (choice, show) | blur `filter: blur(16px)` or hide: `[data-type="video"]` `LIVE` 8 (one per video card, role=button aria-label "Video player"); `[data-pagelet^="FeedUnit"] video` `INFERRED` desktop. Hiding it on `/reel/` hides the reel. |
| `profile-pictures` (choice, show) | blur 8 px or hide: `[aria-label$="Profile Picture"] img` `LIVE` 5 (role=button, English), `[aria-label^="Unseen story from"] img` `LIVE` 3, `[aria-label$="profile picture"] img` seen in a server dump only. |
| `suggested-sections` (off) | `[aria-posinset]:has(a[href="/friends/"])`, `…:has(a[href="/groups/discover/"])`, `…:has([aria-label="Suggested pages"])` `SOURCE` (mustafamohsen Facebook uBO filters gist, undated; desktop feed only, hand-written fixture). |

**CSS cannot:** block `/reel/` or `/stories/` (network rules only); match "Suggested for you", "Sponsored", "People you may know" by text (Facebook splits "Sponsored" into one-character spans). No Bloks selector was found for suggested or sponsored posts, People you may know, Groups suggestions, or the Marketplace/Watch/Gaming tabs, so there are no options for them: `INFERRED` tab labels would be English-only guesses. The cookie dialog (`[data-testid="cookie-policy-manage-dialog"]`, a second-hand summary) and a Messenger prompt were not seen and are not shipped.

**Pitfalls.** Never hide `[role="dialog"]` or every `aria-modal` dialog: a logged-in comment or share sheet is one too (`INFERRED`), and `[role=dialog]` alone matched 0 on some pages and 1 on others. On the login page a 844 px `div.wbloks_115` sits four levels above the banner and wraps the whole form: never climb that far. `:has()` over `[data-mcomponent]` can match the feed container itself and hide every post. `[aria-label="Open app"]` matches 2 (the bar and the sheet button); prefer the data attribute. Search-engine-suggested filters like `[data-type*="reel" i]` match nothing (`data-type` is `container` or `text`). The 2020 `m.facebook.com###login_top_banner` rule is for a different DOM and reportedly broke login.

**Examples.** *"Remove the 'Get Facebook for iOS' bar"* → `div:has(> div > [aria-label^="Get Facebook"])`: stable label text on a deep child, climb to the 42 px wrapper and stop. *"Stop the sign-in popup on Watch"* → hide the labelled dialog **and** unlock `html`/`body`.

Re-checked 2026-11-13: `m.facebook.com/watch/`, iPhone UA 390x844, headless Chrome, logged out. Choice options (Show / Blur / Hide): the first state is the untouched one.

**CSS cannot:** (added) match Reels, Stories or Sponsored by visible text; find the Bloks feed unit boundary logged out; blur only photos in a post (`img[data-type="image"]` also covers 16 px reaction icons, thumbnails and avatars: 46 on `/watch/`).

**Pitfalls.** Bloks exposes language-independent hooks that the old playbook missed: `data-log-comp-type` (`navbar:logo`, `navbar:login`, `navbar:open_app`, `seed_post:ufi_*`, `feed_post:ufi_*`), `data-type` (`video`, `image`, `container`, `vscroller`, `text`), `data-video-id`, `data-testid="story-photo-N"` (on the video cards). Everything else wraps in `data-mcomponent="MContainer"`; do not select by it. `/watch/` cards are children of one `data-type="vscroller"` (68 children); there is no per-post wrapper attribute. Avatar labels are capitalised ("Profile Picture") in the card but lower-case in some server dumps; list both.

Re-checked 2026-11-13: `m.facebook.com/watch/`, iPhone UA 390x844, headless Chrome, logged out. Choice options (Show / Blur / Hide): the first state is the untouched one.

**CSS cannot:** (added) match Reels, Stories or Sponsored by visible text; find the Bloks feed unit boundary logged out; blur only photos in a post (`img[data-type="image"]` also covers 16 px reaction icons, thumbnails and avatars: 46 on `/watch/`).

**Pitfalls.** Bloks exposes language-independent hooks that the old playbook missed: `data-log-comp-type` (`navbar:logo`, `navbar:login`, `navbar:open_app`, `seed_post:ufi_*`, `feed_post:ufi_*`), `data-type` (`video`, `image`, `container`, `vscroller`, `text`), `data-video-id`, `data-testid="story-photo-N"` (on the video cards). Everything else wraps in `data-mcomponent="MContainer"`; do not select by it. `/watch/` cards are children of one `data-type="vscroller"` (68 children); there is no per-post wrapper attribute. Avatar labels are capitalised ("Profile Picture") in the card but lower-case in some server dumps; list both.

## X / Twitter (`twitter.default`)

- **Where it lands.** `twitter.com` → `x.com`; iPhone UA stays on `x.com`. The match patterns cover both hosts.
- **Two front ends.** X announced a rebuilt web app on 2026-11-04 (The Verge, 2026-11-05). Logged-out visitors get it now; signed-in users move one country at a time. The rebuilt one has **no `data-testid` at all** (checked on `/`, a profile, a post, the login page, mobile and desktop); it uses `data-interaction`, `data-slot`, `data-engagement-action`, `role`, `href`, and Tailwind-style classes. The classic app keeps `data-testid` and hashed classes. SPA (pushState) in both. Same DOM for phone and desktop width. **Each option ships both families in separate rules; whichever is absent matches nothing.**
- Logged out, every action link on a profile or post is `https://m.x.com/…?launch_app_store=true&ct=engagement_*`; following one aborts and ends at the login page. No bottom sign-up bar, no cookie banner and no scroll lock on the rebuilt app in the research session.

| Option (default) | Rules and evidence |
|---|---|
| `counts` (off) | existing classic rules `SOURCE`. **Added (rebuilt)** `[data-engagement-action="reply"] svg + span, [data-engagement-action="retweet"] svg + span, [data-engagement-action="like"] svg + span` `LIVE` 5 each (the count wrapper is the span after the icon). |
| `verified-badges` (off) | existing `[data-testid="icon-verified"]` classic `SOURCE`. **Added (rebuilt)** `span[role="button"][aria-label="Verified account"]` `LIVE` 12 (wraps the `svg > use`). English label only. |
| `avatars` (choice show/blur/hide, show) | rebuilt `[data-post-avatar] img` `LIVE` 5; classic `[data-testid="Tweet-User-Avatar"]` `SOURCE` (widely used in uBlock/AdGuard X lists, not served logged out). Blur is `filter: blur(6px)`. |
| `post-media` (choice show/blur/hide, show) | rebuilt `article [data-slot="xds-context-menu-trigger"]` `LIVE` 4 (3 video players + 1 photo; it wraps the `img`/`video` and the Play button); classic `[data-testid="tweetPhoto"], [data-testid="videoPlayer"], [data-testid="card.wrapper"]` `SOURCE`. Blur is `filter: blur(20px)`; hide removes the media block. |
| `quote-posts` (choice show/dim/hide, show) | `[data-slot="embedded-tweet-frame"]` `LIVE` 5 (rebuilt only; contains a nested `article`). Dim is `opacity: 0.35`. No classic rule shipped (no reliable test id). |
| `view-counts` (off) | rebuilt `[data-engagement-action="generic"]` `LIVE` 5; classic `a[href$="/analytics"]` `INFERRED` (the classic view count is a link to `/status/<id>/analytics`). |
| `bookmark-share` (off) | rebuilt `[data-engagement-action="bookmark"], [data-engagement-action="share"]` `LIVE` 5 each; classic `[data-testid="bookmark"], [data-testid="removeBookmark"]` `SOURCE`. |
| `profile-counts` (off) | `a[href$="/following"], a[href*="/following?"], a[href$="/verified_followers"], a[href*="/verified_followers?"]` `LIVE` 1 each: desktop hrefs end in the path, phone hrefs are `https://m.x.com/<user>/following?launch_app_store=true&ct=engagement_generic`. |
| `footer-links` (off) | `nav[aria-label="Footer"]` `LIVE` 1 on desktop, 0 on the phone (not rendered). English label only. |

**CSS cannot:** hide only "For you" or force "Following" (no href or text to tell the tabs apart, and `[role=presentation]:first-child` would also hide "Posts" on profiles); hide "Discover more", "Today's News" or "Trending now" by text (all published rules use `:has-text`); block `/explore` or `/i/grok`; rewrite the logged-out `launch_app_store` links (`pointer-events:none` on them would make the page inert); dismiss the classic cookie banner (needs the `d_prefs` cookie). Sidebar rules (`sidebarColumn`, "Who to follow", `news_sidebar`) do nothing at phone width because the sidebar is not rendered, so they are not shipped.

**Pitfalls.** `a[href*="launch_app_store"]` matches 50 elements on a profile (every tab, like and status link). `[data-slot]` matches 33. Never hide `a[data-interaction="mobile-top-bar-log-in"]` (the only log-in link), `[data-testid="loginButton"]`, `article`, or an unscoped `[data-testid="BottomBar"]` (the classic logged-in tab bar). `:upward()` and `:has-text()` in the community lists are uBlock-only: use `X:has(> Y)`. A `svg[viewBox="0 0 22 22"]` verified-badge rule hides real check marks.

**Examples.** *"Stop the open-in-app popup"* → `[data-interaction="app-store-obstruction"]` plus the narrow `$=` pill rule: semantic markers, and the suffix excludes the 48 other `launch_app_store` links. *"Hide Grok everywhere"* → href, test id and the logo-`viewBox` form together.

Rebuilt front end re-checked logged out on 2026-11-13 on `/elonmusk` with an iPhone UA and a 1440 px desktop UA: both got the rebuilt app (0 `data-testid`, 0 `[data-testid]` anywhere), same DOM. New hooks seen: `data-post-avatar`, `data-engagement-action` (`reply`, `retweet`, `like`, `generic` = views, `bookmark`, `share`), `data-slot="embedded-tweet-frame"` (quote box), `data-slot="xds-context-menu-trigger"` (media holder), `data-press-control`, `nav[aria-label="Footer"]` (desktop only).

**CSS cannot (add):** hide the desktop "Log in or sign up for X" card and the "See the full profile" bar; they are `aside` elements and the only visible log-in/sign-up controls on desktop (the header `mobile-top-bar-log-in` link measures 0x0 there), so hiding them would remove the way in. Hide only "Posts"/"Replies" profile tabs (their hrefs are `launch_app_store` links, a rule would hit all 50).

**Pitfalls (add).**
- Phone profile links are absolute `https://m.x.com/...?launch_app_store=true...` URLs; desktop ones are relative. Rules on `href` need both `$=` and `*="...?"` forms.
- `[data-slot="xds-context-menu-trigger"]` is also on other menus: keep the `article` prefix (4 inside articles on the profile, more outside).
- Embedded quote posts contain their own `article` and `data-post-avatar`, so avatar and media rules also affect them, which is intended.

Rebuilt front end re-checked logged out on 2026-11-13 on `/elonmusk` with an iPhone UA and a 1440 px desktop UA: both got the rebuilt app (0 `data-testid`, 0 `[data-testid]` anywhere), same DOM. New hooks seen: `data-post-avatar`, `data-engagement-action` (`reply`, `retweet`, `like`, `generic` = views, `bookmark`, `share`), `data-slot="embedded-tweet-frame"` (quote box), `data-slot="xds-context-menu-trigger"` (media holder), `data-press-control`, `nav[aria-label="Footer"]` (desktop only).

**CSS cannot (add):** hide the desktop "Log in or sign up for X" card and the "See the full profile" bar; they are `aside` elements and the only visible log-in/sign-up controls on desktop (the header `mobile-top-bar-log-in` link measures 0x0 there), so hiding them would remove the way in. Hide only "Posts"/"Replies" profile tabs (their hrefs are `launch_app_store` links, a rule would hit all 50).

**Pitfalls (add).**
- Phone profile links are absolute `https://m.x.com/...?launch_app_store=true...` URLs; desktop ones are relative. Rules on `href` need both `$=` and `*="...?"` forms.
- `[data-slot="xds-context-menu-trigger"]` is also on other menus: keep the `article` prefix (4 inside articles on the profile, more outside).
- Embedded quote posts contain their own `article` and `data-post-avatar`, so avatar and media rules also affect them, which is intended.

## YouTube (`youtube.default`)

- **Where it lands.** `m.youtube.com` stays on `m.youtube.com` (adds `?ra=m`). An iPhone UA gets a DOM made of `ytm-*` custom elements plus newer view-model elements (`yt-lockup-view-model`, `grid-shelf-view-model`, `yt-tab-shape`, `chip-shape`, `lazy-list`, `yt-video-metadata-carousel-view-model`, `yt-subscribe-button-view-model`, `yt-compactify-video-action-bar-view-model`). **`ytd-*` elements never appear there.** Desktop (`www.youtube.com`) is `ytd-*` plus `yt-lockup-view-model` / `yt-thumbnail-view-model` cards. SPA. Paths: `/`, `/results?search_query=`, `/watch?v=`, `/shorts/ID`, `/@handle`, `/@handle/videos`, `/playlist?list=`, `/feed/you`, `/feed/subscriptions`.
- Logged-out bottom bar: Home, Shorts, You (Subscriptions appears logged in, `INFERRED`). A fresh logged-out Home is the empty "Try searching to get started" page on both platforms, so Home rules are checked against older fixtures. "Open App" appears only on `/watch`. No overlay and no scroll lock anywhere; `body{overflow:hidden}` on the watch layout is normal, do not override it.
- Lazy loading: Shorts cards appear after scrolling (0 → 3 → 9); CSS applies as nodes arrive. The desktop app needs about 20 s in headless Chrome before the page renders.
- 2026-11-13 re-check: real Chrome over CDP, logged out, iPhone UA 390x844 (home, watch, search, channel Videos) and Chrome desktop UA (watch, search). Counts below are `querySelectorAll` on that DOM; new fixtures are sanitised excerpts of it.

| Option (default) | Rules and evidence |
|---|---|
| `open-app` (on) | `ytm-mobile-topbar-renderer ytm-button-renderer:has(> a[href^="vnd.youtube://"])` `LIVE` 1 on `/watch`: the header pill (height 40 → 0, nothing else changed). The mic button is also a `ytm-button-renderer`, so the `vnd.youtube://` link anchors it. |
| `promos` (on) | `ytm-mealbar-promo-renderer, ytm-statement-banner-renderer, ytm-upsell-dialog-renderer, ytm-brand-video-singleton-renderer` `INFERRED` from the `ytd-*` names in mjones.network and yt-neuter; none rendered logged out. Desktop twin `ytd-statement-banner-renderer, ytd-banner-promo-renderer, ...` `LIVE` (signed in, 2026-11-10). |
| `ads` (on) | `ytm-companion-slot` `LIVE` 1 (empty companion container). `ytm-promoted-sparkles-web-renderer, ytm-promoted-video-renderer, ytm-ad-slot-renderer, ytm-masthead-ad-renderer` `INFERRED`. Desktop: `ytd-ad-slot-renderer`, `ytd-search-pyv-renderer` `LIVE` 3 each on a search page (2026-11-13), masthead and player containers `LIVE`. Video ads inside the player are not hidden (see CSS cannot). |
| `premium-upsell` (on) | Desktop only: `ytd-guide-entry-renderer:has(a[href*="premium"])`, `ytd-button-renderer:has(a[href*="premium"])` `LIVE` (signed in, 2026-11-10). |
| `shorts` (off) | `ytm-pivot-bar-item-renderer:has(.pivot-shorts)` `LIVE` 1 (`.pivot-shorts` alone matches 2 nodes). `ytm-rich-section-renderer:has(ytm-shorts-lockup-view-model)` `LIVE` 2 of 3 Home sections (the community-post section stays). `grid-shelf-view-model:has(ytm-shorts-lockup-view-model)` `LIVE` 2 to 5 on search. `ytm-video-with-context-renderer:has(a[href^="/shorts/"])` `LIVE` 3 after scrolling. `ytm-reel-shelf-renderer` `LIVE` 1 on `/watch`. `yt-tab-shape[tab-title="Shorts"]` `LIVE` 1 on a channel (English label). `ytm-chip-cloud-chip-renderer:has([aria-label="Shorts"])` `SOURCE` (gijsdev/ublock-hide-yt-shorts v2026.4.29; 0 in the tested chip bar). Desktop twins (`ytd-reel-shelf-renderer`, `ytd-rich-shelf-renderer[is-shorts]`, sidebar entry, `ytd-video-renderer:has(a[href^="/shorts/"])`) `LIVE` on home, search and watch. |
| `home-feed` (off) | Phone: `ytm-browse:not(:has(yt-page-header-renderer)) ytm-rich-grid-renderer .rich-grid-renderer-contents` `LIVE` 1 on Home, **0 on a channel Videos tab** (fixed 2026-11-13: `ytm-rich-grid-renderer` is shared by Home and channels, the bare selector emptied channel video lists too; the channel has `yt-page-header-renderer`, Home does not). Desktop: `ytd-browse[page-subtype="home"] ytd-rich-grid-renderer > #contents` `LIVE`. |
| `home-chips` (off) | `ytm-feed-filter-chip-bar-renderer` `LIVE` 1 (leaves a blank gap about the bar's height); desktop `ytd-feed-filter-chip-bar-renderer` `LIVE`. |
| `comments` (off) | `ytm-item-section-renderer:has(> lazy-list > yt-video-metadata-carousel-view-model[aria-label="Comments"])` `LIVE` 1 (113 px → 0; English label). Desktop `ytd-comments#comments, ytd-comments-entry-point-header-renderer` `LIVE` 1. |
| `related` (off) | `.related-items-container` `LIVE` 1; desktop `ytd-watch-next-secondary-results-renderer` `LIVE` 1. Player, title, actions and comments unaffected. |
| `playlists` (off) | `ytm-compact-playlist-renderer`, `ytm-compact-radio-renderer` `LIVE` (some pages only); desktop playlist, radio and `yt-lockup-view-model:has(a[href*="list=RD"])` cards. |
| `sidebar-more` (off) | Desktop `ytd-guide-section-renderer:has(a[href="/premium"]), ytd-guide-renderer #footer`; `INFERRED` (the guide drawer was not open in captures). |
| `end-cards` (off) | `.ytp-ce-element, .ytp-ce-covering-overlay, .ytp-endscreen-content, .ytp-pause-overlay, .ytp-suggestion-set` `LIVE` (`.ytp-ce-element` 4, `.ytp-endscreen-content` 1 on desktop watch). |
| `live-chat` (off) | `ytd-live-chat-frame` `INFERRED` (hand-written fixture). |
| `shopping` (off) | `ytd-merch-shelf-renderer, ytd-ticket-shelf-renderer, ytd-product-list-renderer, ytd-donation-shelf-renderer` `INFERRED`; `ytd-info-panel-container-renderer, #clarify-box` `LIVE`. |
| `topbar-buttons` (off) | `#voice-search-button` and the Create button `LIVE` (desktop). |
| `notifications` (off) | `ytd-notification-topbar-button-renderer` `LIVE` (signed in). |
| `library-tabs` (off) | `ytm-pivot-bar-item-renderer:has(.pivot-you)`, `:has(.pivot-subs)` `LIVE` on a phone. |
| `thumbnails` (choice Show/Blur/Hide, show) | blur (css `filter: blur(12px)`): phone `ytm-thumbnail-cover img, ytm-compact-thumbnail img, yt-thumbnail-view-model img` `LIVE` 12 on watch, 19 + 8 on search, `ytm-compact-thumbnail` 30 on a channel; desktop `ytd-thumbnail:not(.player-container-background-image) img, yt-thumbnail-view-model img` `LIVE` 29 + 20 on search, 46 on watch. Hide: the same elements without `img` (duration badge goes with it). The `:not` skips the invisible cinematic backdrop. |
| `video-titles` (choice Show/Blur, show) | css `filter: blur(6px)`: phone `ytm-media-item h3, ytm-compact-video-renderer h4` `LIVE` 12/19 and 30; desktop `yt-lockup-view-model h3` `LIVE` 40, `ytd-video-renderer h3` `LIVE` 18, `ytd-compact-video-renderer h3` `INFERRED`. The `h1` above the player is not touched. |
| `channel-avatars` (off) | Phone `div:has(> ytw-channel-thumbnail-with-link-renderer)` `LIVE` 12/19; `comments-entry-point-teaser-view-model avatar-view-model` `LIVE` 1. Desktop `yt-lockup-metadata-view-model > div:has(> yt-decorated-avatar-view-model)` `LIVE` 38; `ytd-video-renderer #channel-info > a#channel-thumbnail` `LIVE` 18; `ytd-comments #author-thumbnail` `LIVE` 21. |
| `video-stats` (off) | Phone: `.ytmBadgeAndBylineRendererItemByline:has([aria-label$=" views"])` `LIVE` 12/19; `.YtmCompactMediaItemStats:has(...)` `LIVE` on channels; `.ytVideoSubtitleViewModelSubstring[aria-label$=" views"]` and `" likes"` `LIVE` 1 each. Desktop: `yt-content-metadata-view-model [aria-label$=" views"]` `LIVE` 39; `ytd-video-meta-block #metadata-line span.inline-metadata-item:first-of-type` `LIVE` 18; `ytd-watch-info-text`, `ytd-watch-metadata #owner-sub-count`, the like number (`like-button-view-model .ytSpecButtonShapeNextButtonTextContent`) `LIVE` 1 each. English `aria-label` suffix; "1 view" is missed. |
| `hashtags` (off) | `a[href^="/hashtag/"]` `LIVE` 5 (phone crawler description), 3 under the desktop title and 12 in all. `SOURCE` r/uBlockOrigin "disable hashtag links from titles" (`###title h1 a[href^="/hashtag/"]`). |
| `subscribe-buttons` (off) | `yt-subscribe-button-view-model, ytm-subscribe-button-renderer` `LIVE` 1 on watch and 1 on search (phone); `ytd-subscribe-button-renderer, yt-subscribe-button-view-model` `LIVE` 1 (desktop). |
| `action-buttons` (off) | Phone `.ytCompactifyVideoActionBarViewModelActionButtons > button-view-model` `LIVE` 1 (Share). Desktop `ytd-watch-metadata yt-button-view-model:has(button[aria-label="Share"])`, `...[aria-label="Save to playlist"]`, `ytd-watch-metadata ytd-download-button-renderer` `LIVE` 1 each. Like and Dislike stay. |
| `player-overlays` (off) | `.ytp-cards-teaser, .ytp-cards-button, .iv-branding, .ytp-watermark` `LIVE` 1, 1, 1 on desktop watch (the watermark is `INFERRED`, 0 on the test video); `SOURCE` houssemko Youtube-Declutter. Phone player overlays not rendered logged out. |
| `comments-look` (choice Show/Dim/Blur, show) | css on `ytm-item-section-renderer:has(> lazy-list > yt-video-metadata-carousel-view-model[aria-label="Comments"])` (`LIVE` 1) and `ytd-comments#comments` (`LIVE` 1): dim `opacity: 0.35`, blur `filter: blur(8px)`. The hide toggle wins. |
| `related-look` (choice Show/Dim/Blur, show) | the `related` selectors, dim or blur 8px. |
| `home-feed-look` (choice Show/Dim/Blur, show) | the `home-feed` selectors (with the channel-page guard), dim or blur 8px. |
| `search-shelves` (off) | `ytd-search ytd-shelf-renderer` `LIVE` 2 (Music shelves on a "music" search); `SOURCE` Onsotumenh YouTube-Cosmetic-Filters (Latest Posts From, People also watched share the element, `INFERRED`). Desktop only; no phone shelf seen. |
| `mini-player` (off) | `ytd-miniplayer` `LIVE` 1 on the desktop watch page: the small floating player that follows you when you scroll away. Desktop only. The up-next grid at the end of a video (`.ytp-modern-videowall-still`) already carries `ytp-suggestion-set`, so `end-cards` covers it. |

**CSS cannot:** block `/shorts/ID` (hide every entry point; direct links still open the player); hide the "Open App" entry in the More sheet (an unmarked `<button>`, identical to "Feedback"); match by length or text; show only subscriptions; disable autoplay; hide or skip video ads, which play inside the player (the global Ad blocking setting's `openmedia-youtube-ads` scriptlet handles them, see [Ad Blocking](./ad-blocking.md#youtube-ads)); the `ads` rules `ad-slot-feed-mobile`, `ad-shorts-mobile` and `ad-shorts-desktop` are `SOURCE` (uBlock Origin, EasyList) with synthetic fixtures, not captured live. Hovering to reveal blurred thumbnails is not possible in the rule model. The consent page (`consent.youtube.com`, EU) is another origin and was not reachable. The "Ask" AI button never rendered in the logged-out captures (only its label string in the page's i18n table), so there is no rule for it.

**Pitfalls.** Never hide `ytm-app`, `ytm-browse` (shared by Home, channels, playlists), `ytm-search`, `ytm-watch`, a bare `ytm-item-section-renderer` (also holds comments and all search results), `lazy-list`, `ytm-pivot-bar-renderer`, `#player` or `#movie_player`. `ytm-rich-grid-renderer` is used on Home **and** on a channel Videos tab; scope with `ytm-browse:not(:has(yt-page-header-renderer))`. A blanket `ytm-rich-section-renderer` hides the community posts and nudges too: scope with `:has(ytm-shorts-lockup-view-model)`. `ytd-thumbnail` also draws the invisible player backdrop on a watch page (`.player-container-background-image`). `yt-thumbnail-view-model` and `yt-lockup-view-model` are shared by Home, watch and search cards on desktop and by Shorts shelves on a phone. Endscreen cards (`.ytp-ce-element`) sit inside `#movie_player`. Hide-based "look" choices (Dim/Blur) stack under the plain hide toggles: the toggle wins because it removes the element.

**Examples.** *"Hide Shorts everywhere"* → the `shorts` rules. *"Stop recommended videos on the watch page"* → `related`, or `related-look` to just dim it. *"Empty my Home but keep search"* → `home-feed`. *"No clickbait"* → `thumbnails` Blur plus `video-titles` Blur.

## Reddit (`reddit.default`)

- **Where it lands.** `www.reddit.com` serves an iPhone UA the new **shreddit** web-component site (`<shreddit-app app-name="mweb3x" devicetype="mobile">`). `m.`, `i.` and bare `reddit.com` redirect there; `old.reddit.com` redirects to a login page when logged out, so only the shreddit DOM matters. The DOM is chosen by user agent, not viewport. Navigation is mixed: in-site links are SPA, but after the first navigation feed and logo links are `https://applink.reddit.com/…?utm_source=app_first_navigation`, which load a full page.
- **Anatomy.** Feed rows are `article > shreddit-post[post-type="video|image|gallery|link|multi_media"]` followed by a sibling `hr`; `shreddit-ad-post` is a direct child of `shreddit-feed` (not inside an `article`), also followed by an `hr`. Post pages put "People also ask", related posts and translations in `main > div#mosaic-pdp-feed`, separate from the comment tree. Feeds are virtualized (`div.virtualized-placeholder`), so never use `:nth-child`. Many components have shadow roots (`reddit-search-small`, parts of `shreddit-post`); injected CSS cannot reach inside them.
- **The blocking pop-up.** About 28 seconds into a feed (reproduced twice; trigger `global_feeds_30_sec`, experiment `mweb3x_feeds_blocking_xpromo_lo_page_fade`), `div#configured-xpromo-<experiment>.rpl-bottom-sheet.configured-xpromo` is added under `shreddit-app` and `body` gets the class `rpl-scroll-lock`, which the page styles `overflow: hidden !important`. The experiment name changes between releases (another author saw `global_direct_blocking` on 2026-10-17), so only the **id prefix** is matched.

| Option (default) | Rules and evidence |
|---|---|
| `suggested-communities` (off) | existing `in-feed-community-recommendations` `LIVE` 4 on `/explore/`, 0 in the home feed. **Added** `[slot="related-community-recommendation"]` `LIVE` 1 on a post page. |
| `related-posts` (off) | existing three rules (`LIVE` 1 each). **Added** `reddit-pdp-right-rail-post` `LIVE` 25 on a post page (related posts that also appear on the phone page). |
| `feed-media` (choice show/blur/hide, show) | `article shreddit-post [slot="post-media-container"], article shreddit-post [slot="thumbnail"]` `LIVE` 18 + 3 on `/`, 28 on `/r/pics`; 4 more containers sit inside `shreddit-ad-post` and are not matched. The `article` prefix leaves post pages (no `article`) untouched. Blur is `filter: blur(18px)`. Hide collapses the slot, leaving title and flair. |
| `avatars` (choice show/blur/hide, show) | `shreddit-post [slot="credit-bar"] img, shreddit-comment [slot="commentAvatar"]` `LIVE` 36 header icons on `/`, 16 on `/r/pics`, 6 comment avatars on a post. Blur is `filter: blur(6px)`. |
| `reply-depth` (choice show/dim/hide, show) | `shreddit-comment[depth="1"]` `LIVE` 2 of 6 comments on a post (`depth` is `0` for top-level). Dim is `opacity: 0.35` on the reply, which carries everything nested under it; hide removes the whole reply subtree. Only `depth="1"` is matched on purpose (matching deeper levels would multiply the opacity). |
| `post-flair` (off) | `shreddit-post-flair` `LIVE` 28 on `/` and `/r/pics`. |
| `text-previews` (off) | `article shreddit-post [slot="text-body"]` `LIVE` 10 on `/`; not applied on post pages (0 matches there, so the full body stays). |
| `timestamps` (off) | `faceplate-timeago` `LIVE` 28 on `/`, 33 on a post (posts and comments). |
| `comment-actions` (off) | `shreddit-comment [slot="actionRow"]` `LIVE` 9 on a post (vote, reply, award and share row). |
| `subreddit-banner` (off) | `div:has(> #subreddit-banner-img)` `LIVE` 1 on `/r/pics` and `/r/AskReddit`: the 64 px banner wrapper inside the masthead; name, icon and Join stay. |

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

**CSS cannot (add):** hide or blur vote scores and comment counts on feed posts (they are `faceplate-number` inside the `shreddit-post` shadow root, together with the vote buttons); hide the post "..." menu without also touching the action row (`shreddit-post-overflow-menu` is light DOM but removing it is not requested). A desktop UA in headless Chrome got a JS challenge page (`?js_challenge=1`), so only the mobile shreddit DOM was re-checked on 2026-11-13.

**Pitfalls (add).**
- `[slot="post-media-container"]` also exists inside `shreddit-ad-post` (4 on `/`); prefixing `shreddit-post` or `article shreddit-post` avoids touching ads (hidden separately by `ads`).
- Post pages put `shreddit-post` outside any `article`: always prefix feed-only rules with `article`.
- `[slot="text-body"]` on a post page is the post body: never match it without the `article` prefix.
- Comment nesting is the `depth` attribute (0, 1, 2...); `shreddit-comment` elements nest inside their parent's `children` slot, so one rule on `depth="1"` covers every deeper reply.
- A post URL needs the full slug to resolve; `/comments/<id>/` alone returned "not found" for a logged-out phone UA.

**CSS cannot (add):** hide or blur vote scores and comment counts on feed posts (they are `faceplate-number` inside the `shreddit-post` shadow root, together with the vote buttons); hide the post "..." menu without also touching the action row (`shreddit-post-overflow-menu` is light DOM but removing it is not requested). A desktop UA in headless Chrome got a JS challenge page (`?js_challenge=1`), so only the mobile shreddit DOM was re-checked on 2026-11-13.

**Pitfalls (add).**
- `[slot="post-media-container"]` also exists inside `shreddit-ad-post` (4 on `/`); prefixing `shreddit-post` or `article shreddit-post` avoids touching ads (hidden separately by `ads`).
- Post pages put `shreddit-post` outside any `article`: always prefix feed-only rules with `article`.
- `[slot="text-body"]` on a post page is the post body: never match it without the `article` prefix.
- Comment nesting is the `depth` attribute (0, 1, 2...); `shreddit-comment` elements nest inside their parent's `children` slot, so one rule on `depth="1"` covers every deeper reply.
- A post URL needs the full slug to resolve; `/comments/<id>/` alone returned "not found" for a logged-out phone UA.

## Bottom margin

Some sites draw fixed bars at the very bottom that sit under the screen edge or under the floating button. Settings → Bottom margin shrinks the native site view from the bottom (0–200 px, shared), and an expanded favorite in Settings → Favorites can override it. It is a native layout setting, not CSS, so it works the same on every page and needs no selector. See [UI Design](./ui-design.md#settings).

## Discord (`discord.default`)

Matches `https://*.discord.com/*`. Checked 2026-11-07 and 2026-11-13, logged out, headless Chromium as iPhone (390x844).

**Where it lands.** `/app` redirects to `/login`, which is only a login form. Logged out, rules touch the marketing home `https://discord.com/`. The logged-in web app was not reachable, so its rules are SOURCE or INFERRED (see table) and match on stable class prefixes (`[class*="x"]`) because real class names carry a hash suffix.

| Option (default) | Rules and evidence |
|---|---|
| Hide download-the-app prompts (on) | `body:has(div.home--hero) a[href*="/api/downloads/distributions/"]` LIVE 3 (hero, mobile menu, closing band). The same href matches 18 links on `/download`, hence the scope. |
| Hide the closing app promo band (on) | `div.discord_banner` LIVE 1 (631px closing "go chat" band), 0 on `/download`, `/nitro`, `/quests`, `/login`. |
| `cookie-banner` (on) | `#onetrust-consent-sdk` LIVE 1 but empty, 0px: the banner never rendered here (region). Contents are SOURCE (OneTrust standard markup, EasyList cookie lists). `#onetrust-banner-sdk` LIVE 0. |
| `site-footer` (off) | `.footer_new` LIVE 1. The page's `<footer>` tag only holds a decorative robot animation. |
| `home-artwork` Show / Dim / Hide (Show) | `.home--image-wr` LIVE 8, containing all 6 `main video` loops. Dim is `opacity: 0.35`; text stays. |
| `sparkle-decor` (off) | `.star-hero-home` LIVE 89 (5 in view at load). |
| `chat-upsells` (on) | SOURCE `button[aria-label="Send a gift"]` (espimarisa gist; English UI) and `[class*="channelAppLauncher"]` (ikl.sh/garden/discord_ublock, Aug 2024). Web app only, not run live. |
| `dm-store-links` (off) | INFERRED `[class*="privateChannels"] a[href="/store"]` and `a[href="/shop"]`. The ikl.sh list targets these by text xpath, so the hrefs are recalled from the client. |
| `active-now` (off) | SOURCE `[class*="nowPlayingColumn"]` (JustZix example, toydotgame Vencord CSS, r/BetterDiscord). A Dec 2025 thread says older selectors broke after an update, so expect drift. |
| `avatars` Show / Blur (Show) | SOURCE `img[class*="avatar_"]`: `avatar_` classes exist in the shipped login-page CSS (`avatar_SISQ-M`). |
| `chat-media` Show / Blur / Hide (Show) | INFERRED `[class*="imageWrapper_"], [class*="embedWrapper_"]`: long-lived names in community themes, absent from the login CSS chunks. |

**CSS cannot do:** pick the Activity group in the member list (it is an unclassed `div`; uBlock needs `:xpath`), or pick Nitro/Shop by their text.

**Pitfalls.** The page's `<footer>` is not the footer; use `.footer_new`. Logged-in class names are `name_hash`; never match the hash. Left alone: the "Open Discord in your browser" button, nav and footer `/download` links.

## Douyin (`douyin.default`)

- **Where it lands.** Two layouts were seen for the same iPhone UA. 2026-11-07: `www.douyin.com/` served the vertical slide feed (`[data-e2e="slideList"]` > `[data-e2e="feed-item"]`, xgplayer). 2026-11-13: it redirected to `/jingxuan`, a desktop-style Featured grid (`.discover-video-card-item` cards under `.discover-tab-bar`, left navigation with a red Get APP tile) squeezed into 390 px. Rules for both are kept; each rule only matches in its own layout.
- **Classes are hashed**; stable hooks are `data-e2e`, ids, `discover-*`, `waterfall-videoCardContainer`, `videoImage`, `tab-get_app`, `xgplayer-*`/`xg-*` tags, `disturb-login-panel`, `ai-douyin-entry`.

| Option (default) | Rules and evidence |
|---|---|
| `guide-overlay` (on) | `[data-e2e="recommend-guide-mask"]` `LIVE` 1 (slide layout, 11-07). |
| `login-nag` (on) | `.disturb-login-panel` `LIVE` 3 (11-07; empty until triggered). Login-nag role `INFERRED`. |
| `ai-features` (off) | `.ai-douyin-entry` `LIVE` 2; `[data-e2e="chapter-container"]` `LIVE` 1; `#chapterVideoSideCard` `LIVE` 1 (11-07). |
| `follow-buttons` (off) | `[data-e2e="feed-follow-icon"]` `LIVE` 5 (11-07). |
| `video-info` (off) | `[data-e2e="video-info"]` `LIVE` 2 (11-07). |
| `thumbnails` (choice Show/Blur/Hide, show) | blur: `.discover-video-card-img` css `filter: blur(16px)` `LIVE` 30; hide: `.discover-video-card-item .videoImage` `LIVE` 30 (grid layout, 11-13). |
| `card-captions` (off) | `.discover-video-card-item .videoImage + div` `LIVE` 30: title, author and date under each card (11-13). |
| `video-blur` (off) | `xg-video-container video` css `filter: blur(20px)`; `SOURCE` earlier 11-07 fixture (0 on the grid layout). |
| `player-chrome` (choice Show/Dim/Faint, show) | `.xgplayer-controls xg-left-grid, .xgplayer-controls xg-right-grid, .xgplayer-video-info-wrap` css opacity 0.35 (dim) or 0.1 (faint). `SOURCE` greasyfork douyin-helper "pure mode" (opacity 0.1 controls, 0.3 info wrap) plus 11-07 fixture; not LIVE on the grid layout. |
| `side-counters` (off) | `[data-e2e="video-player-digg"] > div, [data-e2e="feed-comment-icon"] > div, [data-e2e="video-player-share"] > div`: counts only, buttons stay. 11-07 fixture, `INFERRED` for current layout. |
| `app-promo` (on) | `.tab-get_app` `LIVE` 1: red Get APP tile in the left navigation (11-13). The slide layout's header Get APP has no stable hook. |
| `category-tabs` (off) | `.discover-tab-bar` `LIVE` 1 (11-13). Hide the bar only; `.discover-tab-container` also wraps the grid. |
| `header-icons` (off) | `[data-e2e="notice-entry"], [data-e2e="im-entry"]` `LIVE` 1 + 1 (11-13). |

Fixtures: `feed-logged-out.html` (slide layout) and `jingxuan-grid.html` (grid layout, hand-reduced from the live DOM).

What CSS cannot do: block the sponsored first video or full-screen ad popups (AdGuard issue 212150 reports them); they are fed by the API response.

Pitfalls: hashed class names rotate per deploy, never use them. The same URL can yield a different layout per visit; do not assume the slide feed exists. `.discover-tab-container` contains the whole grid, so hide only `.discover-tab-bar`.

## Kuaishou (`kuaishou.default`)

Lands on `https://m.kuaishou.com/` (mobile UA is redirected there from `www`). Logged out this is a static brand landing page whose job is to push the app. Re-checked 2026-11-13: same page; the real web app (`www.kuaishou.com/brilliant`, desktop UA) timed out again (~50 s), so feed/video/profile/live are not covered. No community cosmetic list was found for m.kuaishou.com; every rule is `LIVE`.

| Option (default) | Rules and evidence |
| --- | --- |
| `app-prompts` (on) | `.com-download-bar` `LIVE` 1; `a.open-or-download-app-main, .cover .arrrow-wrapper` `LIVE` 2; `.open-in-browser-dialog, .open-app-confirm-dialog` `LIVE` 2 (display:none until an app-open attempt, best-effort). |
| `top-up-link` (off) | `.com-header li.nav.highlight` `LIVE` 1. |
| `landing-pictures` (choice Show/Blur/Hide, show) | blur: `.title-pic .pic-wrapper img.pic` css `filter: blur(14px)` `LIVE` 3; hide: `.title-pic .pic-wrapper` `LIVE` 3 (phone screenshots). |
| `marketing-sections` (off) | `.page-content .title-pic` `LIVE` 3: headline + tagline + picture blocks. |
| `brand-slogan` (off) | `.cover img.slogan` `LIVE` 1: slogan artwork above the download button. |
| `header-menus` (off) | `.com-header .navs > li.nav:has(> a > span.triangle)` `LIVE` 2: the APP and About dropdowns (Home and Top up stay separate). |
| `registration-footer` (off) | `.com-icp` `LIVE` 1: ICP and public-security links. |

Fixture: `recipes/fixtures/kuaishou/landing.html` (header, hero and content marked `data-keep`).

What CSS cannot do: stop the page's own app-open redirect attempts; the dialogs are only shown by script.

Pitfalls: `www.kuaishou.com` desktop app was unreachable from headless Chromium, so do not add feed rules without a live session.

## LinkedIn (`linkedin.default`)

Matches `https://*.linkedin.com/*`. Logged-out pages are server-rendered with stable BEM class names and `data-*` attributes (no hashed classes), so selectors are plain class/attribute anchors.

**Evidence.** LIVE = `querySelectorAll` in headless Chrome (puppeteer), logged out, 2026-11-13, iPhone UA 390x844 and macOS Safari UA 1280x800: `/`, `/in/williamhgates`, `/company/microsoft`, a `/jobs/view/<id>`, `/jobs/search/?keywords=engineer`. HTML = server HTML via curl, iPhone UA, 2026-11-08 (earlier evidence, still valid). SOURCE = named current list, not seen on a page here (the signed-in app needs a login; hand-written fixtures `desktop-feed.html`, `desktop-feed-new.html`). INFERRED = reasoned. Counts are total (visible).

| Option (default) | Rules and evidence |
|------------------|--------------------|
| App prompts (on) | `.promo-bottom-sheet`: 1 on `/jobs/` (HTML; ships with class `hidden`, script shows it). Absent from the other pages. |
| Sign-in pop-up (on) | `.contextual-sign-in-modal[data-show-on-page-load]`: 1 on profile, article, job, job search, company (HTML); LIVE 1 (0 visible until its script opens it) on profile and company. Tap-to-open wrappers (Follow, Connect, Apply) lack the attribute and stay. `#credential_picker_container` 1 (1) on desktop pages, LIVE. **The dialog that really opens is portaled:** `.top-level-modal-container` 1 (1) on profile, company and job pages (0 on `/`), holding `.modal--contextual-sign-in-v2` ("View Bill's full profile"); the v1 `.modal--contextual-sign-in` inside the attribute wrapper no longer exists (0 matches). New rule `.top-level-modal-container`; with it hidden the profile renders fully (checked with a screenshot). The other modals (logo, title, contact info, mutual connections, Follow) are inline and stay. |
| Join banners (on) | `.bottom-cta-banner` 1 (1) LIVE profile; `.aside-section-container:has(.top-content-cta)` 1 (profile, job, HTML); `.find-a-referral` 1 (job, HTML); `[data-id="conversion-prompt"]` 1 (0 visible), LIVE company. |
| Promoted posts and ads (on) | INFERRED + SOURCE (signed in): `.ad-banner-container`, `.ad-banner`, `.feed-shared-update-v2:has(.update-components-actor__sub-description a[href*="/ad"])`. LinkedIn Focus also uses `.ad-banner-container`. |
| Premium prompts (on) | SOURCE (signed in): `.premium-upsell-link`, `.premium-upsell-card`, `a[href*="/premium/products"]` (mig4ng/ublock-origin-filters has `.premium-upsell-link`). |
| Suggestions (off) | `.browsemap` 1, `.related-posts` 1 LIVE profile; `.articles-content-card`, `.top-content-categories` (article), `.people-also-viewed` (job), `data-test-id` affiliated-pages / similar-pages / browse-jobs (company); HTML. |
| Similar jobs and searches (off) | `.similar-jobs` 1, `.similar-searches` 1, `[data-test-id="more-searches"]` 1 (job, HTML). |
| Comments and reaction bars (off) | `.comments__container` 1 (5 `.comment`), `.article-social-activity` 1 fixed bottom bar (article, HTML). New rule `.social-action-bar`: 8 (8) profile, 10 (10) company, LIVE (the Like, Comment, Share row under each public post card). |
| Posts and activity (off) | `section.activities` 1 LIVE profile; `section.updates` 1 LIVE company. |
| Promo sections and footer (off) | `.explore-top-content`, `.top-product-categories`, `.game-hub-banner`, `section.directory` 1 each on `/`; `footer.li-footer` 1 on every page; LIVE mobile and desktop. |
| Feed sidebars (off) | INFERRED (signed in): `.scaffold-layout__aside, .scaffold-layout__sidebar`. |
| Messaging pop-up (off) | INFERRED + SOURCE: `.msg-overlay-container` (mig4ng list has `.msg-overlay-container`). |
| **Photos and logos** (choice: Show / Blur / Hide, default Show) | Blur: `filter: blur(10px)`; Hide: `hide`; both on `.top-card__profile-image-container, .top-card-layout__entity-image-container, .face-pile__images-container, .base-main-card__media, .search-entity-media, .profile-section-card__image-link, img.artdeco-entity-image`. LIVE profile 25 (14 visible): container 1, face pile 11 (5), article thumbnails 10 (3), experience logos 5 (5); company 2; job `img.artdeco-entity-image` 2; job search `.search-entity-media` 60 (60). Faces and logos are `div[role=img]` with a background image, so the container is blurred. |
| **Hide follower and connection counts** (off) | `.top-card-layout .not-first-middot` 1 (1) LIVE profile ("41M followers", "8 connections"). Companies have no such element (see CSS cannot). |
| **Hide reaction and comment counts** (off) | `[data-test-id="social-actions__reactions"]`, `[data-test-id="social-actions__comments"]` 28 (15) each LIVE profile, 10 (10) company. `.social-details-social-counts`: SOURCE (feed markup sample from a scraper vendor), not seen on a page. |
| **Hide applicant counts and job badges** (off) | `.num-applicants__caption` 1 (1) LIVE job; `.job-posting-benefits` 53 (53) LIVE job search ("Be an early applicant" 40, "Actively Hiring" 12; 0 on a job page). |
| **Feed posts** (choice: Show / Dim / Hide, default Show) | SOURCE, signed in. Dim: `opacity: 0.35` on `[data-testid="mainFeed"], .feed-shared-update-v2`. Hide: same selector plus `.feed-sort-toggle-dsa__wrapper`. `mainFeed` is the React-shell feed (LinkedIn Focus, verified by its author 2026-07), `.feed-shared-update-v2` the classic-shell post (JustZix blog, LinkedIn Focus, mig4ng). |
| **Hide notification badges** (off) | SOURCE, signed in (LinkedIn Focus): `[data-testid="primary-nav"] span[data-color-scheme]`, `#global-nav .notification-badge`, `.notification-badge--show`, `.notification-badge__count`. |

**CSS cannot do:** stop the page script from re-opening the sign-in wall on a tap, dismiss pop-ups it counts as shown (cool-off is stored by the site), or unlock body scroll if the pop-up sets it (none was shipped; unverified). Split "Redmond, Washington · 29,506,499 followers" on a company page: it is one text node in `.top-card-layout__first-subline`. Un-blur a photo on tap. Select a promoted post by its "Promoted" label (no stable class; the only pure-CSS handle is the sub-description link).

**Pitfalls:**
- Hiding every `.feed-shared-update-v2` (Feed posts Hide) means a fixture can no longer mark an organic post `data-keep`; the `ad-banners` rule's "do not hide organic posts" guard is therefore reasoning, not a test.
- `.not-first-middot` is a utility class used elsewhere on the page (4 matches on a profile); always scope it with `.top-card-layout`.
- Blur on both `.search-entity-media` and the `img` inside it compounds; harmless.
- `/in/<name>` answers 999 to curl but renders fine in Chrome; use a real browser for evidence.

**Not verified:** how the sign-in pop-up and bottom sheet look while shown, scroll lock, `#toasts` (cookie toast template, deliberately left alone), the whole signed-in app (feed, badges, composer, notifications), and `.social-details-social-counts`.

## Messenger (`messenger.default`)

Matches `https://*.messenger.com/*` **and, since 2026-11-13, `https://www.facebook.com/messages` and `https://www.facebook.com/messages/*`.** Meta ended messaging on messenger.com on 2026-04-16 and redirects computers to `facebook.com/messages` (TechCrunch 2026-02-19; Business Standard 2026-02-20; IBTimes 2026-04); `www.messenger.com/` still serves the marketing landing page (`LIVE` 2026-11-13, iPhone UA 390x844, logged out). The Facebook recipe also matches `facebook.com/messages`; option choices are saved per recipe. Choice options (Show / Blur / Hide): the first state is the untouched one.

| Option (default) | Rules and evidence |
|---|---|
| `app-badges` (on, annoyance) | unchanged: `span:has(> a[href^="https://lm.messenger.com/l.php"])` `LIVE` (3 earlier; the phone layout showed the App Store badge span). |
| `signup-link` (on, annoyance) | unchanged: `a[href^="https://www.facebook.com/r.php"]` `LIVE` 1 on desktop `/login/`. |
| `landing-art` (off) | `div[role="main"]:not(:has(footer)) div > img` `LIVE` 2 on the landing page (the 330x479 and 1136x1648 phone pictures). The outer `#root[role=main]` holds the footer so it is excluded; header, badge and footer logos sit in `span` or `a` parents. |
| `chat-list` (choice, show) | blur 8 px: `[role="navigation"] [role="row"]` `SOURCE` (Caprine fork css/browser.css, 2026: private mode blurs these rows); hide: `div[aria-label="Thread list"]` `SOURCE` (greasyfork Messenger Hide Chat List, 2024, messenger.com; `INFERRED` still the label on `/messages`). Hide removes the way to switch chats. |
| `conversation` (choice, show; 2 states) | blur 7 px: `[role="grid"][aria-label^="Messages in conversation"] [role="row"]` `SOURCE` (Shadeed 2021 and its Habr translation: `role=grid` labelled "Messages in conversation with <name>", `role=row` per message, `role=gridcell` inside). 2021, not re-checked. |
| `chat-avatars` (choice, show) | blur 6 px or hide: `[role="navigation"] [role="row"] img, [role="navigation"] [role="row"] image, [role="grid"][aria-label^="Messages in conversation"] img` `INFERRED` (rows are `SOURCE`; avatar tags are not). |
| `facebook-bar` (off) | `body:not(:has([role="dialog"])) div[role="banner"]` `SOURCE` (Caprine hides `[role='banner']` on `/messages`; the guard is `INFERRED` from Caprine's note that the photo viewer's Close button is mounted inside `role=banner`). `div` only: the landing page header is `header[role=banner]`. |
| `call-buttons` (off) | `[aria-label="Start a voice call"], [aria-label="Start a video call"]` `INFERRED` (English labels; not seen). |

**CSS cannot:** read or hide unread dots, active status or Notes (hashed classes only); block seen or typing receipts (network rules only, e.g. uBO `||facebook.com/ajax/mercury/change_read_status.php$xmlhttprequest`, and `facebook.com/messages` uses the newer transport); keep the chat list blurred but readable on hover (no `:hover` in `css` rules).

**Pitfalls.** `/messages` is logged-in only and redirects to the login page logged out, so every `/messages` rule is `SOURCE`/`INFERRED`; fixture `messages.html` is hand-written. `[role="banner"]` unqualified would also hit the landing header (`header[role=banner]`, `data-keep` in the fixture). Fixtures: `landing.html` (phone landing, now with the picture divs), `login.html` (desktop login), `messages.html` (hand-written /messages; named without the `desktop-` prefix so `tags` stay `["mobile"]`).

## Pinterest (`pinterest.default`)

Matches `https://*.pinterest.com/*`. Logged out, a phone UA gets the mobile web app (React, hashed classes, stable `data-test-id`). The home page is itself a sign-up screen; every other route (pin, profile, board, search) shows the content behind a sign-up dialog: a bottom sheet on phones, a full-page "Welcome to Pinterest" log-in window on desktop.

Evidence: LIVE = `querySelectorAll` in headless Chrome (puppeteer), logged out. 2026-11-08: iPhone UA 390x844 on `/`, `/pin/<id>/`, `/<user>/`, `/<user>/<board>/`, `/search/pins/?q=test`. 2026-11-13: iPhone UA and macOS Safari UA 1280x800 on a pin and on `/search/pins/?q=kitchen island`. SOURCE = named list, not seen logged out (Pinterest Power Menu userscript, Angel2mp3; uBlockOrigin/uAssets issue 18369), hand-written fixture `feed-logged-in.html`. Counts are total (visible).

| Option (default) | Rules and evidence |
| --- | --- |
| `signup-popup` (on) | LIVE phone: `div[role="dialog"]:has([data-test-id="mobile-signup-mask"])` 1 on pin, profile, board, search (0 on home). New, LIVE desktop pin and search: `[data-test-id="fullPageSignupModal"]` 1 (0 visible: the wrapper has no box, its fixed children cover the page, 60% black layer, `<style>body{overflow:hidden !important}</style>` ships with it; with the modal hidden the window still scrolled 1200 px); `[data-test-id="bottom-right-upsell"]` 1 (1) ("You are signed out", fixed bottom right). |
| `home-promo` (on) | LIVE, home only: `[data-test-id^="homepage-section-"]` 3, `bottom-signup-header` 1, `unauth-homepage-redesign-footer` 1. The hero sign-up block stays (`data-keep`). |
| `one-tap` (on) | LIVE desktop home and pin: `#credential_picker_container, #credential_picker_iframe` (Google One Tap card top right). |
| `related-pins` (off) | LIVE phone: `related-pins-without-drawer` 1 and `more-like-this-button` 2 on a pin; `more-ideas-container` 1 on a board. New, LIVE desktop: `[data-test-id="relatedPins"] [role="listitem"] [data-grid-item-idx]:not([data-grid-item-idx="0"])` 11-13 on a desktop pin, 4-5 on phone (the count varies per load). **On desktop `relatedPins` also contains the pin itself (grid item 0), so the wrapper must not be hidden; the rule skips grid item 0 by its index.** No match was ever inside `CloseupMainPin` (checked). Avoid `:not(:has(...))` here: the recipe selector engine does not need that nesting. |
| `comments-button` (off) | LIVE phone: `comment-button` 1 on a pin. Only the button exists logged out on a phone. |
| `follower-counts` (off) | LIVE: `follower-count` 1 on a pin, `div:has(> [data-test-id="profile-followers-count"])` 1 on a profile. |
| **`sponsored`** (annoyance, on) | SOURCE only, signed in: two rules, `[role="listitem"]:has(div[title^="Sponsored"]), [role="listitem"]:has(div[title^="Partner"])` and `[role="listitem"]:has([data-test-id="otpp"])` (Power Menu hides list items with the titles Sponsored, Partner Content and Sponsored Content; uAssets issue 18369 hides `[data-test-id="otpp"]` and its list item). 0 matches on live pages (no promoted pin appeared logged out in 2026-11-08 or 2026-11-13). Split into several rules because one selector may carry at most two `:has(`. |
| **`pin-images`** (choice: Show / Grayscale / Blur, default Show) | `filter: grayscale(1)` / `blur(14px)` on `[data-test-id="gated-pin-rep"] img, [data-test-id="pinWrapper"] img, [data-test-id="pin"] img, [data-test-id="pin-closeup-image"]`. LIVE: `gated-pin-rep img` 8 (8) phone search, 14 (14) desktop search; `pin-closeup-image` is a div on desktop, an img on phone, so the element itself is filtered. `pinWrapper` / `pin`: SOURCE (Power Menu). |
| **`video-pins`** (choice: Show / Blur / Hide, default Show) | Blur: `[data-test-id="gated-pin-video"], [data-test-id="closeup-video-with-visibility"]`. Hide: `[role="listitem"]:has([data-test-id="gated-pin-video"]), [role="listitem"]:has([data-test-id="story-pin-video-block"])`. LIVE: 3 on a desktop pin, 1 on desktop search, 0 on a phone search (the "0:10" badge `PinTypeIdentifier` is on the same cards); 0 matches on a normal pin grid. `closeup-video-with-visibility`, `story-pin-video-block`: SOURCE. |
| **`comments`** (choice: Show / Dim / Hide, default Show) | Dim `opacity: 0.35` / hide `[data-test-id="aggregated-comment-list"], [data-test-id="comments-count-container"]`. LIVE desktop pin: 1 each, visible (the comment box `unauth-comment-composer` is inside `comments-count-container`); none on a phone. |
| **`shopping`** (off) | SOURCE only: `duplo-shopping-module`, `ShopTheLookSimilarProducts`, `visual-search-shopping-bar`, `related-products`, `ShopTheLookAnnotations`, `shopping-module`; product pins in two rules, `[role="listitem"]:has([aria-label="Shoppable Pin indicator"]), [role="listitem"]:has([data-test-id="product-price-text"])` and `[role="listitem"]:has([data-test-id="pincard-product-with-link"])`. Not seen logged out; 0 matches on live pages. |
| **`search-chips`** (off) | LIVE: `[data-test-id="one-bar-module-3"]` 9 (9) phone search, 25 (25) desktop search (Small, Pendant lights, Seating...). `one-bar-module-0` is the filter button and stays. |
| **`visual-search`** (off) | LIVE: `[data-test-id="visual-search-icon"]` 1 (1) desktop pin (magnifier button in the corner of the picture). |

CSS cannot do:
- Open the real comments or pins: gated cards are not links logged out and need a login anyway.
- Close the gap a hidden masonry card leaves: cards are absolutely positioned.
- Undo `body{overflow:hidden !important}` from the desktop modal (not needed: the root scroller still works) or un-blur on tap.
- Select a promoted pin without a signed-in label: none appeared logged out.

Pitfalls:
- On desktop `relatedPins` wraps the whole pin page including the main pin; select its other `role="listitem"` children, never the wrapper.
- Keep selectors free of `:not(:has(...))`: the recipe validator only allows plain attribute `:not()` here, and the desktop pin page is the only place where the main pin has to be skipped.
- The desktop log-in modal wrapper reports zero size; check with `display:none` and a screenshot, not `getBoundingClientRect`.
- The same pin page hydrates differently per run (12 vs 13 related items); compare ranges, not exact counts.

Not verified: logged-in pages (promoted pins, shopping modules, the signed-in grid), non-US regional hosts, cookie banners, a desktop home sign-up screen beyond the One Tap card.

## Snapchat (`snapchat.default`)

Lands on `https://*.snapchat.com/*`. Next.js app with `data-testid` anchors; it asks for the app on every page but shows no cookie banner, sign-in wall or timed pop-up (30 s on home and Spotlight). Evidence: LIVE = headless Chrome, logged out. 2026-11-08 iPhone UA 390x844: home, `/spotlight` (redirects to `/@<user>/spotlight/<id>`), a profile, `/discover`, `/topic`. 2026-11-13 (puppeteer `querySelectorAll`, counts total (visible)): `/` on iPhone and macOS Safari UA 1280x800, `/@mrbeast` on both, `/spotlight` on iPhone.

| Option (default) | Rules and evidence |
|---|---|
| Hide "better on the app" pop-up (on) | `[data-testid="mobileExpandedCtaBanner"]` and `-backdrop`: 1 each on profile, `/discover` (fixed bottom sheet). LIVE |
| Hide Open Snapchat bars (on) | `[data-testid="mobileCTAHeader"]` 1 (profile, Stories, topic); `[data-testid="mobile-nav"] a[class*="downloadButton"]` 1 (home, Spotlight); `a[data-testid="home-install-link"]` 1 (home); `div[class*="EndOfFeedPrompt_inlineContainer"]` 1 (profile). New: `[data-testid="ConsumerNav_DownloadButton"]` 1 (1) desktop profile (0 visible at 390 px). LIVE |
| Hide home page download promo (on) | `a[data-testid="home-hero-download"]` 1, `[data-testid="home-mobile"] div[class*="mobileSlides"]` 1, `section[aria-labelledby="home-mobile-closing-heading"]` 1; desktop: `video-slide-*` and `home-chat-now`. LIVE |
| **Hide Snapchat+ promo** (on) | `li:has(> a[data-testid="navItem-PLUS"])` 1 (1 on desktop profile, 0 visible at 390 px; the item is a "Snapchat+" link in the desktop nav). LIVE |
| Hide the Comment button (off) | `[data-testid="spotlight-engagement-rail"] button:nth-of-type(3)`: 2 (active and next slide). LIVE; position based (Like, Recommend, Comment, Share). |
| Hide like, share and view counts (off) | `[data-testid="spotlight-engagement-rail"] span[class*="__count"]` 7; `[data-testid="content-tile"] div[class*="CountCard_card"]` 24. LIVE |
| Hide local and topic lists (off) | `[data-testid="home-explore"]` 1 (`home-explore-local`, `home-explore-entertainment`). LIVE |
| Hide the bottom tab bar (off) | `[data-testid="mobile-tab-bar"]` 1 (home, Spotlight); `[data-testid="mobile-nav-bottom"]` 1 (profile, Stories). LIVE |
| Hide footer links (off) | `[data-testid="global-footer"]` 1 (home); `div[class*="Footer_entertainmentBar"]` 1 (profile). LIVE |
| Hide the parents banner (off) | `[data-testid="home-parents-banner"]` 1 (1) desktop home. LIVE |
| **Hide business links** (off) | `nav:has(> [data-testid="home-advertisers-link"])` 1 (1) mobile home: the Advertisers, Creators, Developers links under the Download block. LIVE |
| **Hide follower count** (off) | `[data-testid="subscribersCountText"]` 1 (1) on `/@mrbeast`, mobile and desktop ("1.5m followers"). LIVE |
| **Hide the Related tab** (off) | `[role="tab"]:has([data-testid="related-section-heading-wrapper"])` 1 (1) mobile and desktop profile; tabs are All, Stories, Spotlight, Related. LIVE |
| **Thumbnails and videos** (choice: Show / Dim / Blur, default Show) | `opacity: 0.35` / `filter: blur(14px)` on `[data-testid="content-tile"] img, [data-testid="content-tile"] div:has(> video), [data-testid="spotlight-player"] div[role="region"]`. LIVE profile 18 (9 visible: 15 images, 3 videos); Spotlight player video 1 (1). Blur the video's wrapper, never the `<video>`: Chromium composites a video on its own layer and ignores a filter set on it (checked with a screenshot). |
| **Profile pictures** (choice: Show / Blur / Hide, default Show) | `filter: blur(8px)` / hide `[data-testid="profilePicture"]`: 7 (4 visible) on a profile (header avatar and bubbles in the search drop-down). LIVE |
| **Spotlight caption** (choice: Show / Dim / Hide, default Show) | `opacity: 0.35` / hide `[data-testid="spotlight-metadata"], [data-testid="spotlight-sound"]`: 2 + 1 (all visible) on a Spotlight video. LIVE |
| **Spotlight buttons** (choice: Show / Dim / Hide, default Show) | `opacity: 0.35` / hide `[data-testid="spotlight-engagement-rail"]`: 2 (all visible; active and next slide). Includes the creator avatar link and Copy link. LIVE |

Class-substring anchors (`downloadButton`, `mobileSlides`, `__count`, `CountCard_card`, `EndOfFeedPrompt_inlineContainer`, `Footer_entertainmentBar`) use the CSS-module name before the hashed suffix, not the hash; a rebuild could rename them. New rules use only `data-testid` and roles.

What CSS cannot do: the Comment button is found by position, not by label; the "Add" button on profiles and the Spotlight player are left alone; counts cannot be hidden per kind on profile tiles (views and shares share one class); a blurred or dimmed tile still opens on tap and cannot be un-blurred.

Pitfalls:
- The mobile and desktop navs are both in the DOM; each hides with CSS at the other width, so a rule can match with 0 visible. That is fine, count both.
- `[data-testid="profilePicture"]` also matches the search drop-down bubbles, not only the header avatar.
- The Spotlight page keeps several slides mounted (active and next); selectors match them all.

Not verified: logged-in app, Stories player pages beyond the landing list, the official `/@snapchat` profile (returned "content not found"), any sign-in wall or timed pop-up beyond 30 s, the desktop Spotlight page. The empty `mobile-cta-bottom-sheet` placeholder on home has no rule.

## Telegram (`telegram.default`)

Matches `https://*.telegram.org/*` and `https://t.me/*`. Lands on the `t.me/<name>` landing page and the `t.me/s/<name>` public channel preview; logged-out `web.telegram.org/a/` shows only the QR login. Verified 2026-11-07 and 2026-11-13 at 390x844, iPhone UA, logged out, on `t.me/s/telegram`, `t.me/s/durov`, `t.me/s/contest`, `t.me/telegram`.

| Option (default) | Rules and evidence |
|---|---|
| `app-nags` (on) | `.tgme_channel_join_telegram` (LIVE 1); `.tgme_head_right_btn` (landing Download, LIVE 1); `.tgme_page_additional` (landing blurb, LIVE 1) |
| `link-previews` (off) | `a.tgme_widget_message_link_preview` (LIVE 4 on `t.me/s/telegram`); SOURCE `.WebPage` (Web A, telegram-tt WebPage.tsx, not run live) |
| `media` (off) | `a.tgme_widget_message_photo_wrap` (LIVE 3); `a.tgme_widget_message_video_player` (LIVE 13) |
| `view-counts` (off) | `.tgme_widget_message_views` (LIVE 20) plus the ` views` label `.tgme_widget_message_info .copyonly` (LIVE); SOURCE `.MessageMeta .message-views` (Web A) |
| `avatars` Show / Blur / Hide (Show) | Blur `.tgme_widget_message_user_photo` (LIVE 20 on `t.me/s/durov`), `.tgme_page_photo_image` (LIVE 2, 1 visible), SOURCE `.Avatar` (Web A). Hide `.tgme_widget_message_user` and `.tgme_page_photo_image`; Web A avatars are not hideable (would collapse chat rows) |
| `reactions` Show / Dim / Hide (Show) | `.tgme_widget_message_reactions` (LIVE 20 on `t.me/s/durov`, 0 on `t.me/s/telegram`). Dim is `opacity: 0.35` |
| `media-look` Normal / Blur / Grayscale (Normal) | `a.tgme_widget_message_photo_wrap, a.tgme_widget_message_video_player`: `filter: blur(14px)` or `grayscale(1)`. Hiding stays on the `media` switch |
| `link-preview-images` Show / Blur / Hide (Show) | `.link_preview_image` (LIVE 3 on `t.me/s/durov`, 4 on `t.me/s/telegram`); title and text stay |
| `reply-headers` (off) | `.tgme_widget_message_reply` (LIVE 1 on `t.me/s/durov`, 3 on `t.me/s/contest`); `.tgme_widget_message_forwarded_from` (LIVE 1 on `t.me/s/durov`) |
| `subscriber-counts` (off) | `.tgme_header_counter` (LIVE 1); `.tgme_page_extra` (landing, LIVE 1) |
| `post-authors` (off) | `.tgme_widget_message_author` (LIVE 21 on `t.me/s/durov`) |

**CSS cannot do:** `.tgme_channel_info` (info card with counters) and `.tgme_footer` exist but are `display: none` at 390px, so no rules. Web A reaction chips and chat badges use hashed CSS-module classes.

**Pitfalls.** `t.me/s/telegram` has no reactions, replies or forwards, so count those on a busier channel (`durov`, `contest`). No polls, stickers, voice or documents appeared on 10 sampled channels, so nothing targets them. Web A is SOURCE only (class names read from github.com/Ajaxy/telegram-tt); the logged-in app was not opened.

## Threads (`threads.default`)

- **Where it lands.** `www.threads.com` serves an iPhone UA the mobile web app: `#barcelona-header` (logo, Log in, Get app), a bottom `nav` (Home, Search, Create, Notifications, Profile) and `#scrollview` holding `#barcelona-page-layout`. Logged out, every fresh load puts a modal sheet over the page. Post pages add a "Related threads" section; profiles add a "Log in to see more from ..." banner.
- **No stable classes**; the hooks are ids (`#barcelona-header`), `data-pagelet` names and `href`s. The desktop layout is a different DOM (it shows the login sheet, not the open-app sheet).
- **No scroll lock** was seen behind the sheet (`html` overflow auto, `body` visible), so no unlock rule is needed.

| Option (default) | Rules and evidence |
|---|---|
| `app-prompts` (on) | `body > div:has(a[download][href*="applink.threads.com"])` `LIVE` 1 on `/`, `/@zuck` and a post: the body-level wrapper of the "Thread on Threads" sheet, which holds the dim backdrop and the card. `#barcelona-header div:has(> a[href*="apps.apple.com"])` `LIVE` 1 on the same three pages: the "Get app" button. |
| `login-wall` (on) | `div:has(> span + div > a[href^="/login"])` `LIVE` 1 on a post ("Log in to see more replies.") and 1 on a profile ("Log in to see more from ..."). The nav entry `a[href="/login/"]` and the header Log in button are not matched. Desktop: `div[role="dialog"]:has(i[aria-label="Instagram"]):not(:has(a[href*="applink.threads.com"]))`. |
| `related-threads` (off) | `div:has(> [data-pagelet^="threads_logged_out_related_posts"])` `LIVE` 1 on a post; 0 on `/` and profiles. |
| `avatars` (choice show/blur/hide, show) | `[data-pressable-container] a > div > img:not([draggable])` `LIVE` 28 on `/@zuck`, 5 on desktop `/` (the 36 px avatars; media images carry `draggable="false"`). Blur is `filter: blur(6px)`. The 64 px profile-header avatar is outside a post and untouched. |
| `post-media` (choice show/blur/hide, show) | `[data-pressable-container] img[draggable="false"], ... img[aria-hidden="true"], ... video` `LIVE` 28 on `/@zuck` (24 images + 4 videos), 6 on desktop `/`; together with `avatars` it covers all 52 post images. Blur is `filter: blur(18px)`. Hide leaves a **blank box of the same size** (see Pitfalls). |
| `post-actions` (off) | `[data-pressable-container] div:has(> div > div[role="button"] > div > div > svg + span[dir="auto"])` `LIVE` exactly one row per post (5 of 5 loaded); hiding it took a post from 325 to 289 px. |
| `counts` (off) | `[data-pressable-container] div[role="button"] > div > div > svg + span[dir="auto"]` `LIVE` 107 on `/@zuck` (four per post), 19 on desktop `/`. Follow and Mention buttons have no svg+span and are not matched. |
| `topic-tags` (off) | `div:has(> div > a[href*="serp_type=tags"])` `LIVE` 6 on `/@zuck`, 3 on desktop `/`: the pill row (icon + link) beside the author name. |
| `verified-badges` (off) | `svg[aria-label="Verified"]` `LIVE` 1 on `/@zuck`. English labels only. |
| `post-times` (off) | `[data-pressable-container] time` `LIVE` one per post (5 to 28 depending on how much of the feed had loaded). The permalink `a` around it stays. |
| `instagram-link` (off) | `#barcelona-page-layout div:has(> a[href^="https://www.instagram.com/"])` `LIVE` 1 on `/@zuck`, 0 on `/`. |

- **Left alone on purpose.** The "Say more with Threads" login sheet: its Open Threads link carries `aria-label="Open Threads"` and no `download` attribute, and the sheet sits in its own body-level wrapper, so the login path survives while the open-app sheet is hidden.
- **CSS cannot:** dismiss the sheet in the page's own state (it can only be hidden), match the sheet text, unlock posts or replies behind the login wall, or tell a post from a reply.
- **Not verified.** Logged-in pages (no account was available), WKWebView rendering, the desktop layout, ads and suggested accounts (none were served to the logged-out session), and the other routes (search, notifications, post composer).

**CSS cannot (add):** collapse the media box of a post without hiding a hashed-class carousel ancestor (measured: the post height only dropped when the 10th ancestor of the `img` was hidden, `div` with `overflow: auto`, no stable attribute); match `@` handles (`@` is rejected in selectors, so `a[href^="/@"]` cannot be used: use structure and `draggable` instead); match localized `alt`/`aria-label` text outside English; tell replies from the post continuation (`threads_post_page_{n}` holds both); hide follower counts in the profile header (plain text spans, no hook).

**Pitfalls (add).**
- Avatars and post images are both `img` in a `[data-pressable-container]`. The stable separator is `draggable="false"` (+ `aria-hidden="true"`) on media and no `draggable` on avatars; the `alt` is "<user>'s profile picture" and localized.
- The action-row buttons are `div[role="button"]`, never `button`. Only the four count buttons have `svg + span[dir="auto"]`.
- `[data-pressable-container]` is the post card; images are lazy, so counts grow while scrolling.
- Fixture `post-details.html` is a hand-condensed copy of the observed structure (picture/carousel wrappers reduced).

**CSS cannot (add):** collapse the media box of a post without hiding a hashed-class carousel ancestor (measured: the post height only dropped when the 10th ancestor of the `img` was hidden, `div` with `overflow: auto`, no stable attribute); match `@` handles (`@` is rejected in selectors, so `a[href^="/@"]` cannot be used: use structure and `draggable` instead); match localized `alt`/`aria-label` text outside English; tell replies from the post continuation (`threads_post_page_{n}` holds both); hide follower counts in the profile header (plain text spans, no hook).

**Pitfalls (add).**
- Avatars and post images are both `img` in a `[data-pressable-container]`. The stable separator is `draggable="false"` (+ `aria-hidden="true"`) on media and no `draggable` on avatars; the `alt` is "<user>'s profile picture" and localized.
- The action-row buttons are `div[role="button"]`, never `button`. Only the four count buttons have `svg + span[dir="auto"]`.
- `[data-pressable-container]` is the post card; images are lazy, so counts grow while scrolling.
- Fixture `post-details.html` is a hand-condensed copy of the observed structure (picture/carousel wrappers reduced).

## TikTok (`tiktok.default`)

- **Where it lands.** `www.tiktok.com` with an iPhone UA serves the mobile web app (feed `/foryou`, `/discover`, `/@user`, `/@user/video/<id>`); a desktop UA serves the desktop web app (For You column, `/@user`, `/discover`, `/@user/video/<id>`). The mobile app uses styled-components (`css-<hash>-<hash>--DivName`), the desktop app uses `css-<hash>-<hash>--DivName` plus `e<hash>` shorthands, so rules use `data-e2e` hooks, ids and custom elements. Match pattern `https://*.tiktok.com/*`.
- **Two very different pages.** The mobile feed renders a full-screen slide (`[data-e2e="video-slide-active"]`) with a right-hand action column; the desktop For You page renders a vertical column of media cards (`#main-content-homepage_hot`) with the action buttons and the caption in the description layer of each card. A rule written for one rarely matches the other, so each option carries one rule per platform.
- **Checked logged out on 2026-11-13**, headless Chromium, iPhone UA 390x844 for the mobile app and a macOS Safari UA 1440x900 for the desktop site. `www.tiktok.com` served both apps without a bot wall; `/explore` redirects to `/foryou`.

| Option (default) | Rules and evidence |
|---|---|
| `app-prompts` (on) | `body > div:has(#login-modal)` LIVE 1 (the "Get the full app experience" modal), `div:has(> div > button[class*="CTAOpenApp"])` LIVE 1 (the feed header "Open app" button), `div:has(> div > [data-e2e="top-banner-open"])` and `div:has(> div > [data-e2e="bottom-banner-open"])` LIVE 1 each (the bars above and under a video), `div:has(> div > div > [data-e2e="bottom_banner"])` LIVE 1 (the "Watch on TikTok" section), `.launch-popup-sheet-host` LIVE 1 and `div:has(> [data-e2e="launch-popup-close"])` LIVE 1 (the "Watch this video on TikTok" sheet), `[data-e2e="user-page"] div:has(> div + div > p + div > div > button)` LIVE 1 (the app cover on a profile), `div:has(> div > div > [data-e2e="bottom-cta-container"])` LIVE 1 (the app pop-up on a profile), `[class*="DivFloatButtonWrapper"]` LIVE 1 (the "Discover more" button), `[data-e2e="side-nav-utilities-get-app"]` LIVE 1 (the desktop sidebar Get App button). |
| `cookie-banner` (on) | `tiktok-cookie-banner` LIVE 2 (the cookie notice element in the fixtures; the site then keeps its default cookie settings). |
| `screen-time` (on) | `.box-border:has(.tt-intro__container)` LIVE 3 on the mobile feed: "Screen time breaks", "To support your well-being, your daily screen time" and "Ready to close TikTok?". Each sheet and its dim backdrop (`.tt-sheet__mask`) sit inside the same `.box-border`, so one rule removes the prompt and the backdrop. The sheets were in the DOM but parked off-screen, so whether every account sees them is not verified. |
| `suggested-videos` (off) | `div:has(> ul[data-e2e="recommend-list"])` LIVE 1 (the "You may like" list under a video), `div:has(> h2 + [data-e2e="page-header-three-dots"])` and `div:has(> [data-e2e="video-item"] [data-e2e="video-user-item"])` LIVE 1 each (the "Selected by TikTok" heading and list on Discover). |
| `discover-genres` (off) | `div:has(> a[href^="/discover/"])` LIVE 1 (the genre card row at the top of Discover). |
| `counters` (off) | `[data-e2e="like-count"], [data-e2e="comment-count"], [data-e2e="share-count"]` LIVE 2 each in the feed, `[data-e2e="play-side-like"] span, [data-e2e="play-side-comment"] span, [data-e2e="share-count"], [data-e2e="play-side-share"] span` LIVE 4 on a mobile video page, `div:has(> [data-e2e="following-count"])` and `div:has(> [data-e2e="followers-count"])` LIVE 2 and `div:has(> [data-e2e="likes-count"])` LIVE 1 on a profile, `[data-e2e="video-views"], [data-e2e="video-likes"]` LIVE 6 on the grid covers, `[data-e2e="favorite-count"]` LIVE 1 on the desktop player. SOURCE: JustZix "TikTok: hide all engagement counts" and the tiktok-unhook extension (vanity metrics). |
| `sidebar-nav` (off) | `[data-e2e="nav-live"], button[aria-label="LIVE"]` LIVE 4, `[data-e2e="nav-explore"], a[href^="/shortdrama"], button[aria-label="Explore"], button[aria-label="Short dramas"]` LIVE 4 (desktop sidebar only). |
| `sidebar-footer` (off) | `div[class*="DivFooterContainer"]` LIVE 2 (the links and copyright line at the bottom of the desktop sidebar). |
| `for-you-feed` (off) | `#main-content-homepage_hot` LIVE 4 (the desktop For You video column). |
| `captions` (off) | `[data-e2e="video-desc"], [data-e2e="browse-video-desc"]` LIVE 3 (the caption block on a video page and on Discover), `[class*="DivVideoCaption"] [class*="DivOverflowContainer"] > span` LIVE 7 and `[class*="DivVideoCaption"] [class*="DivBtnWrapper"]` LIVE 2 (the caption text and its "more" button in the mobile feed). The mobile rule leaves the hashtag links in place, because the `hashtags` option owns them. |
| `thumbnails` (show) | `filter: blur(10px)` on `[data-e2e="video-item"] img, [data-e2e="user-post-item"] img` LIVE 5 (mobile profile grid 24 covers, mobile Discover 12, desktop profile grid 32 when it renders) and the same selector with `display: none` for the Hide state. |
| `avatars` (show) | `filter: blur(8px)` on `[data-e2e="user-avatar"], [data-e2e="video-author-avatar"], [data-e2e="play-side-author"] img` LIVE 6 (mobile profile picture 1, feed author avatars 2, video page author picture 2, desktop creator picture 1) and the same selector with `display: none` for the Hide state. On the mobile feed the avatar is a `background-image` on a `div`, so the blur lands on the circle itself. |
| `hashtags` (show) | `opacity: 0.35` on `[class*="DivVideoCaption"] a[href^="/tag/"], [data-e2e="video-desc"] a[href^="/tag/"]` LIVE 5-9 (mobile feed caption hashtags) and LIVE 3-5 (desktop caption hashtags), and `display: none` on the same links for the Hide state. On the desktop site the whole caption block is one `data-e2e="video-desc"` element, so the `captions` option removes the hashtags along with the text. |
| `music` (off) | `[data-e2e="music-name"], [data-e2e="music-cover"]` LIVE 2 each (the sound name under a video and the music disc in the feed), `[data-e2e="video-music"]` LIVE 2 (the music disc on the desktop player). |
| `follow-buttons` (off) | `[class*="DivFollowPlus"]` LIVE 2 (the + badge on the author's picture in the feed), `[data-e2e="cinema-video-info-follow"]` LIVE 1 (the Follow button next to the creator on the desktop site). |
| `suggested-accounts` (off) | `[class*="DivUserCardListContainer"]` LIVE 1 (the Suggested accounts panel on a desktop profile), `[class*="DivDiscoverUserCardSwiperContainer"]` LIVE 1 (the popular creators row on the desktop Discover page). SOURCE: JustZix "TikTok: hide suggested accounts" hides the same block. |
| `profile-tabs` (off) | `[data-e2e="playlist"], [data-e2e="liked"]` LIVE 1 each (the mobile profile tabs), `[data-e2e="drama-tab"], [data-e2e="repost-tab"], [data-e2e="favorites-tab"], [data-e2e="liked-tab"]` LIVE 1 each (the desktop profile tabs). The Videos tab stays. |

What CSS cannot do: dismiss the script-driven sheets (the "Get the full app experience" modal, the "Watch this video on TikTok" sheet and the screen time sheets) — CSS only removes what is in the DOM, so a sheet that renders later comes back; and it cannot keep the app prompts from being re-shown by TikTok's own scripts.

Pitfalls: the mobile feed slide is a `background-image` on a `div`, so an avatar rule must target the `div`, not an `img`; the desktop creator picture is an `<a data-e2e="video-author-avatar">` wrapping the image, so the same rule covers both layouts. `[data-e2e="video-desc"]` on the desktop site holds the caption text *and* its hashtag links in one element, so hiding the caption also hides the hashtags there. `[class*="DivVideoCaption"] [class*="DivText"]` covers the caption text *and* the hashtag links in the mobile feed, so the feed rule targets `[class*="DivOverflowContainer"] > span` instead. The mobile feed has no `data-e2e="share-count"]`: the share number lives in `[data-e2e="play-side-share"] span` on a video page. The desktop Discover page has no "Selected by TikTok" list, and the mobile profile has no `user-post-item` (that hook is desktop only). The `data-e2e="follow-button"` hook is a `div` in the feed and a `button` on a profile, so the follow rules use the class and the desktop `cinema-video-info-follow` hook instead of the shared attribute. A desktop profile sometimes renders the "Your next discovery is waiting" empty state instead of the video grid, which is why the desktop grid count varies between loads.

## Twitch (`twitch.default`)

Matches `https://*.twitch.tv/*`. One recipe, two different sites: an iPhone UA lands on `m.twitch.tv`, a React app whose classes are hashed styled-components (`Layout-sc-…`, `ScCoreLink-sc-…`) and unusable, so selectors use `data-a-target`, `data-test-selector`, `aria-label`, `href` and structure; a desktop UA lands on `www.twitch.tv`, the full site. Checked 2026-11-13, logged out, real Chrome over CDP: iPhone UA 390x844 on m.twitch.tv (Home, `/directory/all`, a live channel) and desktop UA on www.twitch.tv (Home, a category page, several live channels). Counts are `querySelectorAll` on the live DOM; the fixtures are sanitised excerpts of it.

| Option (default) | Rules and evidence |
|---|---|
| `app-nags` (on) | Phone: `nav a[href*="tt_medium=mweb"]` (Open App) 1 and `nav > div:has(> a[href*="tt_medium=mweb"]) > button` (Sign Up) 1, both in the top bar. Desktop: `[data-a-target="signup-button"], #twilight-sticky-footer-root` 2 (the Sign Up button and the join footer). `LIVE` |
| `ad-overlays` (on) | Phone `[data-test-selector="sda-wrapper"]` 1 on a live channel (the slot was empty, best effort). Desktop `div[aria-label="Advertisement"], .stream-display-ad__wrapper` 1 on Home. `LIVE` |
| `prime-offers` (on) | `button[aria-label="Prime offers"], [data-a-target="top-nav-get-bits-button"]` 1 on desktop Home. `LIVE` |
| `suggested-rows` (off) | `div:has(> div > h2 > a[href="/directory"])` (the "Categories we think you'll like" row) 1 and `div:has(> div > h2 > a[href^="/directory/collection/"])` (themed collection rows) 4 on phone Home, 1 on desktop Home. "Live on Twitch" (`/directory/all`) stays. `LIVE` |
| `stream-tags` (off) | `[aria-label^="Tag, "]` (language, genre, DropsEnabled pills) 107 on phone Home, 24 on `/directory/all`, 31 on desktop Home. `LIVE` |
| `chat` (off) | Phone and desktop `[data-a-target="chat-scroller"]` (the message list) 1; desktop `.channel-root__right-column` (the whole chat column) 1. The Send Chat box stays. `LIVE` |
| `subscribe` (off) | Phone `button[aria-label="Subscribe"]` 1 on a live channel; desktop `[data-a-target="subscribe-button"], [data-a-target="gift-button"]` 2. Follow stays (it has its own switch). `LIVE` |
| `follow-button` (off) | `button[data-a-target="follow-button"], button[data-test-selector="follow-button"]` 1 on a live channel, phone and desktop (both attributes sit on the same button). `LIVE` |
| `featured` (off) | `.front-page-carousel` 1 on desktop Home (the big carousel at the top). `LIVE` |
| `side-nav` (off) | `#side-nav` 1 on desktop Home and on a live channel (the whole left sidebar). The phone has no sidebar. `LIVE` |
| `stream-info` (off) | `#live-channel-stream-information` 1 on desktop, a live channel (title, tags, about under the player). `LIVE` |
| `thumbnails` (choice Show/Blur/Hide, show) | blur `filter: blur(12px)` on `article img.tw-image, [data-a-target="tw-card-image"] img` (`LIVE` 48 stream pictures on phone Home, 7 on desktop Home) and on `[data-test-selector="featured-item-image"]` (5, the carousel pictures, which sit outside `article` and carry no `tw-image` class); hide `article > button:has(.tw-aspect)` (40 on phone Home), `[data-a-target="preview-card-image-link"], [data-a-target="tw-card-image"]` (12 on desktop Home) and the carousel picture. `LIVE` |
| `stream-titles` (choice Show/Blur, show) | blur `filter: blur(6px)` on `article h3` (`LIVE` 48 on phone Home, and the same markup carries the category names) and `[data-a-target="preview-card-title-link"] h4` (6 on desktop Home). `LIVE` |
| `viewer-counts` (off) | `.tw-media-card-stat` (the count on a card) 48 on phone Home and 6 on desktop Home; `div:has(> div > strong[data-a-target="animated-channel-viewers-count"])` 1 above a desktop live stream; `.side-nav-card__live-status` 10 in the desktop sidebar. `LIVE` |
| `streamer-avatars` (off) | `article div:has(> a > .tw-avatar)` 48 on phone Home; `[data-test-selector="preview-card-avatar"], #side-nav .tw-avatar` 17 on desktop Home (card and sidebar avatars). `LIVE` |
| `chat-badges` (off) | `[data-a-target="chat-badge"]` 20 on a busy desktop channel (subscriber, moderator and Bits icons before the names). The phone chat renders no lines logged out, so nothing matches there. `LIVE` |
| `chat-banners` (off) | `.community-highlight-stack__card` 1 (a pinned Prediction card; the same stack holds gift, raid and Hype Train cards) and `[data-test-selector="chat-private-callout-queue__callout-container"]` 1 (the tip pop-up) on a desktop live channel. `LIVE` |
| `channel-points` (off) | `[data-test-selector="community-points-summary"]` 1 (the Bits and Channel Points balance beside the chat box). `LIVE` |
| `about-panels` (off) | `#live-channel-about-panel` 1 and `.channel-panels` 1 on a desktop live channel (the About box with the follower count and links, and the panels under the stream). `LIVE` |
| `similar-channels` (off) | `.side-nav-section:has([data-test-selector="similarity-channel"])` 1 on a desktop live channel ("Viewers Also Watch", 3 cards). `LIVE` |
| `recommended-channels` (off) | `.side-nav-section:has([data-test-selector="recommended-channel"])` 1 on desktop Home and 1 on a live channel (the "Live Channels" section with the 10 channels Twitch suggests). `SOURCE` (uBlock `www.twitch.tv##div[aria-label="Recommended Channels"]`, blog.drale.com) and `LIVE`. |
| `activity-tab` (off) | `a[href="/activity"]` 1 in the phone's bottom tab bar; logged out the page is only an "Open App for Activity" prompt. `LIVE` |
| `chat-style` (choice Show/Dim/Blur, show) | css on `[data-a-target="chat-scroller"]` (`LIVE` 1 on a desktop live channel): dim `opacity: 0.35`, blur `filter: blur(4px)`. Hide live chat wins over it. |

**CSS cannot:** hide or skip the pre-roll and mid-roll video ads, because they play inside the player element itself; only the display-ad slot around the player can go. It cannot open the chat: logged out the phone chat renders no lines, and on desktop the messages appear only after the "Show more" button is clicked, which is script-driven. It cannot turn off the carousel's auto-advance or the hover preview that plays on card hover. It cannot change a count's text, only hide its box.

**Pitfalls:** the phone and desktop card markup differ, so a picture rule has to name both (`article img.tw-image` covers the phone and the desktop stream cards, `[data-a-target="tw-card-image"] img` the desktop category art, `[data-test-selector="featured-item-image"]` the carousel, which is outside `article` and has no `tw-image` class). `article h3` is the stream title on a phone and the category name on a category page, so blurring titles blurs both. `.tw-media-card-stat` is the viewer count, not a duration. The desktop sidebar's suggestion section is now labelled "Live Channels" (`aria-label`), so the community filter `div[aria-label="Recommended Channels"]` no longer matches it; its cards still carry `data-test-selector="recommended-channel"`, which is what the rule uses. The two sidebar sections are disjoint: the suggestions use `recommended-channel`, "Viewers Also Watch" uses `similarity-channel`. The chat's community cards all share `.community-highlight-stack__card`, so the rule covers Prediction, gift, raid and Hype Train cards alike. `data-a-target="tw-core-button-label-text"` is generic (every button label); prefer the button's own `data-a-target` or `data-test-selector`. The hashed `Layout-sc-*` classes change on every deploy; only `tw-image`, `tw-avatar`, `tw-aspect`, `tw-media-card-stat` and the `data-a-target` / `data-test-selector` values are stable.

## What CSS cannot do

- Pre-roll and mid-roll video ads play inside the player (the VOD showed "Ad 1 of 2", Learn More); hiding that overlay would break playback, so no rule.
- Viewer and follower counts have no stable anchor (plain text in hashed containers), so there is no counter option.
- Home shelves are virtualised and lazy-loaded; rows that scroll in later are matched by the same selectors only once they exist.
- `/activity` is only an "Open App for Activity" prompt; there is nothing to hide separately from the page.

## Not verified

No cookie/consent banner, notification prompt, Drops or Prime promo, shopping or AI module appeared logged out, so no rules exist for them. Logged-in views, other regions' consent dialogs, clips/schedule tabs and desktop `www.twitch.tv` are untested. Whether `sda-wrapper` ever shows a visible ad was not observed.

## Weibo (`weibo.default`)

Matches `*.weibo.cn` and `*.weibo.com`. Only the mobile site `m.weibo.cn` was observed (logged out, iPhone UA, 2026-11-08 and 2026-11-13). It opens via `visitor.passport.weibo.cn` then serves a Vue app: home feed, `/search?containerid=231583` (hot search), `/status/<id>` (post page). 2026-11-13 re-check covered the home feed only (15 posts).

| Option (default) | Rules and evidence |
|---|---|
| `login-button` (on) | `div.login-box:has(> a.login-btn)` `LIVE` 1, fixed button on every feed view. |
| `follow-buttons` (on) | `header.weibo-top > div.m-followBtn` `LIVE` 20 on Charts, 0 on Hot; leads only to sign-in. |
| `trending` (off) | `div.card.card16.m-col-2` (2) and `div.card.card11.ctype-3` (1) on the search page, `LIVE`. |
| `feed-tabs` (off) | `.lite-topbar.main-top > div.nav-main` `LIVE` 1. |
| `counters` (off) | `footer.f-footer-ctrl > div.m-diy-btn` `LIVE` 45 on 15 posts; `div.lite-page-tab div.tab-item > i + i` `LIVE` 3. |
| `comments` (off) | `div.comment-content` 1, `div.lite-page-tab` 1, `div.lite-page-editor` 1, `LIVE` on a post page. |
| `media` (off) | `div.weibo-media.f-media` `LIVE`: image grids and video players. |
| `avatars` (choice Show/Blur/Hide, show) | blur: `.weibo-top .m-avatar-box img` css `filter: blur(8px)` `LIVE` 15; hide: `.weibo-top > .m-avatar-box` `LIVE` 15 (picture and V badge). |
| `quoted-reposts` (choice Show/Dim/Hide, show) | `.weibo-rp` `LIVE` 2: dim css opacity 0.35, or hide. |
| `media-blur` (choice Show/Blur/Strong blur, show) | `.weibo-media img` css `filter: blur(10px)` / `blur(28px)` `LIVE` 29 (pictures and video covers). Works together with `media` (hide wins). |
| `post-source` (off) | `.weibo-top h4 > .from, .weibo-top h4 > .time` `LIVE` 12 + 15: date and "from <client>" line (some posts have no client). |
| `vip-badges` (off) | `.weibo-top .m-avatar-box i.m-icon` `LIVE` 15 (goldv/orangev badges); `.weibo-top h3 img.vipicon` `LIVE` 15 (member icon). |
| `video-stats` (off) | `.mwb-video .mwbv-info-bar` `LIVE` 8: play count and duration on video covers. |
| `search-hint` (off) | `.nav-top .nav-search .m-text-cut` `LIVE` 1: the "everyone is searching" topic hint; search link stays. |

What CSS cannot do: stop the app-install address-bar popup and the login popup after playing a video (uBlockOrigin/uAssets issues 23990 and 23851); they are script-driven.

Pitfalls: `.weibo-media` also matches the inner `.weibo-media-wraps`; target images (`.weibo-media img`) for blur rather than the wrapper. `.weibo-top` is both the header of a post and, on the post page, the author block, so `> .m-avatar-box` selectors cover both. Some posts have no `.from`.

## WhatsApp (`whatsapp.default`)

Matches `https://*.whatsapp.com/*`. On iPhone UA `web.whatsapp.com` redirects to `/mobile/`, a static page with nothing to hide. Rules land on the `www.whatsapp.com` marketing pages, the desktop-UA WebMessenger login, and (SOURCE only) the logged-in chat UI. Checked 2026-11-08 and 2026-11-13.

| Option (default) | Rules and evidence |
|---|---|
| `app-nags` (on) | LIVE: header `a[href*=itunes.apple.com]` in `[data-testid=whatsapp_www_header]` (2), hero `article a[href*=...ct=website_cta]` (1), footer itunes links (3), desktop web `[data-testid=download-native-client-button]` and `-inline` (1 each). The primary Download button on `/download` is in a `section`, so it stays |
| `promo-sections` (off) | LIVE: `section[data-testid=waui_section]:has(a[href="https://web.whatsapp.com/"])` (1); `:has(a[href^="https://whatsappbusiness.com"])` (1) |
| `footer` (off) | LIVE: `footer[data-testid=whatsapp_www_footer]` (1) |
| `page-images` Show / Blur / Hide (Show) | `[data-testid=whatsapp_www_full_page] picture` LIVE 18 on the saved home page HTML. Blur is `blur(14px)` |
| `feature-sections` (off) | `section[data-testid=waui_section]:has(a[href="https://www.whatsapp.com/calling"])`, `.../privacy`, `.../community`, `.../messaging`: LIVE 1 each (of 11 sections). Four rules, one per `:has` link |
| `chat-list-privacy` Show / Blur (Show) | SOURCE `#pane-side [role="row"]` (andryompusunggu.com/blog/pure-css-whatsapp-blur, greasyfork UI Manager); not run live (needs login) |
| `message-privacy` Show / Blur (Show) | SOURCE `#main .message-in, #main .message-out` (dark-whatsapp, privacy gists); not run live |
| `profile-pictures` Show / Blur / Hide (Show) | SOURCE `[data-testid="group-chat-profile-picture"]` (greasyfork Clean UI); INFERRED `#pane-side img, #main header img`. Hide only covers group message pictures |
| `channels-tab` (off) | SOURCE `[aria-label="Channels"]` (greasyfork Remove Channels script; English UI only) |
| `meta-ai` (off) | SOURCE `[aria-label*="Meta AI"]` (greasyfork Clean UI context-menu rule). A contact named Meta AI could also match |

**CSS cannot do:** hover-to-reveal for the blur options (the privacy extensions use `:hover`, which a recipe selector cannot be fixture-checked for, so the blur is permanent while on). The "Download WhatsApp for Mac" card on web.whatsapp.com has only generated classes, so just its button is hidden.

**Pitfalls.** www classes (`_9ta2` style) are hashed: use `data-testid` and `href`. `<video>` matched 0 on the www home page, so there is no video rule. WhatsApp Web markup changes often (r/uBlockOrigin Jun 2025: old menu filters stopped working); the logged-in rules are community-sourced and unverified. Not verified: chats, Status, Channels page, cookie prompts, faq.whatsapp.com.

## Sources

- Live pages (iPhone UA, 390×844, logged out, 2026-11-07): instagram.com `/`, `/reels/`, `/explore/`, `/instagram/`, a missing `/p/…`; `m.facebook.com` `/`, `/facebook`, `/watch/`, `/reel/`, `/groups_browse/`, `www.facebook.com/marketplace/`; x.com `/`, `/home`, `/explore`, `/NASA`, a status page, `/i/flow/login`; m.youtube.com `/`, search, watch, a Short, a channel, a playlist, `/feed/*`; www.reddit.com `/`, `/r/popular/`, a subreddit, a post, `/r/nsfw/`, `/explore/`, `/answers/`, search, a user page.
- Instagram: gist.github.com/viki53/74ab17ce5eb3c30699aae5620ad031e0 (Instagram Purified, 2025-07); gist.github.com/shraiwi/009c652da6ce8c99a6e1e0c86fe66886 (Nuke Insta Slop, 2026); greasyfork.org/en/scripts/551825 (Instagram Unhook); news.ycombinator.com/item?id=44941909 (2025-08); github.com/BevizLaszlo/UBlock-Filters-for-Social-Media (undated); secure.fanboy.co.nz/fanboy-mobile-notifications.txt.
- Facebook: github.com/kurtnettle/uBO-filters-fb (undated); gist.github.com/mustafamohsen/bede2bc01f5ddc310af023a490e3aab9 (2025-12, desktop only); greasyfork.org/en/scripts/548145 (desktop only); github.com/easylist/easylist/issues/6018 (2020, stale).
- X: theverge.com/tech/1027113/x-says-its-updated-web-app-is-way-faster (2026-11-05); pastebin.com/raw/Z2Tum43r (FreekyCreep, updated 2026-09-27); github.com/hgsanguk/adguard-x-filter (v2025.1229.0); gist.github.com/char/2b992f69eadafa94c78af30bf2cfda9e (2025-02); github.com/DandelionSprout/adfilt (TwitterPureReadingExperience); github.com/uBlockOrigin/uAssets commit 99deccb (2023-09, `d_prefs` cookie, possibly stale).
- Reddit: greasyfork.org/en/scripts/602031 (Reddit UI Enhancer, dumps 2026-09/10); github.com/zenstorage/Reddit-NSFW-Unblur (filters/ublock.txt, 2026-05); github.com/JobcenterTycoon/cookie-auto-decline commit ae1a88d (2025-09); reddit.com/r/Adguard/comments/1nsjorl (2025-09); sh.itjust.works/post/64935602 and the 2022/2024 r/uBlockOrigin threads on scroll lock (undated or stale; generic selectors rejected).
- YouTube: github.com/gijsdev/ublock-hide-yt-shorts (list.txt v2026.4.29; PR 58, 2025-07); github.com/insin/control-panel-for-youtube issue 187 (2026); mjones.network/ublock-filters.html and github.com/mchangrh/yt-neuter (desktop `ytd-*` names, undated).

## See Also

[Recipe Format](./recipe-format.md) · [AI Assistant](./ai-assistant.md) · [Site Runtime](./site-runtime.md) · [UI Design](./ui-design.md)
