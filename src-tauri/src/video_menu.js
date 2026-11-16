// The runtime of a recipe's `videoMenu` rules: the option lists of a site's own player (quality,
// captions, audio) for the video controls' panel, read from and driven through the site's own menu.
// It is a function expression the page script calls with the rules; no recipe code runs in it.
// The groups are offered at `document[Symbol.for('openmedia.videoMenus')](video)`.
function (menus) {
  'use strict';
  var KEY = Symbol.for('openmedia.videoMenus');
  var STEP_WAIT_MS = 700; // how long a menu entry may take to appear after a click
  var POLL_MS = 60;
  var RESCAN_MS = 4000; // the least time between two openings of a menu for the same video
  var OFF = /^(false|0|off|no|unchecked|inactive)$/i;
  var ON_STATE = /^(checked|active|on|selected|true)$/i;

  var states = menus.map(function () { return { items: [], key: null, busy: false, at: 0 }; });

  function all(css) {
    try { return Array.prototype.slice.call(document.querySelectorAll(css)); } catch (_) { return []; }
  }

  function first(css) { return all(css)[0] || null; }

  // The press a person makes: the events a site's own handlers listen for, in their order.
  function press(element) {
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (type) {
      try {
        var Event = type.indexOf('pointer') === 0 && window.PointerEvent ? window.PointerEvent : window.MouseEvent;
        element.dispatchEvent(new Event(type, { bubbles: true, cancelable: true, view: window }));
      } catch (_) {}
    });
  }

  // Resolves with whatever `find` returns once it is truthy, or null after the wait.
  function until(find, ms) {
    return new Promise(function (resolve) {
      var waited = 0;
      (function look() {
        var found = null;
        try { found = find(); } catch (_) {}
        if (found && (!Array.isArray(found) || found.length)) return resolve(found);
        waited += POLL_MS;
        if (waited > ms) return resolve(null);
        setTimeout(look, POLL_MS);
      })();
    });
  }

  function labelOf(element) {
    return String(element.textContent || element.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  }

  function selectedOf(element, selected) {
    try {
      if (selected.class) return element.classList.contains(selected.class);
      var value = element.getAttribute(selected.attr);
      if (value === null) return false;
      if (selected.attr === 'data-state') return ON_STATE.test(value);
      return !OFF.test(value);
    } catch (_) { return false; }
  }

  function read(rule) {
    return all(rule.items).map(function (element) {
      return { label: labelOf(element), selected: selectedOf(element, rule.selected) };
    }).filter(function (item) { return item.label; });
  }

  // Opens the menu by pressing each step in turn, as a person would. Resolves with the element that
  // opened it first (to close it the same way), or true when it was open already, or null.
  function open(rule) {
    if (all(rule.items).length) return Promise.resolve(true);
    var opener = null;
    var chain = Promise.resolve(true);
    rule.open.forEach(function (css) {
      chain = chain.then(function (ok) {
        if (!ok) return null;
        return until(function () { return first(css); }, STEP_WAIT_MS).then(function (element) {
          if (!element) return null;
          if (!opener) opener = element;
          press(element);
          return true;
        });
      });
    });
    return chain.then(function (ok) {
      if (!ok) return null;
      return until(function () { return all(rule.items); }, STEP_WAIT_MS).then(function (found) {
        return found ? (opener || true) : null;
      });
    });
  }

  function close(rule, opener) {
    var closer = rule.close ? first(rule.close) : (opener && opener !== true ? opener : null);
    if (closer && all(rule.items).length) press(closer);
  }

  function scan(index, key) {
    var rule = menus[index];
    var state = states[index];
    if (state.busy) return;
    state.busy = true;
    state.at = Date.now();
    open(rule).then(function (opener) {
      if (opener) {
        state.items = read(rule);
        state.key = key;
        close(rule, opener);
      }
    }).catch(function () {}).then(function () { state.busy = false; });
  }

  function pick(index, at) {
    var rule = menus[index];
    var state = states[index];
    if (state.busy) return;
    state.busy = true;
    open(rule).then(function (opener) {
      if (!opener) return;
      var element = all(rule.items)[at];
      if (element) press(element);
      if (rule.close) setTimeout(function () { close(rule, opener); }, 150);
    }).catch(function () {}).then(function () {
      state.busy = false;
      state.key = null;
      state.at = 0;
    });
  }

  document[KEY] = function (video) {
    var key = (video && video.currentSrc) || '';
    var groups = [];
    menus.forEach(function (rule, index) {
      var state = states[index];
      // A menu the person opened themselves is read as it stands.
      if (!state.busy && all(rule.items).length) {
        state.items = read(rule);
        state.key = key;
      } else if (!state.busy && state.key !== key && Date.now() - state.at > RESCAN_MS) {
        scan(index, key);
      }
      if (state.items.length) {
        groups.push({
          kind: rule.kind,
          label: rule.title,
          items: state.items,
          select: function (at) { pick(index, at); }
        });
      }
    });
    return groups;
  };
}
