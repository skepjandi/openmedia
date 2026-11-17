// The runtime of a recipe's `prune` rules: removes items from the JSON the page's own same-origin
// `fetch` and `XMLHttpRequest` calls receive, before the page's code reads them, so a feed's
// reels, suggestions or sponsored items never reach the page (CSS would only hide what is already
// loaded, playing and counted). It is a function expression the page script calls with the rules
// (see `recipes/prune.rs`); no recipe code runs in it.
//
// What it does: for a response whose request URL AND final URL are on the page's own origin, whose
// path a rule's `urls` match, whose type is JSON (or plain text that parses as JSON) and that is
// fully buffered within MAX_BYTES, it deletes what the rule's paths reach and hands the page the
// rewritten body. In every other case, and on any parse or shape failure, the page gets the
// original response untouched.
//
// What it never does: start a request, change a request (URL, method, headers, body), read a
// request body, or send anything anywhere. It reads the response the page already asked for, and
// only the page sees the rewrite.
//
// Calling it again replaces the rules (an empty list switches pruning off) and never wraps twice.
// It switches itself off after repeated unexpected failures.
function (rules) {
  'use strict';
  var KEY = Symbol.for('openmedia.prune');
  var MAX_BYTES = 2 * 1024 * 1024; // larger or chunked-past-this bodies are left alone
  var MAX_FAULTS = 5;
  var hasOwn = Object.prototype.hasOwnProperty;
  var nativeParse = JSON.parse;
  var nativeStringify = JSON.stringify;

  function compile(list) {
    var out = [];
    (list || []).forEach(function (rule) {
      try {
        out.push({
          urls: rule.urls.map(function (source) { return new RegExp(source); }),
          remove: rule.remove
        });
      } catch (_) {}
    });
    return out;
  }

  var state = window[KEY];
  if (state) {
    state.rules = compile(rules);
    state.faults = 0;
    return;
  }
  state = { rules: compile(rules), faults: 0 };
  Object.defineProperty(window, KEY, { value: state, configurable: true });

  function fault() {
    state.faults += 1;
    if (state.faults >= MAX_FAULTS) state.rules = [];
  }

  // The path of `raw` when it is on the page's own origin, else null.
  function ownPath(raw) {
    try {
      var url = new URL(String(raw), window.location.href);
      return url.origin === window.location.origin ? url.pathname : null;
    } catch (_) { return null; }
  }

  // The removals of every rule whose `urls` match this path; null when none does.
  function removalsFor(path) {
    if (path === null) return null;
    var found = [];
    state.rules.forEach(function (rule) {
      if (rule.urls.some(function (re) { return re.test(path); })) found = found.concat(rule.remove);
    });
    return found.length ? found : null;
  }

  function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

  function holds(value, when) {
    if (!when) return true;
    return isObject(value) && hasOwn.call(value, when.key) && value[when.key] === when.equals;
  }

  // Deletes what `steps` reach from `node`, from step `at`; returns how many values were removed.
  function walk(node, steps, at, when) {
    var step = steps[at];
    var last = at === steps.length - 1;
    var removed = 0;
    if (typeof step === 'number') {
      if (!Array.isArray(node) || step >= node.length) return 0;
      if (!last) return walk(node[step], steps, at + 1, when);
      if (holds(node[step], when)) { node.splice(step, 1); return 1; }
      return 0;
    }
    if (step === '*') {
      if (!Array.isArray(node)) return 0;
      for (var i = node.length - 1; i >= 0; i--) {
        if (last) {
          if (holds(node[i], when)) { node.splice(i, 1); removed += 1; }
        } else {
          removed += walk(node[i], steps, at + 1, when);
        }
      }
      return removed;
    }
    if (!isObject(node) || !hasOwn.call(node, step)) return 0;
    if (!last) return walk(node[step], steps, at + 1, when);
    if (holds(node[step], when)) { delete node[step]; return 1; }
    return 0;
  }

  // Prunes parsed JSON in place; returns how many values were removed.
  function pruneData(data, removals) {
    var removed = 0;
    removals.forEach(function (entry) { removed += walk(data, entry.steps, 0, entry.when); });
    return removed;
  }

  function jsonish(type) {
    type = String(type || '').toLowerCase();
    return type === '' || type.indexOf('json') !== -1 || type.indexOf('text/plain') === 0;
  }

  // The pruned text of `text`, or null when it is not JSON or nothing in it matched.
  function prunedText(text, removals) {
    var first = text.charAt(0);
    if (first !== '{' && first !== '[') return null;
    var data;
    try { data = nativeParse(text); } catch (_) { return null; }
    if (!data || typeof data !== 'object') return null;
    return pruneData(data, removals) ? nativeStringify(data) : null;
  }

  // Reads a cloned response's whole body when it fits in MAX_BYTES, else resolves null. Reading
  // the clone leaves the original response whole for the page.
  function bufferedText(copy) {
    var length = Number(copy.headers.get('content-length'));
    if (length > MAX_BYTES) return Promise.resolve(null);
    if (!copy.body || typeof copy.body.getReader !== 'function') {
      return copy.text().then(function (text) { return text.length > MAX_BYTES ? null : text; });
    }
    var reader = copy.body.getReader();
    var chunks = [];
    var size = 0;
    function next() {
      return reader.read().then(function (step) {
        if (step.done) {
          var bytes = new Uint8Array(size);
          var offset = 0;
          chunks.forEach(function (chunk) { bytes.set(chunk, offset); offset += chunk.length; });
          return new TextDecoder().decode(bytes);
        }
        size += step.value.length;
        if (size > MAX_BYTES) {
          try { reader.cancel(); } catch (_) {}
          return null;
        }
        chunks.push(step.value);
        return next();
      });
    }
    return next();
  }

  function rewritten(response, text) {
    var headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');
    var next = new Response(text, { status: response.status, statusText: response.statusText, headers: headers });
    try { Object.defineProperty(next, 'url', { value: response.url }); } catch (_) {}
    return next;
  }

  function prunedResponse(response, requestPath) {
    if (!response || !response.ok || (response.type !== 'basic' && response.type !== 'default')) return response;
    var path = response.url ? ownPath(response.url) : requestPath;
    var removals = removalsFor(path);
    if (!removals || !jsonish(response.headers.get('content-type'))) return response;
    return bufferedText(response.clone()).then(function (text) {
      var pruned = text === null ? null : prunedText(text, removals);
      return pruned === null ? response : rewritten(response, pruned);
    }).catch(function () { fault(); return response; });
  }

  if (typeof window.fetch === 'function' && typeof window.Response === 'function') {
    var nativeFetch = window.fetch;
    window.fetch = function () {
      var promise = nativeFetch.apply(this, arguments);
      var path = null;
      try {
        var input = arguments[0];
        path = ownPath(input && typeof input === 'object' && 'url' in input ? input.url : input);
        if (!removalsFor(path)) return promise;
      } catch (_) { fault(); return promise; }
      return promise.then(function (response) {
        try { return prunedResponse(response, path); } catch (_) { fault(); return response; }
      });
    };
  }

  var Xhr = window.XMLHttpRequest;
  if (Xhr && Xhr.prototype) {
    var opened = new WeakMap(); // the path each request was opened for
    var done = new WeakMap(); // each finished request's pruned text
    var seen = new WeakSet(); // the json objects already pruned
    var nativeOpen = Xhr.prototype.open;
    Xhr.prototype.open = function (method, url) {
      try { opened.set(this, ownPath(url)); } catch (_) { fault(); }
      done.delete(this);
      return nativeOpen.apply(this, arguments);
    };

    var xhrRemovals = function (xhr) {
      var path = opened.get(xhr);
      if (path === undefined || path === null) return null;
      if (xhr.responseURL && ownPath(xhr.responseURL) === null) return null;
      var removals = removalsFor(xhr.responseURL ? ownPath(xhr.responseURL) : path);
      var type = xhr.getResponseHeader('content-type');
      return removals && jsonish(type) ? removals : null;
    };

    var patch = function (name) {
      var descriptor = Object.getOwnPropertyDescriptor(Xhr.prototype, name);
      if (!descriptor || !descriptor.get || !descriptor.configurable) return;
      var nativeGet = descriptor.get;
      Object.defineProperty(Xhr.prototype, name, {
        configurable: true,
        enumerable: descriptor.enumerable,
        set: descriptor.set,
        get: function () {
          var value = nativeGet.call(this);
          try {
            if (this.readyState !== 4 || value === null || value === undefined) return value;
            var removals = xhrRemovals(this);
            if (!removals) return value;
            if (typeof value === 'object') {
              // responseType "json": the object the page would get, pruned in place once (an
              // index step would remove a second item if it ran again on the same object)
              if (this.responseType === 'json' && (Array.isArray(value) || isObject(value)) && !seen.has(value)) {
                seen.add(value);
                pruneData(value, removals);
              }
              return value;
            }
            if (typeof value !== 'string' || (this.responseType !== '' && this.responseType !== 'text')) return value;
            var cached = done.get(this);
            if (cached && cached.source === value) return cached.result;
            var result = value.length > MAX_BYTES ? null : prunedText(value, removals);
            var text = result === null ? value : result;
            done.set(this, { source: value, result: text });
            return text;
          } catch (_) {
            fault();
            return value;
          }
        }
      });
    };
    patch('responseText');
    patch('response');
  }
}
