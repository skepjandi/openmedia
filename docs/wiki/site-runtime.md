# Site Runtime (the injected engine)

> **Status: Design.** Source will live in `engine/`, bundled to `src-tauri/resources/engine.js`.

The engine is one self-contained script injected into every frame of every site view at document start. It has no dependencies on the page and must never assume the page's globals are intact (sites monkey-patch `fetch`, `Array.prototype`, etc.).

## Injection

| Platform | Mechanism | Timing |
|----------|-----------|--------|
| Desktop | Tauri/wry `initialization_script` (documented to run before `window.onload`; all-frames variant exists) | Document start |
| iOS | `WKUserScript` at `.atDocumentStart`, all frames | Document start |
| Android | `WebViewCompat.addDocumentStartJavaScript` with an allowed-origin list when `WebViewFeature.DOCUMENT_START_SCRIPT` is supported | Document start |
| Android fallback | Script evaluated from `onPageStarted` | **Not guaranteed before page scripts** → possible flash; engine must tolerate late start |

The recipe bundle is delivered with the script (embedded as a JSON literal in the injected source) and updated live afterwards via `eval` of an `__om.update(bundle)` call. Because the injected source is generated per navigation by Core, re-resolving recipes on cross-document navigations is free.

## Application strategy

1. **CSS first.** Pure-CSS targets compile to one `<style id="om-style">` appended as early as `document.documentElement` exists. Rules like `a[href^="/reels"]` and `:has()` forms apply before first paint, with no flash.
2. **Observer second.** Targets that need text or complex predicates are evaluated by a single `MutationObserver` on `document.documentElement` (`childList`, `subtree`), batched with `requestAnimationFrame`, and tagged `data-om-hidden="<ruleId>"` so a stylesheet rule hides them. Matching work is scoped to the added subtree, not a full rescan.
3. **Budgeted.** Per-frame time budget; if exceeded, defer to idle. Observer disconnects when the tab is hidden and re-scans on visibility.
4. **Idempotent and reversible.** `__om.update()` removes everything it previously applied (attribute tags, style element, restored removed nodes) before applying the new bundle. Toggling a rule or rejecting a preview is exact.

## SPA navigation

Instagram, YouTube, X and Facebook mostly navigate without page loads. The engine:

