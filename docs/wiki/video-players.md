# Video players of the sites we have recipes for

> **Status: Implemented (research notes).** What each site's mobile-web player is built with, which of the video controls' option lists reach it today, and what is missing. Evidence is marked: **emulator** (looked at on the Android emulator through the WebView's remote debugging, 2026-11), **research** (web research of page sources and public notes, mostly not first-hand), **memory** (prior knowledge, unverified). Nothing here was checked on a real device or behind a login.

How the options reach the panel is in [Site Runtime: Video controls](./site-runtime.md#video-controls): the browser's own tracks on every site; detectors for players built with hls.js, dash.js, Shaka, video.js, Plyr, JW Player, Vidstack and YouTube's player object, found from the video itself (hls.js and Shaka players are remembered as the page makes them, since sites keep them in a variable of their own); a recipe's `videoMenu` rule or script for the rest.

| Site | Player | Evidence | Options today | Gap |
|------|--------|----------|---------------|-----|
| YouTube | its own player object (`movie_player`) | emulator | quality list (detector), speed, tracks | captions are drawn by YouTube, so no caption list |
| Letterboxd, The Guardian (embeds) | YouTube in an iframe | research | the same, inside the frame (the controls run in frames) | not checked |
| Miruro | Vidstack (`strm.cx` iframe) | emulator | quality list when the stream has several levels (one level today) | none |
| Internet Archive | JW Player 8 (in a `play-av` shadow root) | emulator, research | quality list when the item has several levels (one today) | none |
| IMDb | JW Player | emulator | the same (one level today) | none |
| Fandom | JW Player | research, emulator (`jwplayer` global) | the same | none |
| Rumble | hls.js (a global `Hls` class) | emulator | quality list through the remembered-player hook | the hook is tested on a page with the player in a closure, not on Rumble itself (its page did not run the controls in my emulator session) |
| Reddit | Vidstack (`shreddit-player`) | research | the Vidstack detector, if it uses `media-player` | not checked |
| CNN | THEOplayer (FAVE wrapper) | research | none | no THEOplayer detector |
| Odysee | video.js | research | video.js detector, needs the quality-levels plugin | not confirmed |
| Naver TV | hls.js with its own UI | research | the hook, if `Hls` is a global | not checked |
| Paramount+, Peacock, Pluto TV | Shaka Player (DRM) | research | the hook, if `shaka` is a global | login and DRM walls |
| Vimeo | its own player (global `Vimeo`; control CSS is hashed and shown on hover) | emulator | none | needs a rule or a detector for Vimeo's player API |
| Dailymotion | its own player (`geo.dailymotion.com` iframe) | emulator | none | its menu did not open from synthetic or touch input in the frame |
| Twitch, Kick | own player, Amazon IVS likely | research, emulator | none | live pages only; no detector |
| BBC | its own EMP player | research | none | not inspected |
| TikTok, 9GAG, Imgur, Snapchat, Kuaishou, Weibo | a plain `<video>` with a file | emulator (TikTok), research | speed, seek, mute (no quality exists) | nothing to offer |
| Netflix, Disney+, Hulu, Max | in-house players (DRM) | research | none | app wall or login; Netflix and Max have no quality menu |
| Twitter/X, Instagram, Facebook, Threads, Pinterest | custom players | research, memory | speed, seek, mute | no quality menu on mobile web |
| Bilibili, Niconico, Douyin, VK, Viki, Crunchyroll, HIDIVE, MUBI, Nebula, Criterion, Tubi, Plex, Roku Channel | not determined | none | the browser's tracks | login, app or region walls; not reachable |

Rows marked "none" in the Options column are the work left. Each needs either a detector for a player API that is documented (THEOplayer, Vimeo's player API, Amazon IVS) or a `videoMenu` rule whose selectors were read from the live page; neither was written without that evidence.
