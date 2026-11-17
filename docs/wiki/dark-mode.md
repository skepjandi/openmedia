# Dark Mode for Pages

> **Status: Implemented, not device-verified.** Rust, the settings screen and the page engine are covered by unit tests and by runs of the engine against local HTML fixtures; nothing has been looked at on a real iOS or Android page yet.

**Appearance** (Settings, Light / Dark / System) themes OpenMedia's own screens and nothing on a page. How pages look is the **Dark mode** feature: Settings → Dark mode for every site, a per-site choice on each page's settings, and a button in the floating button's fan. A site with no dark stylesheet stays white until Dark mode paints it. Pages see the device's own light or dark setting as `prefers-color-scheme` (on iOS and Android the app no longer overrides it; on macOS the window's appearance is the page's, which the view cannot separate). The engine is the feature set of the Dark Reader extension, reimplemented for the page script: original code, with Dark Reader (MIT) as prior art for the approach.

Everything is off until chosen, nothing leaves the device, and the reader can switch it off globally and per site ([invariant 10](../../AGENTS.md)).

## What the reader can set

| Group | Choice | Stored as (`library.json`, `darkMode`) |
|-------|--------|----------------------------------------|
| | Dark mode for pages | `enabled: bool` |
| Method | Dynamic, Filter, Filter+, Static | `method: "dynamic" \| "filter" \| "filterplus" \| "static"` |
| Colour | Brightness 50–150 %, Contrast 50–150 %, Sepia 0–100 %, Grayscale 0–100 % | `brightness`, `contrast`, `sepia`, `grayscale` |
| Colour | Dark scheme: background and text colour, with presets (Default, Black, Graphite, Midnight, Warm) | `background`, `text` (`#rrggbb`) |
| When | Always, follow the device's light/dark setting, or between two times (wraps midnight) | `schedule: { kind: "always" \| "system" \| "time", from, to }` |
| Pages | Skip pages that are already dark | `skipDarkPages` (default on) |
| Pages | Dark form controls and scrollbars (`color-scheme: dark`) | `systemControls` (default on) |
| Pages | Themed scrollbars and text selection | `scrollbars` (default on) |
| Pages | Adapt images (icons and logos, large diagrams on white) | `images` (default on) |
| Pages | Text stroke 0–1 px in 0.1 steps | `textStroke` (tenths of a pixel, 0 to 10) |
| Per site | Follow settings, Always on, Off, and a method of its own | `darkSites: { "<registrable domain>": { mode?, method? } }` |

A file saved before this existed has none of these keys and loads with the defaults above; no migration. `set_dark_mode(darkMode)` validates (ranges, `#rrggbb`, `HH:MM`; serde rejects an unknown method or mode) and saves; `set_site_dark_mode(site, dark)` saves one site's entry (an entry with neither field removes it). Both hand the open pages a recompiled script, as `set_accessibility` does, so a change shows without a reload. Dark mode applies in normal and incognito mode alike.

## Where the reader turns it on

Three layers, the last one winning:

