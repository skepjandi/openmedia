(function () {
  'use strict';
  var MAX_NODES = 600;
  var MAX_DEPTH = 14;
  var MAX_VISIT = 4000;
  var MAX_CHARS = 120000;
  var MAX_CHAIN = 8;
  var PREVIEW_ID = 'openmedia-ai-preview';
  var SKIP = { script: 1, style: 1, noscript: 1, template: 1, link: 1, meta: 1, head: 1, title: 1, base: 1, br: 1, wbr: 1 };
  var LEAF = { svg: 1, canvas: 1, iframe: 1, video: 1, audio: 1, object: 1, embed: 1, input: 1, textarea: 1, select: 1 };
  var TEXT_TAGS = { a: 1, button: 1, h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1, summary: 1, label: 1 };
  var STABLE_DATA = { 'data-testid': 1, 'data-e2e': 1, 'data-pagelet': 1, 'data-test-selector': 1, 'data-interaction': 1, 'data-click-id': 1, 'data-component': 1 };
  var SENSITIVE = /(token|secret|key|auth|session|email|phone|user|pass|csrf|nonce|sig)/i;
  var TAILWIND = /^(text|bg|px|py|pt|pb|pl|pr|p|m|mx|my|mt|mb|ml|mr|w|h|min|max|flex|grid|gap|items|justify|self|border|rounded|font|leading|tracking|shadow|z|top|left|right|bottom|inset|space|overflow|opacity|cursor|hover|focus|sm|md|lg|xl|css|r|jsx|sc|emotion|chakra|svelte|wbloks|tw)[-_]/i;

  var size = 0;

  function generated(s) {
    var digits = (s.match(/\d/g) || []).length;
    if (digits >= 3) return true;
    if (/^[0-9a-f]{6,}$/i.test(s.replace(/[-_]/g, ''))) return true;
    return /[a-z]{1,3}\d[a-z\d]{3,}/i.test(s) && s.length < 14;
  }
  function stableId(id) {
    return id.length <= 32 && /^[A-Za-z][A-Za-z0-9_-]*$/.test(id) && !generated(id) && !/^[A-Za-z]{1,2}-?[a-z0-9]{6,}$/.test(id) ? id : null;
  }
  function hashy(suffix) {
    return /\d/.test(suffix) || /[a-z][A-Z]/.test(suffix);
  }
  // Class names are never sent as-is. Only human-authored compound names survive; a trailing
  // "_hash" (CSS modules) is replaced by "*" so the model knows to use [class*="prefix"].
  function className(c) {
    var star = '';
    var m = /_([A-Za-z0-9]{5,})$/.exec(c);
    if (m && hashy(m[1])) {
      c = c.slice(0, c.length - m[0].length).replace(/_+$/, '');
      star = '*';
    }
    if (c.length < 6 || c.length > 40) return null;
    if (!/^[A-Za-z][A-Za-z0-9]*([-_]+[A-Za-z0-9]+)+$/.test(c)) return null;
    if (TAILWIND.test(c) || generated(c)) return null;
    var parts = c.split(/[-_]+/);
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].length >= 5 && /\d/.test(parts[i]) && /[A-Za-z]/.test(parts[i])) return null;
    }
    return c + star;
  }
  function dataValue(name, value) {
    var limit = STABLE_DATA[name] ? 40 : 24;
    if (!value || value.length > limit) return '';
    if (/[^\w .:\/-]/.test(value)) return '';
    if (/[0-9a-f]{8,}/i.test(value.replace(/[-_]/g, '')) || /\d{5,}/.test(value)) return '';
    return value;
  }
  function pathOf(href) {
    if (!href) return null;
    var m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(href);
    if (m && !/^https?$/i.test(m[1])) {
      var s = m[1].toLowerCase();
      return /^(javascript|data|blob|about|file)$/.test(s) ? null : s + ':' + (/^[a-z0-9+.-]+:\/\//i.test(href) ? '//' : '');
    }
    try {
      var u = new URL(href, location.href);
      if (u.origin === location.origin) return u.pathname.slice(0, 80);
      return '//' + u.hostname.slice(0, 80);
    } catch (e) {
      return null;
    }
  }
  function shortText(el) {
    var walker = document.createTreeWalker(el, 4, null);
    var out = '';
    var n;
    while ((n = walker.nextNode())) {
      var p = n.parentNode && n.parentNode.localName;
      if (p === 'script' || p === 'style' || p === 'textarea' || p === 'noscript') continue;
      // What the user is typing is never page content.
      if (n.parentNode && n.parentNode.isContentEditable) continue;
      out += ' ' + n.nodeValue;
      if (out.length > 200) return null;
    }
    out = out.replace(/\s+/g, ' ').trim();
    return out && out.length <= 40 ? out : null;
  }
  function add(node, key, value, cost) {
    node[key] = value;
    size += cost;
  }
  function describe(el, cs, vp) {
    var tag = el.localName;
    var node = { t: tag };
    size += tag.length + 8;
    var role = el.getAttribute('role');
    if (role && /^[a-z-]{1,30}$/.test(role)) add(node, 'r', role, role.length + 8);
    var label = el.getAttribute('aria-label');
    if (label && label.length <= 60) add(node, 'l', label.replace(/\s+/g, ' ').trim(), label.length + 8);
    var id = el.id ? stableId(el.id) : null;
    if (id) add(node, 'i', id, id.length + 8);
    if (tag === 'a' || tag === 'area') {
      var href = pathOf(el.getAttribute('href'));
      if (href) add(node, 'h', href, href.length + 8);
    }
    var data = [];
    var attrs = el.attributes;
    for (var i = 0; i < attrs.length && data.length < 8; i++) {
      var name = attrs[i].name;
      if (name.indexOf('data-') !== 0 || name.length > 30 || !/^data-[a-z0-9-]+$/.test(name)) continue;
      if (!STABLE_DATA[name] && (generated(name.slice(5)) || SENSITIVE.test(name))) continue;
      data.push([name, SENSITIVE.test(name) ? '' : dataValue(name, attrs[i].value)]);
      size += name.length + data[data.length - 1][1].length + 8;
    }
    if (data.length) node.d = data;
    var classes = [];
    var list = el.classList;
    for (var j = 0; j < list.length && classes.length < 4; j++) {
      var cn = className(list[j]);
      if (cn && classes.indexOf(cn) < 0) classes.push(cn);
    }
    if (classes.length) {
      node.c = classes;
      size += classes.join('.').length + 8;
    }
    if ((TEXT_TAGS[tag] || role) && !el.isContentEditable) {
      var text = shortText(el);
      if (text) add(node, 'x', text, text.length + 8);
    }
    var pos = cs.position;
    if (pos === 'fixed' || pos === 'sticky') {
      var r = el.getBoundingClientRect();
      var big = r.width * r.height >= 0.25 * vp.w * vp.h;
      node.f = big ? [pos, 'overlay'] : [pos];
      size += 24;
    }
    return node;
  }
  function bare(n) {
    for (var k in n) {
      if (k !== 't' && k !== 'k') return false;
    }
    return true;
  }
  function collapse(n) {
    if (n.k) {
      for (var i = 0; i < n.k.length; i++) n.k[i] = collapse(n.k[i]);
    }
    if (n.k && n.k.length === 1 && bare(n) && n.t.split('>').length < MAX_CHAIN) {
      var c = n.k[0];
      c.t = n.t + '>' + c.t;
      return c;
    }
    return n;
  }

  var preview = document.getElementById(PREVIEW_ID);
  var restore = false;
  if (preview && preview.sheet && !preview.sheet.disabled) {
    preview.sheet.disabled = true;
    restore = true;
  }
  try {
    var body = document.body || document.documentElement;
    var vp = { w: window.innerWidth || 0, h: window.innerHeight || 0 };
    var rootStyle = getComputedStyle(body);
    var html = getComputedStyle(document.documentElement);
    var root = describe(body, rootStyle, vp);
    root.k = [];
    var queue = [{ el: body, node: root, depth: 0 }];
    var count = 1;
    var visits = 0;
    var truncated = false;
    for (var qi = 0; qi < queue.length; qi++) {
      var cur = queue[qi];
      if (LEAF[cur.el.localName]) continue;
      var kids = cur.el.children;
      var elided = 0;
      for (var ci = 0; ci < kids.length; ci++) {
        var c = kids[ci];
        var tag = c.localName;
        if (!tag || SKIP[tag] || c.hidden) continue;
        if (++visits > MAX_VISIT) {
          elided++;
          continue;
        }
        if (tag === 'input' && String(c.type).toLowerCase() === 'password') continue;
        var cs = getComputedStyle(c);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        if (cur.depth + 1 > MAX_DEPTH || count >= MAX_NODES || size > MAX_CHARS) {
          elided++;
          continue;
        }
        var node = describe(c, cs, vp);
        node.k = [];
        cur.node.k.push(node);
        count++;
        queue.push({ el: c, node: node, depth: cur.depth + 1 });
      }
      if (elided) {
        cur.node.n = elided;
        truncated = true;
      }
    }
    (function prune(n) {
      if (n.k.length) {
        for (var i = 0; i < n.k.length; i++) prune(n.k[i]);
      } else {
        delete n.k;
      }
    })(root);
    root = collapse(root);
    return {
      v: 1,
      host: location.hostname,
      path: location.pathname,
      w: vp.w,
      vw: vp.w < 600 ? 'phone' : vp.w < 1024 ? 'tablet' : 'desktop',
      sl: /hidden|clip/.test(rootStyle.overflowY) || /hidden|clip/.test(html.overflowY),
      tr: truncated,
      root: root
    };
  } finally {
    if (restore) preview.sheet.disabled = false;
  }
})()
