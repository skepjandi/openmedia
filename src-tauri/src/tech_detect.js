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
    var nodes = document.querySelectorAll(selector);
    for (var i = 0; i < nodes.length && list.length < max; i++) {
      var value = nodes[i].getAttribute(name);
      if (value) list.push(value.slice(0, length));
    }
    return list;
  }
  var generator = document.querySelector('meta[name="generator" i]');
  var cookies = [];
  try {
    cookies = document.cookie.split(';').map(function (c) { return c.split('=')[0].trim(); }).slice(0, 100);
  } catch (e) {}
  return {
    globals: probes.globals.filter(has),
    selectors: probes.selectors.filter(matches),
    urls: attrs('script[src]', 'src', 300, 300).concat(attrs('link[href]', 'href', 150, 300)),
    generator: generator ? (generator.getAttribute('content') || '').slice(0, 200) : '',
    cookies: cookies,
  };
})(__PROBES__)
