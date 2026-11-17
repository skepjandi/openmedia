// The runtime of a recipe's `redirect` rules: a page whose path a rule guards is sent to another
// path of the same site with `location.replace`, so the guarded address does not stay in history.
// It is a function expression the page script calls with the rules; no recipe code runs in it.
// A rule is checked on load and after every navigation the page makes without reloading
// (`pushState`, `replaceState`, `popstate`, `hashchange`). Each rule may redirect three times in
// a second; one more and it is suspended for the rest of the session, so a site that sends the
// page straight back cannot trap it in a loop. Only the top frame is redirected.
function (rules) {
  'use strict';
  if (window.top !== window) return;
  var WINDOW_MS = 1000;
  var MAX_REDIRECTS = 3;
  var STORE = '__openmedia_redirects';
  var memory = {};

  function load() {
    try {
      var saved = JSON.parse(window.sessionStorage.getItem(STORE));
      if (saved && typeof saved === 'object') return saved;
    } catch (_) {}
    return memory;
  }

  function save(state) {
    memory = state;
    try { window.sessionStorage.setItem(STORE, JSON.stringify(state)); } catch (_) {}
  }

  function applies(rule, here) {
    return rule.matchers.some(function (m) {
      return (m.scheme === '*' || m.scheme + ':' === here.protocol) &&
        new RegExp(m.host).test(here.hostname) &&
        new RegExp(m.path).test(here.pathname);
    }) && new RegExp(rule.regex).test(here.pathname) !== rule.negate;
  }

  // The same-site address of a rule's target, or null when it would lead anywhere else.
  function target(rule, here) {
    try {
      var url = new URL(rule.to, here.origin);
      return url.origin === here.origin ? url.href : null;
    } catch (_) { return null; }
  }

  // Records one redirect of the rule; false when the rule is suspended or has used its three.
  function allow(rule) {
    var state = load();
    var entry = state[rule.key] || { at: [], off: false };
    var now = Date.now();
    entry.at = entry.at.filter(function (at) { return now - at < WINDOW_MS; });
    if (entry.off || entry.at.length >= MAX_REDIRECTS) entry.off = true;
    else entry.at.push(now);
    state[rule.key] = entry;
    save(state);
    return !entry.off;
  }

  function check() {
    var here = window.location;
    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i];
      try {
        if (!applies(rule, here)) continue;
        var href = target(rule, here);
        if (href === null || href === here.href || !allow(rule)) continue;
        here.replace(href);
        return;
      } catch (_) {}
    }
  }

  ['pushState', 'replaceState'].forEach(function (name) {
    try {
      var original = window.history[name];
      window.history[name] = function () {
        var result = original.apply(this, arguments);
        check();
        return result;
      };
    } catch (_) {}
  });
  window.addEventListener('popstate', check);
  window.addEventListener('hashchange', check);
  check();
}