1. **General** (Settings → Dark mode): every choice above, the default for every site.
2. **Specific** (Settings → Favorites, the expanded favorite's **Dark mode** row, which opens its own page `Dark mode: <name>`): the same controls as general (on/off for this site, method, brightness, contrast, sepia, grayscale, text stroke, scheme colours, schedule, skip dark pages, dark controls, scrollbars, images), each one either following general or overriding it. A control the site overrides shows a dot and a *Follow general* button that clears only that field; *Reset all to general* clears the site's entry. Stored as `darkSites[<registrable domain>]`, every field optional (`mode`, `method`, `brightness`, `contrast`, `sepia`, `grayscale`, `background`, `text`, `schedule` as a whole, `skipDarkPages`, `systemControls`, `scrollbars`, `images`, `textStroke`); the page engine overlays the entry on the general config (`effectiveConfig`), so a missing field follows general.
3. **The floating button:** a moon button in the fan, after Incognito and the video controls switch. A tap turns dark mode on or off for the page in view and overrides what the favorite says (it writes that site's specific `mode`; with no page open it flips the general `enabled`). Holding it opens that favorite's *Dark mode* page when the page is a favorite, and the general page otherwise.

## The methods

- **Dynamic** (default). The engine reads the page's stylesheets and writes an override sheet next to each one that holds only the colour declarations, recoloured. Light backgrounds scale down to the scheme background, dark text becomes light, grey takes the scheme's hue, blue links stay readable, borders go to mid tones. Brightness, contrast, sepia and grayscale are applied to every colour it writes. Photos are never touched.
- **Filter.** `filter: invert(1) hue-rotate(180deg)` on the page with pictures, video and canvases inverted back. Works on anything, at the cost of colours that are only approximate and of a filtered root (fixed elements behave slightly differently).
- **Filter+.** Filter, with the page background painted so that white lands on exactly the chosen dark background.
- **Static.** No stylesheet reading: a fixed background, text, link and border colour on the page's root, form controls and tables. Light on CPU; for pages the dynamic method makes sluggish.

## How the dynamic engine works

`src-tauri/src/dark_mode/page.js` is a function expression called with a JSON config, appended to the document-start script after the recipe, accessibility, feed player and video controls scripts, in every frame. It has no IPC, event or capability, so a site gains nothing it could not do already.

1. **Early paint.** As soon as `<html>` exists, a base style sets the scheme background and `color-scheme: dark`, so there is no white flash.
2. **Stylesheets.** For every readable sheet (`document.styleSheets`, adopted sheets, open shadow roots, `@import`s, and rules nested in `@media`, `@supports`, `@layer`, `@container` and CSS nesting) it writes an override sheet right after the original, so the cascade order is unchanged. A sheet the page cannot read (cross-origin) is fetched again by address, like the page did, parsed in a detached sheet and rewritten; if the fetch is refused it is left alone.
3. **Properties rewritten.** `color`, `background*` (gradient colours; `url()` images go to image analysis), `border*`, `outline-color`, `box-shadow`, `text-shadow`, `text-decoration-color`, `caret-color`, `column-rule-color`, `fill`, `stroke`, `stop-color`, `-webkit-text-fill-color`, `scrollbar-color`, `accent-color` and the like.
4. **Custom properties.** A variable that holds a colour gets three variants (`--om-bg--name`, `--om-text--name`, `--om-border--name`) and each `var(--name)` in a colour property reads the variant that fits the property.
5. **Inline styles.** Not rewritten in place: the element gets a `data-om-i` mark and the override lives in a sheet of its own, so the page's own scripts still read the style they wrote.
6. **Changes.** A `MutationObserver` and patches of `CSSStyleSheet.insertRule`, `deleteRule`, `replace`, `replaceSync` and `adoptedStyleSheets` re-process what a page adds later (CSS-in-JS, lazy sheets, shadow roots), debounced.
7. **Already-dark pages.** Once the document has loaded the engine reads the page's own background and text colour with its sheets off; a dark page is left alone. A site set to Always on skips this check.
8. **Images.** Where the pixels are readable (same origin, `data:`, or CORS), a dark, mostly transparent, grey image (an icon or logo) is inverted and a large, mostly white, opaque, grey one (a diagram) is inverted and hue-rotated back; everything else is left as is. Pictures whose pixels the page cannot read are not touched.

Recipe CSS (`style[data-openmedia]`) is never rewritten: it is the reader's own choice.

## Which setting wins

User's per-site entry (`darkSites`, longest registrable-domain match) → recipe `dark` rule → global settings. `mode: "on"` forces the engine on regardless of `enabled` and the schedule and skips the dark-page check; `mode: "off"` forces it off. The schedule `system` follows `prefers-color-scheme` as the page sees it, which is the device's setting.

## Recipes and the assistant

Site knowledge lives in recipes, never in the engine ([invariant 5](../../AGENTS.md)). A recipe can carry a `dark` rule:

```json
{ "id": "dark-fix", "label": "Dark mode fixes", "type": "dark",
  "mode": "off", "method": "filter", "invert": ["img.logo", "svg.chart"] }
```

| Field | Notes |
|-------|-------|
| `mode` | `"on"` or `"off"`: force the engine on (a site it should always theme) or off (a site with a good dark theme of its own, or one the engine breaks). |
| `method` | `dynamic`, `filter`, `filterplus` or `static`: the method this site needs. |
| `invert` | Up to 20 selectors, each through the usual selector validator. Elements whose light and dark are flipped: logos and icons drawn dark on transparent, charts. Used by the dynamic and static methods only; the filter methods have already inverted the page. Never for photos. |

At least one of the three is required. The rule is declarative (enums and validated selectors), so it may be shared, imported and bundled; it needs no script policy. The compiled recipe script sets `document[Symbol.for("openmedia.darkFixes")]` for the rules that apply on the page and the engine reads it; with no applying rule the symbol is removed so a switched-off option takes effect on the next run. An older app that does not know `dark` refuses a recipe that has one, as it refuses any unknown rule type.

The in-app assistant knows the dark mode: the system prompt describes the methods, the settings it cannot change, and when to write a `dark` rule (a logo that vanishes, an image inverted wrongly, a page that is already dark, a page the dynamic method cannot theme) or an ordinary `css` rule for a single element. A `dark` rule has no count to preview; the review shows its mode, method and selectors.

## Files

| File | Role |
|------|------|
| `src-tauri/src/dark_mode/mod.rs` | `DarkMode`, `DarkMethod`, `DarkSchedule`, `SiteDark`; validation; builds the config; unit tests |
| `src-tauri/src/dark_mode/page.js` | The engine: colour pipeline, stylesheet rewriting, observers, image analysis, filter and static methods, schedule, teardown |
| `src-tauri/src/library.rs` | `dark_mode` and `dark_sites` in `AppState` and `LibraryData` |
| `src-tauri/src/commands.rs` | `set_dark_mode`, `set_site_dark_mode`, `script_for` |
| `src-tauri/src/recipes/{schema,compile}.rs` | The `dark` rule and `darkFixes` |
| `src-tauri/src/ai/{patch,prompt,agent}.rs` | The assistant's dark rule |
| `src/features/settings/DarkModeScreen.tsx` | The settings screen |
| `src/features/settings/FavoritesSection.tsx` | The per-site choice |
| `src/shared/darkEngine.test.ts` | Colour maths, rewriting, schedule, image classification, teardown |

## Limits

- A stylesheet the page cannot read and the fetch cannot get (no CORS) stays light; the engine's base colours keep the page usable and the Filter methods cover it.
- Colours set by script on every frame (canvas drawing, WebGL, a chart library drawing to a canvas) are not recoloured.
- Images whose pixels cannot be read are left as they are.
- Filter methods filter the page root, which changes how `position: fixed` elements behave on some pages.
- Sunrise and sunset schedules are not offered (they need a location); a time window is.
- Dark Reader's per-site fix database is not copied: fixes are recipes.

## Not verified

On-device rendering on iOS and Android; real sites with heavy CSS-in-JS (the engine is tested on local fixtures); the cost on a long, complex page on a phone.

## See Also

[Accessibility](./accessibility.md) · [Site Runtime](./site-runtime.md) · [Recipe Format](./recipe-format.md) · [AI Assistant](./ai-assistant.md) · [Prior Art](./prior-art.md)