- wraps `history.pushState` / `replaceState` and listens for `popstate` and `hashchange` (today only the redirect runtime does; recipe CSS and scripts are chosen once per document);
- re-evaluates `redirect` rules on every virtual navigation (see [Redirect rules](#redirect-rules); `when.path` conditions on other rule types are not implemented);
- reports the new URL to Core so recipe resolution can switch bundles when the pattern set changes.

## Redirect rules

Implemented in `src-tauri/src/route_redirect.js`, embedded in the page script (`compile.rs`) only when an applying recipe has a `redirect` rule. Rust compiles each rule's glob to a regular expression (`route.rs`) and the page tests the same string. The script:

- checks every rule on load and after each `history.pushState`, `history.replaceState`, `popstate` and `hashchange`; a rule applies when its recipe's `match` patterns (or its `on` subset) cover the current location and `when.path` selects the path;
- resolves `to` against the page's origin and refuses any result on another origin, then calls `location.replace`, so the blocked route does not stay in history;
- runs in the top frame only;
- allows 3 redirects per second per rule, keyed by recipe and rule id and counted in `sessionStorage` so a site that sends the page straight back cannot loop across reloads either; one more and the rule is suspended for the rest of that session (tab). There is no on-screen flag for a suspended rule yet.

Only rules whose option (and `choice`) is on reach the script, so switching the option off removes the redirect the next time the page script is built, like every other rule. Tested in `src/shared/routeRedirect.test.ts` (load, no match, single-page navigation, loop guard, negation, cross-origin refusal, top frame) and in `recipes/mod.rs`.

## Element picker

Toggled by Core. Overlays a highlight on hover/tap, shows a breadcrumb of ancestors so the user can widen/narrow the selection, and returns a **proposed target** rather than a raw selector. Target synthesis prefers `ariaLabel`/`href`/`role`/`text` over `css`, and never emits hashed-class selectors. The user confirms; Core creates a `hide` rule. This path works with no AI key.

## Feed player

`src-tauri/src/dark_mode/page.js` is appended after the video controls script, in every frame, when the reader has dark mode on (or a site/recipe asks for it); with it off it still runs, to remove what an earlier run left. See [Dark Mode for Pages](./dark-mode.md).

`src-tauri/src/feed_player.js` is appended to the document-start script after the accessibility script, in the top frame only. It runs in full-screen feeds: `/shorts`, `/reel(s)`, `/<user>/reel(s)`, `/watch/reel(s)` and `/stories` on any site, TikTok, Instagram `/p/` and `/tv/`, and Facebook `/watch`. Once scrolling settles it picks the video in view (one covering at least half the viewport, or a wide clip that sits on screen); a video the site parks off screen while it is not playing (YouTube Shorts) is placed by its wrapper when that is at most 1.5 screens tall, plays it, and pauses videos that left the screen.

- **Refusals.** `NotAllowedError` on iOS posts to the native-only `openmediaPlay` handler, and the plugin calls the page's `Symbol.for('openmedia.feedPlayNow')` through `evaluateJavaScript`, which WebKit runs with a user gesture (so sound and low power mode are not obstacles). Without the handler (Android, macOS) the player mutes and plays. Any other refusal is retried on the next settle.
- **Attempts.** Each element gets 8 attempts, 300 ms apart, then one every 5 s. A new source (`loadstart`, `emptied`) or a new video in view resets the count, because feeds reuse one element for every item. A video that reports playing but does not move for three settles is paused and retried.
- **Reader's pause.** Only a pause within 900 ms of a tap (a finger that moved at most 10 px), a click or a key, on the video in view, counts as the reader's and is left alone until the video leaves the screen. A swipe never does, and neither does a pause the player makes itself.
- **Hold.** It is idle while `window.__openmediaHold` is set (the native background pause; iOS sets it too, with an `openmedia-resume` event on resume) and, in calm mode (`Symbol.for('openmedia.noAutoplay')`), it still reports the video in view (`currentVideo`, which the video controls need) but starts and retries nothing. iOS site views also set `mediaTypesRequiringUserActionForPlayback = []`.

## Video controls

Options beyond the browser's tracks come from three places, in this order (`readOptions` in `video_controls.js`): a recipe's script (`Symbol.for('openmedia.videoOptions')`), a recipe's `videoMenu` rules (`Symbol.for('openmedia.videoMenus')`, `video_menu.js`, which clicks the site's own menu), and detectors for players built with common libraries (video.js, hls.js, dash.js, Shaka, Plyr, JW Player, Vidstack, YouTube's player object; `video_detectors.js`, spliced into `video_controls.js` at build time), found from the video element itself on any site. A group of a kind an earlier source gave is not repeated.

`src-tauri/src/video_controls.js` is appended after the feed player and takes its choices from Settings > Video controls (`VideoControls` in `src-tauri/src/video_controls.rs`, saved in `library.json` as `videoControls`) and, per site, from the favorite (`SiteVideo`, saved as `videoSites`, keyed by registrable domain). It runs in the top frame, on a feed page (the feed player's `Symbol.for('openmedia.isFeed')`) with the video the feed player has in view (`Symbol.for('openmedia.currentVideo')`), and, only when Full videos is on (`fullVideos`, off by default, also per site), on a page about one video (`og:type` starting `video`, or a path starting `/watch`, `/video(s)`, `/embed`, `/clip(s)` or `/movie(s)`) with its biggest video that covers at least 15% of the viewport; with it off, a watch page keeps its own player, which has more (captions, quality, chapters, hold for 2×). It is idle while `window.__openmediaHold` is set. It never clicks a page element.

- **Panel** (`panel`, off until switched on): hidden until the video is tapped. A capture-phase `click` on `window` whose point is inside the video in view, and whose target is not one of the site's buttons or links (`a, button, input, [role=button], [role=link], [role=slider]` and similar), shows the panel and is kept from the site (`stopImmediatePropagation`), so the panel replaces the site's own tap (pause, mute); a second tap hides it. A swipe makes no click and reaches the site untouched. A double tap is the panel's too, so a site's double tap-to-like does not happen while the panel is on: in the left or right third of the video a second tap within 300 ms skips back or forward instead of hiding the panel, each further tap adds to it, and the total shows over that side for 0.7 s; in the middle third the taps show and hide the panel. A double click that skipped is kept from the site (`dblclick`), which would otherwise go full screen on desktop players. The panel fades in, goes away 3.5 s after the last touch on it, but stays on a paused video, and goes away when the video in view changes. Pause and play go through `Symbol.for('openmedia.userPause')` so the feed player does not restart a video the reader paused.
- **Contents:** the small player (top left) and full screen (top right); back, pause/play and forward by the skip length; mute and a volume bar (the device's media volume on Android, the video's own volume elsewhere, no bar on iOS, where a page cannot set it), the site's option lists, and the speed button, which opens a list (`0.5×` to `3×`, the one playing ticked); the seek bar between the time played and the time left (a tap on the time left shows the length instead). Buttons are 40 px (60 px for play) whatever their icon. The seek bar takes pointer events with `touch-action: none`, stopped before they reach the site so a drag is not a swipe; it shows how much is loaded (`buffered`), thickens while held with a bubble over the knob giving the time there, seeks at most every 150 ms while dragged (`fastSeek` where the browser has it) and to the exact point on release, and stops 0.25 s short of the end, which would fire `ended` and move a feed on. A video over an hour reads `h:mm:ss`. The card is at most 560 px wide, centred.
- **Live streams:** a video with no finite length whose `seekable` range is known is live. The seek bar spans that range, the time played is blank, and the time left becomes a dot: red within 3 s of live, otherwise with how far behind it is (`● -0:30`); tapping it goes back to a second behind live. Forward skips stop at live.
- **Keys:** only while the panel is up, and not while typing in a field or with Ctrl, Alt or Cmd held: Space or K plays and pauses, Left/Right (or J/L) skip, Up/Down change the volume by 10 %, M mutes, F goes full screen, Escape hides the panel. Each key it uses is kept from the site; with the panel down every key is the site's.
- **Drag to shrink** (`dragToMini`, on by default, also per site): dragging the video down from the top of a watch page lifts it into the small player. It has its own switch and works with the panel off. When it is off for the page, the drag is left to the site and the page no longer sets `Symbol.for('openmedia.holdRefresh')`, so the app's pull to refresh keeps the touch.
- **Skip length** (`skip`, 10 s by default, also per site): 5, 10, 15 or 30 seconds, for the buttons (which carry the number), a double tap and the arrow keys. Rust snaps any other saved value to the nearest of those when it reads it.
- **Height** (`height`, 16 px by default, at most 200): pixels above the bottom edge plus `env(safe-area-inset-bottom)`.
- **Per site:** a favorite's edit form can turn the panel off, which gives the site's own controls back (no tap is kept from the site), and can set the height and the skip length. A site with no choice follows the shared one. The page finds its entry by hostname (the longest key the host equals or ends with), so no site is named in the script.
- **Speed and sound:** a speed picked in the panel and the panel's mute and volume carry over to the next video for as long as the page lives. With **Remember** (`remember`) they are also kept in the page's `localStorage` under `openmedia.video` (a sound change counts when it comes within 900 ms of a tap or key) and applied to each new video source (`loadstart`) on later pages of the site; without it nothing is saved and a saved speed is not applied.
- **Small player:** a turned phone or a resized window (`resize`) gives it the size it has on the new screen and moves it back inside, where the reader left it.
- **Loop off** (`loopOff`): sets `loop = false` and watches the attribute, because sites put it back.
- **Move on** (`autoAdvance`, which implies loop off): on `ended` it scrolls, as a swipe would: `scrollIntoView` to the next video below, or one screen down inside the feed's scroller. It never clicks the site's own next button, and does nothing in calm mode. A feed that swipes with touch handlers instead of scrolling (m.youtube.com Shorts) cannot be moved this way, so it stays on the last frame.

The feed pages are the ones the feed player knows. A page it does not know is added by a script rule from the assistant, `document[Symbol.for('openmedia.feedPaths')] = ['^/clips/']` (up to 8 case-insensitive path patterns), which also turns on the autoplay of the feed player there. Hiding parts of a feed (title, channel, buttons) is ordinary `hide` rules.

## Prune rules

`src-tauri/src/prune_runtime.js` is a function expression, embedded in the document-start script (like `video_menu.js`) only when a rule that currently applies is a `prune` rule. The page script hands it the rules of every recipe entry matching the page: each rule's `urls` compiled by Rust to anchored path regexes (`recipes/prune.rs`) and each `remove` path parsed by Rust into steps (a string is a key, `"*"` every array element, a number an index), so the page never parses the grammar. It runs in every frame whose own URL a recipe matches, in the page's own world, because that is where the page's `fetch` lives.

- **Wrapping.** `window.fetch`, `XMLHttpRequest.prototype.open` and the `responseText`/`response` getters are wrapped once per window; the wrapper state lives under `Symbol.for('openmedia.prune')`. A second run (a toggled option, a swapped recipe, `set_document_start_script`'s live eval) finds the state and only replaces its rules; the page script runs `state.rules = []` when no prune rule applies any more, so the effect stops on the next response with no reload. Wrapping is never removed (the wrapper with no rules returns the page's own promise or value).
- **What it reads.** The request's URL (a string, `URL` or `Request.url`; never a body, header or option) and the response the page already asked for. It must be on the page's own origin both as requested and as finally answered (a redirect elsewhere is left alone), its path must match a rule, and the response must be `ok`, `basic`/`default` type, JSON-typed (or empty or `text/plain`), and buffered within 2 MiB. For `fetch` it reads a **clone** (`response.clone()`), counting bytes chunk by chunk and giving up past the cap or at a larger `Content-Length`, so the page's own response is never consumed. For XHR it acts only at `readyState` 4 on text and `json` response types.
- **What it returns.** If a path removed anything, a new `Response` (same status, status text and headers, minus `Content-Length` and `Content-Encoding`, `url` kept) holding the re-serialised JSON, or for XHR the pruned text or object. In every other case, including every parse error, shape mismatch and exception, the page gets the original response object or value.
- **What it never does.** Start, change, delay beyond buffering, or read the body of a request, touch the bridge, or send anything. The wait: for a matching request the page's `fetch` promise resolves when the body has been buffered, not when the headers arrive.
- **Circuit breaker.** An unexpected exception (not a parse failure, which is normal) counts as a fault; after 5 the rules are emptied and the page is left as the site made it until the next run of the page script.
- Tested in `src/shared/pruneRuntime.test.ts` (stub `fetch`/XHR, no site) and `recipes/prune.rs` / `recipes/mod.rs` (validation and delivery).

## Crowd rules

`src-tauri/src/crowd_data.js` is a function expression embedded in the document-start script only when a rule that currently applies is a `sponsorBlock` or `dislikeCount` rule; the page script calls it with the rules, and when none applies it calls `window[Symbol.for('openmedia.crowd')].set([])` so a live page is cleaned after a switch. Top frame only. A 500 ms timer compares the page's address with each rule's `videoId`; when the id changes it loads data for the new video and, for `dislikeCount`, removes the old count. `sponsorBlock` listens for `timeupdate` on the document (capture) and sets `currentTime` of the video that fired it, once per segment. `dislikeCount` keeps one `span[data-openmedia-dislikes]` inside the target, putting it back when the site re-renders. What it sends is listed in [Security](./security.md#crowd-rules). Tested in `src/shared/crowdData.test.ts` (fake `fetch` and video, no network) and `recipes/crowd.rs`, `recipes/compile.rs`.

## Snapshot

`__om.snapshot(opts)` returns a pruned tree used by the [AI Assistant](./ai-assistant.md).

- Skips `script`, `style`, `noscript`, `svg` internals, hidden elements (unless requested), and off-screen virtualized rows beyond a cap.
- Keeps per node: tag, `role`, `aria-label`, `id`, `href` **path only (no query/fragment)**, `data-testid`-style stable attributes, and class tokens that look human-authored (hashed-looking tokens dropped).
- Text: only short UI-label text (≤ 40 chars) on interactive/landmark nodes; everything else replaced by a length bucket. Form values, `contenteditable`, `textarea`, `input`, and `[type=password]` content are never read.
- Budgets: depth ≤ 12, nodes ≤ ~1500, serialized size cap tuned to the model's context. Subtrees are collapsed with `…(n children)` when the budget is exhausted, largest-first.
- The engine does the first redaction pass. Core does a second pass (see AI Assistant) so a compromised or buggy page cannot widen what is sent.

## Reporting (page → Core)

The engine sends small, typed messages: `ready`, `urlChanged`, `matchReport { ruleId → count }`, `snapshot`, `pickerResult`, `redirectSuspended`. Transport is the **bridge**: on mobile a native message handler feeding a Rust `Channel` (decided; see [Security](./security.md#the-bridge) and [Platform Support](./platform-support.md#verified-results)). The engine treats the bridge as lossy and fire-and-forget; Core never trusts message contents beyond schema validation.

Because the page's own scripts share the realm with the bridge handle, **the engine assumes anything it can call, hostile page code can also call**. Messages must therefore be low-privilege by construction: they can only inform Core, never trigger actions.

## Robustness rules

- Wrap all engine code in try/catch with a circuit breaker: if the engine throws repeatedly, it disables itself and reports `engineFault`. A broken recipe must never break the site.
- Never `eval` or `new Function` recipe content. Rules are data.
- Never mutate in ways that fight the framework (no re-parenting React-managed nodes); prefer hiding.
- No network from the engine.

## See Also

[Recipe Format](./recipe-format.md) · [Security](./security.md) · [Platform Support](./platform-support.md)
