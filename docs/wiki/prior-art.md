# Prior Art

> **Status: Research** (as of 2026-11-07). Facts come from the products' own public pages; inferences are labelled.
>
> **Re-checked 2026-11-07 against <https://sociallite.app/faq/>:** iOS embedded optimized versions, redirect instead of modifying native apps, Android Accessibility hybrid, up to 10 Instagram accounts, Post Mode, Sleep Mode, Parent plan, message notifications, analytics collection, the limitation list, and the beta platform list. **Not re-checked:** store ratings and the 1M+ users claim, the "embedded web browser" quote from the terms, the daily-allowance feature (not on the FAQ page), and the Chrome extension.

## SocialLite ([sociallite.app](https://sociallite.app/))

"Keep the social. Lose the scroll." Removes Reels, Shorts and Spotlight and other algorithmic loops from social apps. Claims 1M+ users; iOS 4.8★ (35K+ ratings), Google Play 4.5★ (8K+ reviews); a Chrome extension is announced ("coming soon").

### How it works (from their FAQ and terms)

- **iOS:** opens the social account **inside its own app using an optimized version of the site**, "an embedded web browser" per their terms. You log in directly to the platform; a session cookie stays on device. A developer in a public Reddit thread describes it as a WKWebView with injected JavaScript hiding the addictive parts [INFERENCE; not confirmed by SocialLite].
- **Native app blocking on iOS:** impossible directly ("iOS doesn't let any app change what happens inside another app"), so it redirects you from the native app into its own view.
- **Android:** hybrid. Uses the **Accessibility permission** to detect and block features inside the real native apps, and also offers optimized in-app Instagram/YouTube.
- **Platforms:** Instagram, YouTube, X, TikTok, Facebook, LinkedIn, Snapchat. TikTok/Snapchat/LinkedIn/X/Facebook labelled beta.

### Features beyond blocking

Daily allowance for short video (by count or minutes), time-spent stats, Sleep Mode (scheduled app locks), Post Mode (temporary unlock to post), up to 10 Instagram accounts, message notifications (Instagram, Snapchat), a Parent plan (linking codes, downtime schedules, usage overview), subscription pricing. App analytics are collected.

### Stated limitations

Web versions lack: one-time-view DMs, sending video, story poll interaction, music on some content, creator tools/analytics. Intentionally "slow" UX.

### Take-aways

| Observation | Implication for OpenMedia |
|-------------|---------------------------|
| Embedded webview + injected script is a viable, store-distributed product at scale | The core mechanism is validated. [INFERENCE on review-approval odds] |
| Hardcoded list of ~7 platforms; fixed feature toggles | **Our differentiator:** any site, via recipes + AI |
| Needs a backend: accounts, parent linking, push, analytics | We have none. Push notifications and parent plans are **out of scope**; say so |
| Android Accessibility Service for native-app blocking | Not pursued (policy and trust cost); revisit only if users demand it |
| Daily-allowance and scheduling features (Sleep Mode, downtime) | Built as local-only Usage features, not recipe rules: daily limits, per-site downtime schedules (windows on weekdays, through midnight) closing a site with the same native shield |
| Friction before opening, and locks that cannot be waived on impulse (Feurstagram-style permanent lock) | Built: optional per-site pause screen with a breathing countdown, and an opt-in settings lock with a 24 hour cooling-off that Rust enforces; reinstalling bypasses it, so it is a commitment device, not security |
| Multiple accounts per site | Fits our per-profile data stores (Phase 2/3) |
| Web-version feature gaps | Unavoidable; document as known limitations |
| Subscription, closed | We are open, BYOK, local-first |

## Other mechanisms worth knowing

| Approach | What it offers | Why not enough |
|----------|----------------|----------------|
| Content-blocker cosmetic filters (selector + predicates) | Mature selector vocabulary, community lists | Desktop-browser oriented; no AI authoring; no unified mobile+desktop shell |
| Userstyles / userscript managers | Full flexibility | Raw CSS/JS: not safe for AI output, not user-friendly, uneven mobile support |
| Browser extensions (SocialLite's own Chrome extension is the same idea) | Easy on desktop | No mobile story on iOS/Android Chrome |
| Native screen-time/app-limit tools | OS-level time control | Blunt: whole app, not features |

## Positioning

OpenMedia is the **general, open, local-first** version: SocialLite's mechanism, generalized to any site with a declarative recipe format and an AI that writes recipes. Popular sites get official recipes that ship inside the app so the common case needs no AI and no key.

## Sources

- <https://sociallite.app/>, <https://sociallite.app/faq/>, <https://sociallite.app/terms/>
- App Store listing: SocialLite — Block Reels & Shorts App
- Reddit r/IPhoneApps, "Anyone tried Sociallite?"

## Dark Reader

[Dark Reader](https://darkreader.org/) (MIT) is the browser extension that recolours any page dark. Its dynamic theme engine (stylesheet rewriting with a colour model per role, `var()` variants, image analysis, a database of per-site fixes) is the model for [Dark Mode for Pages](./dark-mode.md). OpenMedia reimplements the approach for the page script (no extension APIs, no background page, no sync) and replaces its per-site fix database with recipes: a `dark` rule per site, reviewed like any other.
