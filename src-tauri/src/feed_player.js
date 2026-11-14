(function () {
  'use strict';
  // Keeps the video in view playing in full-screen feeds (YouTube Shorts, Instagram and Facebook
  // Reels, TikTok). Mobile engines refuse a play() the page makes without a tap, sites give up
  // after one refusal, and a recycled feed element can miss its play call; each leaves a still
  // frame until the reader taps. This finds the video that fills the screen once scrolling
  // settles, plays it (muted when the engine refuses sound) and stops the ones that scrolled out.
  // A video the reader paused stays paused until it leaves the screen.
  var KEY = Symbol.for('openmedia.feedPlayer');
  var NO_AUTOPLAY = Symbol.for('openmedia.noAutoplay');
  var FEED_PATH = /^\/(?:shorts|reels?|watch\/reels?|stories)(?:\/|$)/i;
  var FEED_HOST = /(?:^|\.)tiktok\.com$/i;
  var SETTLE_MS = 120;
  var SAFETY_MS = 1200;
  var MIN_SHARE = 0.5; // of the viewport a video must cover to be "the" video
  var GESTURE_MS = 900; // a pause this soon after a touch or key is the reader's
  var MAX_ATTEMPTS = 8;
  try {
    if (window.top !== window) return;
    if (typeof document[KEY] === 'function') document[KEY]();

    var videos = new Set();
    var userPaused = new WeakSet();
    var attempts = new WeakMap();
    var lastGesture = 0;
    var timer = 0;
    var safety = 0;
    var current = null;
    var teardown = [];

    function inFeed() {
      var location = window.location;
      return FEED_PATH.test(location.pathname) || FEED_HOST.test(location.hostname);
    }

    function active() {
      return inFeed() && !document.hidden && !window.__openmediaHold && !document[NO_AUTOPLAY];
    }

    // The share of the viewport this element covers, 0 to 1.
    function share(video) {
      var box = video.getBoundingClientRect();
      var height = window.innerHeight || document.documentElement.clientHeight;
      var width = window.innerWidth || document.documentElement.clientWidth;
      if (!box.width || !box.height || !height || !width) return 0;
      var visibleHeight = Math.min(box.bottom, height) - Math.max(box.top, 0);
      var visibleWidth = Math.min(box.right, width) - Math.max(box.left, 0);
      if (visibleHeight <= 0 || visibleWidth <= 0) return 0;
      return (visibleHeight * visibleWidth) / (height * width);
    }

    function playing(video) {
      return !video.paused && !video.ended;
    }

    function attempt(video) {
      var made = attempts.get(video) || 0;
      if (made >= MAX_ATTEMPTS) return;
      attempts.set(video, made + 1);
      var request;
      try { request = video.play(); } catch (_) { return; }
      if (!request || typeof request.catch !== 'function') return;
      request.catch(function (error) {
        // Sound needs a tap on a phone; a muted video does not. The page's own mute button stays
        // the reader's way to bring the sound back.
        if (!error || error.name !== 'NotAllowedError' || video.muted || video !== current) return;
        video.muted = true;
        try { video.play().catch(function () {}); } catch (_) {}
      });
    }

    function settle() {
      timer = 0;
      if (!active()) return;
      for (var video of Array.from(videos)) if (!video.isConnected) videos.delete(video);
      var best = null;
      var bestShare = 0;
      videos.forEach(function (candidate) {
        var covered = share(candidate);
        if (covered > bestShare) { best = candidate; bestShare = covered; }
      });
      if (!best || bestShare < MIN_SHARE) best = null;
      if (best !== current) {
        if (current) userPaused.delete(current);
        current = best;
        if (current) attempts.set(current, 0);
      }
      videos.forEach(function (candidate) {
        if (candidate === current) return;
        if (playing(candidate) && share(candidate) < 0.1) candidate.pause();
      });
      if (current && !current.ended && current.paused && !userPaused.has(current)) attempt(current);
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

    function gesture() { lastGesture = Date.now(); }

    function on(target, name, handler, options) {
      target.addEventListener(name, handler, options);
      teardown.push(function () { target.removeEventListener(name, handler, options); });
    }

    on(document, 'touchstart', gesture, { capture: true, passive: true });
    on(document, 'touchend', gesture, { capture: true, passive: true });
    on(document, 'keydown', gesture, { capture: true, passive: true });
    on(document, 'click', gesture, { capture: true, passive: true });
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
      if (!(video instanceof HTMLVideoElement) || window.__openmediaHold) return;
      if (Date.now() - lastGesture < GESTURE_MS && share(video) >= MIN_SHARE) userPaused.add(video);
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

    Object.defineProperty(document, KEY, {
      configurable: true,
      value: function () {
        observer.disconnect();
        clearTimeout(timer);
        clearInterval(safety);
        teardown.forEach(function (step) { try { step(); } catch (_) {} });
        delete document[KEY];
      }
    });
  } catch (_) {}
})();
