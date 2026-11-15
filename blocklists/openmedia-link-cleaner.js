// Cleans a link when the user follows it: removes tracking query parameters and replaces a
// redirect-tracker address with the page it redirects to.
//
// Runs in the page's main world at document start, in the main frame only. Rust prepends
// `window.__openmediaLinkRules` (Brave's query-filter, clean-urls and debounce data, see
// blocklists/README.md); this file reads and deletes it before the page can run.
//
// It acts only on a click the user made and only by rewriting the link's own `href` before the
// browser follows it. It never navigates, clicks or requests anything itself. Typed addresses,
// redirects the server sends and navigation the page's own script starts are not touched.
(function () {
  "use strict";
  const rules = window.__openmediaLinkRules;
  delete window.__openmediaLinkRules;
  if (window.top !== window || !rules) return;

  // A redirect-tracker can point at another one. Three hops end every real chain and bound a loop.
  const MAX_HOPS = 3;

  // Brave's patterns are Chrome match patterns: `scheme://host/path`, `*` as scheme means
  // http or https, a leading `*.` on the host means the host and any subdomain, and `*` elsewhere
  // matches anything. They are compiled on first use.
  function patternToRegExp(pattern) {
    const split = pattern.indexOf("://");
    if (split < 0) return null;
    const scheme = pattern.slice(0, split);
    const rest = pattern.slice(split + 3);
    const slash = rest.indexOf("/");
    let host = slash < 0 ? rest : rest.slice(0, slash);
    const path = slash < 0 ? "/*" : rest.slice(slash);
    const escape = (text) => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    let hostSource;
    if (host === "*") {
      hostSource = "[^/]*";
    } else {
      let prefix = "";
      if (host.startsWith("*.")) {
        prefix = "(?:[^/]*\\.)?";
        host = host.slice(2);
      }
      hostSource = prefix + escape(host).replace(/\.\*/g, "[^/]*");
    }
    const schemeSource = scheme === "*" ? "https?" : escape(scheme);
    try {
      return new RegExp("^" + schemeSource + "://" + hostSource + escape(path) + "$", "i");
    } catch {
      return null;
    }
  }

  function compile(patterns) {
    return (patterns || []).map(patternToRegExp).filter(Boolean);
  }

  function ready(rule) {
    if (!rule.compiled) {
      rule.compiled = { include: compile(rule.include), exclude: compile(rule.exclude) };
    }
    return rule.compiled;
  }

  function applies(rule, href) {
    const { include, exclude } = ready(rule);
    return include.some((re) => re.test(href)) && !exclude.some((re) => re.test(href));
  }

  function parse(href) {
    try {
      const url = new URL(href);
      return url.protocol === "http:" || url.protocol === "https:" ? url : null;
    } catch {
      return null;
    }
  }

  function decode(text) {
    try {
      return decodeURIComponent(text);
    } catch {
      return text;
    }
  }

  function fromBase64(value) {
    try {
      const standard = value.replace(/-/g, "+").replace(/_/g, "/");
      return atob(standard + "=".repeat((4 - (standard.length % 4)) % 4));
    } catch {
      return null;
    }
  }

  // The address a redirect-tracker link leads to, or null. Rules that depend on a user
  // preference in Brave (`pref`, such as leaving AMP pages) are not ours to apply.
  function debounced(href) {
    const url = parse(href);
    if (!url) return null;
    for (const rule of rules.debounce || []) {
      if (rule.pref || !applies(rule, href)) continue;
      let target = null;
      if (rule.action === "redirect" || rule.action === "base64,redirect") {
        const value = url.searchParams.get(rule.param);
        if (value) target = rule.action === "redirect" ? value : fromBase64(value);
      } else if (rule.action === "regex-path") {
        let match = null;
        try {
          match = new RegExp(rule.param).exec(url.pathname);
        } catch {
          match = null;
        }
        if (match && match[1]) target = decode(match[1]);
      }
      if (!target) continue;
      if (rule.prepend_scheme && !/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
        target = rule.prepend_scheme + "://" + target;
      }
      if (parse(target) && target !== href) return target;
    }
    return null;
  }

  function stripped(href) {
    const url = parse(href);
    if (!url || !url.search) return href;
    const names = new Set();
    for (const rule of rules.strip || []) {
      if (applies(rule, href)) for (const name of rule.params) names.add(name);
    }
    if (names.size === 0) return href;
    const pairs = url.search.slice(1).split("&");
    const kept = pairs.filter((pair) => {
      const name = pair.split("=")[0];
      return !names.has(name) && !names.has(decode(name));
    });
    if (kept.length === pairs.length) return href;
    url.search = kept.join("&");
    return url.href;
  }

  function clean(href) {
    let current = href;
    for (let hop = 0; hop < MAX_HOPS; hop += 1) {
      const target = debounced(current);
      if (target === null) break;
      current = target;
    }
    return stripped(current);
  }

  function onFollow(event) {
    const start = event.target;
    const link = start && start.closest ? start.closest("a[href], area[href]") : null;
    if (!link || typeof link.href !== "string") return;
    const href = link.href;
    const cleaned = clean(href);
    if (cleaned !== href) link.href = cleaned;
  }

  // Capture phase, so the page's own handlers and the browser's navigation see the clean link.
  window.addEventListener("click", onFollow, true);
  window.addEventListener("auxclick", onFollow, true);
})();
