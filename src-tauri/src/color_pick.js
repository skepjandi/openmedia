(function () {
  var KEY = Symbol.for('openmedia.colorPick');
  var previous = window[KEY];
  if (previous && previous.stop) previous.stop();

  var pick = { status: 'waiting', hex: null, stop: stop };
  window[KEY] = pick;

  var layer = document.createElement('div');
  layer.style.cssText =
    'position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483647;cursor:crosshair;' +
    'background:transparent;touch-action:none;-webkit-tap-highlight-color:transparent;';
  var scratch = document.createElement('canvas');
  scratch.width = scratch.height = 1;
  var context = scratch.getContext('2d', { willReadFrequently: true });

  function stop() {
    if (layer.parentNode) layer.parentNode.removeChild(layer);
    if (pick.status === 'waiting') pick.status = 'cancelled';
  }

  function hex(r, g, b) {
    return '#' + [r, g, b].map(function (v) { return ('0' + v.toString(16)).slice(-2); }).join('');
  }

  /** The colour a CSS colour string paints on `base` (an [r,g,b] array), or null when it paints nothing. */
  function over(css, base) {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = '#000';
    context.fillStyle = css;
    context.fillRect(0, 0, 1, 1);
    var d = context.getImageData(0, 0, 1, 1).data;
    if (d[3] === 0) return null;
    var a = d[3] / 255;
    return [0, 1, 2].map(function (i) { return Math.round(d[i] * a + base[i] * (1 - a)); });
  }

  /** Reads the pixel under the point from an image, video or canvas the page lets us read. */
  function pixelOf(el, x, y) {
    var rect = el.getBoundingClientRect();
    var w = el.naturalWidth || el.videoWidth || el.width;
    var h = el.naturalHeight || el.videoHeight || el.height;
    if (!w || !h || !rect.width || !rect.height) return null;
    try {
      context.clearRect(0, 0, 1, 1);
      context.drawImage(
        el,
        ((x - rect.left) / rect.width) * w,
        ((y - rect.top) / rect.height) * h,
        1, 1, 0, 0, 1, 1
      );
      var d = context.getImageData(0, 0, 1, 1).data;
      return d[3] === 0 ? null : [d[0], d[1], d[2]];
    } catch (e) {
      return null; // a cross-origin image taints the canvas
    }
  }

  /** What is painted at the point: the media's pixel, else the backgrounds stacked behind it. */
  function colourAt(el, x, y) {
    var chain = [];
    for (var n = el; n && n.nodeType === 1; n = n.parentElement) chain.push(n);
    var rgb = [255, 255, 255];
    for (var i = chain.length - 1; i >= 0; i--) {
      var next = over(getComputedStyle(chain[i]).backgroundColor, rgb);
      if (next) rgb = next;
    }
    if (/^(IMG|VIDEO|CANVAS)$/.test(el.tagName)) rgb = pixelOf(el, x, y) || rgb;
    return hex(rgb[0], rgb[1], rgb[2]);
  }

  function choose(event) {
    event.preventDefault();
    event.stopPropagation();
    layer.style.display = 'none';
    var el = document.elementFromPoint(event.clientX, event.clientY) || document.documentElement;
    layer.style.display = '';
    try {
      pick.hex = colourAt(el, event.clientX, event.clientY);
      pick.status = 'done';
    } catch (e) {
      pick.status = 'cancelled';
    }
    stop();
  }

  layer.addEventListener('click', choose, true);
  ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'mousedown', 'mouseup'].forEach(function (type) {
    layer.addEventListener(type, function (event) {
      event.stopPropagation();
      if (event.cancelable) event.preventDefault();
    }, true);
  });
  (document.body || document.documentElement).appendChild(layer);
  return 1;
})()
