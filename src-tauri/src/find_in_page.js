// Find in page: a function expression that Rust calls as `(this)(op, argument)` through the plugin's
// Rust-only `evaluate`. It reads the page's text and moves the selection; it never writes to the
// page's own markup, so a site cannot tell a search from a reader selecting text. The one element it
// adds is a <style> for the highlight colours, removed with the search.
//
// ops: "search" (argument: the text), "next", "previous", "clear".
// Answer: { count, index, capped }, `index` counting from 1 (0 when nothing matches).
(function (op, argument) {
  var KEY = Symbol.for('openmedia.find');
  var MAX_MATCHES = 1000;
  var ALL = 'openmedia-find';
  var ACTIVE = 'openmedia-find-active';
  var SKIPPED = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, TEXTAREA: 1, HEAD: 1, TITLE: 1 };

  function answer(state) {
    if (!state) return { count: 0, index: 0, capped: false };
    var count = state.ranges.length;
    return { count: count, index: count ? state.index + 1 : 0, capped: state.capped };
  }

  function highlights() {
    try {
      if (window.CSS && CSS.highlights && typeof Highlight === 'function') return CSS.highlights;
    } catch (_) {}
    return null;
  }

  function dropHighlights() {
    var registry = highlights();
    if (!registry) return;
    try {
      registry.delete(ALL);
      registry.delete(ACTIVE);
    } catch (_) {}
  }

  function clear() {
    var state = window[KEY];
    dropHighlights();
    if (state) {
      if (state.style && state.style.parentNode) state.style.parentNode.removeChild(state.style);
      if (state.selected) {
        try {
          window.getSelection().removeAllRanges();
        } catch (_) {}
      }
    }
    try {
      delete window[KEY];
    } catch (_) {
      window[KEY] = null;
    }
    return answer(null);
  }

  function isInline(element) {
    try {
      return getComputedStyle(element).display === 'inline';
    } catch (_) {
      return false;
    }
  }

  function visible(element) {
    try {
      if (typeof element.checkVisibility === 'function') return element.checkVisibility();
    } catch (_) {}
    return !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
  }

  // The text of the page in reading groups: a group is the text of one block container, so a word
  // split by <b> or <a> still matches and two paragraphs never join into one match.
  function groups() {
    var root = document.body;
    var found = [];
    if (!root) return found;
    var blockOf = new Map();
    var shown = new Map();
    var skipped = new Map();
    function skip(element) {
      if (skipped.has(element)) return skipped.get(element);
      var result = !!SKIPPED[element.tagName] || (element.parentElement ? skip(element.parentElement) : false);
      skipped.set(element, result);
      return result;
    }
    function isShown(element) {
      if (!shown.has(element)) shown.set(element, visible(element));
      return shown.get(element);
    }
    function block(element) {
      if (blockOf.has(element)) return blockOf.get(element);
      var result = !element.parentElement || !isInline(element) ? element : block(element.parentElement);
      blockOf.set(element, result);
      return result;
    }
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    var current = null;
    var group = null;
    while (walker.nextNode()) {
      var node = walker.currentNode;
      var parent = node.parentElement;
      if (!parent || !node.nodeValue || skip(parent)) continue;
      var container = block(parent);
      if (!isShown(container)) continue;
      if (container !== current) {
        group = { text: '', nodes: [], starts: [] };
        found.push(group);
        current = container;
      }
      group.starts.push(group.text.length);
      group.nodes.push(node);
      group.text += node.nodeValue;
    }
    return found;
  }

  function locate(group, offset, atEnd) {
    var low = 0;
    var high = group.starts.length - 1;
    while (low < high) {
      var middle = (low + high + 1) >> 1;
      if (group.starts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    // An end offset on a node boundary belongs to the node that ended there.
    if (atEnd && low > 0 && group.starts[low] === offset) low -= 1;
    return { node: group.nodes[low], offset: offset - group.starts[low] };
  }

  function collect(needle) {
    var ranges = [];
    var capped = false;
    var lowered = needle.toLowerCase();
    var all = groups();
    for (var i = 0; i < all.length && !capped; i++) {
      var group = all[i];
      var text = group.text.toLowerCase();
      // A few letters change length when lowercased; those groups are searched as they are.
      if (text.length !== group.text.length) text = group.text;
      var from = 0;
      var at;
      while ((at = text.indexOf(lowered, from)) !== -1) {
        if (ranges.length >= MAX_MATCHES) {
          capped = true;
          break;
        }
        var start = locate(group, at, false);
        var end = locate(group, at + lowered.length, true);
        var range = document.createRange();
        range.setStart(start.node, start.offset);
        range.setEnd(end.node, end.offset);
        ranges.push(range);
        from = at + lowered.length;
      }
    }
    return { ranges: ranges, capped: capped };
  }

  function paint(state) {
    var registry = highlights();
    if (registry && state.ranges.length) {
      try {
        registry.set(ALL, new Highlight(...state.ranges));
        registry.set(ACTIVE, new Highlight(state.ranges[state.index]));
        if (!state.style) {
          var style = document.createElement('style');
          style.setAttribute('data-openmedia-find', '');
          style.textContent =
            '::highlight(' + ALL + '){background-color:#ffe066;color:#000}' +
            '::highlight(' + ACTIVE + '){background-color:#ff9f1c;color:#000}';
          (document.head || document.documentElement).appendChild(style);
          state.style = style;
        }
      } catch (_) {}
    }
    var range = state.ranges[state.index];
    if (!range) return;
    try {
      var selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range.cloneRange());
      state.selected = true;
    } catch (_) {}
    var target = range.startContainer && range.startContainer.parentElement;
    if (target && target.scrollIntoView) {
      try {
        target.scrollIntoView({ block: 'center', inline: 'nearest' });
      } catch (_) {}
    }
  }

  if (op === 'clear') return clear();

  if (op === 'search') {
    var needle = String(argument || '');
    if (!needle) return clear();
    var previous = window[KEY];
    var style = previous && previous.style;
    dropHighlights();
    var result = collect(needle);
    var state = {
      query: needle,
      ranges: result.ranges,
      capped: result.capped,
      index: 0,
      style: style || null,
      selected: !!(previous && previous.selected),
    };
    window[KEY] = state;
    paint(state);
    return answer(state);
  }

  var current = window[KEY];
  if (!current || !current.ranges.length) return answer(current);
  var count = current.ranges.length;
  current.index = (current.index + (op === 'previous' ? count - 1 : 1)) % count;
  paint(current);
  return answer(current);
})
