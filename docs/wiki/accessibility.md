# Accessibility

> **Status: Implemented, not device-verified.** Rust, the page script and the shell are covered by unit tests and a stub-DOM run of the page script; nothing has been looked at on a real iOS or Android page yet.

Settings → Accessibility holds three groups. The first two are choices that change what the app and every page look like; the third is the touch aids that were already there.

| Group | Choice | Stored as (`library.json`, `accessibility`) |
|-------|--------|---------------------------------------------|
| | Epilepsy protection | `epilepsyProtection: bool` |
| Dyslexia | Reading font: Default, OpenDyslexic, Atkinson Hyperlegible | `font: "off" \| "opendyslexic" \| "hyperlegible"` |
| Dyslexia | Wider text spacing | `spacing: bool` |
| Dyslexia | Page tint: Off, Cream, Mint, Blue | `tint: "off" \| "cream" \| "mint" \| "blue"` |
| Touch | Floating back button, bottom margin | `backButton`, `bottomMargin` (top level of the file, unchanged) |

Everything is off until chosen. A file saved before this existed has no `accessibility` key and loads with everything off; no migration. `set_accessibility(accessibility)` saves the whole object and, as a recipe switch does, hands the open pages a recompiled script. `serde` rejects an unknown font or tint, so the command is its own validation.

## Two places the choices land

**The app's own screens** read three attributes on `<html>`, set by `useApplyAccessibility` (`src/shared/accessibility.ts`): `data-calm`, `data-reading-font`, `data-wide-text`. `src/index.css` does the rest: the `@font-face` rules, an override of Tailwind's `--font-sans`, a zero-specificity letter and word spacing rule (so the eyebrow label keeps its own; Arabic, Urdu, Hindi, Bengali, Tamil, Sinhala and Thai get none, because spacing breaks their joined letters), and the calm reset below. The tint is not applied to the app: the app is transparent over the native page view, so a tint layer there would colour the page a second time.

**Pages** get one script, `accessibility::Accessibility::page_script`, appended after the recipe script by `commands::script_for` (used by `open_session`, `reload_script` and the incognito switch). It runs at document start in every frame, in normal and incognito mode alike. It is the same mechanism as the recipe script, so nothing new is reachable from a site: no IPC, no event, no capability. The script is `src-tauri/src/accessibility/page.js` called with a JSON config built in Rust.

With every choice off the script still runs; it only removes what an earlier run left on a page that is already open (`document[Symbol.for("openmedia.accessibility")]` is the teardown), so switching a choice off takes effect without a reload. On a view the plugin has to rebuild instead of patch, the page reloads, as it does for a recipe switch.

## Epilepsy protection

What it does, in the app and in every frame:

- Every CSS animation and transition duration becomes 1 ms, delays 0, animations play once, smooth scrolling off. Not `animation: none`: an element that fades in from `opacity: 0` would never appear.
- A `<video>` that starts playing without the reader's own tap or key press is paused (`navigator.userActivation.isActive` is false). A play the reader starts, with the page's button or the native controls, is inside that window and runs. A page that restarts a video after each pause is given up on after 20 tries. A browser without `userActivation` leaves video alone.
- An `<img>` whose address ends in `.gif` (or a `data:image/gif`) is replaced by its first frame on a canvas of the same size; the image stays in the page, hidden.
- SVG SMIL animation is paused and `<marquee>` stopped, once the document has loaded.

What it cannot do: detect flashing inside a video the reader starts, find animation drawn by a page's own JavaScript, canvas or WebGL, or stop animated WebP/APNG or CSS background GIFs. It lowers the risk; it is not a guarantee, and the Settings text says so.

## Dyslexia

- **Reading font.** OpenDyslexic (Regular) and Atkinson Hyperlegible (Regular, Bold), both SIL OFL 1.1; the licence texts sit beside the files in `src-tauri/src/accessibility/fonts/`. The files hold the Latin letters only, so other scripts keep the page's own font. The same files serve the app (`@font-face`, bundled by Vite) and the pages (`include_bytes!`, base64 in the injected config). On a page they are registered with `new FontFace(family, arrayBuffer)` and `document.fonts.add`, not a `data:` URL, because a page's `font-src` policy can block the second and does not apply to the first. The rule is `font-family: "OpenMedia Reading", sans-serif !important` on every element except those that draw with an icon font or a fixed-width face (`i`, `svg`, `code`, `pre`, `kbd`, `samp`, `.fa`, `fa-*`, and classes containing `icon`, `material` or `glyph`). Text directly inside an excluded element keeps the page's font.
- **Wider text spacing.** The WCAG 1.4.12 values: letter spacing 0.12em, word spacing 0.16em, line height 1.5 on paragraphs, list items, quotes and table cells. Paragraph spacing is not changed, because margins break layouts. In the app the spacing is gentler (0.05em / 0.12em).
- **Page tint.** A fixed, click-through `html::after` layer, `mix-blend-mode: multiply`, in the top frame only. Cream, mint and blue at 50%.

Cost: OpenDyslexic adds about 115 kB to the binary and to the script handed to every frame while it is chosen; Atkinson about 35 kB.

## Files

| File | Role |
|------|------|
| `src-tauri/src/accessibility/mod.rs` | `Accessibility`, `ReadingFont`, `Tint`; builds the CSS and the config; unit tests |
| `src-tauri/src/accessibility/page.js` | Runs in the page: styles, fonts, autoplay guard, GIF stills, teardown |
| `src-tauri/src/accessibility/fonts/` | Font files and their licences |
| `src-tauri/src/library.rs` | `accessibility` in `AppState` and `LibraryData`, `set_accessibility` |
| `src-tauri/src/commands.rs` | `set_accessibility` command, `script_for` |
| `src/features/settings/AccessibilitySection.tsx` | The Settings section |
| `src/shared/accessibility.ts` | `<html>` attributes for the app's own screens |

## Not verified

On-device rendering on iOS and Android; real pages (icon fonts that do not match the exclusion list, sites whose layout breaks at 0.12em letter spacing); a flashing video; Android views whose scripts are installed through the `onPageStarted` fallback, where the script may run after the page's own.

## See Also

[UI Design](./ui-design.md#settings) · [Internationalization](./i18n.md) · [Security](./security.md)
