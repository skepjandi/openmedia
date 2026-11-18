function (kind) {
  var root = document.scrollingElement || document.documentElement;
  var area = root;
  var probe = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
  for (var el = probe; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1) {
      area = el;
      break;
    }
  }
  var height = area === root ? window.innerHeight : area.clientHeight;
  var steps = {
    down: [0, 60],
    up: [0, -60],
    left: [-60, 0],
    right: [60, 0],
    halfDown: [0, height / 2],
    halfUp: [0, -height / 2],
    pageDown: [0, height * 0.9],
    pageUp: [0, -height * 0.9]
  };
  if (kind === 'top') area.scrollTo({ top: 0 });
  else if (kind === 'bottom') area.scrollTo({ top: area.scrollHeight });
  else if (steps[kind]) area.scrollBy({ left: steps[kind][0], top: steps[kind][1] });
  return true;
}
