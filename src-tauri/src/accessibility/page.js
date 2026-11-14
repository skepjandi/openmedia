(function (config) {
  'use strict';
  var KEY = Symbol.for('openmedia.accessibility');
  var NO_AUTOPLAY = Symbol.for('openmedia.noAutoplay');
  var STYLE_ATTRIBUTE = 'data-openmedia';
  var STILL_ATTRIBUTE = 'data-openmedia-still';
  var GIF = /\.gif(?:[?#]|$)|^data:image\/gif/i;
  var MAX_PAUSES = 20;
  try {
    if (typeof document[KEY] === 'function') document[KEY]();
    // With every option off this only removes what an earlier run left, so a switch turned off in
    // Settings takes effect on the open page.
    if (!config.css && !config.topCss && !config.calm && !config.fonts.length) return;

    var undo = [];
    var topFrame = window.top === window;

    function style(css) {
      var element = document.createElement('style');
      element.setAttribute(STYLE_ATTRIBUTE, '');
      element.textContent = css;
      var attach = function () {
        (document.head || document.documentElement).appendChild(element);
      };
      if (document.documentElement) attach();
      else new MutationObserver(function (_, observer) {
        if (document.documentElement) { observer.disconnect(); attach(); }
      }).observe(document, { childList: true });
      undo.push(function () { element.remove(); });
    }

    function font(face) {
      var binary = atob(face.data);
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      var loaded = new FontFace(config.family, bytes.buffer, { weight: face.weight });
      document.fonts.add(loaded);
      undo.push(function () { document.fonts.delete(loaded); });
    }

    // A video that starts without a tap or key press of the reader's own is stopped. The reader's
    // own play (the page's button, native controls) happens inside that activation window.
    function stopAutoplay() {
      var pauses = new WeakMap();
      var onPlay = function (event) {
        var video = event.target;
        if (!(video instanceof HTMLVideoElement)) return;
        var activation = navigator.userActivation;
        if (!activation || activation.isActive) return;
        var count = pauses.get(video) || 0;
        if (count >= MAX_PAUSES) return;
        pauses.set(video, count + 1);
        video.pause();
      };
      document.addEventListener('play', onPlay, true);
      document[NO_AUTOPLAY] = true;
      undo.push(function () {
        document.removeEventListener('play', onPlay, true);
        delete document[NO_AUTOPLAY];
      });
    }

    // An animated GIF is replaced by its first frame, drawn on a canvas that takes its place. The
    // image stays in the page, hidden, so the page's own scripts still find it.
    function freeze(image) {
      if (image.hasAttribute(STILL_ATTRIBUTE) || !image.complete || !image.naturalWidth) return;
      if (!GIF.test(image.currentSrc || image.src)) return;
      var canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      try {
        canvas.getContext('2d').drawImage(image, 0, 0);
      } catch (_) {
        return;
      }
      var box = image.getBoundingClientRect();
      var computed = getComputedStyle(image);
      canvas.className = image.className;
      canvas.style.cssText = image.style.cssText;
      canvas.style.display = computed.display === 'inline' ? 'inline-block' : computed.display;
      canvas.style.verticalAlign = computed.verticalAlign;
      canvas.style.objectFit = computed.objectFit;
      canvas.style.maxWidth = '100%';
      if (box.width) canvas.style.width = box.width + 'px';
      if (box.height) canvas.style.height = box.height + 'px';
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', image.alt || '');
      canvas.setAttribute(STILL_ATTRIBUTE, '');
      image.setAttribute(STILL_ATTRIBUTE, '');
      image.style.setProperty('display', 'none', 'important');
      image.insertAdjacentElement('afterend', canvas);
    }

    function stillImages() {
      var onLoad = function (event) {
        if (event.target instanceof HTMLImageElement) freeze(event.target);
      };
      document.addEventListener('load', onLoad, true);
      Array.prototype.forEach.call(document.images || [], freeze);
      undo.push(function () {
        document.removeEventListener('load', onLoad, true);
        document.querySelectorAll('canvas[' + STILL_ATTRIBUTE + ']').forEach(function (canvas) { canvas.remove(); });
        document.querySelectorAll('img[' + STILL_ATTRIBUTE + ']').forEach(function (image) {
          image.removeAttribute(STILL_ATTRIBUTE);
          image.style.removeProperty('display');
        });
      });
    }

    function stopMarkup() {
      document.querySelectorAll('svg').forEach(function (svg) {
        if (svg.pauseAnimations) svg.pauseAnimations();
      });
      document.querySelectorAll('marquee').forEach(function (marquee) {
        if (marquee.stop) marquee.stop();
      });
    }

    if (config.css) style(config.css);
    if (config.topCss && topFrame) style(config.topCss);
    config.fonts.forEach(function (face) {
      try { font(face); } catch (_) {}
    });
    if (config.calm) {
      stopAutoplay();
      stillImages();
      var settle = function () { stopMarkup(); };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', settle, { once: true });
      else settle();
    }

    Object.defineProperty(document, KEY, {
      configurable: true,
      value: function () {
        undo.forEach(function (step) { try { step(); } catch (_) {} });
        delete document[KEY];
      }
    });
  } catch (_) {}
})
