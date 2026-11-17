(function () {
  var KEY = Symbol.for('openmedia.colorPick');
  var previous = window[KEY];
  if (previous && previous.stop) previous.stop();

  var SIZE = 112;
  var RING = 14;
  var DOT = 8;
  var LIFT = 70;

  // x, y: the loupe's centre in viewport CSS px. native: hex came from the real pixel (setHex)
  // since the last move; accept() re-samples the page only while it is false.
  var pick = { status: 'waiting', hex: null, x: 0, y: 0, native: false, setHex: setHex, accept: accept, stop: stop };
  window[KEY] = pick;

  var layer = document.createElement('div');
  layer.style.cssText =
    'position:fixed;top:0;left:0;right:0;bottom:0;margin:0;padding:0;border:0;z-index:2147483647;' +
    'background:transparent;touch-action:none;user-select:none;-webkit-user-select:none;' +
    '-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent;';
  var loupe = document.createElement('div');
  loupe.style.cssText =
    'position:absolute;left:0;top:0;box-sizing:border-box;pointer-events:none;border-radius:50%;' +
    'width:' + SIZE + 'px;height:' + SIZE + 'px;border:' + RING + 'px solid #000;' +
    'box-shadow:0 0 0 2px #fff,0 0 0 3px rgba(0,0,0,.6),inset 0 0 0 1px #fff,inset 0 0 0 2px rgba(0,0,0,.6);';
  var dot = document.createElement('div');
  dot.style.cssText =
    'position:absolute;left:50%;top:50%;box-sizing:border-box;border-radius:50%;' +
    'width:' + DOT + 'px;height:' + DOT + 'px;margin:' + (-DOT / 2) + 'px 0 0 ' + (-DOT / 2) + 'px;' +
    'background:transparent;border:2px solid #fff;box-shadow:0 0 0 1px #000,inset 0 0 0 1px #000;';
  loupe.appendChild(dot);
  layer.appendChild(loupe);
  var scratch = document.createElement('canvas');
  scratch.width = scratch.height = 1;
  var context = scratch.getContext('2d', { willReadFrequently: true });

  var cx = 0;
  var cy = 0;
  var frame = 0;
  var pointer = null;

  function stop() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    if (layer.parentNode) layer.parentNode.removeChild(layer);
    if (pick.status === 'waiting') pick.status = 'cancelled';
  }

  function accept() {
    if (pick.status !== 'waiting') return;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    if (!pick.native) sample();
    pick.status = 'done';
    if (layer.parentNode) layer.parentNode.removeChild(layer);
  }

  function hex(r, g, b) {
    return '#' + [r, g, b].map(function (v) { return ('0' + v.toString(16)).slice(-2); }).join('');
  }

  /** Takes the colour of the real rendered pixel, as the app reads it natively: `#rrggbb` lowercase only. */
  function setHex(value) {
    if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/.test(value)) return;
    pick.hex = value;
    pick.native = true;
    loupe.style.borderColor = value;
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

  function place() {
    var w = window.innerWidth;
    var h = window.innerHeight;
    cx = Math.max(SIZE / 2, Math.min(w - SIZE / 2, cx));
    cy = Math.max(SIZE / 2, Math.min(h - SIZE / 2, cy));
    pick.x = cx;
    pick.y = cy;
    loupe.style.transform = 'translate(' + (cx - SIZE / 2) + 'px,' + (cy - SIZE / 2) + 'px)';
  }

  /** Reads the colour under the loupe's centre; the layer is hidden so it is not what is read. */
  function sample() {
    layer.style.display = 'none';
    try {
      var el = document.elementFromPoint(cx, cy) || document.documentElement;
      var value = colourAt(el, cx, cy);
      pick.hex = value;
      loupe.style.borderColor = value;
    } catch (e) {
      // a page that refuses the read leaves the last colour in place
    } finally {
      layer.style.display = '';
    }
  }

  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(function () {
      frame = 0;
      sample();
    });
  }

  function moveTo(event) {
    cx = event.clientX;
    cy = event.clientY - LIFT;
    pick.native = false;
    place();
    schedule();
  }

  layer.addEventListener('pointerdown', function (event) {
    event.stopPropagation();
    if (event.cancelable) event.preventDefault();
    if (pointer !== null) return;
    pointer = event.pointerId;
    try {
      layer.setPointerCapture(pointer);
    } catch (e) {
      // the pointer is already gone
    }
    moveTo(event);
  }, true);
  layer.addEventListener('pointermove', function (event) {
    event.stopPropagation();
    if (event.cancelable) event.preventDefault();
    if (event.pointerId === pointer) moveTo(event);
  }, true);
  ['pointerup', 'pointercancel'].forEach(function (type) {
    layer.addEventListener(type, function (event) {
      event.stopPropagation();
      if (event.cancelable) event.preventDefault();
      if (event.pointerId === pointer) pointer = null;
    }, true);
  });
  ['touchstart', 'touchmove', 'touchend', 'touchcancel', 'mousedown', 'mousemove', 'mouseup',
    'click', 'dblclick', 'contextmenu', 'wheel', 'pointerover', 'pointerout'].forEach(function (type) {
    layer.addEventListener(type, function (event) {
      event.stopPropagation();
      if (event.cancelable) event.preventDefault();
    }, { capture: true, passive: false });
  });

  (document.body || document.documentElement).appendChild(layer);
  cx = window.innerWidth / 2;
  cy = window.innerHeight / 2;
  place();
  sample();
  return 1;
})()
