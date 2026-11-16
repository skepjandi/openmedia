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
  var MINI_WINDOW = Symbol.for('openmedia.miniWindow');
  var REFRESH_HOLD = Symbol.for('openmedia.holdRefresh');
  // A recipe's script offers the options of its site's player (quality, captions, audio) with
  // `document[Symbol.for('openmedia.videoOptions')] = function (video) { return [group, ...]; }`.
  var VIDEO_OPTIONS = Symbol.for('openmedia.videoOptions');
  var VIDEO_MENUS = Symbol.for('openmedia.videoMenus');
  var MINI_CLOSE = Symbol.for('openmedia.miniClose');
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
  var POP_MS = 1500; // a press on the video keeps small things at its centre out of sight this long
  var POP_SHARE = 0.35; // of the video's width or height: bigger is not a pop-up icon
  var POP_STEP_MS = 60;
  var POP_MIN = 16; // px: smaller is not an icon's badge or picture
  var POP_SCAN = 8000; // elements looked at per step, at most
  var MINI_MAX = 240; // px: widest the small player gets
  var MINI_SHARE = 0.48; // of the screen's width
  var MINI_EDGE = 12; // px from the right edge
  var MINI_RECHECK_MS = 250; // a site's restyling of the lifted video is answered after this
  var MINI_UNDO_MAX = 4; // times a site's pause is undone within the window below
  var MINI_UNDO_WINDOW_MS = 3000;
  var GHOST_MS = 500; // a touch's click comes this late at most, after its release
  var DRAG_SLOP = 10; // px a finger moves before it is a drag, and which way
  var DRAG_REACH = 0.5; // of the screen's height: how far down a drag is all the way to the small player
  var DRAG_COMMIT = 0.2; // of that: letting go past it keeps the small player, short of it puts the video back
  var DRAG_FLICK = 0.5; // px/ms: a flick this fast down keeps it too
  var DRAG_SETTLE_MS = 200;
  var HOLD_RATE_MS = 800; // how long after a drag the speed it started with is kept
  var MINI_FIGHTS = 40; // and this many times, then the site wins
  var MINI_BOTTOM = 96; // px from the bottom edge, clear of the browser's own buttons
  var HIDE_MS = 3500; // the panel goes away this long after the last touch on it
  var SVG = 'http://www.w3.org/2000/svg';
  var INTERACTIVE = 'a,button,input,textarea,select,summary,[role="button"],[role="link"],' +
    '[role="slider"],[role="menuitem"],[role="tab"],[role="switch"],[contenteditable="true"]';
  try {
    if (typeof document[KEY] === 'function') document[KEY]();

    var wantsSound = !!config.remember;
    var wantsLoopOff = !!(config.loopOff || config.autoAdvance);
    var wantsAdvance = !!config.autoAdvance;

    // Players built as web components keep their video in a shadow root, which a query on the
    // document does not reach. Roots are noted as the page makes them (the script runs before the
    // page's own), once for the page however often the controls start again.
    var SHADOWS = Symbol.for('openmedia.shadowRoots');
    if (!window[SHADOWS] && window.Element && Element.prototype.attachShadow) {
      var shadowRoots = window[SHADOWS] = new Set();
      var attachShadow = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function () {
        var root = attachShadow.apply(this, arguments);
        try { shadowRoots.add(root); } catch (_) {}
        return root;
      };
    }

    // Every video on the page, those inside shadow roots too.
    function allVideos() {
      var found = Array.prototype.slice.call(document.querySelectorAll('video'));
      var roots = window[SHADOWS];
      if (roots) {
        roots.forEach(function (root) {
          if (!root.host || !root.host.isConnected) { roots.delete(root); return; }
          root.querySelectorAll('video').forEach(function (video) { found.push(video); });
        });
      }
      return found;
    }

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
    var framed = window.top !== window; // in a frame of the page: a player the page embeds
    var parentMini = false; // in a frame: the page has made this frame its small player
    var mini = null; // the small player, while one is up
    var ghostUntil = 0; // clicks before this are the tail of a press on a button that has gone since
    var miniWindowed = false; // the page is itself the small window, in the corner of the screen
    var lastVideo = null;
    var touchFrom = null;
    var touchTarget = null;
    var pointerFrom = null;
    var popStop = null;
    var awaitTapEnd = false;
    var awaitTapClick = false;
    var mutedAtDown = null;

    function read() {
      try { return JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch (_) { return {}; }
    }

    function write(patch) {
      try { localStorage.setItem(STORE, JSON.stringify(Object.assign(read(), patch))); } catch (_) {}
    }

    function onFeedPage() {
      if (framed) return false;
      var isFeed = document[IS_FEED];
      return typeof isFeed === 'function' && isFeed();
    }

    function active() {
      return onFeedPage() && !document.hidden && !window.__openmediaHold;
    }

    // A page that is about one video: it says so (og:type video.*), its path does, or it is a page
    // with a video taking a good part of the screen, whatever the site (a player of its own, a file).
    function watchPage() {
      try {
        var meta = document.querySelector && document.querySelector('meta[property="og:type"]');
        var type = meta && meta.getAttribute && meta.getAttribute('content');
        if (type && /^video/i.test(type)) return true;
      } catch (_) {}
      if (window.location && WATCH_PATH.test(window.location.pathname || '')) return true;
      return !onFeedPage() && (!!focus() || !!playerFrame());
    }

    // Where the panel may show: a feed, or a page about one video.
    function panelPage() {
      if (framed && (parentMini || !frameBig())) return false;
      return !document.hidden && !window.__openmediaHold && (onFeedPage() || (fullVideosOn() && watchPage()));
    }

    // The video the panel works on: the feed player's in a feed, else the biggest one on screen.
    function focus() {
      if (onFeedPage()) return current();
      var height = window.innerHeight || document.documentElement.clientHeight;
      var width = window.innerWidth || document.documentElement.clientWidth;
      var best = null;
      var bestArea = 0;
      allVideos().forEach(function (video) {
        if (!video.isConnected || (mini && video === mini.video)) return;
        var box = video.getBoundingClientRect();
        var seen = Math.max(0, Math.min(box.bottom, height) - Math.max(box.top, 0)) *
          Math.max(0, Math.min(box.right, width) - Math.max(box.left, 0));
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
      allVideos().forEach(function (candidate) {
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
      expand: ['M9 5v2H6.4l4.3 4.3-1.4 1.4L5 8.4V11H3V5h6zm6 14v-2h2.6l-4.3-4.3 1.4-1.4 4.3 4.3V13h2v6h-6z'],
      close: ['M19 6.4L17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z'],
      pip: ['M19 7h-8v6h8V7z', 'M21 3H3c-1.1 0-2 .9-2 2v14c0 1.1.9 1.98 2 1.98h18c1.1 0 2-.88 2-1.98V5c0-1.1-.9-2-2-2zm0 16.01H3V4.98h18v14.03z'],
      fullscreen: ['M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z'],
      cc: ['M19 4H5c-1.11 0-2 .9-2 2v12c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1c0 .55-.45 1-1 1H7c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1zm7 0h-1.5v-.5h-2v3h2V13H18v1c0 .55-.45 1-1 1h-3c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1z'],
      audio: ['M12 3a9 9 0 0 0-9 9v7a2 2 0 0 0 2 2h3v-8H5v-1a7 7 0 0 1 14 0v1h-3v8h3a2 2 0 0 0 2-2v-7a9 9 0 0 0-9-9z'],
      gear: ['M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z'],
      muted: ['M3 9v6h4l5 5V4L7 9H3z', 'M14.5 9.4l1.4-1.4 2.1 2.1 2.1-2.1 1.4 1.4-2.1 2.1 2.1 2.1-1.4 1.4-2.1-2.1-2.1 2.1-1.4-1.4 2.1-2.1z']
    };

    function setIcon(button, name) {
      if (button.__icon === name) return;
      button.__icon = name;
      button.textContent = '';
      var extra = name === 'back' || name === 'forward' ? digit(String(SKIP_SECONDS)) : null;
      button.appendChild(icon(ICONS[name], extra));
    }

    // The video full screen, or back. A phone's own player takes a video (iOS: webkitEnterFullscreen),
    // otherwise the browser's full screen.
    function toggleFullscreen(video) {
      try {
        // A site's own styles can crop a video that fills the screen; the whole picture is shown.
        if (!document.getElementById('openmedia-fullscreen')) {
          var sheet = make('style', '');
          sheet.id = 'openmedia-fullscreen';
          sheet.textContent = 'video:fullscreen,video:-webkit-full-screen{object-fit:contain!important;' +
            'width:100%!important;height:100%!important;background:#000!important}';
          (document.head || document.documentElement).appendChild(sheet);
        }
        if (video.webkitDisplayingFullscreen && video.webkitExitFullscreen) { video.webkitExitFullscreen(); return; }
        var shown = document.fullscreenElement || document.webkitFullscreenElement;
        if (shown) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); return; }
        if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
        else if (video.requestFullscreen) video.requestFullscreen();
        else if (video.webkitRequestFullscreen) video.webkitRequestFullscreen();
      } catch (_) {}
    }

    // What the browser itself knows of a video's options, whatever the site: its subtitle and
    // caption tracks, and (Safari) its audio tracks. A site that draws its own captions or picks its
    // own quality keeps them to itself: nothing here can read those.
    function textTracksOf(video) {
      var found = [];
      var list = video.textTracks;
      for (var i = 0; list && i < list.length; i++) {
        if (list[i].kind === 'subtitles' || list[i].kind === 'captions') found.push(list[i]);
      }
      return found;
    }

    function audioTracksOf(video) {
      var found = [];
      var list = video.audioTracks;
      for (var i = 0; list && i < list.length; i++) found.push(list[i]);
      return found.length > 1 ? found : [];
    }

    // Off, then each track in turn, then off again.
    function cycleCaptions(video) {
      var tracks = textTracksOf(video);
      if (!tracks.length) return;
      var on = -1;
      tracks.forEach(function (track, index) { if (track.mode === 'showing') on = index; });
      var next = on + 1;
      tracks.forEach(function (track, index) {
        if (index === next) track.mode = 'showing';
        else if (track.mode === 'showing') track.mode = 'disabled';
      });
    }

    // The options a recipe's script offers for its site's player. Each group is
    // { kind: 'quality' | 'captions' | 'audio' | 'other', label, items: [{ label, selected }],
    //   select(index) }. What the script returns is the site's, so it is cut to size and to text.
    var optionGroups = { at: 0, groups: [], signature: '' };

    function normalizeGroups(groups) {
      return groups.slice(0, 4).map(function (group) {
        var items = Array.isArray(group && group.items) ? group.items.slice(0, 40) : [];
        return {
          kind: /^(quality|captions|audio)$/.test(String(group.kind)) ? String(group.kind) : 'other',
          label: String(group.label == null ? '' : group.label).slice(0, 24),
          items: items.map(function (item) {
            return { label: String(item && item.label != null ? item.label : '').slice(0, 60), selected: !!(item && item.selected) };
          }),
          select: typeof group.select === 'function' ? group.select : null
        };
      }).filter(function (group) { return group.items.length && group.select; });
    }

    // Players built with a common library are found from the video itself, so their options
    // need no recipe. A library object is the site's and may throw on any access, so every
    // touch of one is inside a try. What is found is kept for LIB_CACHE_MS per video (and the
    // scan of the window's own values for as long); the groups are built from it on each read.
    var LIB_CACHE_MS = 3000;
    var LIB_SCAN_KEYS = 400;
    var YT_QUALITY = { highres: 'Highest', hd2880: '2880p', hd2160: '2160p', hd1440: '1440p', hd1080: '1080p',
      hd720: '720p', large: '480p', medium: '360p', small: '240p', tiny: '144p', auto: 'Auto' };
    var libraryFinds = new WeakMap();
    var windowScan = { at: -Infinity, objects: [] };
    var ytChoice = new WeakMap();

    function windowObjects() {
      var now = Date.now();
      if (now - windowScan.at < LIB_CACHE_MS) return windowScan.objects;
      var objects = [];
      var keys = [];
      try { keys = Object.keys(window).slice(0, LIB_SCAN_KEYS); } catch (_) {}
      keys.forEach(function (key) {
        try {
          var value = window[key];
          if (value && typeof value === 'object') objects.push(value);
        } catch (_) {}
      });
      windowScan = { at: now, objects: objects };
      return objects;
    }

    function firstWindowObject(test) {
      var objects = windowObjects();
      for (var i = 0; i < objects.length; i++) {
        try { if (test(objects[i])) return objects[i]; } catch (_) {}
      }
      return null;
    }

    function levelLabel(height, bitrate, index) {
      if (height > 0) return height + 'p';
      if (bitrate > 0) return Math.round(bitrate / 1000) + ' kbps';
      return 'Level ' + (index + 1);
    }

    function qualityGroup(labels, selected, pick) {
      if (labels.length < 3) return null; // 'Auto' and one level is no choice
      return {
        kind: 'quality',
        label: 'Quality',
        items: labels.map(function (label, index) { return { label: label, selected: selected === index }; }),
        select: pick
      };
    }

    function containsVideo(element, video) {
      return element === video || (!!element && typeof element.contains === 'function' && element.contains(video));
    }

    // Each detector has find(video) -> the library's player or null, and group(player) -> a group or null.
    var LIBRARIES = [
      {
        // video.js: the qualityLevels plugin lists the levels; one is picked by enabling only it.
        find: function (video) {
          var lib = window.videojs;
          if (!lib) return null;
          var players = typeof lib.getAllPlayers === 'function' ? lib.getAllPlayers() :
            Object.keys(lib.players || {}).map(function (key) { return lib.players[key]; });
          for (var i = 0; i < players.length; i++) {
            var player = players[i];
            try {
              if (!player || typeof player.qualityLevels !== 'function') continue;
              if (containsVideo(player.el(), video)) return player;
              var tech = player.tech_ || player.tech({ IWillNotUseThisInPlugins: true });
              if (tech && tech.el() === video) return player;
            } catch (_) {}
          }
          return null;
        },
        group: function (player) {
          var list = player.qualityLevels();
          var levels = [];
          for (var i = 0; i < list.length; i++) levels.push(list[i]);
          var enabled = levels.filter(function (level) { return level.enabled; });
          var only = enabled.length === 1 ? levels.indexOf(enabled[0]) : -1;
          var labels = ['Auto'].concat(levels.map(function (level, index) {
            return levelLabel(level.height, level.bitrate, index);
          }));
          return qualityGroup(labels, only < 0 ? 0 : only + 1, function (at) {
            levels.forEach(function (level, index) { level.enabled = at === 0 || index === at - 1; });
          });
        }
      },
      {
        // hls.js: rarely a global of its own, so it is found among the window's values by the
        // video it is attached to. Level -1 is its automatic choice.
        find: function (video) {
          return firstWindowObject(function (o) {
            return Array.isArray(o.levels) && typeof o.currentLevel === 'number' &&
              typeof o.attachMedia === 'function' && o.media === video;
          });
        },
        group: function (hls) {
          var auto = hls.autoLevelEnabled !== undefined ? !!hls.autoLevelEnabled : hls.currentLevel === -1;
          var labels = ['Auto'].concat(hls.levels.map(function (level, index) {
            return levelLabel(level.height, level.bitrate, index);
          }));
          return qualityGroup(labels, auto ? 0 : hls.currentLevel + 1, function (at) { hls.currentLevel = at - 1; });
        }
      },
      {
        // dash.js: a fixed level is picked by turning its automatic switching off first.
        find: function (video) {
          return firstWindowObject(function (o) {
            return typeof o.getVideoElement === 'function' && o.getVideoElement() === video &&
              (typeof o.getBitrateInfoListFor === 'function' || typeof o.getTracksFor === 'function');
          });
        },
        group: function (dash) {
          var list = dash.getBitrateInfoListFor('video');
          if (!Array.isArray(list)) return null;
          var settings = typeof dash.getSettings === 'function' ? dash.getSettings() : null;
          var abr = settings && settings.streaming && settings.streaming.abr;
          var auto = !(abr && abr.autoSwitchBitrate && abr.autoSwitchBitrate.video === false);
          var labels = ['Auto'].concat(list.map(function (info, index) {
            return levelLabel(info.height, info.bitrate, index);
          }));
          var current = dash.getQualityFor('video');
          var autoSwitch = function (on) {
            dash.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: on } } } });
          };
          return qualityGroup(labels, auto ? 0 : current + 1, function (at) {
            autoSwitch(at === 0);
            if (at > 0) dash.setQualityFor('video', at - 1);
          });
        }
      },
      {
        // Shaka: one variant per video height (its best), picked with its automatic choice off.
        find: function (video) {
          return firstWindowObject(function (o) {
            return typeof o.getVariantTracks === 'function' && typeof o.getMediaElement === 'function' &&
              o.getMediaElement() === video;
          });
        },
        group: function (shaka) {
          var best = {};
          var active = 0;
          shaka.getVariantTracks().forEach(function (track) {
            if (!(track.height > 0)) return;
            var kept = best[track.height];
            if (!kept || (track.bandwidth || 0) > (kept.bandwidth || 0)) best[track.height] = track;
            if (track.active) active = track.height;
          });
          var tracks = Object.keys(best).map(Number).sort(function (a, b) { return b - a; })
            .map(function (height) { return best[height]; });
          var config = typeof shaka.getConfiguration === 'function' ? shaka.getConfiguration() : null;
          var auto = !(config && config.abr && config.abr.enabled === false);
          var labels = ['Auto'].concat(tracks.map(function (track) { return track.height + 'p'; }));
          var on = 0;
          tracks.forEach(function (track, index) { if (track.height === active) on = index + 1; });
          return qualityGroup(labels, auto ? 0 : on, function (at) {
            shaka.configure({ abr: { enabled: at === 0 } });
            if (at > 0) shaka.selectVariantTrack(tracks[at - 1], true);
          });
        }
      },
      {
        // Plyr sets itself on the video element.
        find: function (video) { return video.plyr || null; },
        group: function (plyr) {
          var list = plyr.options && plyr.options.quality;
          if (!Array.isArray(list) || list.length < 2) return null;
          var current = plyr.quality;
          return {
            kind: 'quality',
            label: 'Quality',
            items: list.map(function (value) {
              return { label: typeof value === 'number' ? value + 'p' : String(value), selected: value === current };
            }),
            select: function (at) { plyr.quality = list[at]; }
          };
        }
      },
      {
        // JW Player: its API is reached through the container the video is in.
        find: function (video) {
          if (typeof window.jwplayer !== 'function') return null;
          var holder = video.closest && video.closest('.jwplayer');
          var player = holder && holder.id ? window.jwplayer(holder.id) : null;
          return player && typeof player.getQualityLevels === 'function' ? player : null;
        },
        group: function (jw) {
          var levels = jw.getQualityLevels();
          if (!Array.isArray(levels)) return null;
          if (levels.length < 2) return null;
          var current = jw.getCurrentQuality();
          return {
            kind: 'quality',
            label: 'Quality',
            items: levels.map(function (level, index) { return { label: String(level.label), selected: index === current }; }),
            select: function (at) { jw.setCurrentQuality(at); }
          };
        }
      },
      {
        // Vidstack (a media-player element): `qualities` lists them, one of which can be selected.
        find: function (video) {
          var player = video.closest && video.closest('media-player');
          return player && player.qualities && typeof player.qualities.autoSelect === 'function' ? player : null;
        },
        group: function (player) {
          var list = Array.prototype.slice.call(player.qualities);
          list.sort(function (a, b) { return (b.height || 0) - (a.height || 0); });
          var labels = ['Auto'].concat(list.map(function (quality) { return quality.height ? quality.height + 'p' : String(quality.id); }));
          var on = 0;
          if (!player.qualities.auto) list.forEach(function (quality, index) { if (quality.selected) on = index + 1; });
          return qualityGroup(labels, on, function (at) {
            if (at === 0) player.qualities.autoSelect();
            else list[at - 1].selected = true;
          });
        }
      },
      {
        // A player object (YouTube's) that answers for its qualities and holds the video.
        find: function (video) {
          var places = [
            function () { return document.getElementById('movie_player'); },
            function () { return document.querySelector('.html5-video-player'); }
          ];
          for (var i = 0; i < places.length; i++) {
            try {
              var player = places[i]();
              if (player && typeof player.getAvailableQualityLevels === 'function' &&
                  typeof player.getPlaybackQuality === 'function' &&
                  (typeof player.setPlaybackQualityRange === 'function' || typeof player.setPlaybackQuality === 'function') &&
                  containsVideo(player, video)) return player;
            } catch (_) {}
          }
          return null;
        },
        group: function (player) {
          var levels = player.getAvailableQualityLevels();
          if (!Array.isArray(levels)) return null;
          var ids = ['auto'].concat(levels.filter(function (id) { return id !== 'auto'; }).map(String));
          // The player reports the level in play, not whether it was left on automatic.
          var chosen = ytChoice.has(player) ? ytChoice.get(player) : player.getPlaybackQuality();
          var labels = ids.map(function (id) {
            var hd = /^hd(\d+)$/.exec(id);
            return YT_QUALITY[id] || (hd ? hd[1] + 'p' : id);
          });
          return qualityGroup(labels, ids.indexOf(chosen), function (at) {
            var id = ids[at];
            ytChoice.set(player, id);
            if (typeof player.setPlaybackQualityRange === 'function') player.setPlaybackQualityRange(id, id);
            if (typeof player.setPlaybackQuality === 'function') player.setPlaybackQuality(id);
          });
        }
      }
    ];

    function libraryGroups(video) {
      var now = Date.now();
      var found = libraryFinds.get(video);
      if (!found || now - found.at >= LIB_CACHE_MS) {
        found = { at: now, players: [] };
        LIBRARIES.forEach(function (library) {
          try {
            var player = library.find(video);
            if (player) found.players.push({ library: library, player: player });
          } catch (_) {}
        });
        libraryFinds.set(video, found);
      }
      var groups = [];
      found.players.forEach(function (entry) {
        try {
          var group = entry.library.group(entry.player);
          if (group) groups.push(group);
        } catch (_) {}
      });
      return groups;
    }

    function readOptions(video) {
      var groups = [];
      var provider = document[VIDEO_OPTIONS];
      if (typeof provider === 'function') {
        try {
          var offered = provider(video);
          if (Array.isArray(offered)) groups = normalizeGroups(offered);
        } catch (_) {}
      }
      // The `videoMenu` rules of a recipe (`video_menu.js`) are offered the same way.
      var menus = document[VIDEO_MENUS];
      if (typeof menus === 'function') {
        try {
          var offeredByRules = menus(video);
          if (Array.isArray(offeredByRules)) groups = groups.concat(normalizeGroups(offeredByRules));
        } catch (_) {}
      }
      // A library's groups fill in the kinds the recipe left out.
      normalizeGroups(libraryGroups(video)).forEach(function (group) {
        if (!groups.some(function (own) { return own.kind === group.kind; })) groups.push(group);
      });
      return groups;
    }

    function closeMenu() {
      if (ui && ui.menu) { ui.menu.style.display = 'none'; ui.menu.textContent = ''; }
      ui && (ui.menu.__group = -1);
    }

    function openMenu(index) {
      var group = optionGroups.groups[index];
      if (!ui || !group) return;
      if (ui.menu.style.display === 'block' && ui.menu.__group === index) { closeMenu(); return; }
      ui.menu.textContent = '';
      ui.menu.__group = index;
      group.items.forEach(function (item, at) {
        var row = make('div', 'padding:10px 14px;white-space:nowrap;cursor:pointer;touch-action:manipulation;' +
          (item.selected ? 'font-weight:600' : 'opacity:.85'));
        row.textContent = (item.selected ? '\u2713 ' : '\u2003') + item.label;
        row.addEventListener('pointerdown', stop);
        row.addEventListener('pointerup', function (event) {
          stop(event);
          ghostUntil = Date.now() + GHOST_MS;
          try { group.select(at); } catch (_) {}
          closeMenu();
          optionGroups.at = 0;
          keepAlive();
        });
        ui.menu.appendChild(row);
      });
      ui.menu.style.display = 'block';
    }

    // Buttons for the groups, made again only when the groups change.
    function syncOptions(video) {
      var now = Date.now();
      if (now - optionGroups.at < 700) return;
      optionGroups.at = now;
      var groups = readOptions(video);
      var signature = JSON.stringify(groups.map(function (group) {
        return [group.kind, group.label, group.items];
      }));
      if (signature === optionGroups.signature) return;
      optionGroups.signature = signature;
      optionGroups.groups = groups;
      ui.extras.textContent = '';
      closeMenu();
      groups.forEach(function (group, index) {
        var icon = group.kind === 'captions' ? 'cc' : group.kind === 'audio' ? 'audio' : 'gear';
        var opener = button(32, icon, function () { openMenu(index); });
        if (group.label) opener.title = group.label;
        ui.extras.appendChild(opener);
      });
    }

    function cycleAudio(video) {
      var tracks = audioTracksOf(video);
      if (!tracks.length) return;
      var on = 0;
      tracks.forEach(function (track, index) { if (track.enabled) on = index; });
      var next = (on + 1) % tracks.length;
      tracks.forEach(function (track, index) { track.enabled = index === next; });
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
        ghostUntil = Date.now() + GHOST_MS;
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

    // The small player: the video is lifted out of the page into a box in the bottom right corner
    // that stays above everything, with its own close and play buttons, and goes back where it
    // was when the reader closes it. The page's own player is left empty meanwhile. It ends with
    // the video, or when the site loads another into the same player.
    var MINI_VIDEO_CSS = 'position:absolute!important;left:0!important;top:0!important;' +
      'width:100%!important;height:100%!important;max-width:none!important;max-height:none!important;' +
      'margin:0!important;padding:0!important;transform:none!important;object-fit:contain!important;' +
      'background:#000!important;opacity:1!important;visibility:visible!important;display:block!important';

    function miniButton(name, size, place, action) {
      var element = make('div',
        'position:absolute;display:flex;align-items:center;justify-content:center;box-sizing:border-box;' +
        'width:' + size + 'px;height:' + size + 'px;padding:6px;border-radius:50%;background:rgba(0,0,0,.6);' +
        'color:#fff;touch-action:manipulation;cursor:pointer;' + place);
      setIcon(element, name);
      element.addEventListener('pointerdown', stop);
      element.addEventListener('pointerup', function (event) {
        stop(event);
        ghostUntil = Date.now() + GHOST_MS;
        action();
      });
      return element;
    }

    // The app moves this page to the corner as it is and opens the page again in its place.
    // Without an app to do that, the player stays over this page.
    function askAppToFloat() {
      try { window.webkit.messageHandlers.openmediaMini.postMessage({ float: true }); } catch (_) {}
    }

    // Tells the app whether the small player is up, so it can keep the page when a link is tapped.
    function tellApp(up) {
      try { window.webkit.messageHandlers.openmediaMini.postMessage(up); } catch (_) {}
    }


    // ---- Players the page embeds in a frame ----
    // A frame cannot be reached from the page (another site's), and its touches do not reach the
    // page. So the controls run in the frame too, on the video there, and ask the page by message
    // for what only the page can do: the frame is moved to the corner as it is (moving it in the
    // document would load it again), and the app is told, from the page only.

    function frameBig() {
      var area = (window.innerWidth || 0) * (window.innerHeight || 0);
      var screenArea = ((window.screen && window.screen.width) || 400) * ((window.screen && window.screen.height) || 800);
      return area >= MIN_VIDEO_SHARE * screenArea;
    }

    function toPage(message) {
      try { window.parent.postMessage(message, '*'); } catch (_) {}
    }

    // The page's frames, those inside shadow roots too.
    function allFrames() {
      var found = Array.prototype.slice.call(document.querySelectorAll('iframe'));
      var roots = window[SHADOWS];
      if (roots) {
        roots.forEach(function (root) {
          if (!root.host || !root.host.isConnected) return;
          root.querySelectorAll('iframe').forEach(function (frame) { found.push(frame); });
        });
      }
      return found;
    }

    // The frame that is the page's player: the biggest on screen, over the share a video needs.
    function playerFrame() {
      if (framed) return null;
      var height = window.innerHeight || document.documentElement.clientHeight;
      var width = window.innerWidth || document.documentElement.clientWidth;
      var best = null;
      var bestArea = 0;
      allFrames().forEach(function (frame) {
        if (!frame.isConnected || (mini && mini.frame === frame)) return;
        var box = frame.getBoundingClientRect();
        var seen = Math.max(0, Math.min(box.bottom, height) - Math.max(box.top, 0)) *
          Math.max(0, Math.min(box.right, width) - Math.max(box.left, 0));
        if (seen > bestArea && seen >= MIN_VIDEO_SHARE * width * height) {
          best = frame;
          bestArea = seen;
        }
      });
      return best;
    }

    function frameOf(source) {
      var found = null;
      allFrames().forEach(function (frame) { if (frame.contentWindow === source) found = frame; });
      return found;
    }

    function tellFrame(frame, message) {
      try { frame.contentWindow.postMessage(message, '*'); } catch (_) {}
    }

    var FRAME_CSS_PROPS = ['position', 'right', 'bottom', 'left', 'top', 'width', 'height', 'z-index',
      'border-radius', 'margin', 'max-width', 'max-height', 'transform', 'background'];

    // The frame follows the box the small player's buttons are in.
    function syncFrame(state) {
      if (!state || !state.frame) return;
      var box = state.root.style;
      var frame = state.frame.style;
      frame.setProperty('right', box.right, 'important');
      frame.setProperty('bottom', box.bottom, 'important');
      frame.setProperty('width', box.width, 'important');
      frame.setProperty('height', box.height, 'important');
      frame.setProperty('border-radius', box.borderRadius, 'important');
      frame.setProperty('transition', box.transition || 'none', 'important');
      frame.setProperty('visibility', 'visible', 'important');
    }

    function miniOnFrame(frame, from) {
      if (mini || !frame.isConnected || !frame.parentNode) return;
      var screenWidth = window.innerWidth || document.documentElement.clientWidth || 400;
      var screenHeight = window.innerHeight || document.documentElement.clientHeight || 800;
      var here = frame.getBoundingClientRect();
      var width = Math.round(Math.min(MINI_MAX, screenWidth * MINI_SHARE));
      var ratio = here.width > 0 && here.height > 0 ? here.width / here.height : 16 / 9;
      var height = Math.round(Math.min(screenHeight * 0.32, Math.max(90, width / ratio)));
      var start = {
        right: screenWidth - here.right, bottom: screenHeight - here.bottom,
        width: here.width, height: here.height
      };
      var root = make('div',
        'position:fixed;right:' + (from ? start.right : MINI_EDGE) + 'px;bottom:' + (from ? start.bottom : MINI_BOTTOM) +
        'px;width:' + (from ? start.width : width) + 'px;height:' + (from ? start.height : height) +
        'px;z-index:2147483647;pointer-events:none;border-radius:' + (from ? 0 : 12) + 'px;touch-action:none');
      root.setAttribute('data-openmedia-mini', '');
      var state = {
        frame: frame, video: null, root: root,
        marker: document.createElement('div'),
        style: frame.getAttribute('style'),
        right: MINI_EDGE, bottom: MINI_BOTTOM, width: width, height: height,
        start: from ? start : null, stops: []
      };
      // Its place in the page stays as it was, so the page does not move under the reader.
      state.marker.setAttribute('style', 'width:' + here.width + 'px;height:' + here.height + 'px;display:block;' +
        'flex:none;visibility:hidden');
      var close = miniButton('close', 28, 'top:6px;right:6px', function () { miniOff(); });
      var expand = miniButton('expand', 28, 'top:6px;left:6px', function () {
        try { window.webkit.messageHandlers.openmediaMini.postMessage({ expand: true }); } catch (_) { miniOff(); }
      });
      var toggle = miniButton('pause', 34, 'left:6px;bottom:6px', function () { tellFrame(frame, { om: 'toggle' }); });
      state.toggle = toggle;
      [close, expand, toggle].forEach(function (button) { button.style.pointerEvents = 'auto'; root.appendChild(button); });
      frame.parentNode.insertBefore(state.marker, frame);
      frame.style.setProperty('position', 'fixed', 'important');
      frame.style.setProperty('z-index', '2147483646', 'important');
      frame.style.setProperty('margin', '0', 'important');
      frame.style.setProperty('max-width', 'none', 'important');
      frame.style.setProperty('max-height', 'none', 'important');
      frame.style.setProperty('transform', 'none', 'important');
      frame.style.setProperty('overflow', 'hidden', 'important');
      frame.style.setProperty('left', 'auto', 'important');
      frame.style.setProperty('top', 'auto', 'important');
      frame.style.setProperty('box-shadow', '0 6px 24px rgba(0,0,0,.5)', 'important');
      (document.documentElement || document.body).appendChild(root);
      mini = state;
      syncFrame(state);
      var watchdog = setInterval(function () { if (!frame.isConnected) miniOff(); }, 500);
      state.stops.push(function () { clearInterval(watchdog); });
      tellApp(true);
      tellFrame(frame, { om: 'mini', on: true });
    }

    var frameDrag = null; // in the page: a drag that began in a frame

    // What a frame says to the page.
    function onFrameMessage(event) {
      var data = event.data;
      if (!data || typeof data.om !== 'string') return;
      if (!framed) {
        var frame = frameOf(event.source);
        if (!frame) return;
        if (data.om === 'drag-start') {
          var top = window.scrollY || (document.scrollingElement && document.scrollingElement.scrollTop) || 0;
          var ok = !mini && panelOn() && !onFeedPage() && !document.hidden && !window.__openmediaHold &&
            top <= 1 && frame === playerFrame();
          frameDrag = ok ? { frame: frame, rect: frame.getBoundingClientRect() } : null;
          tellFrame(frame, { om: 'drag-ok', ok: ok });
        } else if (data.om === 'drag-move' && frameDrag && frameDrag.frame === frame) {
          if (!mini) {
            var rect = frameDrag.rect;
            miniOnFrame(frame, { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
          }
          var reach = (window.innerHeight || document.documentElement.clientHeight || 800) * DRAG_REACH;
          frameDrag.progress = Math.min(1, Math.max(0, data.dy / reach));
          miniDrag(frameDrag.progress);
        } else if (data.om === 'drag-end' && frameDrag && frameDrag.frame === frame) {
          var held = frameDrag;
          frameDrag = null;
          if (!mini || mini.frame !== frame) return;
          ghostUntil = Date.now() + GHOST_MS;
          var keep = !data.cancelled && ((held.progress || 0) >= DRAG_COMMIT ||
            (data.speed > DRAG_FLICK && (held.progress || 0) > 0.08));
          if (keep) settleMini(function () { miniDrag(1); }, askAppToFloat);
          else settleMini(function () { miniDrag(0); }, miniOff);
        } else if (data.om === 'float') {
          miniOnFrame(frame);
          askAppToFloat();
        } else if (data.om === 'unfloat') {
          miniOff();
        } else if (data.om === 'paused' && mini && mini.frame === frame && mini.toggle) {
          setIcon(mini.toggle, data.paused ? 'play' : 'pause');
        }
        return;
      }
      if (event.source !== window.parent) return;
      if (data.om === 'drag-ok') {
        if (drag) drag.ok = !!data.ok;
      } else if (data.om === 'mini') {
        parentMini = !!data.on;
        if (parentMini) hide();
      } else if (data.om === 'toggle') {
        var video = focus();
        if (!video) return;
        if (video.paused) { try { video.play().catch(function () {}); } catch (_) {} } else video.pause();
        toPage({ om: 'paused', paused: video.paused });
      }
    }

    function miniOn(video, from) {
      if (mini || !video.parentNode) return;
      var screenWidth = window.innerWidth || document.documentElement.clientWidth || 400;
      var screenHeight = window.innerHeight || document.documentElement.clientHeight || 800;
      var width = Math.round(Math.min(MINI_MAX, screenWidth * MINI_SHARE));
      var ratio = video.videoWidth > 0 && video.videoHeight > 0 ? video.videoWidth / video.videoHeight : 16 / 9;
      var height = Math.round(Math.min(screenHeight * 0.32, Math.max(90, width / ratio)));
      // Started by a drag, it begins where the video was, full size, and the finger shrinks it.
      var start = from ? {
        right: screenWidth - from.right, bottom: screenHeight - from.bottom,
        width: from.right - from.left, height: from.bottom - from.top
      } : null;
      var root = make('div',
        'position:fixed;right:' + (start ? start.right : MINI_EDGE) + 'px;bottom:' + (start ? start.bottom : MINI_BOTTOM) +
        'px;width:' + (start ? start.width : width) + 'px;height:' + (start ? start.height : height) +
        'px;z-index:2147483647;background:#000;border-radius:' + (start ? 0 : 12) + 'px;overflow:hidden;' +
        'box-shadow:0 6px 24px rgba(0,0,0,.5);touch-action:none;-webkit-user-select:none;user-select:none');
      root.setAttribute('data-openmedia-mini', '');
      var state = {
        video: video,
        root: root,
        marker: document.createComment('openmedia-mini'),
        style: video.getAttribute('style'),
        src: video.currentSrc,
        playing: !video.paused,
        right: MINI_EDGE,
        bottom: MINI_BOTTOM,
        width: width,
        height: height,
        start: start,
        stops: []
      };
      var close = miniButton('close', 28, 'top:6px;right:6px', function () { miniOff(); });
      // Back to the page as it was: the app puts the page in front again (the page it opened in its
      // place is closed) and the video back in it. Without an app, the video goes back to its place.
      var expand = miniButton('expand', 28, 'top:6px;left:6px', function () {
        try { window.webkit.messageHandlers.openmediaMini.postMessage({ expand: true }); } catch (_) { miniOff(); }
      });
      // The player plays until the reader pauses it: a site's own pausing (a feed pausing what it
      // thinks is out of view, Instagram's Reels) is refused, and a pause that gets past that is
      // undone a few times. Only this button pauses it.
      state.wantsPlay = !video.paused;
      state.allowPause = false;
      state.undone = [];
      var nativePause = video.pause;
      video.pause = function () {
        if (state.allowPause) return nativePause.apply(video, arguments);
      };
      state.stops.push(function () { delete video.pause; });
      var toggle = miniButton(video.paused ? 'play' : 'pause', 34, 'left:6px;bottom:6px', function () {
        if (video.paused) {
          state.wantsPlay = true;
          try { video.play().catch(function () {}); } catch (_) {}
        } else {
          state.wantsPlay = false;
          state.allowPause = true;
          try { nativePause.call(video); } finally { state.allowPause = false; }
        }
      });
      var sync = function () { setIcon(toggle, video.paused ? 'play' : 'pause'); };
      var listen = function (name, handler) {
        video.addEventListener(name, handler);
        state.stops.push(function () { video.removeEventListener(name, handler); });
      };
      listen('play', sync);
      listen('pause', sync);
      listen('pause', function () {
        var now = Date.now();
        state.undone = state.undone.filter(function (at) { return now - at < MINI_UNDO_WINDOW_MS; });
        if (!state.wantsPlay || video.ended || state.undone.length >= MINI_UNDO_MAX) return;
        state.undone.push(now);
        setTimeout(function () {
          if (mini === state && state.wantsPlay && video.paused && !video.ended) {
            try { video.play().catch(function () {}); } catch (_) {}
          }
        }, 50);
      });
      listen('ended', function () { miniOff(); });
      // A site that reuses its player for the next video loads it into this one.
      listen('loadstart', function () { if (video.currentSrc !== state.src) miniOff(); });
      // Dragged by any part that is not a button.
      var from = null;
      root.addEventListener('pointerdown', function (event) {
        stop(event);
        if (miniWindowed) return;
        from = { x: event.clientX, y: event.clientY, right: state.right, bottom: state.bottom };
        try { root.setPointerCapture(event.pointerId); } catch (_) {}
      });
      root.addEventListener('pointermove', function (event) {
        if (!from) return;
        stop(event);
        state.right = Math.max(0, Math.min(screenWidth - width, from.right - (event.clientX - from.x)));
        state.bottom = Math.max(0, Math.min(screenHeight - height, from.bottom - (event.clientY - from.y)));
        root.style.right = state.right + 'px';
        root.style.bottom = state.bottom + 'px';
      });
      var release = function (event) {
        if (!from) return;
        stop(event);
        from = null;
      };
      root.addEventListener('pointerup', release);
      root.addEventListener('pointercancel', release);

      video.parentNode.insertBefore(state.marker, video);
      root.appendChild(video);
      video.style.cssText = MINI_VIDEO_CSS;
      root.appendChild(close);
      root.appendChild(expand);
      root.appendChild(toggle);
      (document.documentElement || document.body).appendChild(root);
      // The site's player keeps styling its video: the box's styles are put back when it does, at
      // most a few times a second and a limited number of times. Putting them back on every
      // change would make this and a player that restyles on every change feed each other
      // without end, which hangs the page.
      var checking = 0;
      var fights = 0;
      var kept = function () {
        var style = video.style;
        return typeof style.getPropertyPriority !== 'function' ||
          (style.getPropertyPriority('position') === 'important' &&
            style.getPropertyPriority('width') === 'important' &&
            style.getPropertyPriority('height') === 'important');
      };
      var watch = new MutationObserver(function () {
        if (checking || fights >= MINI_FIGHTS) return;
        checking = setTimeout(function () {
          checking = 0;
          if (kept()) return;
          fights += 1;
          video.style.cssText = MINI_VIDEO_CSS;
        }, MINI_RECHECK_MS);
      });
      watch.observe(video, { attributes: true, attributeFilter: ['style'] });
      state.stops.push(function () { watch.disconnect(); clearTimeout(checking); });
      // A site that disposes its player (YouTube, navigating inside the page) takes the video out of
      // the player's box: a box without its video is closed, not left black and silent.
      var watchdog = setInterval(function () {
        if (!video.isConnected || video.parentNode !== root) miniOff();
      }, 500);
      state.stops.push(function () { clearInterval(watchdog); });
      mini = state;
      tellApp(true);
      if (state.playing && video.paused) { try { video.play().catch(function () {}); } catch (_) {} }
    }

    // Dragging the player down on a watch page, from the top of the page, shrinks it into the small
    // player as the finger goes, as the YouTube app does; let go far enough (or flick) and it
    // stays, short of that it goes back. Not in a feed, where a swipe down is the way to the
    // previous video, and not sideways (a seek) or up (a scroll).
    var drag = null;

    // The app's own pull to refresh would take a drag down from the top of the page, and decides
    // before the page can say anything about a touch that has just begun. So the page says so in
    // advance: while a watch page is at its top with its video on screen, it counts as scrolled.
    var refreshHeld = false;
    function syncRefreshHold() {
      if (framed) return;
      var top = window.scrollY || (document.scrollingElement && document.scrollingElement.scrollTop) || 0;
      var want = !mini && !document.hidden && panelOn() && !onFeedPage() && watchPage() && top <= 1 && !!(focus() || playerFrame());
      if (want === refreshHeld) return;
      refreshHeld = want;
      document[REFRESH_HOLD] = want;
      try { window.openmediaScroll.postMessage(want ? '1' : '0'); } catch (_) {}
      try { window.webkit.messageHandlers.openmediaScroll.postMessage(want ? 1 : 0); } catch (_) {}
    }

    function miniDrag(progress) {
      if (!mini || !mini.start) return;
      var a = mini.start;
      var mix = function (from, to) { return Math.round(from + (to - from) * progress); };
      mini.root.style.right = mix(a.right, mini.right) + 'px';
      mini.root.style.bottom = mix(a.bottom, mini.bottom) + 'px';
      mini.root.style.width = mix(a.width, mini.width) + 'px';
      mini.root.style.height = mix(a.height, mini.height) + 'px';
      mini.root.style.borderRadius = Math.round(12 * progress) + 'px';
      syncFrame(mini);
    }

    function settleMini(to, then) {
      var state = mini;
      if (!state) return;
      state.root.style.transition = 'right,bottom,width,height,border-radius'.split(',').map(function (name) {
        return name + ' ' + DRAG_SETTLE_MS + 'ms ease-out';
      }).join(',');
      syncFrame(state);
      to();
      setTimeout(function () {
        if (mini !== state) return;
        state.root.style.transition = '';
        syncFrame(state);
        then();
      }, DRAG_SETTLE_MS + 20);
    }

    // Where a touch is. In a frame that the page then moves under the finger, the position in the
    // frame stands still while the finger goes on; the position on the screen does not.
    function touchX(touch) { return framed && typeof touch.screenX === 'number' ? touch.screenX : touch.clientX; }
    function touchY(touch) { return framed && typeof touch.screenY === 'number' ? touch.screenY : touch.clientY; }

    // A site's press and hold for double speed (YouTube's) starts with the touch, and since the page
    // keeps the rest of a drag from the site, the touch never ends for it: the speed would stay
    // doubled. The speed the video had is kept while the drag lasts, and a little after.
    function holdRate(video, rate) {
      var back = function () { if (video.playbackRate !== rate) video.playbackRate = rate; };
      video.addEventListener('ratechange', back);
      back();
      return function (after) {
        setTimeout(function () {
          video.removeEventListener('ratechange', back);
          back();
        }, after);
      };
    }

    function dragStart(event) {
      drag = null;
      if (mini || !event.touches || event.touches.length !== 1 || document.hidden || window.__openmediaHold) return;
      if (framed && (parentMini || !frameBig())) return;
      if (!panelOn() || onFeedPage() || !watchPage() || inPanel(event.target)) return;
      var top = window.scrollY || (document.scrollingElement && document.scrollingElement.scrollTop) || 0;
      if (top > 1) return;
      // The page's own video, or its frame: a touch on a frame goes to the frame's own copy of the
      // controls, but one that lands on something laid over it (an ad's catcher) comes here.
      var video = focus();
      var frame = video ? null : playerFrame();
      if (!video && !frame) return;
      var touch = event.touches[0];
      var box = video ? boxOf(video) : frame.getBoundingClientRect();
      if (!(touch.clientX >= box.left && touch.clientX <= box.right && touch.clientY >= box.top && touch.clientY <= box.bottom)) return;
      if (video && onSiteButton(event.target, video)) return;
      drag = {
        video: video, frame: frame, rate: video ? video.playbackRate : 1, x: touchX(touch), y: touchY(touch), engaged: false,
        box: { left: box.left, right: box.right, top: box.top, bottom: box.bottom },
        last: { y: touchY(touch), at: Date.now() }, speed: 0, ok: false
      };
      // In a frame only the page knows whether it is at its top and this is its player.
      if (framed) toPage({ om: 'drag-start' });
    }

    function dragMove(event) {
      if (!drag || !event.touches || !event.touches.length) return;
      var touch = event.touches[0];
      var dx = touchX(touch) - drag.x;
      var dy = touchY(touch) - drag.y;
      if (!drag.engaged) {
        if (Math.abs(dx) > DRAG_SLOP && Math.abs(dx) >= Math.abs(dy)) { drag = null; return; }
        if (dy < -DRAG_SLOP) { drag = null; return; }
        if (dy < DRAG_SLOP || dy < Math.abs(dx) * 1.4) return;
        if (framed) {
          if (!drag.ok) return;
          hide();
        } else {
          hide();
          if (drag.frame) miniOnFrame(drag.frame, drag.box); else miniOn(drag.video, drag.box);
          if (!mini) { drag = null; return; }
        }
        drag.engaged = true;
        if (drag.video) drag.release = holdRate(drag.video, drag.rate);
      }
      event.stopImmediatePropagation();
      if (event.cancelable) event.preventDefault();
      var now = Date.now();
      if (now > drag.last.at) drag.speed = (touchY(touch) - drag.last.y) / (now - drag.last.at);
      drag.last = { y: touchY(touch), at: now };
      if (framed) {
        toPage({ om: 'drag-move', dy: dy });
        return;
      }
      var reach = (window.innerHeight || document.documentElement.clientHeight || 800) * DRAG_REACH;
      drag.progress = Math.min(1, Math.max(0, dy / reach));
      miniDrag(drag.progress);
    }

    function dragEnd(event, cancelled) {
      var held = drag;
      drag = null;
      if (held && held.release) held.release(HOLD_RATE_MS);
      if (!held || !held.engaged || (!framed && !mini)) return;
      event.stopImmediatePropagation();
      if (event.cancelable) event.preventDefault();
      ghostUntil = Date.now() + GHOST_MS;
      if (framed) {
        toPage({ om: 'drag-end', speed: held.speed, cancelled: !!cancelled });
        return;
      }
      var keep = !cancelled && (held.progress >= DRAG_COMMIT || (held.speed > DRAG_FLICK && held.progress > 0.08));
      if (keep) {
        settleMini(function () { miniDrag(1); }, askAppToFloat);
      } else {
        settleMini(function () { miniDrag(0); }, miniOff);
      }
    }

    // The app moved this page into a small window of its own in the corner: the player fills it.
    var MINI_WINDOW_STYLE = 'html,body{background:transparent!important}body{visibility:hidden!important}';
    function miniWindow(on) {
      miniWindowed = !!on;
      if (!on) document.documentElement.style.visibility = '';
      var sheet = document.getElementById('openmedia-mini-window');
      if (on && !sheet) {
        sheet = make('style', '');
        sheet.id = 'openmedia-mini-window';
        sheet.textContent = MINI_WINDOW_STYLE;
        (document.head || document.documentElement).appendChild(sheet);
      } else if (!on && sheet && sheet.parentNode) {
        sheet.parentNode.removeChild(sheet);
      }
      if (!mini) return;
      var css = on ?
        'right:0;bottom:0;width:100%;height:100%;border-radius:12px;box-shadow:none' :
        'right:' + mini.right + 'px;bottom:' + mini.bottom + 'px;width:' + mini.width + 'px;height:' + mini.height + 'px;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.5)';
      var parts = css.split(';');
      parts.forEach(function (part) {
        var pair = part.split(/:(.+)/);
        mini.root.style.setProperty(pair[0], pair[1]);
      });
      syncFrame(mini);
    }

    function miniOff() {
      var state = mini;
      if (!state) return;
      mini = null;
      tellApp(false);
      state.stops.forEach(function (step) { try { step(); } catch (_) {} });
      if (state.frame) {
        if (state.style === null) state.frame.removeAttribute('style'); else state.frame.setAttribute('style', state.style);
        if (state.marker.parentNode) state.marker.parentNode.removeChild(state.marker);
        if (state.root.parentNode) state.root.parentNode.removeChild(state.root);
        tellFrame(state.frame, { om: 'mini', on: false });
        if (miniWindowed) document.documentElement.style.visibility = 'hidden';
        return;
      }
      var video = state.video;
      var home = state.marker.parentNode;
      if (state.style === null) video.removeAttribute('style'); else video.setAttribute('style', state.style);
      if (home) {
        home.insertBefore(video, state.marker);
        home.removeChild(state.marker);
      } else {
        video.pause();
      }
      if (state.root.parentNode) state.root.parentNode.removeChild(state.root);
      if (miniWindowed) document.documentElement.style.visibility = 'hidden';
      if (home && state.playing && video.paused && !video.ended) {
        try { video.play().catch(function () {}); } catch (_) {}
      }
    }

    // The panel: three buttons above a row (mute, time left, speed) above the seek bar,
    // fixed above the bottom edge. Everything is made here as plain elements and nothing is read
    // back from the site.
    function build(video) {
      if (ui) return ui;
      var parent = document.body || document.documentElement;
      if (!parent) return null;
      var root = make('div',
        'position:fixed;left:0;right:0;z-index:2147483646;display:none;pointer-events:none;' +
        'font:600 13px/1 -apple-system,system-ui,sans-serif;color:#fff;' +
        '-webkit-user-select:none;user-select:none');
      root.setAttribute('data-openmedia-controls', '');
      var card = make('div',
        'position:relative;pointer-events:auto;margin:0 12px;padding:10px 14px 2px;border-radius:18px;background:rgba(0,0,0,.62);' +
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
      var floatButton = button(32, 'pip', function (target) {
        if (framed) {
          toPage({ om: parentMini ? 'unfloat' : 'float' });
        } else if (mini) {
          miniOff();
        } else {
          miniOn(target);
          askAppToFloat();
        }
        hide();
      });
      var fullButton = button(32, 'fullscreen', function (target) { toggleFullscreen(target); });
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
      var extras = make('span', 'display:flex;align-items:center;gap:10px');
      var cc = button(32, 'cc', function (target) { cycleCaptions(target); });
      var audio = button(32, 'audio', function (target) { cycleAudio(target); });
      var note = make('span',
        'font-size:12px;opacity:.85;max-width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap');
      cc.style.display = 'none';
      audio.style.display = 'none';
      row.appendChild(mute);
      row.appendChild(cc);
      row.appendChild(audio);
      row.appendChild(note);
      row.appendChild(extras);
      row.appendChild(left);
      row.appendChild(pill);
      var seek = slider(30, function (ratio) {
        var target = focus();
        if (!target || !isFinite(target.duration) || !target.duration) return;
        target.currentTime = ratio * target.duration;
        paint(target);
      });
      // The small player's button in the top left corner, full screen in the top right.
      floatButton.style.cssText += ';position:absolute;top:8px;left:10px';
      fullButton.style.cssText += ';position:absolute;top:8px;right:10px';
      card.appendChild(floatButton);
      card.appendChild(fullButton);
      // The list a group's button opens, above the panel.
      var menu = make('div',
        'display:none;position:absolute;right:0;bottom:calc(100% + 8px);max-height:40vh;overflow-y:auto;' +
        'border-radius:14px;background:rgba(0,0,0,.85);color:#fff;pointer-events:auto;' +
        '-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px)');
      menu.__group = -1;
      card.appendChild(menu);
      card.appendChild(transport);
      card.appendChild(row);
      card.appendChild(seek.track);
      root.appendChild(card);
      ['click', 'touchstart', 'touchmove', 'touchend'].forEach(function (name) {
        root.addEventListener(name, function (event) { event.stopPropagation(); });
      });
      parent.appendChild(root);
      ui = {
        root: root, toggle: toggle, mute: mute, cc: cc, audio: audio, note: note, extras: extras, menu: menu, left: left, pill: pill, seek: seek
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
      var texts = textTracksOf(video);
      var showing = texts.filter(function (track) { return track.mode === 'showing'; })[0];
      syncOptions(video);
      var kinds = optionGroups.groups.map(function (group) { return group.kind; });
      ui.cc.style.display = texts.length && kinds.indexOf('captions') < 0 ? 'flex' : 'none';
      ui.cc.style.opacity = showing ? '1' : '.45';
      var audios = audioTracksOf(video);
      var heard = audios.filter(function (track) { return track.enabled; })[0];
      ui.audio.style.display = audios.length && kinds.indexOf('audio') < 0 ? 'flex' : 'none';
      ui.note.textContent = (showing && showing.label) || (heard && heard.label) || '';
    }

    function hide() {
      shown = false;
      closeMenu();
      clearTimeout(hideTimer);
      if (ui) {
        ui.root.style.display = 'none';
      }
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
      syncRefreshHold();
      if (active()) {
        allVideos().forEach(prepare);
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
      var parts = build(video);
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
      return !!(hit && hit.closest && hit.closest('[data-openmedia-controls],[data-openmedia-mini]'));
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
    // A tap is also found from the pointer, which players that act on its release see before the
    // touch ends. The press itself is always the site's: a drag, a hold or a swipe needs it whole,
    // and a player that does something on it (toggles the sound) is undone by `restoreMute`.
    // A press on the video makes some players flash an icon at its centre (Instagram's sound badge
    // on every tap). The press is theirs, so the icon is hidden instead: whatever small, visible
    // thing sits near the video's centre for the next moment gets no opacity, then its own back.
    // (It cannot be found by what it is made of or by where it is hit: it is a plain badge that
    // takes no pointer.)
    function quietPop(video) {
      var hidden = [];
      var until = Date.now() + POP_MS;
      var stopped = false;
      var restore = function () {
        hidden.forEach(function (entry) {
          try {
            if (entry.value) entry.el.style.setProperty('opacity', entry.value, entry.priority);
            else entry.el.style.removeProperty('opacity');
            if (entry.seen) entry.el.style.setProperty('visibility', entry.seen, entry.seenPriority);
            else entry.el.style.removeProperty('visibility');
          } catch (_) {}
        });
        hidden = [];
      };
      var step = function () {
        if (stopped) return;
        try {
          var box = boxOf(video);
          var width = box.right - box.left;
          var height = box.bottom - box.top;
          var cx = (Math.max(box.left, 0) + Math.min(box.right, window.innerWidth || box.right)) / 2;
          var cy = (Math.max(box.top, 0) + Math.min(box.bottom, window.innerHeight || box.bottom)) / 2;
          var all = document.querySelectorAll('body *');
          for (var i = 0; i < all.length && i < POP_SCAN; i++) {
            var el = all[i];
            if (el === video || (el.contains && el.contains(video))) continue;
            var rect = el.getBoundingClientRect();
            if (rect.width < POP_MIN || rect.width > width * POP_SHARE || rect.height > height * POP_SHARE) continue;
            if (Math.abs((rect.left + rect.right) / 2 - cx) > width * 0.2) continue;
            if (Math.abs((rect.top + rect.bottom) / 2 - cy) > height * 0.2) continue;
            if (inPanel(el)) continue;
            if (hidden.some(function (entry) { return entry.el === el; })) continue;
            var look = getComputedStyle(el);
            if (Number(look.opacity) < 0.02 || look.visibility === 'hidden') continue;
            hidden.push({
              el: el,
              value: el.style.getPropertyValue('opacity'),
              priority: el.style.getPropertyPriority('opacity'),
              seen: el.style.getPropertyValue('visibility'),
              seenPriority: el.style.getPropertyPriority('visibility')
            });
            el.style.setProperty('opacity', '0', 'important');
            el.style.setProperty('visibility', 'hidden', 'important');
          }
        } catch (_) {}
        if (Date.now() < until) {
          setTimeout(step, POP_STEP_MS);
          return;
        }
        restore();
      };
      step();
      // A press that turns into a swipe stops it at once: nothing is left hidden, nothing scanned.
      return function () {
        stopped = true;
        restore();
      };
    }

    function onPointerDown(event) {
      pointerFrom = null;
      awaitTapEnd = false;
      awaitTapClick = false;
      if (event.isPrimary === false || inPanel(event.target)) return;
      noteMute(true);
      var pressed = videoAt(event.clientX, event.clientY, event.target);
      if (popStop) popStop();
      popStop = pressed ? quietPop(pressed) : null;
      pointerFrom = { x: event.clientX, y: event.clientY, time: Date.now(), target: event.target };
    }

    function onPointerMove(event) {
      var from = pointerFrom;
      if (!from || !popStop) return;
      if (Math.hypot(event.clientX - from.x, event.clientY - from.y) > TAP_SLOP) {
        popStop();
        popStop = null;
      }
    }

    function onPointerCancel(event) {
      // Not the one this script sends to the site after a tap.
      if (event.isTrusted === false) return;
      if (popStop) popStop();
      popStop = null;
    }

    function onPointerUp(event) {
      var from = pointerFrom;
      pointerFrom = null;
      if (!from || inPanel(event.target) || Date.now() - from.time > TAP_MAX_MS) return;
      if (Math.hypot(event.clientX - from.x, event.clientY - from.y) > TAP_SLOP) return;
      if (!tapAt(event.clientX, event.clientY, event.target, event)) return;
      awaitTapEnd = true;
      awaitTapClick = true;
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
      awaitTapEnd = false;
      awaitTapClick = false;
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
      // The touch of a tap the pointer already took only gets swallowed, once.
      if (awaitTapEnd) {
        awaitTapEnd = false;
        event.stopImmediatePropagation();
        if (event.cancelable) event.preventDefault();
        cancelForSite(event);
        return;
      }
      var last = event.changedTouches && event.changedTouches[0];
      if (!from || !last || Date.now() - from.time > TAP_MAX_MS) return;
      if (Math.hypot(last.clientX - from.x, last.clientY - from.y) > TAP_SLOP) return;
      if (tapAt(last.clientX, last.clientY, event.target, event)) {
        awaitTapClick = true;
        cancelForSite(event);
      }
    }

    function onClick(event) {
      // A touch ends with a click a moment after the release, at the same spot. A button that took
      // the release and went away (the player closing, the panel hiding) leaves that click to
      // whatever is under the finger now: a link, a thumbnail, the next video.
      if (Date.now() < ghostUntil) {
        event.stopImmediatePropagation();
        if (event.cancelable) event.preventDefault();
        return;
      }
      if (inPanel(event.target)) {
        event.stopImmediatePropagation();
        return;
      }
      // The click a tap the panel took would have made is swallowed, once.
      if (awaitTapClick) {
        awaitTapClick = false;
        event.stopImmediatePropagation();
        if (event.cancelable) event.preventDefault();
        return;
      }
      tapAt(event.clientX, event.clientY, event.target, event);
    }

    function tapped() { lastTap = Date.now(); }

    // Presses a script makes (the menu rules click the site's own controls, a site may too) are not
    // the reader's, and must not show or hide the panel.
    function trusted(handler) {
      return function (event) {
        if (event.isTrusted === false) return;
        return handler.apply(this, arguments);
      };
    }

    function on(target, name, handler, options) {
      target.addEventListener(name, handler, options);
      teardown.push(function () { target.removeEventListener(name, handler, options); });
    }

    on(document, 'touchend', trusted(tapped), { capture: true, passive: true });
    on(document, 'click', trusted(tapped), { capture: true, passive: true });
    on(window, 'pointerdown', trusted(onPointerDown), { capture: true, passive: true });
    on(window, 'pointermove', trusted(onPointerMove), { capture: true, passive: true });
    on(window, 'pointercancel', trusted(onPointerCancel), { capture: true, passive: true });
    on(window, 'pointerup', trusted(onPointerUp), { capture: true });
    on(window, 'message', onFrameMessage, { capture: true, passive: true });
    on(window, 'touchstart', trusted(dragStart), { capture: true, passive: true });
    on(window, 'touchmove', trusted(dragMove), { capture: true, passive: false });
    on(window, 'touchend', trusted(function (event) { dragEnd(event, false); }), { capture: true, passive: false });
    on(window, 'touchcancel', trusted(function (event) { dragEnd(event, true); }), { capture: true, passive: false });
    on(window, 'touchstart', trusted(onTouchStart), { capture: true, passive: true });
    on(window, 'touchmove', trusted(keepFromSite), { capture: true, passive: true });
    on(window, 'touchend', trusted(onTouchEnd), { capture: true });
    on(window, 'click', trusted(onClick), { capture: true });
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

    Object.defineProperty(document, MINI_CLOSE, {
      configurable: true,
      value: miniOff
    });

    Object.defineProperty(document, MINI_WINDOW, {
      configurable: true,
      value: miniWindow
    });

    Object.defineProperty(document, KEY, {
      configurable: true,
      value: function () {
        clearInterval(timer);
        clearTimeout(hideTimer);
        miniOff();
        delete document[MINI_WINDOW];
        delete document[MINI_CLOSE];
        delete document[REFRESH_HOLD];
        observers.forEach(function (observer) { observer.disconnect(); });
        teardown.forEach(function (step) { try { step(); } catch (_) {} });
        if (ui && ui.root.parentNode) ui.root.parentNode.removeChild(ui.root);
        delete document[KEY];
      }
    });
  } catch (_) {}
})
