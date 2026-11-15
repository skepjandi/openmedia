(function (config) {
  'use strict';
  // OpenMedia's controls for the video in view in a full-screen feed (YouTube Shorts, Reels,
  // TikTok, or any page the feed player is told about) and, when the reader asked for it, for the
  // video of a page that is about one video (a watch page), whose own controls are left alone
  // otherwise. They stay hidden; a tap on the video shows a panel in place of the
  // site's own tap: pause, back and forward 6 seconds, mute, speed, and a seek bar with the time
  // left. The reader can switch the panel off, or move it, for the whole app or for one site; with
  // it off nothing here touches the page's own controls. Around it: the last speed and sound
  // remembered between videos, looping switched off, and, when asked for, moving on to the next
  // video when one ends. It runs in the top frame, after the feed player, whose idea of "a feed
  // page" and of "the video in view" it shares. It never clicks anything on the page: moving on
  // scrolls.
  var KEY = Symbol.for('openmedia.videoControls');
  var IS_FEED = Symbol.for('openmedia.isFeed');
  var CURRENT = Symbol.for('openmedia.currentVideo');
  var NO_AUTOPLAY = Symbol.for('openmedia.noAutoplay');
  var USER_PAUSE = Symbol.for('openmedia.userPause');
  var STORE = 'openmedia.video';
  var RATES = [0.5, 1, 1.25, 1.5, 2];
  var TICK_MS = 100;
  var TAP_MS = 900; // a volume change this soon after a tap or key is the reader's
  var ADVANCE_GAP_MS = 1500;
  var WRAPPER_MAX = 1.5; // screens, as in the feed player
  var NEXT_GAP = 20; // px below the video in view that counts as the next one
  var DEFAULT_HEIGHT = 16; // px between the panel and the bottom edge, on top of the safe area
  var SKIP_SECONDS = 6;
  var WATCH_PATH = /^\/(?:watch|video|videos|embed|clip|clips|movie|movies)(?:\/|$)/i;
  var MIN_VIDEO_SHARE = 0.15; // of the viewport, for the video of a page that is not a feed
  var TAP_SLOP = 10; // px a finger may move and still be a tap
  var TAP_MAX_MS = 500;
  var CLICK_AFTER_TOUCH_MS = 700; // the click a tapped touch would make is swallowed this long
  var HIDE_MS = 3500; // the panel goes away this long after the last touch on it
  var SVG = 'http://www.w3.org/2000/svg';
  var INTERACTIVE = 'a,button,input,textarea,select,summary,[role="button"],[role="link"],' +
    '[role="slider"],[role="menuitem"],[role="tab"],[role="switch"],[contenteditable="true"]';
  try {
    if (window.top !== window) return;
    if (typeof document[KEY] === 'function') document[KEY]();

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
    var shown = false;
    var hideTimer = 0;
    var lastVideo = null;
    var touchFrom = null;
    var touchTarget = null;
    var touchTapAt = 0;
    var pointerFrom = null;
    var mutedAtDown = null;
    var pointerTapAt = 0;

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

    // A page that is about one video: it says so (og:type video.*) or its path does.
    function watchPage() {
      try {
        var meta = document.querySelector && document.querySelector('meta[property="og:type"]');
        var type = meta && meta.getAttribute && meta.getAttribute('content');
        if (type && /^video/i.test(type)) return true;
      } catch (_) {}
      return !!(window.location && WATCH_PATH.test(window.location.pathname || ''));
    }

    // Where the panel may show: a feed, or a page about one video.
    function panelPage() {
      return !document.hidden && !window.__openmediaHold && (onFeedPage() || (fullVideosOn() && watchPage()));
    }

    // The video the panel works on: the feed player's in a feed, else the biggest one on screen.
    function focus() {
      if (onFeedPage()) return current();
      var height = window.innerHeight || document.documentElement.clientHeight;
      var width = window.innerWidth || document.documentElement.clientWidth;
      var best = null;
      var bestArea = 0;
      document.querySelectorAll('video').forEach(function (video) {
        if (!video.isConnected) return;
        var box = video.getBoundingClientRect();
        var seen = (Math.min(box.bottom, height) - Math.max(box.top, 0)) *
          (Math.min(box.right, width) - Math.max(box.left, 0));
        if (seen > bestArea && seen >= MIN_VIDEO_SHARE * width * height) {
          best = video;
          bestArea = seen;
        }
      });
      return best;
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

    // What the reader chose last, put on a new video, only where these controls are in charge: a
    // watch page that keeps its own player (and its own idea of speed) is left as it is.
    function prefer(video) {
      if (!panelPage()) return;
      var saved = read();
      if (panelOn() && typeof saved.rate === 'number') {
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

    // What the reader chose for this site, if anything: the entry for the longest registrable
    // domain the page's host belongs to.
    function siteChoice() {
      var host = ((window.location && window.location.hostname) || '').toLowerCase();
      var sites = config.sites || {};
      var best = null;
      var length = -1;
      Object.keys(sites).forEach(function (key) {
        var inside = host === key || host.slice(-key.length - 1) === '.' + key;
        if (inside && key.length > length) { best = sites[key]; length = key.length; }
      });
      return best || {};
    }

    function panelOn() {
      var site = siteChoice();
      return typeof site.panel === 'boolean' ? site.panel : !!config.panel;
    }

    // The panel on a watch page too, in place of the site's own player controls: only when asked.
    function fullVideosOn() {
      var site = siteChoice();
      return typeof site.fullVideos === 'boolean' ? site.fullVideos : !!config.fullVideos;
    }

    function panelHeight() {
      var site = siteChoice();
      var height = typeof site.height === 'number' ? site.height : config.height;
      return typeof height === 'number' ? height : DEFAULT_HEIGHT;
    }

    function make(tag, css) {
      var element = document.createElement(tag);
      element.style.cssText = css;
      return element;
    }

    function icon(paths, extra) {
      var svg = document.createElementNS(SVG, 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('width', '100%');
      svg.setAttribute('height', '100%');
      svg.setAttribute('fill', 'currentColor');
      paths.forEach(function (definition) {
        var path = document.createElementNS(SVG, 'path');
        path.setAttribute('d', definition);
        svg.appendChild(path);
      });
      if (extra) svg.appendChild(extra);
      return svg;
    }

    function digit(text) {
      var label = document.createElementNS(SVG, 'text');
      label.setAttribute('x', '12');
      label.setAttribute('y', '15.2');
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('font-size', '7');
      label.setAttribute('font-weight', '700');
      label.textContent = text;
      return label;
    }

    var ICONS = {
      play: ['M8 5v14l11-7z'],
      pause: ['M6 5h4v14H6z', 'M14 5h4v14h-4z'],
      back: ['M12 5V1L7 6l5 5V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z'],
      forward: ['M12 5V1l5 5-5 5V7a6 6 0 1 0 6 6h2a8 8 0 1 1-8-8z'],
      sound: ['M3 9v6h4l5 5V4L7 9H3z', 'M14 8.5a4.5 4.5 0 0 1 0 7z'],
      muted: ['M3 9v6h4l5 5V4L7 9H3z', 'M14.5 9.4l1.4-1.4 2.1 2.1 2.1-2.1 1.4 1.4-2.1 2.1 2.1 2.1-1.4 1.4-2.1-2.1-2.1 2.1-1.4-1.4 2.1-2.1z']
    };

    function setIcon(button, name) {
      if (button.__icon === name) return;
      button.__icon = name;
      button.textContent = '';
      var extra = name === 'back' || name === 'forward' ? digit(String(SKIP_SECONDS)) : null;
      button.appendChild(icon(ICONS[name], extra));
    }

    function button(size, name, action) {
      var element = make('div',
        'pointer-events:auto;display:flex;align-items:center;justify-content:center;' +
        'width:' + size + 'px;height:' + size + 'px;color:#fff;border-radius:50%;' +
        'touch-action:manipulation;cursor:pointer');
      setIcon(element, name);
      element.addEventListener('pointerdown', stop);
      element.addEventListener('pointerup', function (event) {
        stop(event);
        var video = focus();
        lastTap = Date.now();
        if (video) action(video);
        keepAlive();
        paint(focus());
      });
      return element;
    }

    // A thin bar the reader drags along; `onRatio` gets where on it the finger is, 0 to 1.
    function slider(height, onRatio) {
      var track = make('div',
        'pointer-events:auto;height:' + height + 'px;display:flex;align-items:center;' +
        'touch-action:none;cursor:pointer');
      var line = make('div', 'position:relative;width:100%;height:4px;background:rgba(255,255,255,.35)');
      var fill = make('div', 'position:absolute;left:0;top:0;bottom:0;width:0;background:#fff');
      var knob = make('div',
        'position:absolute;top:-4px;width:12px;height:12px;margin-left:-6px;border-radius:50%;' +
        'background:#fff;left:0');
      line.appendChild(fill);
      line.appendChild(knob);
      track.appendChild(line);
      var drag = false;
      function at(event) {
        var box = line.getBoundingClientRect();
        onRatio(Math.min(1, Math.max(0, (event.clientX - box.left) / (box.width || 1))));
      }
      track.addEventListener('pointerdown', function (event) {
        stop(event);
        drag = true;
        dragging = true;
        try { track.setPointerCapture(event.pointerId); } catch (_) {}
        at(event);
        keepAlive();
      });
      track.addEventListener('pointermove', function (event) {
        if (!drag) return;
        stop(event);
        at(event);
        keepAlive();
      });
      var release = function (event) {
        if (!drag) return;
        stop(event);
        drag = false;
        dragging = false;
      };
      track.addEventListener('pointerup', release);
      track.addEventListener('pointercancel', release);
      return {
        track: track,
        line: line,
        set: function (ratio) {
          fill.style.width = ratio * 100 + '%';
          knob.style.left = ratio * 100 + '%';
        }
      };
    }

    // The panel: three buttons above a row (mute, time left, speed) above the seek bar,
    // fixed above the bottom edge. Everything is made here as plain elements and nothing is read
    // back from the site.
    function build() {
      if (ui) return ui;
      var parent = document.body || document.documentElement;
      if (!parent) return null;
      var root = make('div',
        'position:fixed;left:0;right:0;z-index:2147483646;display:none;pointer-events:none;' +
        'font:600 13px/1 -apple-system,system-ui,sans-serif;color:#fff;' +
        '-webkit-user-select:none;user-select:none');
      root.setAttribute('data-openmedia-controls', '');
      var card = make('div',
        'pointer-events:auto;margin:0 12px;padding:10px 14px 2px;border-radius:18px;background:rgba(0,0,0,.62);' +
        '-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px)');
      var transport = make('div',
        'display:flex;align-items:center;justify-content:center;gap:30px;padding-bottom:6px');
      var back = button(40, 'back', function (target) {
        target.currentTime = Math.max(0, target.currentTime - SKIP_SECONDS);
      });
      var toggle = button(56, 'pause', function (target) {
        var feed = document[USER_PAUSE];
        if (target.paused) {
          if (typeof feed === 'function') feed(target, false);
          try { target.play().catch(function () {}); } catch (_) {}
        } else {
          if (typeof feed === 'function') feed(target, true);
          target.pause();
        }
      });
      toggle.style.background = 'rgba(255,255,255,.18)';
      var forward = button(40, 'forward', function (target) {
        var end = isFinite(target.duration) && target.duration > 0 ? target.duration : Infinity;
        target.currentTime = Math.min(end, target.currentTime + SKIP_SECONDS);
      });
      transport.appendChild(back);
      transport.appendChild(toggle);
      transport.appendChild(forward);
      var row = make('div', 'display:flex;align-items:center;gap:10px;padding:2px 0');
      var mute = button(32, 'sound', function (target) {
        target.muted = !target.muted;
        if (!target.muted && target.volume === 0) target.volume = 1;
      });
      var left = make('span', 'margin-left:auto;min-width:48px;text-align:right');
      var pill = make('span',
        'pointer-events:auto;padding:7px 12px;border-radius:999px;background:rgba(255,255,255,.18);' +
        'touch-action:manipulation;cursor:pointer');
      pill.addEventListener('pointerdown', stop);
      pill.addEventListener('pointerup', function (event) {
        stop(event);
        var target = focus();
        var rate = target ? target.playbackRate : 1;
        var next = RATES[(RATES.indexOf(rate) + 1) % RATES.length];
        write({ rate: next });
        if (target) {
          target.defaultPlaybackRate = next;
          target.playbackRate = next;
        }
        keepAlive();
        paint(target);
      });
      row.appendChild(mute);
      row.appendChild(left);
      row.appendChild(pill);
      var seek = slider(30, function (ratio) {
        var target = focus();
        if (!target || !isFinite(target.duration) || !target.duration) return;
        target.currentTime = ratio * target.duration;
        paint(target);
      });
      card.appendChild(transport);
      card.appendChild(row);
      card.appendChild(seek.track);
      root.appendChild(card);
      ['click', 'touchstart', 'touchmove', 'touchend'].forEach(function (name) {
        root.addEventListener(name, function (event) { event.stopPropagation(); });
      });
      parent.appendChild(root);
      ui = {
        root: root, toggle: toggle, mute: mute, left: left, pill: pill, seek: seek
      };
      return ui;
    }

    function stop(event) {
      event.stopPropagation();
      if (event.cancelable) event.preventDefault();
    }

    function paint(video) {
      if (!ui || !video) return;
      var known = isFinite(video.duration) && video.duration > 0;
      if (!dragging) ui.seek.set(known ? Math.min(1, video.currentTime / video.duration) : 0);
      ui.left.textContent = known ? '-' + clock(video.duration - video.currentTime) : '';
      var rate = video.playbackRate || 1;
      ui.pill.textContent = (Math.round(rate * 100) / 100) + '\u00d7';
      setIcon(ui.toggle, video.paused ? 'play' : 'pause');
      setIcon(ui.mute, video.muted || video.volume === 0 ? 'muted' : 'sound');
    }

    function hide() {
      shown = false;
      clearTimeout(hideTimer);
      if (ui) ui.root.style.display = 'none';
    }

    // The panel goes away a few seconds after the last touch on it, but not off a paused video:
    // there it is the way to start it again.
    function keepAlive() {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(function () {
        var video = focus();
        if (video && video.paused) keepAlive();
        else hide();
      }, HIDE_MS);
    }

    function tick() {
      if (active()) {
        document.querySelectorAll('video').forEach(prepare);
      }
      var video = shown && panelPage() && panelOn() ? focus() : null;
      if (video !== lastVideo) {
        lastVideo = video;
        if (shown) hide();
      }
      if (!video || !shown) {
        if (ui) ui.root.style.display = 'none';
        return;
      }
      var parts = build();
      if (!parts) return;
      parts.root.style.bottom = 'calc(env(safe-area-inset-bottom,0px) + ' + panelHeight() + 'px)';
      parts.root.style.display = 'block';
      paint(video);
    }

    // A tap on the video, anywhere the site has not put a button of its own, shows or hides the
    // panel and is kept from the site, whose own tap (pause, mute) the panel replaces. A swipe is
    // not a tap and reaches the site untouched. Some players end a touch themselves and cancel the
    // click that follows it, so a tap is found from the touch, and the click it would have made
    // is swallowed.
    // Whether the tap landed on a button of the site's own. A player that puts one transparent
    // button over the whole video to catch taps (Instagram does) is not one: the element has to be
    // small next to the video.
    function onSiteButton(hit, video) {
      var button = hit && hit.closest && hit.closest(INTERACTIVE);
      if (!button) return false;
      if (!button.getBoundingClientRect) return true;
      var own = button.getBoundingClientRect();
      var box = boxOf(video);
      var wide = Math.min(own.right, box.right) - Math.max(own.left, box.left);
      var tall = Math.min(own.bottom, box.bottom) - Math.max(own.top, box.top);
      var area = (box.right - box.left) * (box.bottom - box.top);
      return !(area > 0 && wide > 0 && tall > 0 && (wide * tall) / area >= 0.5);
    }

    // The video a press at this point is on, when the panel is in charge of it: not on the panel,
    // not on a button of the site's own, inside the video.
    function videoAt(x, y, hit) {
      if (!panelPage() || !panelOn()) return null;
      if (inPanel(hit)) return null;
      var video = focus();
      if (!video) return null;
      if (onSiteButton(hit, video)) return null;
      var box = boxOf(video);
      if (!(x >= box.left && x <= box.right && y >= box.top && y <= box.bottom)) return null;
      return video;
    }

    function tapAt(x, y, hit, event) {
      var video = videoAt(x, y, hit);
      if (!video) return false;
      event.stopImmediatePropagation();
      if (event.cancelable) event.preventDefault();
      restoreMute();
      if (shown) {
        hide();
        return true;
      }
      lastVideo = video;
      shown = true;
      keepAlive();
      tick();
      return true;
    }

    // A tap on the video is the panel's and never mutes or unmutes: players that do so on the
    // press (Instagram's Reels) have it undone, now and once more after they have acted.
    function noteMute(fresh) {
      var now = Date.now();
      if (!fresh && mutedAtDown && now - mutedAtDown.at < 300) return;
      var video = panelPage() && panelOn() ? focus() : null;
      mutedAtDown = video ? { video: video, muted: video.muted, at: now } : null;
    }

    function restoreMute() {
      var kept = mutedAtDown;
      if (!kept) return;
      var undo = function () {
        try { if (kept.video.muted !== kept.muted) kept.video.muted = kept.muted; } catch (_) {}
      };
      undo();
      setTimeout(undo, 80);
      setTimeout(undo, 400);
    }

    function inPanel(hit) {
      return !!(hit && hit.closest && hit.closest('[data-openmedia-controls]'));
    }

    // A touch on the panel is the panel's alone: the site's own handlers, which may work out what
    // was tapped from where the finger is, never see it. The panel's buttons listen to pointer
    // events, which this leaves alone.
    function keepFromSite(event) {
      if (!inPanel(event.target)) return false;
      event.stopImmediatePropagation();
      if (event.type !== 'touchstart' && event.type !== 'touchmove' && event.cancelable) {
        event.preventDefault();
      }
      return true;
    }

    // The site saw the touch begin and is not allowed to see it end, so it is told it was
    // cancelled: a player waits on that to drop its hold timer, or a press that stays down opens
    // its long-press menu (a sheet on Shorts, hold for 2x on a watch page) under the panel.
    function cancelForSite(event) {
      try {
        var at = touchTarget;
        if (typeof TouchEvent !== 'function' || !at || !at.dispatchEvent) return;
        at.dispatchEvent(new TouchEvent('touchcancel', {
          bubbles: true,
          touches: [],
          targetTouches: [],
          changedTouches: Array.prototype.slice.call(event.changedTouches || [])
        }));
      } catch (_) {}
    }

    // Players that act on the pointer (Instagram mutes on the pointer's release) see it before the
    // touch ends, so a tap is also found from the pointer, which is cancelled for the site the
    // same way, and the touch and click that follow are then only swallowed.
    function onPointerDown(event) {
      pointerFrom = null;
      if (event.isPrimary === false || inPanel(event.target)) return;
      noteMute(true);
      // A press on the video is not shown to the site: players that toggle the sound on it
      // (Instagram's Reels, with an icon that pops in) would do so before the tap is known. A
      // touch that turns out to be a swipe reaches the page through its own touch events.
      if (videoAt(event.clientX, event.clientY, event.target)) event.stopImmediatePropagation();
      pointerFrom = { x: event.clientX, y: event.clientY, time: Date.now(), target: event.target };
    }

    function onPointerUp(event) {
      var from = pointerFrom;
      pointerFrom = null;
      if (!from || inPanel(event.target) || Date.now() - from.time > TAP_MAX_MS) return;
      if (Math.hypot(event.clientX - from.x, event.clientY - from.y) > TAP_SLOP) return;
      if (!tapAt(event.clientX, event.clientY, event.target, event)) return;
      pointerTapAt = Date.now();
      try {
        if (typeof PointerEvent === 'function' && from.target && from.target.dispatchEvent) {
          from.target.dispatchEvent(new PointerEvent('pointercancel', {
            bubbles: true,
            pointerId: event.pointerId,
            pointerType: event.pointerType,
            isPrimary: true
          }));
        }
      } catch (_) {}
    }

    function onTouchStart(event) {
      touchFrom = null;
      touchTarget = null;
      if (keepFromSite(event)) return;
      touchTarget = event.target;
      noteMute(false);
      var first = event.touches && event.touches.length === 1 ? event.touches[0] : null;
      touchFrom = first ? { x: first.clientX, y: first.clientY, time: Date.now() } : null;
    }

    function onTouchEnd(event) {
      var from = touchFrom;
      touchFrom = null;
      if (keepFromSite(event)) return;
      if (Date.now() - pointerTapAt < CLICK_AFTER_TOUCH_MS) {
        touchTapAt = Date.now();
        event.stopImmediatePropagation();
        if (event.cancelable) event.preventDefault();
        cancelForSite(event);
        return;
      }
      var last = event.changedTouches && event.changedTouches[0];
      if (!from || !last || Date.now() - from.time > TAP_MAX_MS) return;
      if (Math.hypot(last.clientX - from.x, last.clientY - from.y) > TAP_SLOP) return;
      if (tapAt(last.clientX, last.clientY, event.target, event)) {
        touchTapAt = Date.now();
        cancelForSite(event);
      }
    }

    function onClick(event) {
      if (inPanel(event.target)) {
        event.stopImmediatePropagation();
        return;
      }
      if (Date.now() - touchTapAt < CLICK_AFTER_TOUCH_MS || Date.now() - pointerTapAt < CLICK_AFTER_TOUCH_MS) {
        event.stopImmediatePropagation();
        if (event.cancelable) event.preventDefault();
        return;
      }
      tapAt(event.clientX, event.clientY, event.target, event);
    }

    function tapped() { lastTap = Date.now(); }

    function on(target, name, handler, options) {
      target.addEventListener(name, handler, options);
      teardown.push(function () { target.removeEventListener(name, handler, options); });
    }

    on(document, 'touchend', tapped, { capture: true, passive: true });
    on(document, 'click', tapped, { capture: true, passive: true });
    on(window, 'pointerdown', onPointerDown, { capture: true, passive: true });
    on(window, 'pointerup', onPointerUp, { capture: true });
    on(window, 'touchstart', onTouchStart, { capture: true, passive: true });
    on(window, 'touchmove', keepFromSite, { capture: true, passive: true });
    on(window, 'touchend', onTouchEnd, { capture: true });
    on(window, 'click', onClick, { capture: true });
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
      if (!panelPage() || Date.now() - lastTap > TAP_MS) return;
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
        clearTimeout(hideTimer);
        observers.forEach(function (observer) { observer.disconnect(); });
        teardown.forEach(function (step) { try { step(); } catch (_) {} });
        if (ui && ui.root.parentNode) ui.root.parentNode.removeChild(ui.root);
        delete document[KEY];
      }
    });
  } catch (_) {}
})
