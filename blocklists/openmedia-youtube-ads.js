// Removes YouTube ads from the data the page is built from, so no ad is ever scheduled.
//
// Run as a filter-list scriptlet (`openmedia-youtube-ads`, see openmedia-specific.txt) in the
// page's main world at document start, on youtube.com hosts only.
//
// Why data and not network rules: ad media come from the same googlevideo.com hosts as the video.
// Blocking that request leaves the player holding an ad it can never play, which is the black
// screen. The ad exists only because the player response lists it (`adPlacements`, `playerAds`,
// `adSlots`), so the list is removed before the player reads it. The same is done to feed,
// search and Shorts responses, where ads are extra items among the real ones.
//
// A player watchdog covers what data cannot: an ad stitched into the video stream itself.
// It never clicks anything. It mutes the ad, jumps to its end and, if the ad is stuck, reloads
// the same video once, which now fetches a pruned player response.
(function () {
  "use strict";
  const GUARD = "__openmediaYoutubeAds";
  if (window[GUARD]) return;
  Object.defineProperty(window, GUARD, { value: true });

  // Keys that list ads on a player response, at any depth.
  const DROP_KEYS = ["adPlacements", "playerAds", "adSlots"];
  // List items that are ads. They arrive as feed, search and watch-next items.
  const AD_RENDERERS = new Set([
    "adSlotRenderer",
    "inFeedAdLayoutRenderer",
    "displayAdRenderer",
    "promotedSparklesWebRenderer",
    "promotedSparklesTextSearchRenderer",
    "promotedVideoRenderer",
    "compactPromotedVideoRenderer",
    "searchPyvRenderer",
    "videoMastheadAdV3Renderer",
    "brandVideoSingletonRenderer",
    "brandVideoShelfRenderer",
  ]);
  // Wrappers an ad renderer hides in (a feed tile holds its ad in `content`).
  const WRAPPERS = new Set(["richItemRenderer", "richSectionRenderer", "content"]);
  // Cheap test on response text, so ordinary responses are never parsed.
  const MARKER =
    /adPlacements|playerAds|adSlots|adSlotRenderer|inFeedAdLayoutRenderer|displayAdRenderer|promotedSparkles|promotedVideoRenderer|compactPromotedVideoRenderer|searchPyvRenderer|videoMastheadAdV3Renderer|brandVideo(?:Singleton|Shelf)Renderer|"isAd"/;
  const API = /\/youtubei\/v1\//;

  const nativeParse = JSON.parse;
  const nativeStringify = JSON.stringify;

  function isAd(item, depth) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    for (const key of Object.keys(item)) {
      if (AD_RENDERERS.has(key)) return true;
    }
    // A Short that is an ad: entries[].command.reelWatchEndpoint.adClientParams.isAd
    const params = item.command?.reelWatchEndpoint?.adClientParams;
    if (params && params.isAd === true) return true;
    if (depth >= 2) return false;
    for (const key of WRAPPERS) {
      if (isAd(item[key], depth + 1)) return true;
    }
    return false;
  }

  // Removes ads from `node` in place. True when something was removed.
  function prune(node, depth = 0) {
    if (!node || typeof node !== "object" || depth > 60) return false;
    let changed = false;
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) {
        if (isAd(node[i], 0)) {
          node.splice(i, 1);
          changed = true;
        } else if (prune(node[i], depth + 1)) {
          changed = true;
        }
      }
      return changed;
    }
    for (const key of DROP_KEYS) {
      if (Object.prototype.hasOwnProperty.call(node, key)) {
        delete node[key];
        changed = true;
      }
    }
    for (const key of Object.keys(node)) {
      if (prune(node[key], depth + 1)) changed = true;
    }
    return changed;
  }

  // Text of a response with its ads removed, or null when it has none.
  function prunedText(text) {
    if (typeof text !== "string" || !MARKER.test(text)) return null;
    const data = nativeParse(text);
    return prune(data) ? nativeStringify(data) : null;
  }

  // 1. JSON.parse: inline page data and anything the player parses itself.
  JSON.parse = new Proxy(nativeParse, {
    apply(target, thisArg, args) {
      const result = Reflect.apply(target, thisArg, args);
      try {
        if (typeof args[0] === "string" && MARKER.test(args[0])) prune(result);
      } catch (_) {}
      return result;
    },
  });

  // 2. The objects the page assigns to globals before any script of ours could see them.
  for (const name of ["ytInitialPlayerResponse", "ytInitialData"]) {
    const existing = Object.getOwnPropertyDescriptor(window, name);
    if (existing && !existing.configurable) continue;
    let value = existing && "value" in existing ? existing.value : undefined;
    try {
      prune(value);
    } catch (_) {}
    Object.defineProperty(window, name, {
      configurable: true,
      enumerable: true,
      get() {
        return value;
      },
      set(next) {
        try {
          prune(next);
        } catch (_) {}
        value = next;
      },
    });
  }

  // 3. fetch: the player, watch-next, feed, search and Shorts requests.
  const nativeFetch = window.fetch;
  if (typeof nativeFetch === "function") {
    window.fetch = function (input) {
      const pending = nativeFetch.apply(this, arguments);
      let url = "";
      try {
        url = typeof input === "string" ? input : String((input && input.url) || input);
      } catch (_) {}
      if (!API.test(url)) return pending;
      return pending.then(async (response) => {
        try {
          const text = await response.clone().text();
          const pruned = prunedText(text);
          if (pruned === null) return response;
          const replaced = new Response(pruned, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
          Object.defineProperty(replaced, "url", { value: response.url });
          return replaced;
        } catch (_) {
          return response;
        }
      });
    };
  }

  // 4. XMLHttpRequest: the same requests, for the code paths that still use it.
  const xhr = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (xhr) {
    const targets = new WeakSet();
    const cache = new WeakMap();
    const nativeOpen = xhr.open;
    xhr.open = function (method, url) {
      try {
        if (API.test(String(url))) targets.add(this);
      } catch (_) {}
      return nativeOpen.apply(this, arguments);
    };
    for (const prop of ["response", "responseText"]) {
      const descriptor = Object.getOwnPropertyDescriptor(xhr, prop);
      if (!descriptor || !descriptor.get) continue;
      Object.defineProperty(xhr, prop, {
        configurable: true,
        enumerable: descriptor.enumerable,
        get() {
          const value = descriptor.get.call(this);
          if (this.readyState !== 4 || !targets.has(this)) return value;
          try {
            if (typeof value === "string") {
              const seen = cache.get(this);
              if (seen && seen.source === value) return seen.output;
              const pruned = prunedText(value);
              const output = pruned === null ? value : pruned;
              cache.set(this, { source: value, output });
              return output;
            }
            if (value && typeof value === "object") prune(value);
          } catch (_) {}
          return value;
        },
      });
    }
  }

  // 5. Watchdog for an ad that is already in the stream.
  const PLAYER = ".html5-video-player";
  const AD_STATE = ".ad-showing, .ad-interrupting";
  let mutedByUs = false;
  let stuckTicks = 0;
  let reloaded = false;
  let lastContentTime = 0;

  function watch() {
    const player = document.querySelector(PLAYER);
    if (!player) return;
    const video = player.querySelector("video");
    if (!player.matches(AD_STATE)) {
      if (video) {
        if (mutedByUs) {
          video.muted = false;
          mutedByUs = false;
        }
        if (video.currentTime > 0) lastContentTime = video.currentTime;
      }
      stuckTicks = 0;
      reloaded = false;
      return;
    }
    stuckTicks += 1;
    if (video) {
      if (!video.muted) {
        video.muted = true;
        mutedByUs = true;
      }
      if (Number.isFinite(video.duration) && video.duration > 0) {
        video.currentTime = video.duration;
      }
    }
    // About 3 s of ad with nothing to skip: the ad stream is unavailable, so ask for the video
    // again. The new player response comes through `fetch` above, without the ad.
    if (stuckTicks >= 6 && !reloaded) {
      reloaded = true;
      try {
        const id = player.getVideoData && player.getVideoData().video_id;
        if (id && player.loadVideoById) {
          player.loadVideoById({ videoId: id, startSeconds: lastContentTime });
        }
      } catch (_) {}
    }
  }
  setInterval(watch, 500);
})();
