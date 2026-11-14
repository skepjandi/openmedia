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

- wraps `history.pushState` / `replaceState` and listens for `popstate` and `hashchange`;
- re-evaluates `when.path` conditions and `redirect` rules on every virtual navigation;
- reports the new URL to Core so recipe resolution can switch bundles when the pattern set changes.

## Redirect rules

Evaluated on load and on virtual navigation. Same-origin only. Uses `location.replace` so the blocked route does not stay in history. Guards against redirect loops (max 3 per second per rule, then the rule is suspended and flagged).

## Element picker

Toggled by Core. Overlays a highlight on hover/tap, shows a breadcrumb of ancestors so the user can widen/narrow the selection, and returns a **proposed target** rather than a raw selector. Target synthesis prefers `ariaLabel`/`href`/`role`/`text` over `css`, and never emits hashed-class selectors. The user confirms; Core creates a `hide` rule. This path works with no AI key.

## Feed player

`src-tauri/src/feed_player.js` is appended to the document-start script after the accessibility script, in the top frame only. In full-screen feeds (`/shorts`, `/reel(s)`, TikTok) it picks the video covering at least half the viewport once scrolling settles, plays it (muted if refused with `NotAllowedError`), pauses videos that left the screen and honours a reader's own pause until the video leaves the screen. It is idle while `window.__openmediaHold` is set (the native background pause) or calm mode is on (`Symbol.for('openmedia.noAutoplay')`). iOS site views also set `mediaTypesRequiringUserActionForPlayback = []`; with `.audio` an unmuted feed video needs a tap.

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
