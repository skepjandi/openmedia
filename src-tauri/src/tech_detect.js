(function (probes) {
  function has(path) {
    try {
      var o = window;
      var parts = path.split('.');
      for (var i = 0; i < parts.length; i++) {
        if (o === null || o === undefined) return false;
        o = o[parts[i]];
        if (o === undefined) return false;
      }
      return true;
    } catch (e) {
      return false;
    }
  }
  function matches(selector) {
    try {
      return document.querySelector(selector) !== null;
    } catch (e) {
      return false;
    }
  }
  function attrs(selector, name, max, length) {
    var list = [];
    try {
      var nodes = document.querySelectorAll(selector);
      for (var i = 0; i < nodes.length && list.length < max; i++) {
        var value = nodes[i].getAttribute(name);
        if (value && value.indexOf('data:') !== 0 && value.indexOf('blob:') !== 0) {
          list.push(value.slice(0, length));
        }
      }
    } catch (e) {}
    return list;
  }
  // Addresses of everything the page loaded, including scripts and requests that its own code
  // added after the markup: the page's tags alone miss most of them on a bundled site.
  function resources() {
    try {
      return performance
        .getEntriesByType('resource')
        .slice(0, 500)
        .map(function (entry) { return String(entry.name).slice(0, 300); });
    } catch (e) {
      return [];
    }
  }
  // Which of the known prefixes a library leaves as a property on the elements it renders into
  // (React keeps its root under `__reactContainer$...`, Vue under `__vue_app__`).
  function expandos() {
    var found = [];
    try {
      // The page's top levels: the element a framework renders into is usually one of the first
      // two levels under <body> (`#root`, `#app`, a generated `mount_...` id).
      var roots = [document.documentElement, document.body];
      var tops = document.body ? Array.prototype.slice.call(document.body.children, 0, 12) : [];
      roots = roots.concat(tops);
      tops.forEach(function (top) {
        roots = roots.concat(Array.prototype.slice.call(top.children, 0, 8));
      });
      ['root', 'app', '__next', '__nuxt'].forEach(function (id) {
        roots.push(document.getElementById(id));
      });
      roots.forEach(function (el) {
        if (!el) return;
        var keys = Object.keys(el).slice(0, 60);
        probes.expandos.forEach(function (prefix) {
          if (found.indexOf(prefix) < 0 && keys.some(function (k) { return k.indexOf(prefix) === 0; })) {
            found.push(prefix);
          }
        });
      });
    } catch (e) {}
    return found;
  }
  // Custom properties a framework's stylesheet defines on the root.
  function props() {
    try {
      var style = getComputedStyle(document.documentElement);
      return probes.props.filter(function (name) {
        return style.getPropertyValue(name).trim() !== '';
      });
    } catch (e) {
      return [];
    }
  }
  var generator = null;
  try {
    generator = document.querySelector('meta[name="generator" i]');
  } catch (e) {}
  var cookies = [];
  try {
    cookies = document.cookie.split(';').map(function (c) { return c.split('=')[0].trim(); }).slice(0, 100);
  } catch (e) {}
  return {
    globals: probes.globals.filter(has),
    selectors: probes.selectors.filter(matches),
    urls: attrs('script[src]', 'src', 300, 300)
      .concat(attrs('link[href]', 'href', 150, 300))
      .concat(resources()),
    generator: generator ? String(generator.getAttribute('content') || '').slice(0, 200) : '',
    cookies: cookies,
    expandos: expandos(),
    props: props(),
  };
})(__PROBES__)
