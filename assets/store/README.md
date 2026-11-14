# Store assets

App Store and Google Play artwork, built from real iOS Simulator captures. Upload the PNGs as they are.

## Sizes

All files are sRGB PNG with no alpha channel (both stores reject transparency). Sizes were checked
against Apple's [screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/)
and Google's [preview assets help](https://support.google.com/googleplay/android-developer/answer/9866151) in November 2026.

| Folder                | Store slot                      | Size (px)   | Count | Store rule                                                                                        |
| --------------------- | ------------------------------- | ----------- | ----- | ------------------------------------------------------------------------------------------------- |
| `ios/iphone-6.3/`     | iPhone with Dynamic Island, medium display (**required**) | 1206 × 2622 | 8 | Apple also accepts 1179 × 2556; 1 to 10 per slot |
| `ios/iphone-6.1/`     | iPhone, 6.1" display                                 | 1179 × 2556 | 8 | Exact accepted screenshot size; 1 to 10 per slot  |
| `ios/ipad-13/`        | iPad, 13" (required for iPad)   | 2064 × 2752 | 8     | Apple also accepts 2048 × 2732; 1 to 10 per slot                                                  |
| `android/phone/`      | Phone                           | 1080 × 1920 | 8     | 9:16 or 16:9, 320 to 3840 px a side, 2 to 8 shots. 1080 px or more keeps the listing promotable   |
| `android/tablet/`     | 7" and 10" tablet (same files)  | 1440 × 2560 | 8     | 9:16 or 16:9, 1080 to 7680 px a side, up to 8 each                                                |
| `android/feature-graphic.png` | Feature graphic         | 1024 × 500  | 1     | Required to publish; PNG or JPEG, no alpha                                                        |
| `macos/<size>/`       | Mac (`APP_DESKTOP`)             | 2880 × 1800, 2560 × 1600, 1440 × 900, 1280 × 800 | 8 per size | 16:10 landscape; Apple accepts any one of the four sizes; 1 to 10 per slot |

Each set tells the same story in the same order: `01-browse`, `02-fan`, `03-recipes`, `04-browsing`, `05-usage`,
`06-limits`, `07-byok`, `08-dark`.

Mac slot (`macos/<size>/`, `APP_DESKTOP`): 8 slides in each of 1280 × 800, 1440 × 900, 2560 × 1600 and 2880 × 1800 (16:10; Apple accepts any one, 1 to 10 shots). They are made from window captures of the macOS app in `captures/macbook-pro/` (2880 × 1800, debug build with Pro forced on, a fresh profile and synthetic usage data). The Mac App Store also takes a 1920 × 1080 app preview video, which is not made. Slide 7 shows the app's current "iOS Keychain" wording; fix the string and retake before submitting if that matters. Google Play also takes Chromebook and other large-screen sets if those platforms ship.

## Captures

`captures/` holds the unedited Simulator screenshots the artwork is made from, and the landing page reuses them.

| Folder                 | Device                       | Native size |
| ---------------------- | ---------------------------- | ----------- |
| `iphone-17-pro-max/`   | iPhone 17 Pro Max, iOS 26.5  | 1320 × 2868 |
| `ipad-pro-13-m5/`      | iPad Pro 13-inch (M5), iOS 26.5 | 2064 × 2752 |
| `macbook-pro/`         | OpenMedia window on macOS (Apple Silicon), 1440 × 900 pt | 2880 × 1800 |

- Debug build of `main` (`yarn tauri ios build --debug --target aarch64-sim`), fresh install, onboarding skipped.
- Status bar fixed with `xcrun simctl status_bar <udid> override --time 9:41 --batteryState charged --batteryLevel 100`.
- The iPad was set to Full-Screen Apps (Settings > Multitasking & Gestures) so iPadOS 26's window resize handle stays out of the frame.
- Browsing shots show a live public page (`reddit.com/r/EarthPorn`). It carries third-party photos and Reddit usernames; swap the page and recapture if that is a concern.
- Usage and Limits show **sample data**: a week of synthetic seconds per site and three sample limits written to the app's `usage.json` before launch. They are not real browsing history.
- The AI provider form is empty; no key was entered.
- `01-browse`, `02-fan` and `08-dark` are JPEG (quality 96, 4:4:4) because their photographic content makes lossless PNG 3 to 5 MB each. The rest are the original PNGs.

## Android caveat

The Android site-view implementation and build path exist, but Android has not been verified on a device or emulator. These Android artwork sets reuse iOS captures (frameless: Google advises against device art in listings, so there is no device frame, only a thin edge light). Replace them with Android app captures before submitting to Google Play.

## Panoramic layout

Every set is one panorama: a single wide scene sliced into the 8 store images, so the gallery reads as one picture when swiped. The backdrop (ink to royal blue and back, with aurora glows), a twisting ribbon, seam-centred ripples and a particle field cross the seams. The particles are the "noise": thick on the left, gone by the right. Each slice still stands alone: its headline and device sit fully inside it, and only decoration plus one zoom card (the fan menu, from slide 2 into slide 3) cross a seam. App Store search shows the first three portrait slices on their own, so nothing the viewer needs is split.

iOS and iPad devices are drawn in CSS (no Apple bezel assets). The Mac sets use the native window captures. `macos/2880x1800/` is rendered; the other three sizes are exact 16:10 Lanczos downscales of it.

## Regenerating

`scripts/render-store-assets.mjs` composes the artwork from `captures/`.

Needs Node, Google Chrome and ImageMagick (`magick`). Fonts come from `node_modules` (`yarn install` first).

```bash
node scripts/render-store-assets.mjs                    # everything
node scripts/render-store-assets.mjs ios/ipad-13        # one folder
node scripts/render-store-assets.mjs macos/2880x1800    # Mac, all four sizes
node scripts/render-store-assets.mjs android/feature-graphic
node scripts/render-store-assets.mjs ios/iphone-6.9 --panorama   # also writes the full strip to /tmp
```

Set `CHROME_BIN` to use a Chrome or Chromium binary other than the macOS default. Headlines are in the `slides` array, the zoom card in `zoomCards`, set sizes and device placement in `sets`, the palette in `backdropCss`. A full run takes a few minutes; the sets are independent, so run several folders in parallel.
