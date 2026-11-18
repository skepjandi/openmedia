// The runtime of a recipe's `sponsorBlock` and `dislikeCount` rules. Both ask one public
// crowd-sourced service about the video whose id is in the page's address, and change only what
// the reader sees: sponsor segments are skipped once each, and an estimated dislike count is
// written next to the site's dislike button. It is a function expression the page script calls
// with the rules (see `recipes/crowd.rs`); no recipe code runs in it.
//
// What it sends, and only when its rule applies: one GET with no cookies, no referrer and no
// custom headers.
//   sponsorBlock  -> sponsor.ajay.app, the first four hex digits of the SHA-256 of the video id
//                    (the service's k-anonymity scheme: it never sees the id itself), the
//                    categories the rule lists, and `actionTypes=["skip"]`.
//   dislikeCount  -> returnyoutubedislikeapi.com, the video id (the service has no hashed form).
// Both hosts are fixed here; a rule cannot name another.
//
// What it never does: send anything else, read or write storage or cookies, touch the site's
// requests, click, or change a control of the site. A segment is skipped once per page view of the
// video, so seeking back into it plays it. Calling it again replaces the rules (an empty list
// switches everything off and removes what it added); it never starts a second timer.
function (rules) {
  'use strict';
  if (window.top !== window) return;
  var KEY = Symbol.for('openmedia.crowd');
  var SPONSOR_API = 'https://sponsor.ajay.app/api/skipSegments/';
  var DISLIKE_API = 'https://returnyoutubedislikeapi.com/votes?videoId=';
  var ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
  var MARK = 'data-openmedia-dislikes';
  var TICK_MS = 500;
  var END_SLACK = 0.05;
  var DURATION_SLACK = 5;

  var state = window[KEY];
  if (state) {
    state.set(rules);
    return;
  }
  state = { set: set };
  Object.defineProperty(window, KEY, { value: state, configurable: true });

  var active = [];
  var timer = 0;

  function set(list) {
    active = (list || []).map(function (rule) {
      return { rule: rule, id: null, segments: [], skipped: [], count: null };
    });
    clearMarks();
    if (active.length && !timer) {
      timer = window.setInterval(tick, TICK_MS);
      document.addEventListener('timeupdate', onTime, true);
    } else if (!active.length && timer) {
      window.clearInterval(timer);
      timer = 0;
      document.removeEventListener('timeupdate', onTime, true);
    }
    tick();
  }

  function clearMarks() {
    try {
      document.querySelectorAll('[' + MARK + ']').forEach(function (node) { node.remove(); });
    } catch (_) {}
  }

  // The video id the page's address holds for this rule, or null when this is not a video page.
  function videoIdOf(rule) {
    var found = null;
    if (rule.videoId.query) {
      found = new URLSearchParams(window.location.search).get(rule.videoId.query);
    } else if (rule.videoId.afterSegment) {
      var parts = window.location.pathname.split('/');
      var at = parts.indexOf(rule.videoId.afterSegment);
      if (at >= 0) found = parts[at + 1] || null;
    }
    return found && ID_PATTERN.test(found) ? found : null;
  }

  function tick() {
    active.forEach(function (entry) {
      try {
        var id = videoIdOf(entry.rule);
        if (id !== entry.id) {
          entry.id = id;
          entry.segments = [];
          entry.skipped = [];
          entry.count = null;
          if (entry.rule.kind === 'dislikeCount') clearMarks();
          if (id) load(entry, id);
        }
        if (entry.rule.kind === 'dislikeCount') render(entry);
      } catch (_) {}
    });
  }

  function request(url) {
    return window.fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'default' });
  }

  function load(entry, id) {
    if (entry.rule.kind === 'sponsorBlock') loadSegments(entry, id);
    else loadCount(entry, id);
  }

  function hashPrefix(id) {
    return window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(id)).then(function (buffer) {
      var hex = '';
      new Uint8Array(buffer).slice(0, 2).forEach(function (byte) {
        hex += (byte < 16 ? '0' : '') + byte.toString(16);
      });
      return hex;
    });
  }

  function loadSegments(entry, id) {
    var categories = JSON.stringify(entry.rule.categories);
    hashPrefix(id).then(function (prefix) {
      return request(SPONSOR_API + prefix + '?categories=' + encodeURIComponent(categories) +
        '&actionTypes=' + encodeURIComponent('["skip"]'));
    }).then(function (response) {
      return response.ok ? response.json() : [];
    }).then(function (videos) {
      if (entry.id !== id || !Array.isArray(videos)) return;
      var own = videos.filter(function (video) { return video && video.videoID === id; })[0];
      var segments = own && Array.isArray(own.segments) ? own.segments : [];
      entry.segments = segments.filter(function (item) {
        return item && item.actionType === 'skip' &&
          entry.rule.categories.indexOf(item.category) >= 0 &&
          Array.isArray(item.segment) && item.segment.length === 2 &&
          isFinite(item.segment[0]) && isFinite(item.segment[1]) &&
          item.segment[0] >= 0 && item.segment[1] > item.segment[0];
      }).sort(function (a, b) { return a.segment[0] - b.segment[0]; });
    }).catch(function () {});
  }

  function loadCount(entry, id) {
    request(DISLIKE_API + encodeURIComponent(id)).then(function (response) {
      return response.ok ? response.json() : null;
    }).then(function (votes) {
      if (entry.id !== id || !votes) return;
      var dislikes = votes.dislikes;
      if (typeof dislikes === 'number' && isFinite(dislikes) && dislikes >= 0) entry.count = dislikes;
    }).catch(function () {});
  }

  function format(count) {
    try {
      return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(count);
    } catch (_) {
      return String(count);
    }
  }

  // Keeps one span with the count inside the rule's target, putting it back when the site's own
  // rendering replaces the button.
  function render(entry) {
    if (entry.count === null) return;
    var host = document.querySelector(entry.rule.target);
    if (!host) return;
    var text = format(entry.count);
    var mark = host.querySelector(':scope > [' + MARK + ']');
    if (!mark) {
      mark = document.createElement('span');
      mark.setAttribute(MARK, '');
      mark.style.cssText = 'display:inline-flex;align-items:center;padding:0 12px 0 0;font:inherit;pointer-events:none';
      host.appendChild(mark);
    }
    if (mark.textContent !== text) mark.textContent = text;
  }

  // The video that is playing the page's own content: a segment applies only to a video about as
  // long as the one it was submitted for, so a short advertisement in the same player is left alone.
  function onTime(event) {
    var video = event.target;
    if (!(video instanceof HTMLVideoElement)) return;
    var now = video.currentTime;
    active.forEach(function (entry) {
      if (entry.rule.kind !== 'sponsorBlock') return;
      for (var i = 0; i < entry.segments.length; i++) {
        var item = entry.segments[i];
        var start = item.segment[0];
        var end = item.segment[1];
        if (now < start || now >= end - END_SLACK || entry.skipped.indexOf(item) >= 0) continue;
        if (!(video.duration >= end)) continue;
        if (item.videoDuration > 0 && Math.abs(video.duration - item.videoDuration) > DURATION_SLACK) continue;
        entry.skipped.push(item);
        video.currentTime = end;
        return;
      }
    });
  }

  set(rules);
}
