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
  var FEED_PATH = /^\/(?:(?:[^/]+\/)?(?:shorts|reels?)|watch\/reels?|stories)(?:\/|$)/i;
  var TIKTOK = /(?:^|\.)tiktok\.com$/i;
  var INSTAGRAM = /(?:^|\.)instagram\.com$/i;
  var INSTAGRAM_POST = /^\/(?:p|tv)\//i;
  var FACEBOOK = /(?:^|\.)facebook\.com$/i;
  var FACEBOOK_WATCH = /^\/watch(?:\/|$)/i;
  var SETTLE_MS = 120;
  var SAFETY_MS = 1200;
  var MIN_SHARE = 0.5; // of the viewport a video must cover to be "the" video
  var LETTERBOX_SHARE = 0.15; // a wide clip covers less, but it is the video if it is on screen
  var LETTERBOX_VISIBLE = 0.6; // of its own box, which then has to be on screen
  var GESTURE_MS = 900; // a pause this soon after a tap or key is the reader's
  var TAP_SLOP = 10; // px a finger may move and still be a tap, not a swipe
  var ATTEMPT_GAP_MS = 300;
  var MAX_ATTEMPTS = 8;
  var SLOW_RETRY_MS = 5000; // once the attempts are spent, one more this often
  var STALL_TICKS = 3; // settles with no progress before a "playing" video is kicked
  try {
    if (window.top !== window) return;
    if (typeof document[KEY] === 'function') document[KEY]();

    var videos = new Set();
    var userPaused = new WeakSet();
    var ownPauses = new WeakSet();
    var attempts = new WeakMap();
    var progress = new WeakMap();
    var lastTap = 0;
    var touchStart = null;
    var timer = 0;
    var safety = 0;
    var current = null;
    var teardown = [];

    function inFeed() {
      var location = window.location;
      var path = location.pathname;
      var host = location.hostname;
      return FEED_PATH.test(path) ||
        TIKTOK.test(host) ||
        (INSTAGRAM.test(host) && INSTAGRAM_POST.test(path)) ||
        (FACEBOOK.test(host) && FACEBOOK_WATCH.test(path));
    }

    function active() {
      return inFeed() && !document.hidden && !window.__openmediaHold && !document[NO_AUTOPLAY];
    }

    // How much of the viewport this element covers, and how much of the element is on screen,
    // both 0 to 1.
    function cover(video) {
      var box = video.getBoundingClientRect();
      var height = window.innerHeight || document.documentElement.clientHeight;
      var width = window.innerWidth || document.documentElement.clientWidth;
      if (!box.width || !box.height || !height || !width) return { share: 0, own: 0 };
      var visibleHeight = Math.min(box.bottom, height) - Math.max(box.top, 0);
      var visibleWidth = Math.min(box.right, width) - Math.max(box.left, 0);
      if (visibleHeight <= 0 || visibleWidth <= 0) return { share: 0, own: 0 };
      var visible = visibleHeight * visibleWidth;
      return { share: visible / (height * width), own: visible / (box.width * box.height) };
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
        if (!error || error.name !== 'NotAllowedError' || video.muted || video !== current) return;
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
      if (!active()) return;
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
      if (!current || current.ended || userPaused.has(current)) return;
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
    on(document, 'pause', function (event) {
      var video = event.target;
      if (!(video instanceof HTMLVideoElement)) return;
      if (ownPauses.has(video)) { ownPauses.delete(video); return; }
      if (window.__openmediaHold) return;
      if (Date.now() - lastTap < GESTURE_MS && onScreen(video)) userPaused.add(video);
      else if (video === current) schedule();
    }, true);

    var observer = new MutationObserver(function (records) {
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
    Object.defineProperty(document, KEY, {
      configurable: true,
      value: function () {
        observer.disconnect();
        clearTimeout(timer);
        clearInterval(safety);
        teardown.forEach(function (step) { try { step(); } catch (_) {} });
        delete document[PLAY_NOW];
        delete document[KEY];
      }
    });
  } catch (_) {}
})();
