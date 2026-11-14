(function (config) {
  'use strict';
  // Controls for the video in view in a full-screen feed (YouTube Shorts, Reels, TikTok, or any
  // page the feed player is told about): a seek bar with the time left, a speed button, the last
  // speed and sound remembered between videos, looping switched off, and, when the reader asked
  // for it, moving on to the next video when one ends. Each is a choice in Settings, off until
  // chosen. It runs in the top frame, after the feed player, whose idea of "a feed page" and of
  // "the video in view" it shares. It never clicks anything on the page: moving on scrolls.
  var KEY = Symbol.for('openmedia.videoControls');
  var IS_FEED = Symbol.for('openmedia.isFeed');
  var CURRENT = Symbol.for('openmedia.currentVideo');
  var NO_AUTOPLAY = Symbol.for('openmedia.noAutoplay');
  var STORE = 'openmedia.video';
  var RATES = [0.5, 1, 1.25, 1.5, 2];
  var TICK_MS = 100;
  var TAP_MS = 900; // a volume change this soon after a tap or key is the reader's
  var ADVANCE_GAP_MS = 1500;
  var WRAPPER_MAX = 1.5; // screens, as in the feed player
  var NEXT_GAP = 20; // px below the video in view that counts as the next one
  try {
    if (window.top !== window) return;
    if (typeof document[KEY] === 'function') document[KEY]();

    var wantsBar = !!config.seekBar;
    var wantsSpeed = !!config.speed;
    var wantsSound = !!config.remember;
    var wantsLoopOff = !!(config.loopOff || config.autoAdvance);
    var wantsAdvance = !!config.autoAdvance;

    var fresh = new WeakSet();
    var watched = new WeakSet();
    var observers = [];
    var teardown = [];
    var lastTap = 0;
    var lastAdvance = 0;
    var dragging = false;
    var ui = null;

    function read() {
      try { return JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch (_) { return {}; }
    }

    function write(patch) {
      try { localStorage.setItem(STORE, JSON.stringify(Object.assign(read(), patch))); } catch (_) {}
    }

    function onFeedPage() {
      var isFeed = document[IS_FEED];
      return typeof isFeed === 'function' && isFeed();
    }

    function active() {
      return onFeedPage() && !document.hidden && !window.__openmediaHold;
    }

    function current() {
      var video = document[CURRENT];
      return video && video.isConnected ? video : null;
    }

    // A video the site parks off screen while it is not playing is placed by its wrapper.
    function boxOf(video) {
      var height = window.innerHeight || document.documentElement.clientHeight;
      var box = video.getBoundingClientRect();
      if (box.bottom > 0 && box.top < height) return box;
      var wrapper = video.parentElement;
      if (!wrapper) return box;
      var outer = wrapper.getBoundingClientRect();
      return outer.height <= height * WRAPPER_MAX ? outer : box;
    }

    function prefer(video) {
      var saved = read();
      if (wantsSpeed && typeof saved.rate === 'number') {
        try {
          video.defaultPlaybackRate = saved.rate;
          video.playbackRate = saved.rate;
        } catch (_) {}
      }
      if (wantsSound && typeof saved.muted === 'boolean') {
        try {
          video.muted = saved.muted;
          if (typeof saved.volume === 'number') video.volume = saved.volume;
        } catch (_) {}
      }
    }

    function keepLooping(video) {
      if (!wantsLoopOff || watched.has(video)) return;
      watched.add(video);
      var observer = new MutationObserver(function () { if (video.loop) video.loop = false; });
      observer.observe(video, { attributes: true, attributeFilter: ['loop'] });
      observers.push(observer);
    }

    function prepare(video) {
      if (wantsLoopOff) {
        video.loop = false;
        keepLooping(video);
      }
    }

    function scrollParent(node) {
      for (var parent = node.parentElement; parent; parent = parent.parentElement) {
        var overflow = getComputedStyle(parent).overflowY;
        if ((overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay') &&
            parent.scrollHeight > parent.clientHeight + 1) return parent;
      }
      return null;
    }

    // Moves on by scrolling, as a swipe would: to the next video below this one, or one screen
    // down inside the feed's own scroller.
    function advance(video) {
      var now = Date.now();
      if (now - lastAdvance < ADVANCE_GAP_MS) return;
      lastAdvance = now;
      var top = boxOf(video).top;
      var next = null;
      var nextTop = Infinity;
      document.querySelectorAll('video').forEach(function (candidate) {
        if (candidate === video || !candidate.isConnected) return;
        var candidateTop = boxOf(candidate).top;
        if (candidateTop > top + NEXT_GAP && candidateTop < nextTop) {
          next = candidate;
          nextTop = candidateTop;
        }
      });
      if (next) {
        next.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      var scroller = scrollParent(video);
      var by = { top: window.innerHeight, behavior: 'smooth' };
      if (scroller) scroller.scrollBy(by);
      else window.scrollBy(by);
    }

    function clock(seconds) {
      var whole = Math.max(0, Math.round(seconds));
      var minutes = Math.floor(whole / 60);
      var rest = whole % 60;
      return minutes + ':' + (rest < 10 ? '0' : '') + rest;
    }

    function make(tag, css) {
      var element = document.createElement(tag);
      element.style.cssText = css;
      return element;
    }

    // The controls: one row (time left, speed) above one thin bar, fixed to the bottom of the
    // page. Everything is made here as plain elements and nothing is read back from the site.
    function build() {
      if (ui || (!wantsBar && !wantsSpeed)) return ui;
      var parent = document.body || document.documentElement;
      if (!parent) return null;
      var root = make('div',
        'position:fixed;left:0;right:0;bottom:0;z-index:2147483646;display:none;' +
        'pointer-events:none;font:600 13px/1 -apple-system,system-ui,sans-serif;color:#fff;' +
        'text-shadow:0 1px 3px rgba(0,0,0,.7);-webkit-user-select:none;user-select:none');
      root.setAttribute('data-openmedia-controls', '');
      var row = make('div',
        'display:flex;justify-content:space-between;align-items:center;padding:0 14px 2px');
      var left = make('span', 'min-width:48px');
      var pill = make('span',
        'pointer-events:auto;padding:7px 12px;border-radius:999px;background:rgba(0,0,0,.55);' +
        'touch-action:manipulation');
      var track = make('div',
        'pointer-events:auto;height:30px;display:flex;align-items:flex-end;touch-action:none;' +
        'padding:0 0 6px');
      var line = make('div', 'position:relative;width:100%;height:4px;background:rgba(255,255,255,.35)');
      var fill = make('div', 'position:absolute;left:0;top:0;bottom:0;width:0;background:#fff');
      var knob = make('div',
        'position:absolute;top:-4px;width:12px;height:12px;margin-left:-6px;border-radius:50%;' +
        'background:#fff;left:0');
      line.appendChild(fill);
      line.appendChild(knob);
      track.appendChild(line);
      if (wantsBar) row.appendChild(left);
      if (wantsSpeed) row.appendChild(pill);
      root.appendChild(row);
      if (wantsBar) root.appendChild(track);
      parent.appendChild(root);
      ui = { root: root, left: left, pill: pill, track: track, fill: fill, knob: knob, line: line };
      wire(ui);
      return ui;
    }

    function stop(event) {
      event.stopPropagation();
      if (event.cancelable) event.preventDefault();
    }

    function seekTo(event) {
      var video = current();
      if (!video || !isFinite(video.duration) || !video.duration) return;
      var box = ui.line.getBoundingClientRect();
      var ratio = Math.min(1, Math.max(0, (event.clientX - box.left) / (box.width || 1)));
      video.currentTime = ratio * video.duration;
      paint(video);
    }

    function wire(parts) {
      parts.track.addEventListener('pointerdown', function (event) {
        stop(event);
        dragging = true;
        try { parts.track.setPointerCapture(event.pointerId); } catch (_) {}
        seekTo(event);
      });
      parts.track.addEventListener('pointermove', function (event) {
        if (!dragging) return;
        stop(event);
        seekTo(event);
      });
      var release = function (event) {
        if (!dragging) return;
        stop(event);
        dragging = false;
      };
      parts.track.addEventListener('pointerup', release);
      parts.track.addEventListener('pointercancel', release);
      parts.pill.addEventListener('pointerdown', stop);
      parts.pill.addEventListener('pointerup', function (event) {
        stop(event);
        var video = current();
        var rate = video ? video.playbackRate : 1;
        var index = RATES.indexOf(rate);
        var next = RATES[(index + 1) % RATES.length];
        write({ rate: next });
        if (video) {
          video.defaultPlaybackRate = next;
          video.playbackRate = next;
        }
        paint(video);
      });
    }

    function paint(video) {
      if (!ui) return;
      var known = video && isFinite(video.duration) && video.duration > 0;
      var ratio = known ? Math.min(1, video.currentTime / video.duration) : 0;
      ui.fill.style.width = ratio * 100 + '%';
      ui.knob.style.left = ratio * 100 + '%';
      ui.left.textContent = known ? '-' + clock(video.duration - video.currentTime) : '';
      var rate = video ? video.playbackRate : 1;
      ui.pill.textContent = (Math.round(rate * 100) / 100) + '\u00d7';
    }

    function tick() {
      var showing = active();
      if (showing) {
        document.querySelectorAll('video').forEach(prepare);
      }
      var video = showing ? current() : null;
      if (!video) {
        if (ui) ui.root.style.display = 'none';
        return;
      }
      var parts = build();
      if (!parts) return;
      parts.root.style.display = 'block';
      if (!dragging) paint(video);
    }

    function tapped() { lastTap = Date.now(); }

    function on(target, name, handler, options) {
      target.addEventListener(name, handler, options);
      teardown.push(function () { target.removeEventListener(name, handler, options); });
    }

    on(document, 'touchend', tapped, { capture: true, passive: true });
    on(document, 'click', tapped, { capture: true, passive: true });
    on(document, 'keydown', tapped, { capture: true, passive: true });
    // A new source is a new video: it gets the remembered speed and sound, once it has started.
    on(document, 'loadstart', function (event) {
      var video = event.target;
      if (!(video instanceof HTMLVideoElement)) return;
      fresh.add(video);
      prefer(video);
      prepare(video);
    }, true);
    var applyOnStart = function (event) {
      var video = event.target;
      if (!(video instanceof HTMLVideoElement) || !fresh.has(video)) return;
      prefer(video);
      if (event.type === 'playing') fresh.delete(video);
    };
    on(document, 'loadedmetadata', applyOnStart, true);
    on(document, 'play', applyOnStart, true);
    on(document, 'playing', applyOnStart, true);
    on(document, 'volumechange', function (event) {
      var video = event.target;
      if (!wantsSound || !(video instanceof HTMLVideoElement)) return;
      if (!active() || Date.now() - lastTap > TAP_MS) return;
      write({ muted: video.muted, volume: video.volume });
    }, true);
    on(document, 'ended', function (event) {
      var video = event.target;
      if (!wantsAdvance || !(video instanceof HTMLVideoElement)) return;
      if (!active() || document[NO_AUTOPLAY] || video !== current()) return;
      advance(video);
    }, true);

    var timer = setInterval(tick, TICK_MS);
    tick();

    Object.defineProperty(document, KEY, {
      configurable: true,
      value: function () {
        clearInterval(timer);
        observers.forEach(function (observer) { observer.disconnect(); });
        teardown.forEach(function (step) { try { step(); } catch (_) {} });
        if (ui && ui.root.parentNode) ui.root.parentNode.removeChild(ui.root);
        delete document[KEY];
      }
    });
  } catch (_) {}
})
