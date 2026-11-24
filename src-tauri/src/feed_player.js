(function () {
  'use strict';
  // Keeps the video in view playing in full-screen feeds (YouTube Shorts, Instagram and Facebook
  // Reels, TikTok). Mobile engines refuse a play() the page makes without a tap, sites give up
  // after one refusal, and a recycled feed element can miss its play call; each leaves a still
  // frame until the reader taps. This finds the video that fills the screen once scrolling
  // settles, plays it and stops the ones that scrolled out. When the engine refuses, iOS plays it
  // through a native call (which counts as a gesture) and every platform falls back to muted.
  // A video the reader paused with a tap or a key stays paused until it leaves the screen; a
  // swipe, or a pause the site makes itself, is never taken for the reader's.
  var KEY = Symbol.for('openmedia.feedPlayer');
  var NO_AUTOPLAY = Symbol.for('openmedia.noAutoplay');
  var PLAY_NOW = Symbol.for('openmedia.feedPlayNow');
  var IS_FEED = Symbol.for('openmedia.isFeed');
  var CURRENT = Symbol.for('openmedia.currentVideo');
  var USER_PAUSE = Symbol.for('openmedia.userPause');
  var FEED_PATHS = Symbol.for('openmedia.feedPaths');
  var FEED_PATH = /^\/(?:(?:[^/]+\/)?(?:shorts|reels?)|watch\/reels?|stories)(?:\/|$)/i;
  var TIKTOK = /(?:^|\.)tiktok\.com$/i;
  var INSTAGRAM = /(?:^|\.)instagram\.com$/i;
  var INSTAGRAM_POST = /^\/(?:p|tv)\//i;
  var FACEBOOK = /(?:^|\.)facebook\.com$/i;
  var FACEBOOK_WATCH = /^\/watch(?:\/|$)/i;
  var MAX_FEED_PATHS = 8; // path patterns a page's own script may add
  var SETTLE_MS = 120;
  var SAFETY_MS = 1200;
  var MIN_SHARE = 0.5; // of the viewport a video must cover to be "the" video
  var LETTERBOX_SHARE = 0.15; // a wide clip covers less, but it is the video if it is on screen
  var LETTERBOX_VISIBLE = 0.6; // of its own box, which then has to be on screen
  var GESTURE_MS = 900; // a pause this soon after a tap or key is the reader's
  var SETTLED_MS = 600; // a video must have played this long before a pause can be the reader's
  var TAP_SLOP = 10; // px a finger may move and still be a tap, not a swipe
  var ATTEMPT_GAP_MS = 300;
  var MAX_ATTEMPTS = 8;
  var SLOW_RETRY_MS = 5000; // once the attempts are spent, one more this often
  var WRAPPER_MAX = 1.5; // screens: a wrapper taller than this is a list, not one item
  var STALL_TICKS = 3; // settles with no progress before a "playing" video is kicked
  try {
    if (window.top !== window) return;
    if (typeof document[KEY] === 'function') document[KEY]();

    var videos = new Set();
    var userPaused = new WeakSet();
    var ownPauses = new WeakSet();
    var attempts = new WeakMap();
    var progress = new WeakMap();
    var playingSince = new WeakMap();
    var lastTap = 0;
    var touchStart = null;
    var timer = 0;
    var safety = 0;
    var current = null;
    var teardown = [];

    // Paths a script in a recipe adds with `document[Symbol.for('openmedia.feedPaths')] = ['^/clips/']`:
    // the way to tell the app that a page is a full-screen video feed it does not know. Each
    // entry is a case-insensitive pattern for the path.
    var customPatterns = new Map();

    function inCustomFeed(path) {
      var list = document[FEED_PATHS];
      if (!Array.isArray(list)) return false;
      for (var index = 0; index < list.length && index < MAX_FEED_PATHS; index += 1) {
        var source = list[index];
        if (typeof source !== 'string' || source.length > 200) continue;
        if (!customPatterns.has(source)) {
          var pattern = null;
          try { pattern = new RegExp(source, 'i'); } catch (_) {}
          customPatterns.set(source, pattern);
        }
        var compiled = customPatterns.get(source);
        if (compiled && compiled.test(path)) return true;
      }
      return false;
    }

    function inFeed() {
      var location = window.location;
      var path = location.pathname;
      var host = location.hostname;
      return FEED_PATH.test(path) ||
        TIKTOK.test(host) ||
        (INSTAGRAM.test(host) && INSTAGRAM_POST.test(path)) ||
        (FACEBOOK.test(host) && FACEBOOK_WATCH.test(path)) ||
        inCustomFeed(path);
    }

    // Which video is in view, for the video controls and for autoplay alike. Not while the app is
    // away (screen locked, or minimized: native code sets `__openmediaAway`), or a pause from the
    // lock screen or a system window would be undone at once. Not while the small
    // player is up: its video is not a feed item, and the feed's idea of what plays and what is
    // out of view is not for it.
    function tracking() {
      return inFeed() && !document.hidden && !window.__openmediaHold && !window.__openmediaAway &&
        !document.querySelector('[data-openmedia-mini]');
    }

    // A sheet or dialog over the feed (Instagram's share menu, say) makes the site pause the video
    // under it; restarting it here would start a play/pause fight with the site until the sheet
    // closes. The safety tick settles again once it is gone.
    function dialogOpen() {
      var dialogs = document.querySelectorAll('[role="dialog"],[aria-modal="true"],dialog[open]');
      for (var index = 0; index < dialogs.length; index += 1) {
        var dialog = dialogs[index];
        if (dialog.getAttribute('aria-hidden') === 'true') continue;
        var box = dialog.getBoundingClientRect();
        if (box.width > 0 && box.height > 0) return true;
      }
      return false;
    }

    // Calm mode (epilepsy protection) keeps the video in view known but never starts one.
    function active() {
      return tracking() && !document[NO_AUTOPLAY] && !dialogOpen();
    }

    // How much of the viewport a box covers, and how much of the box is on screen, both 0 to 1.
    function boxCover(box) {
      var height = window.innerHeight || document.documentElement.clientHeight;
      var width = window.innerWidth || document.documentElement.clientWidth;
      if (!box.width || !box.height || !height || !width) return { share: 0, own: 0 };
      var visibleHeight = Math.min(box.bottom, height) - Math.max(box.top, 0);
      var visibleWidth = Math.min(box.right, width) - Math.max(box.left, 0);
      if (visibleHeight <= 0 || visibleWidth <= 0) return { share: 0, own: 0 };
      var visible = visibleHeight * visibleWidth;
      return { share: visible / (height * width), own: visible / (box.width * box.height) };
    }

    // How much of the viewport this video covers. A feed can park a video that is not playing far
    // off screen (YouTube Shorts leaves it thousands of pixels up and left until it plays), so its box
    // says nothing: its own wrapper, when that is about screen sized, says where it belongs.
    function cover(video) {
      var covered = boxCover(video.getBoundingClientRect());
      if (covered.share > 0 || video.paused === false) return covered;
      var wrapper = video.parentElement;
      if (!wrapper) return covered;
      var box = wrapper.getBoundingClientRect();
      var height = window.innerHeight || document.documentElement.clientHeight;
      var width = window.innerWidth || document.documentElement.clientWidth;
      if (box.height > height * WRAPPER_MAX || box.width > width * WRAPPER_MAX) return covered;
      return boxCover(box.right <= 0 || box.left >= width ? shiftedOnScreen(box) : box);
    }

    // YouTube parks a paused video far to the left (-9999 px) as well as above the screen; its
    // wrapper keeps the place the video belongs in, so only the sideways park is undone.
    function shiftedOnScreen(box) {
      return { top: box.top, bottom: box.bottom, height: box.height, width: box.width, left: 0, right: box.width };
    }

    function share(video) {
      return cover(video).share;
    }

    // The video that counts as on screen: it fills the viewport, or it is a wide clip that sits
    // fully inside it.
    function onScreen(video) {
      var covered = cover(video);
      return covered.share >= MIN_SHARE ||
        (covered.share >= LETTERBOX_SHARE && covered.own >= LETTERBOX_VISIBLE);
    }

    function playing(video) {
      return !video.paused && !video.ended;
    }

    function stop(video) {
      ownPauses.add(video);
      try { video.pause(); } catch (_) { ownPauses.delete(video); }
    }

    function mutedPlay(video) {
      if (video !== current || video.muted) return;
      video.muted = true;
      try { video.play().catch(function () {}); } catch (_) {}
    }

    // iOS runs this from native code, which WebKit treats as a gesture, so even a refusal that
    // no page script can lift (low power mode, say) ends in a playing video with its sound.
    function askNative() {
      try {
        window.webkit.messageHandlers.openmediaPlay.postMessage(1);
        return true;
      } catch (_) {
        return false;
      }
    }

    function playNow() {
      var video = current;
      if (!video || video.ended || !video.paused) return;
      var request;
      try { request = video.play(); } catch (_) { return; }
      if (request && typeof request.catch === 'function') {
        request.catch(function () { mutedPlay(video); });
      }
    }

    function attempt(video) {
      var now = Date.now();
      var state = attempts.get(video);
      if (!state) { state = { count: 0, last: 0 }; attempts.set(video, state); }
      var wait = state.count >= MAX_ATTEMPTS ? SLOW_RETRY_MS : ATTEMPT_GAP_MS;
      if (now - state.last < wait) return;
      state.count += 1;
      state.last = now;
      var request;
      try { request = video.play(); } catch (_) { return; }
      if (!request || typeof request.catch !== 'function') return;
      request.catch(function (error) {
        // Sound needs a gesture when the engine says so, a muted video does not. Any other
        // refusal (a source swap aborting the call, say) is retried by the next settle. The
        // page's own mute button stays the reader's way to bring the sound back.
        if (!error || error.name !== 'NotAllowedError' || video !== current) return;
        // A muted video is refused too in low power mode: native play is the way out then.
        if (!askNative()) mutedPlay(video);
      });
    }

    // A video that says it is playing but does not move is a play() that never took hold (a
    // source swap swallowed it): stop it so the next attempt starts clean.
    function watchProgress(video) {
      var seen = progress.get(video);
      if (!seen || seen.time !== video.currentTime || video.seeking) {
        progress.set(video, { time: video.currentTime, ticks: 0 });
        return;
      }
      seen.ticks += 1;
      if (seen.ticks >= STALL_TICKS) {
        seen.ticks = 0;
        stop(video);
      }
    }

    function settle() {
      timer = 0;
      if (!tracking()) return;
      for (var video of Array.from(videos)) if (!video.isConnected) videos.delete(video);
      var best = null;
      var bestShare = 0;
      videos.forEach(function (candidate) {
        var covered = share(candidate);
        if (covered > bestShare && onScreen(candidate)) { best = candidate; bestShare = covered; }
      });
      if (best !== current) {
        if (current) userPaused.delete(current);
        current = best;
        if (current) attempts.delete(current);
      }
      videos.forEach(function (candidate) {
        if (candidate === current) return;
        if (playing(candidate) && share(candidate) < 0.1) stop(candidate);
      });
      if (!active() || !current || current.ended || userPaused.has(current)) return;
      if (current.paused) attempt(current);
      else watchProgress(current);
    }

    function schedule() {
      clearTimeout(timer);
      timer = setTimeout(settle, SETTLE_MS);
    }

    function track(video) {
      if (videos.has(video)) return;
      videos.add(video);
      schedule();
    }

    function scan(root) {
      if (root.nodeType !== 1) return;
      if (root.localName === 'video') track(root);
      else if (root.querySelectorAll) root.querySelectorAll('video').forEach(track);
    }

    function tapped() { lastTap = Date.now(); }

    function on(target, name, handler, options) {
      target.addEventListener(name, handler, options);
      teardown.push(function () { target.removeEventListener(name, handler, options); });
    }

    // Only a finger that stayed put is a tap. A swipe through the feed is not: the site pauses
    // the video it leaves, and that pause must not read as the reader's.
    on(document, 'touchstart', function (event) {
      var touch = event.touches && event.touches[0];
      touchStart = touch ? { x: touch.clientX, y: touch.clientY } : null;
    }, { capture: true, passive: true });
    on(document, 'touchend', function (event) {
      var touch = event.changedTouches && event.changedTouches[0];
      var still = !touchStart || !touch ||
        Math.hypot(touch.clientX - touchStart.x, touch.clientY - touchStart.y) <= TAP_SLOP;
      touchStart = null;
      if (still) tapped();
    }, { capture: true, passive: true });
    on(document, 'keydown', tapped, { capture: true, passive: true });
    on(document, 'click', tapped, { capture: true, passive: true });
    // Feeds scroll inside a container, so the scroll events do not bubble: capture them.
    on(document, 'scroll', schedule, { capture: true, passive: true });
    on(document, 'scrollend', schedule, { capture: true, passive: true });
    on(window, 'resize', schedule, { passive: true });
    on(window, 'pageshow', schedule);
    on(window, 'focus', schedule);
    on(document, 'visibilitychange', schedule);
    on(document, 'openmedia-resume', schedule);
    on(document, 'loadeddata', function (event) {
      if (event.target instanceof HTMLVideoElement) { track(event.target); schedule(); }
    }, true);
    // A site that reuses one element for every item gives it a new source: that is a new video,
    // with a fresh budget of attempts and no memory of the last one's pause.
    function fresh(event) {
      var video = event.target;
      if (!(video instanceof HTMLVideoElement)) return;
      track(video);
      attempts.delete(video);
      progress.delete(video);
      userPaused.delete(video);
      schedule();
    }
    on(document, 'loadstart', fresh, true);
    on(document, 'emptied', fresh, true);
    on(document, 'canplay', function (event) {
      if (event.target === current) schedule();
    }, true);
    on(document, 'play', function (event) {
      var video = event.target;
      if (!(video instanceof HTMLVideoElement)) return;
      track(video);
      userPaused.delete(video);
    }, true);
    // A site pauses and restarts its own video while it loads or after a tap on its tab bar; a
    // pause only counts as the reader's once the video has really been playing.
    on(document, 'playing', function (event) {
      if (event.target instanceof HTMLVideoElement) playingSince.set(event.target, Date.now());
    }, true);
    on(document, 'pause', function (event) {
      var video = event.target;
      if (!(video instanceof HTMLVideoElement)) return;
      if (ownPauses.has(video)) { ownPauses.delete(video); return; }
      if (window.__openmediaHold) return;
      var since = playingSince.get(video);
      playingSince.delete(video);
      var settled = since !== undefined && Date.now() - since >= SETTLED_MS;
      if (settled && Date.now() - lastTap < GESTURE_MS && onScreen(video)) userPaused.add(video);
      else if (video === current) schedule();
    }, true);

    // Outside a feed (Instagram's home feed, say) the page mutates constantly and nothing here
    // is needed: videos reach `track` through their own events, so a mutation costs nothing.
    var observer = new MutationObserver(function (records) {
      if (!inFeed()) return;
      for (var record of records) record.addedNodes.forEach(scan);
    });
    function start() {
      scan(document.documentElement);
      observer.observe(document.documentElement, { childList: true, subtree: true });
      schedule();
    }
    if (document.documentElement) start();
    else on(document, 'readystatechange', function again() {
      if (!document.documentElement) return;
      document.removeEventListener('readystatechange', again);
      start();
    });
    // A feed navigates without a page load and a site can swap a video's source in place; this
    // catches what no event announced.
    safety = setInterval(function () { if (inFeed()) { scan(document.documentElement); settle(); } }, SAFETY_MS);

    Object.defineProperty(document, PLAY_NOW, { configurable: true, value: playNow });
    Object.defineProperty(document, IS_FEED, { configurable: true, value: inFeed });
    // The video controls pause and play on the reader's behalf; the player must not undo that.
    Object.defineProperty(document, USER_PAUSE, {
      configurable: true,
      value: function (video, paused) {
        if (paused) userPaused.add(video);
        else userPaused.delete(video);
      }
    });
    Object.defineProperty(document, CURRENT, { configurable: true, get: function () { return current; } });
    Object.defineProperty(document, KEY, {
      configurable: true,
      value: function () {
        observer.disconnect();
        clearTimeout(timer);
        clearInterval(safety);
        teardown.forEach(function (step) { try { step(); } catch (_) {} });
        delete document[PLAY_NOW];
        delete document[IS_FEED];
        delete document[CURRENT];
        delete document[USER_PAUSE];
        delete document[KEY];
      }
    });
  } catch (_) {}
})();
