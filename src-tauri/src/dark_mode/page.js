(function (config) {
  'use strict';
  var KEY = Symbol.for('openmedia.darkMode');
  var STATE = Symbol.for('openmedia.darkMode.state');
  var FIXES = Symbol.for('openmedia.darkFixes');
  var OWN = 'data-om-dark';
  var RECIPE_STYLE = 'data-openmedia';
  var INLINE_ID = 'data-om-i';
  var IMAGE_MARK = 'data-om-img';
  var HTML_NS = 'http://www.w3.org/1999/xhtml';
  var INVERT = 'invert(1) hue-rotate(180deg)';
  var METHODS = ['dynamic', 'filter', 'filterplus', 'static'];
  var KINDS = ['bg', 'text', 'border'];
  var GLYPH = 'i,svg,svg *,code,pre,kbd,samp,.fa,[class^="fa-"],[class*=" fa-"],[class*="icon" i],[class*="material" i],[class*="glyph" i]';
  var WHITE = { r: 255, g: 255, b: 255, a: 1 };
  var BLACK = { r: 0, g: 0, b: 0, a: 1 };

  // ---------------------------------------------------------------------------------------------
  // Colour parsing and conversion
  // ---------------------------------------------------------------------------------------------

  var NAMED = Object.create(null);
  ('aliceblue:f0f8ff,antiquewhite:faebd7,aqua:00ffff,aquamarine:7fffd4,azure:f0ffff,beige:f5f5dc,' +
    'bisque:ffe4c4,black:000000,blanchedalmond:ffebcd,blue:0000ff,blueviolet:8a2be2,brown:a52a2a,' +
    'burlywood:deb887,cadetblue:5f9ea0,chartreuse:7fff00,chocolate:d2691e,coral:ff7f50,' +
    'cornflowerblue:6495ed,cornsilk:fff8dc,crimson:dc143c,cyan:00ffff,darkblue:00008b,' +
    'darkcyan:008b8b,darkgoldenrod:b8860b,darkgray:a9a9a9,darkgreen:006400,darkgrey:a9a9a9,' +
    'darkkhaki:bdb76b,darkmagenta:8b008b,darkolivegreen:556b2f,darkorange:ff8c00,darkorchid:9932cc,' +
    'darkred:8b0000,darksalmon:e9967a,darkseagreen:8fbc8f,darkslateblue:483d8b,darkslategray:2f4f4f,' +
    'darkslategrey:2f4f4f,darkturquoise:00ced1,darkviolet:9400d3,deeppink:ff1493,deepskyblue:00bfff,' +
    'dimgray:696969,dimgrey:696969,dodgerblue:1e90ff,firebrick:b22222,floralwhite:fffaf0,' +
    'forestgreen:228b22,fuchsia:ff00ff,gainsboro:dcdcdc,ghostwhite:f8f8ff,gold:ffd700,' +
    'goldenrod:daa520,gray:808080,green:008000,greenyellow:adff2f,grey:808080,honeydew:f0fff0,' +
    'hotpink:ff69b4,indianred:cd5c5c,indigo:4b0082,ivory:fffff0,khaki:f0e68c,lavender:e6e6fa,' +
    'lavenderblush:fff0f5,lawngreen:7cfc00,lemonchiffon:fffacd,lightblue:add8e6,lightcoral:f08080,' +
    'lightcyan:e0ffff,lightgoldenrodyellow:fafad2,lightgray:d3d3d3,lightgreen:90ee90,' +
    'lightgrey:d3d3d3,lightpink:ffb6c1,lightsalmon:ffa07a,lightseagreen:20b2aa,lightskyblue:87cefa,' +
    'lightslategray:778899,lightslategrey:778899,lightsteelblue:b0c4de,lightyellow:ffffe0,' +
    'lime:00ff00,limegreen:32cd32,linen:faf0e6,magenta:ff00ff,maroon:800000,' +
    'mediumaquamarine:66cdaa,mediumblue:0000cd,mediumorchid:ba55d3,mediumpurple:9370db,' +
    'mediumseagreen:3cb371,mediumslateblue:7b68ee,mediumspringgreen:00fa9a,mediumturquoise:48d1cc,' +
    'mediumvioletred:c71585,midnightblue:191970,mintcream:f5fffa,mistyrose:ffe4e1,moccasin:ffe4b5,' +
    'navajowhite:ffdead,navy:000080,oldlace:fdf5e6,olive:808000,olivedrab:6b8e23,orange:ffa500,' +
    'orangered:ff4500,orchid:da70d6,palegoldenrod:eee8aa,palegreen:98fb98,paleturquoise:afeeee,' +
    'palevioletred:db7093,papayawhip:ffefd5,peachpuff:ffdab9,peru:cd853f,pink:ffc0cb,plum:dda0dd,' +
    'powderblue:b0e0e6,purple:800080,rebeccapurple:663399,red:ff0000,rosybrown:bc8f8f,' +
    'royalblue:4169e1,saddlebrown:8b4513,salmon:fa8072,sandybrown:f4a460,seagreen:2e8b57,' +
    'seashell:fff5ee,sienna:a0522d,silver:c0c0c0,skyblue:87ceeb,slateblue:6a5acd,slategray:708090,' +
    'slategrey:708090,snow:fffafa,springgreen:00ff7f,steelblue:4682b4,tan:d2b48c,teal:008080,' +
    'thistle:d8bfd8,tomato:ff6347,turquoise:40e0d0,violet:ee82ee,wheat:f5deb3,white:ffffff,' +
    'whitesmoke:f5f5f5,yellow:ffff00,yellowgreen:9acd32').split(',').forEach(function (pair) {
    var parts = pair.split(':');
    NAMED[parts[0]] = parseInt(parts[1], 16);
  });

  var COLOR_FUNCTIONS = Object.create(null);
  ['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'color-mix'].forEach(function (name) {
    COLOR_FUNCTIONS[name] = true;
  });

  function clamp(value, low, high) {
    return value < low ? low : value > high ? high : value;
  }

  function parseChannel(token) {
    if (token === 'none') return 0;
    var value = parseFloat(token);
    if (isNaN(value)) return null;
    return token.charAt(token.length - 1) === '%' ? value * 2.55 : value;
  }

  function parseFraction(token) {
    if (token === 'none') return 0;
    var value = parseFloat(token);
    if (isNaN(value)) return null;
    return token.charAt(token.length - 1) === '%' ? value / 100 : value;
  }

  function parseHue(token) {
    if (token === 'none') return 0;
    var value = parseFloat(token);
    if (isNaN(value)) return null;
    if (/turn$/i.test(token)) return value * 360;
    if (/grad$/i.test(token)) return value * 0.9;
    if (/rad$/i.test(token)) return value * 180 / Math.PI;
    return value;
  }

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b);
    var min = Math.min(r, g, b);
    var l = (max + min) / 2;
    var d = max - min;
    if (d === 0) return { h: 0, s: 0, l: l };
    var s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    var h;
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return { h: h * 60, s: s, l: l };
  }

  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360;
    s = clamp(s, 0, 1);
    l = clamp(l, 0, 1);
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var x = c * (1 - Math.abs((h / 60) % 2 - 1));
    var m = l - c / 2;
    var r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else { r = c; b = x; }
    return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
  }

  var canvasContext = null;
  var canvasResults = Object.create(null);

  // Colours the parser does not know (lab(), color-mix(), system colours) are resolved by the
  // browser itself: a canvas serialises any valid fillStyle as hex or rgba().
  function colorFromCanvas(text) {
    if (text in canvasResults) return canvasResults[text];
    var result = null;
    try {
      if (!canvasContext) canvasContext = document.createElement('canvas').getContext('2d');
      canvasContext.fillStyle = '#010203';
      canvasContext.fillStyle = text;
      var value = String(canvasContext.fillStyle);
      if (value !== '#010203') result = parseColor(value, true);
    } catch (_) {}
    canvasResults[text] = result;
    return result;
  }

  function parseColor(input, noCanvas) {
    if (typeof input !== 'string') return null;
    var text = input.trim().toLowerCase();
    if (!text) return null;
    if (text === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    var match;
    if (text.charAt(0) === '#') {
      match = /^#([0-9a-f]+)$/.exec(text);
      if (!match) return null;
      var hex = match[1];
      if (hex.length === 3 || hex.length === 4) {
        hex = hex.replace(/./g, function (digit) { return digit + digit; });
      }
      if (hex.length !== 6 && hex.length !== 8) return null;
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
        a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1
      };
    }
    match = /^(rgba?|hsla?)\((.*)\)$/.exec(text);
    if (match) {
      var parts = match[2].replace(/[,\/]/g, ' ').trim().split(/\s+/);
      if (parts.length < 3 || parts.length > 4) return null;
      var alpha = 1;
      if (parts.length === 4) {
        alpha = parseFraction(parts[3]);
        if (alpha === null) return null;
      }
      alpha = clamp(alpha, 0, 1);
      if (match[1].charAt(0) === 'r') {
        var red = parseChannel(parts[0]);
        var green = parseChannel(parts[1]);
        var blue = parseChannel(parts[2]);
        if (red === null || green === null || blue === null) return null;
        return { r: clamp(red, 0, 255), g: clamp(green, 0, 255), b: clamp(blue, 0, 255), a: alpha };
      }
      var hue = parseHue(parts[0]);
      var sat = parseFraction(parts[1]);
      var light = parseFraction(parts[2]);
      if (hue === null || sat === null || light === null) return null;
      var rgb = hslToRgb(hue, sat, light);
      return { r: rgb.r, g: rgb.g, b: rgb.b, a: alpha };
    }
    if (text in NAMED) {
      var n = NAMED[text];
      return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
    }
    if (noCanvas || !/^[a-z-]+\(.*\)$/.test(text)) return null;
    return colorFromCanvas(text);
  }

  function byte(value) {
    return Math.round(clamp(value, 0, 255));
  }

  function colorToCss(c) {
    if (c.a >= 1) {
      return '#' + [c.r, c.g, c.b].map(function (v) {
        var h = byte(v).toString(16);
        return h.length < 2 ? '0' + h : h;
      }).join('');
    }
    return 'rgba(' + byte(c.r) + ', ' + byte(c.g) + ', ' + byte(c.b) + ', ' + Math.round(clamp(c.a, 0, 1) * 1000) / 1000 + ')';
  }

  function luma(c) {
    return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
  }

  // ---------------------------------------------------------------------------------------------
  // Theme and the colour mappers
  // ---------------------------------------------------------------------------------------------

  function number(value, low, high, fallback) {
    return typeof value === 'number' && isFinite(value) ? clamp(value, low, high) : fallback;
  }

  function normalise(raw) {
    var c = raw || {};
    var schedule = c.schedule || {};
    return {
      enabled: !!c.enabled,
      method: METHODS.indexOf(c.method) >= 0 ? c.method : 'dynamic',
      brightness: number(c.brightness, 50, 150, 100),
      contrast: number(c.contrast, 50, 150, 100),
      sepia: number(c.sepia, 0, 100, 0),
      grayscale: number(c.grayscale, 0, 100, 0),
      background: typeof c.background === 'string' ? c.background : '#181a1b',
      text: typeof c.text === 'string' ? c.text : '#e8e6e3',
      schedule: {
        kind: schedule.kind === 'system' || schedule.kind === 'time' ? schedule.kind : 'always',
        from: typeof schedule.from === 'string' ? schedule.from : '21:00',
        to: typeof schedule.to === 'string' ? schedule.to : '07:00'
      },
      skipDarkPages: c.skipDarkPages !== false,
      systemControls: c.systemControls !== false,
      scrollbars: c.scrollbars !== false,
      images: c.images !== false,
      textStroke: number(c.textStroke, 0, 10, 0),
      sites: c.sites && typeof c.sites === 'object' ? c.sites : {}
    };
  }

  function buildTheme(raw) {
    var c = normalise(raw);
    var bg = parseColor(c.background, true) || { r: 24, g: 26, b: 27, a: 1 };
    var text = parseColor(c.text, true) || { r: 232, g: 230, b: 227, a: 1 };
    return {
      bg: bg,
      text: text,
      bgHsl: rgbToHsl(bg.r, bg.g, bg.b),
      textHsl: rgbToHsl(text.r, text.g, text.b),
      brightness: c.brightness / 100,
      contrast: c.contrast / 100,
      sepia: c.sepia / 100,
      grayscale: c.grayscale / 100,
      plain: c.brightness === 100 && c.contrast === 100 && c.sepia === 0 && c.grayscale === 0,
      systemControls: c.systemControls,
      scrollbars: c.scrollbars,
      textStroke: c.textStroke,
      cache: Object.create(null),
      images: null
    };
  }

  // The same four adjustments the CSS filter functions of that name make, in the same order.
  function adjust(c, theme) {
    if (theme.plain) return c;
    var r = c.r / 255, g = c.g / 255, b = c.b / 255;
    if (theme.brightness !== 1) { r *= theme.brightness; g *= theme.brightness; b *= theme.brightness; }
    if (theme.contrast !== 1) {
      r = (r - 0.5) * theme.contrast + 0.5;
      g = (g - 0.5) * theme.contrast + 0.5;
      b = (b - 0.5) * theme.contrast + 0.5;
    }
    r = clamp(r, 0, 1); g = clamp(g, 0, 1); b = clamp(b, 0, 1);
    var s = theme.sepia;
    if (s > 0) {
      var k = 1 - s;
      var sr = (0.393 + 0.607 * k) * r + (0.769 - 0.769 * k) * g + (0.189 - 0.189 * k) * b;
      var sg = (0.349 - 0.349 * k) * r + (0.686 + 0.314 * k) * g + (0.168 - 0.168 * k) * b;
      var sb = (0.272 - 0.272 * k) * r + (0.534 - 0.534 * k) * g + (0.131 + 0.869 * k) * b;
      r = clamp(sr, 0, 1); g = clamp(sg, 0, 1); b = clamp(sb, 0, 1);
    }
    var y = theme.grayscale;
    if (y > 0) {
      var q = 1 - y;
      var gr = (0.2126 + 0.7874 * q) * r + (0.7152 - 0.7152 * q) * g + (0.0722 - 0.0722 * q) * b;
      var gg = (0.2126 - 0.2126 * q) * r + (0.7152 + 0.2848 * q) * g + (0.0722 - 0.0722 * q) * b;
      var gb = (0.2126 - 0.2126 * q) * r + (0.7152 - 0.7152 * q) * g + (0.0722 + 0.9278 * q) * b;
      r = clamp(gr, 0, 1); g = clamp(gg, 0, 1); b = clamp(gb, 0, 1);
    }
    return { r: r * 255, g: g * 255, b: b * 255, a: c.a };
  }

  var NEUTRAL = 0.1;
  var LIGHT_CAP = 0.4;

  // Light backgrounds are folded onto the scheme background; dark ones stay as they are (never
  // darker than the scheme) so a page's own dark panels keep their look.
  function mapBackground(c, theme) {
    var hsl = rgbToHsl(c.r, c.g, c.b);
    var base = theme.bgHsl.l;
    var h = hsl.h, s = hsl.s, l;
    if (hsl.l > LIGHT_CAP) {
      var top = Math.max(base, LIGHT_CAP);
      l = base + (1 - hsl.l) / (1 - LIGHT_CAP) * (top - base);
    } else {
      l = Math.max(hsl.l, base);
    }
    if (s < NEUTRAL) { h = theme.bgHsl.h; s = theme.bgHsl.s; }
    else s = Math.min(s, 0.9);
    var rgb = hslToRgb(h, s, l);
    return { r: rgb.r, g: rgb.g, b: rgb.b, a: c.a };
  }

  // Dark text turns light, light text stays light, and a dark link blue becomes a readable one.
  function mapForeground(c, theme) {
    var hsl = rgbToHsl(c.r, c.g, c.b);
    var top = theme.textHsl.l;
    var h = hsl.h, s = hsl.s, l = hsl.l;
    if (l < 0.5) {
      l = top - l / 0.5 * (top - 0.5);
      if (s >= NEUTRAL && s > 0.3 && h >= 190 && h <= 270) {
        l = Math.max(l, 0.68);
        s = Math.min(s, 0.8);
      }
    }
    if (hsl.s < NEUTRAL) { h = theme.textHsl.h; s = theme.textHsl.s; }
    var rgb = hslToRgb(h, s, l);
    return { r: rgb.r, g: rgb.g, b: rgb.b, a: c.a };
  }

  // Borders become mid tones above the background: light borders sink, dark ones rise.
  function mapBorder(c, theme) {
    var hsl = rgbToHsl(c.r, c.g, c.b);
    var base = theme.bgHsl.l + 0.1;
    var l = hsl.l >= 0.5 ? base + (1 - hsl.l) * 0.2 : base + 0.1 + (0.5 - hsl.l) * 0.2;
    var h = hsl.h, s = hsl.s;
    if (s < NEUTRAL) { h = theme.bgHsl.h; s = theme.bgHsl.s; }
    var rgb = hslToRgb(h, s, l);
    return { r: rgb.r, g: rgb.g, b: rgb.b, a: c.a };
  }

  function mapFill(c, theme) {
    return rgbToHsl(c.r, c.g, c.b).l < 0.5 ? mapForeground(c, theme) : mapBackground(c, theme);
  }

  function modifyBackground(c, theme) { return adjust(mapBackground(c, theme), theme); }
  function modifyForeground(c, theme) { return adjust(mapForeground(c, theme), theme); }
  function modifyBorder(c, theme) { return adjust(mapBorder(c, theme), theme); }
  function modifyFill(c, theme) { return adjust(mapFill(c, theme), theme); }

  var MAPPERS = { bg: modifyBackground, text: modifyForeground, border: modifyBorder, fill: modifyFill };

  function recolour(text, kind, theme) {
    var key = kind + '|' + text;
    var hit = theme.cache[key];
    if (hit !== undefined) return hit;
    var parsed = parseColor(text);
    var result = text;
    if (parsed && parsed.a > 0) result = colorToCss(MAPPERS[kind](parsed, theme));
    theme.cache[key] = result;
    return result;
  }

  // ---------------------------------------------------------------------------------------------
  // Declaration rewriting
  // ---------------------------------------------------------------------------------------------

  var kindCache = Object.create(null);

  function propKind(name) {
    var cached = kindCache[name];
    if (cached !== undefined) return cached;
    var kind = null;
    if (name === 'color' || name === 'caret-color' || name === '-webkit-text-fill-color' ||
        name === '-webkit-text-stroke' || name === '-webkit-text-stroke-color' ||
        name === 'text-decoration' || name === 'text-decoration-color' ||
        name === 'text-emphasis' || name === 'text-emphasis-color') kind = 'text';
    else if (name === 'background' || name === 'background-color' || name === 'background-image' ||
        name === 'box-shadow' || name === 'text-shadow' || name === 'scrollbar-color' ||
        name === 'accent-color' || name === 'stop-color' || name === 'flood-color' ||
        name === 'lighting-color' || name === '-webkit-tap-highlight-color') kind = 'bg';
    else if (name === 'fill' || name === 'stroke') kind = 'fill';
    else if (/^(border|outline|column-rule)/.test(name) && !/radius|width|style|spacing|collapse|image|offset/.test(name)) kind = 'border';
    kindCache[name] = kind;
    return kind;
  }

  function sticky(pattern, text, index) {
    pattern.lastIndex = index;
    var match = pattern.exec(text);
    return match ? match[0] : null;
  }

  var HEX = /#[0-9a-f]{3,8}(?![\w-])/iy;
  var IDENT = /-{0,2}[a-z_][\w-]*/iy;
  var NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?[a-z%]*/iy;

  function skipQuoted(text, start) {
    var quote = text.charAt(start);
    var i = start + 1;
    while (i < text.length) {
      var c = text.charAt(i);
      if (c === '\\') i++;
      else if (c === quote) return i + 1;
      i++;
    }
    return text.length;
  }

  // Index just past the parenthesis closing the one at `open`, or -1.
  function closing(text, open) {
    var depth = 0;
    for (var i = open; i < text.length; i++) {
      var c = text.charAt(i);
      if (c === '"' || c === "'") { i = skipQuoted(text, i) - 1; continue; }
      if (c === '\\') { i++; continue; }
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) return i + 1; }
    }
    return -1;
  }

  function resolveUrl(url, base) {
    try { return new URL(url, base).href; } catch (_) { return url; }
  }

  function mapUrl(text, kind, theme, base) {
    if (kind !== 'bg' || !theme.images) return text;
    var match = /^url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)$/i.exec(text);
    if (!match) return text;
    var url = match[1] !== undefined ? match[1] : match[2] !== undefined ? match[2] : match[3];
    if (!url) return text;
    var replacement = theme.images.lookup(resolveUrl(url, base));
    return typeof replacement === 'string' ? 'url("' + replacement + '")' : text;
  }

  // var(--x) in a colour property reads the dark variant of --x when there is one.
  function mapVar(inner, kind, theme, base) {
    var depth = 0, comma = -1;
    for (var i = 0; i < inner.length; i++) {
      var c = inner.charAt(i);
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === ',' && depth === 0) { comma = i; break; }
    }
    var name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
    if (name.slice(0, 2) !== '--') return 'var(' + inner + ')';
    var variant = kind === 'fill' ? 'text' : kind;
    var fallback = comma < 0 ? '' : ',' + mapValue(inner.slice(comma + 1), kind, theme, base).trim();
    return 'var(--om-' + variant + '--' + name.slice(2) + ',var(' + name + fallback + '))';
  }

  function mapValue(value, kind, theme, base) {
    var out = '';
    var i = 0;
    var n = value.length;
    while (i < n) {
      var ch = value.charAt(i);
      if (ch === '"' || ch === "'") {
        var stop = skipQuoted(value, i);
        out += value.slice(i, stop);
        i = stop;
        continue;
      }
      var token = ch === '#' ? sticky(HEX, value, i) : null;
      if (token !== null) {
        out += recolour(token, kind, theme);
        i += token.length;
        continue;
      }
      token = sticky(IDENT, value, i);
      if (token !== null) {
        var end = i + token.length;
        var lower = token.toLowerCase();
        if (value.charAt(end) === '(') {
          var close = closing(value, end);
          if (close < 0) { out += value.slice(i); break; }
          if (lower === 'url') out += mapUrl(value.slice(i, close), kind, theme, base);
          else if (lower === 'var') out += mapVar(value.slice(end + 1, close - 1), kind, theme, base);
          else if (COLOR_FUNCTIONS[lower]) out += recolour(value.slice(i, close), kind, theme);
          else if (lower === 'light-dark') out += value.slice(i, close);
          else { out += token + '('; i = end + 1; continue; }
          i = close;
          continue;
        }
        out += lower in NAMED ? recolour(token, kind, theme) : token;
        i = end;
        continue;
      }
      token = sticky(NUMBER, value, i);
      if (token !== null) {
        out += token;
        i += token.length;
        continue;
      }
      out += ch;
      i++;
    }
    return out;
  }

  // A value with its colours replaced; a property that carries no colour comes back unchanged.
  function rewriteValue(prop, value, theme, base) {
    var kind = propKind(String(prop).toLowerCase());
    return kind ? mapValue(value, kind, theme, base || '') : value;
  }

  var BIG_UNCHANGED = 512;

  // [name, value] pairs that replace one declaration. A colour property always comes back (even
  // unchanged) so the override keeps the cascade order of the original; a custom property comes
  // back as its --om-bg--, --om-text-- and --om-border-- variants, all three whenever any differs.
  function rewriteDeclaration(prop, value, theme, base) {
    if (prop.slice(0, 2) === '--') {
      var variants = [];
      var differs = false;
      KINDS.forEach(function (kind) {
        var mapped = mapValue(value, kind, theme, base || '');
        if (mapped !== value) differs = true;
        variants.push(['--om-' + kind + '--' + prop.slice(2), mapped]);
      });
      return differs ? variants : [];
    }
    var kind = propKind(prop.toLowerCase());
    if (!kind) return [];
    var mapped = mapValue(value, kind, theme, base || '');
    if (mapped === value && value.length > BIG_UNCHANGED && /url\(/i.test(value)) return [];
    return [[prop, mapped]];
  }

  function parseDeclarations(text) {
    var chunks = [];
    var depth = 0, quote = '', start = 0;
    for (var i = 0; i < text.length; i++) {
      var c = text.charAt(i);
      if (quote) {
        if (c === '\\') i++;
        else if (c === quote) quote = '';
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === ';' && depth === 0) { chunks.push(text.slice(start, i)); start = i + 1; }
    }
    chunks.push(text.slice(start));
    var out = [];
    chunks.forEach(function (chunk) {
      var colon = chunk.indexOf(':');
      if (colon <= 0) return;
      var value = chunk.slice(colon + 1).trim();
      var important = /\s*!\s*important\s*$/i.test(value);
      if (important) value = value.replace(/\s*!\s*important\s*$/i, '');
      out.push({ name: chunk.slice(0, colon).trim(), value: value, important: important });
    });
    return out;
  }

  function declarationText(name, value, important) {
    return name + ':' + value + (important ? '!important' : '') + ';';
  }

  // The override declarations for a block of declarations (a rule body or a style attribute).
  function rewriteDeclarations(text, theme, base, inline) {
    var out = '';
    parseDeclarations(text).forEach(function (decl) {
      rewriteDeclaration(decl.name, decl.value, theme, base).forEach(function (pair) {
        if (inline && pair[0] === decl.name && pair[1] === decl.value) return;
        out += declarationText(pair[0], pair[1], inline || decl.important);
      });
    });
    return out;
  }

  // ---------------------------------------------------------------------------------------------
  // Rule tree mirroring
  // ---------------------------------------------------------------------------------------------

  function tagOf(rule) {
    return Object.prototype.toString.call(rule).slice(8, -1);
  }

  function prelude(rule) {
    var text = rule.cssText || '';
    var brace = text.indexOf('{');
    return brace < 0 ? '' : text.slice(0, brace).trim();
  }

  function wrapRules(head, rule, theme, ctx) {
    var inner = rulesToCss(rule.cssRules, theme, ctx);
    return inner ? head + '{' + inner + '}' : '';
  }

  function keyframesCss(rule, theme, ctx) {
    var changed = false;
    var frames = '';
    for (var i = 0; i < rule.cssRules.length; i++) {
      var frame = rule.cssRules[i];
      var body = '';
      parseDeclarations(frame.style ? frame.style.cssText : '').forEach(function (decl) {
        var mapped = rewriteValue(decl.name, decl.value, theme, ctx.base);
        if (mapped !== decl.value) changed = true;
        body += declarationText(decl.name, mapped, decl.important);
      });
      frames += frame.keyText + '{' + body + '}';
    }
    return changed ? '@keyframes ' + rule.name + '{' + frames + '}' : '';
  }

  function importCss(rule, theme, ctx) {
    var sheet = rule.styleSheet;
    if (!sheet || !ctx.readRules) return '';
    var rules = ctx.readRules(sheet);
    if (!rules) return '';
    var inner = rulesToCss(rules, theme, { base: sheet.href || ctx.base, readRules: ctx.readRules });
    var media = rule.media && rule.media.mediaText;
    return inner && media ? '@media ' + media + '{' + inner + '}' : inner;
  }

  function ruleToCss(rule, theme, ctx) {
    switch (tagOf(rule)) {
      case 'CSSStyleRule': {
        var body = rewriteDeclarations(rule.style ? rule.style.cssText : '', theme, ctx.base, false);
        var nested = rule.cssRules && rule.cssRules.length ? rulesToCss(rule.cssRules, theme, ctx) : '';
        return body || nested ? rule.selectorText + '{' + body + nested + '}' : '';
      }
      case 'CSSNestedDeclarations':
        return rewriteDeclarations(rule.style ? rule.style.cssText : '', theme, ctx.base, false);
      case 'CSSImportRule':
        return importCss(rule, theme, ctx);
      case 'CSSKeyframesRule':
        return keyframesCss(rule, theme, ctx);
      case 'CSSMediaRule':
        return wrapRules('@media ' + rule.media.mediaText, rule, theme, ctx);
      case 'CSSSupportsRule':
        return wrapRules('@supports ' + rule.conditionText, rule, theme, ctx);
      default:
        if (rule.cssRules && rule.cssRules.length) {
          var head = prelude(rule);
          if (head) return wrapRules(head, rule, theme, ctx);
        }
        return '';
    }
  }

  function rulesToCss(rules, theme, ctx) {
    var out = '';
    for (var i = 0; i < rules.length; i++) {
      try { out += ruleToCss(rules[i], theme, ctx); } catch (_) {}
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------------
  // Fixed CSS: the other methods, the base layer, scrollbars, selection, stroke
  // ---------------------------------------------------------------------------------------------

  function hue180(c) {
    return {
      r: -0.574 * c.r + 1.43 * c.g + 0.144 * c.b,
      g: 0.426 * c.r + 0.43 * c.g + 0.144 * c.b,
      b: 0.426 * c.r + 1.43 * c.g - 0.856 * c.b,
      a: c.a
    };
  }

  // The colour to paint under an invert(1) hue-rotate(180deg) filter so that it comes out as `c`.
  function prefilter(c) {
    return hue180({ r: 255 - c.r, g: 255 - c.g, b: 255 - c.b, a: c.a });
  }

  function shade(hsl, delta) {
    var rgb = hslToRgb(hsl.h, hsl.s, hsl.l + delta);
    return { r: rgb.r, g: rgb.g, b: rgb.b, a: 1 };
  }

  function palette(theme, inverse) {
    var finish = function (c) { return colorToCss(inverse ? prefilter(c) : adjust(c, theme)); };
    var bg = mapBackground(WHITE, theme);
    var hsl = rgbToHsl(bg.r, bg.g, bg.b);
    return {
      bg: finish(bg),
      text: finish(mapForeground(BLACK, theme)),
      input: finish(shade(hsl, 0.04)),
      track: finish(shade(hsl, -0.03)),
      border: finish(mapBorder({ r: 204, g: 204, b: 204, a: 1 }, theme)),
      thumb: finish(mapBorder({ r: 160, g: 160, b: 160, a: 1 }, theme)),
      link: finish(mapForeground({ r: 6, g: 69, b: 173, a: 1 }, theme)),
      muted: finish(mapForeground({ r: 117, g: 117, b: 117, a: 1 }, theme)),
      selection: finish({ r: 38, g: 79, b: 120, a: 1 }),
      selectionText: finish(WHITE)
    };
  }

  function dynamicCss(theme) {
    var p = palette(theme, false);
    return 'html{background-color:' + p.bg + '!important;color:' + p.text + '}' +
      ':where(input,textarea,select,button){background-color:' + p.input + ';color:' + p.text +
      ';border-color:' + p.border + '}';
  }

  function staticCss(theme) {
    var p = palette(theme, false);
    return 'html,body{background-color:' + p.bg + '!important;color:' + p.text + '!important}' +
      'input,textarea,select,button{background-color:' + p.input + '!important;color:' + p.text +
      '!important;border-color:' + p.border + '!important}' +
      'a{color:' + p.link + '!important}' +
      '::placeholder{color:' + p.muted + '!important;opacity:1!important}' +
      'table,th,td,hr{border-color:' + p.border + '!important}';
  }

  // The same look without !important, for a page whose own sheets could not be rewritten.
  function fallbackCss(theme) {
    var p = palette(theme, false);
    return 'html,body{background-color:' + p.bg + ';color:' + p.text + '}' +
      'input,textarea,select,button{background-color:' + p.input + ';color:' + p.text +
      ';border-color:' + p.border + '}' +
      'a:link,a:visited{color:' + p.link + '}';
  }

  function percent(value) {
    return String(Math.round(value) / 100);
  }

  function filterCss(method, theme) {
    var chain = INVERT + ' brightness(' + percent(theme.brightness * 100) + ') contrast(' +
      percent(theme.contrast * 100) + ') sepia(' + percent(theme.sepia * 100) + ') grayscale(' +
      percent(theme.grayscale * 100) + ')';
    var media = 'img,video,canvas,svg image,[style*="background-image"]';
    var background = method === 'filterplus' ?
      'html{background-color:' + colorToCss(prefilter(theme.bg)) + '!important}' :
      'html{background-color:#ffffff}';
    return 'html{filter:' + chain + '!important}' + background +
      media + '{filter:' + INVERT + '!important}' +
      ':is(' + media + ') :is(img,video,canvas){filter:none!important}';
  }

  function commonCss(theme, inverse) {
    var p = palette(theme, inverse);
    var css = '';
    if (theme.systemControls) css += ':root{color-scheme:' + (inverse ? 'light' : 'dark') + '}';
    if (theme.scrollbars) {
      css += '::-webkit-scrollbar{background-color:' + p.track + ';color:' + p.thumb + '}' +
        '::-webkit-scrollbar-thumb{background-color:' + p.thumb + '}' +
        '::-webkit-scrollbar-corner{background-color:' + p.track + '}' +
        '@supports not selector(::-webkit-scrollbar){:root{scrollbar-color:' + p.thumb + ' ' + p.track + '}}' +
        '::selection{background-color:' + p.selection + ';color:' + p.selectionText + '}';
    }
    if (theme.textStroke > 0) {
      css += ':root :not(:is(' + GLYPH + ')){-webkit-text-stroke-width:' + theme.textStroke / 10 + 'px}';
    }
    return css;
  }

  function imageRules() {
    return '[' + IMAGE_MARK + '="invert"]{filter:' + INVERT + '!important}' +
      '[' + IMAGE_MARK + '="tone"]{filter:invert(.92) hue-rotate(180deg)!important}';
  }

  function invertFixes(selectors) {
    return selectors.map(function (selector) {
      return selector + '{filter:' + INVERT + '!important}';
    }).join('');
  }

  function pageCss(method, theme, invert, images) {
    var filtered = method === 'filter' || method === 'filterplus';
    var css = filtered ? filterCss(method, theme) : method === 'static' ? staticCss(theme) : dynamicCss(theme);
    css += commonCss(theme, filtered);
    if (!filtered) {
      css += invertFixes(invert || []);
      if (images) css += imageRules();
    }
    return css;
  }

  // ---------------------------------------------------------------------------------------------
  // Image analysis
  // ---------------------------------------------------------------------------------------------

  function analysePixels(data, width, height) {
    var count = width * height;
    var transparent = 0, opaque = 0, white = 0, lightness = 0, saturation = 0;
    for (var i = 0; i < count; i++) {
      var o = i * 4;
      if (data[o + 3] < 26) { transparent++; continue; }
      var r = data[o], g = data[o + 1], b = data[o + 2];
      var l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      var s = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
      opaque++;
      lightness += l;
      saturation += s;
      if (l > 0.9 && s < 0.1) white++;
    }
    var result = {
      kind: 'photo',
      luminance: opaque ? lightness / opaque : 0.5,
      transparency: count ? transparent / count : 0,
      saturation: opaque ? saturation / opaque : 0,
      whiteFraction: opaque ? white / opaque : 0
    };
    if (!opaque) return result;
    if (result.transparency >= 0.1 && result.luminance < 0.45 && result.saturation < 0.35) result.kind = 'icon';
    else if (result.transparency < 0.1 && result.whiteFraction >= 0.6 && result.saturation < 0.25) result.kind = 'diagram';
    return result;
  }

  // ---------------------------------------------------------------------------------------------
  // Site and schedule decisions
  // ---------------------------------------------------------------------------------------------

  function resolveSite(host, sites) {
    var name = String(host || '').toLowerCase();
    var best = null;
    var length = -1;
    Object.keys(sites || {}).forEach(function (key) {
      var inside = name === key || name.slice(-key.length - 1) === '.' + key;
      if (inside && key.length > length) { best = sites[key]; length = key.length; }
    });
    return best || {};
  }

  var SITE_FIELDS = {
    method: 'string', brightness: 'number', contrast: 'number', sepia: 'number', grayscale: 'number',
    background: 'string', text: 'string', schedule: 'object', skipDarkPages: 'boolean',
    systemControls: 'boolean', scrollbars: 'boolean', images: 'boolean', textStroke: 'number'
  };

  // The configuration for one page: the global one with every field of the site's entry laid over
  // it (a schedule replaces the whole schedule). `enabled` and `mode` are not overlaid: mode is
  // decided on its own.
  function effectiveConfig(raw, site) {
    var merged = Object.assign({}, raw || {});
    var entry = site || {};
    Object.keys(SITE_FIELDS).forEach(function (key) {
      var value = entry[key];
      if (value === undefined || value === null || typeof value !== SITE_FIELDS[key]) return;
      if (key === 'method' && METHODS.indexOf(value) < 0) return;
      merged[key] = value;
    });
    return normalise(merged);
  }

  function minutesOf(text) {
    var match = /^(\d{1,2}):(\d{2})$/.exec(String(text));
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  }

  function scheduleActive(schedule, now, prefersDark) {
    var kind = schedule && schedule.kind;
    if (kind === 'system') return !!prefersDark;
    if (kind !== 'time') return true;
    var from = minutesOf(schedule.from);
    var to = minutesOf(schedule.to);
    if (from === null || to === null || from === to) return true;
    var at = now.getHours() * 60 + now.getMinutes();
    return from < to ? at >= from && at < to : at >= from || at < to;
  }

  function mergeFixes(list) {
    var merged = { mode: null, method: null, invert: [] };
    (Array.isArray(list) ? list : []).forEach(function (fix) {
      if (!fix || typeof fix !== 'object') return;
      if (!merged.mode && (fix.mode === 'on' || fix.mode === 'off')) merged.mode = fix.mode;
      if (!merged.method && METHODS.indexOf(fix.method) >= 0) merged.method = fix.method;
      (Array.isArray(fix.invert) ? fix.invert : []).forEach(function (selector) {
        if (typeof selector === 'string' && merged.invert.indexOf(selector) < 0) merged.invert.push(selector);
      });
    });
    return merged;
  }

  if (config && config.expose && typeof config.expose === 'object') {
    var exposed = {
      parseColor: parseColor, rgbToHsl: rgbToHsl, hslToRgb: hslToRgb, colorToCss: colorToCss,
      buildTheme: buildTheme, adjust: adjust, palette: palette,
      modifyBackground: modifyBackground, modifyForeground: modifyForeground,
      modifyBorder: modifyBorder, modifyFill: modifyFill,
      rewriteValue: rewriteValue, rewriteDeclaration: rewriteDeclaration,
      rewriteDeclarations: rewriteDeclarations, rulesToCss: rulesToCss,
      scheduleActive: scheduleActive, resolveSite: resolveSite, effectiveConfig: effectiveConfig, mergeFixes: mergeFixes,
      dynamicCss: dynamicCss, staticCss: staticCss, filterCss: filterCss, commonCss: commonCss,
      pageCss: pageCss, analysePixels: analysePixels
    };
    Object.keys(exposed).forEach(function (name) { config.expose[name] = exposed[name]; });
  }

  // ---------------------------------------------------------------------------------------------
  // The page: sessions, sheets, observers
  // ---------------------------------------------------------------------------------------------

  try {
    if (typeof document[KEY] === 'function') document[KEY]();

    var global = normalise(config);
    var host = String((window.location && window.location.hostname) || '').toLowerCase();
    var site = resolveSite(host, global.sites);
    // Every setting the site entry carries beats the global one; the rest follows global.
    var cfg = effectiveConfig(config, site);
    var firstFixes = mergeFixes(document[FIXES]);
    var firstMode = site.mode || firstFixes.mode || null;
    // With everything off this only tears down what an earlier run left.
    if (firstMode === 'off' || (!cfg.enabled && firstMode !== 'on')) return;

    var nativeFetch = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;
    var ours = new WeakSet();
    var foreign = new Map();
    var imageResults = new Map();
    var imageQueue = [];
    var imageRunning = 0;
    var dead = false;
    var session = null;
    var activeKey = 'off';
    var activeForced = false;
    var detected = false;
    var skippedDark = false;
    var idCounter = 0;
    var undo = [];

    function later(fn, ms) {
      var done = false;
      var run = function () { if (done) return; done = true; fn(); };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
      setTimeout(run, ms || 60);
    }

    function setState(active, reason) {
      Object.defineProperty(document, STATE, {
        configurable: true,
        value: { active: active, reason: reason }
      });
    }

    function html(el) {
      return el.namespaceURI === HTML_NS;
    }

    function makeStyle(s, css) {
      var el = document.createElement('style');
      el.setAttribute(OWN, '');
      el.textContent = css;
      s.styles.push(el);
      return el;
    }

    function removeStyle(s, el) {
      var at = s.styles.indexOf(el);
      if (at >= 0) s.styles.splice(at, 1);
      try { el.remove(); } catch (_) {}
    }

    // ------- adopted style sheets

    var adoptedDescriptors = null;

    function adoptedDescriptor(root) {
      if (!adoptedDescriptors) {
        adoptedDescriptors = {
          document: typeof Document === 'function' ? Object.getOwnPropertyDescriptor(Document.prototype, 'adoptedStyleSheets') : null,
          shadow: typeof ShadowRoot === 'function' ? Object.getOwnPropertyDescriptor(ShadowRoot.prototype, 'adoptedStyleSheets') : null
        };
      }
      return root.nodeType === 9 ? adoptedDescriptors.document : adoptedDescriptors.shadow;
    }

    function readAdopted(root) {
      var descriptor = adoptedDescriptor(root);
      var list = descriptor && descriptor.get ? descriptor.get.call(root) : root.adoptedStyleSheets;
      return Array.prototype.slice.call(list || []);
    }

    function writeAdopted(root, list) {
      var descriptor = adoptedDescriptor(root);
      if (descriptor && descriptor.set) descriptor.set.call(root, list);
      else root.adoptedStyleSheets = list;
    }

    // ------- cross-origin sheets are fetched once and parsed into a detached sheet

    function absolutise(text, href) {
      return text
        .replace(/@import[^;]*;/gi, '')
        .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, function (all, quote, url) {
          if (/^(data:|#|about:)/i.test(url)) return all;
          return 'url("' + resolveUrl(url, href) + '")';
        });
    }

    function foreignRules(href, entry) {
      if (!href || !nativeFetch || typeof CSSStyleSheet !== 'function') return null;
      var record = foreign.get(href);
      if (record) {
        if (record.pending && entry && record.waiters.indexOf(entry) < 0) record.waiters.push(entry);
        return record.rules;
      }
      record = { pending: true, rules: null, waiters: entry ? [entry] : [] };
      foreign.set(href, record);
      nativeFetch(href, { credentials: 'omit' })
        .then(function (response) {
          if (!response.ok) throw new Error('status');
          return response.text();
        })
        .then(function (text) {
          var parsed = new CSSStyleSheet();
          ours.add(parsed);
          parsed.replaceSync(absolutise(text, href));
          record.rules = parsed.cssRules;
        })
        .catch(function () {})
        .then(function () {
          record.pending = false;
          if (!dead && session) record.waiters.forEach(function (waiting) { markDirty(session, waiting); });
          record.waiters = [];
        });
      return null;
    }

    function pendingForeign(href) {
      var record = foreign.get(href);
      return !!record && record.pending;
    }

    // ------- sessions

    function startSession(method, forced) {
      var theme = buildTheme(cfg);
      var fixes = mergeFixes(document[FIXES]);
      var dynamic = method === 'dynamic';
      var images = cfg.images && (dynamic || method === 'static');
      var s = {
        method: method,
        forced: forced,
        theme: theme,
        dynamic: dynamic,
        images: images,
        styles: [],
        sheets: [],
        undo: [],
        roots: new Set(),
        entries: new Map(),
        adopted: new Map(),
        inline: new Map(),
        dirty: new Set(),
        inlineDirty: new Set(),
        adoptedDirty: new Set(),
        imageTimes: new WeakMap(),
        byInner: new WeakMap(),
        originalCount: new Map(),
        observer: null,
        fallback: null,
        pending: false,
        rebuild: false,
        suspended: false,
        dead: false
      };
      session = s;
      var base = makeStyle(s, pageCss(method, theme, fixes.invert, images));
      document.documentElement.appendChild(base);
      if (dynamic || images) startObserving(s);
      if (dynamic) startPatches(s);
      if (images) theme.images = { lookup: function (url) { return backgroundImage(s, url); } };
      registerRoot(s, document);
      if (!forced && cfg.skipDarkPages && !detected) detectSoon();
    }

    function stopSession() {
      var s = session;
      if (!s) return;
      session = null;
      s.dead = true;
      s.undo.slice().reverse().forEach(function (step) { try { step(); } catch (_) {} });
      s.undo.length = 0;
      s.entries.forEach(function (entry) {
        if (entry.onLoad) entry.owner.removeEventListener('load', entry.onLoad);
      });
      s.roots.forEach(function (root) {
        try {
          if (s.adopted.size) {
            var list = readAdopted(root);
            var kept = list.filter(function (sheet) { return !ours.has(sheet); });
            if (kept.length !== list.length) writeAdopted(root, kept);
          }
          Array.prototype.forEach.call(root.querySelectorAll('[' + INLINE_ID + ']'), function (el) { el.removeAttribute(INLINE_ID); });
          Array.prototype.forEach.call(root.querySelectorAll('[' + IMAGE_MARK + ']'), function (el) { el.removeAttribute(IMAGE_MARK); });
        } catch (_) {}
      });
      s.styles.slice().forEach(function (el) { try { el.remove(); } catch (_) {} });
      s.styles.length = 0;
      s.roots.clear();
      s.entries.clear();
      s.adopted.clear();
      s.inline.clear();
    }

    function setSuspended(s, suspended) {
      s.suspended = suspended;
      s.styles.forEach(function (el) { el.disabled = suspended; });
      s.sheets.forEach(function (sheet) { sheet.disabled = suspended; });
    }

    function markDirty(s, entry) {
      s.dirty.add(entry);
      schedule(s);
    }

    function schedule(s) {
      if (s.pending || s.dead) return;
      s.pending = true;
      later(function () {
        s.pending = false;
        if (!s.dead) { try { flush(s); } catch (_) {} }
      }, 60);
    }

    function flush(s) {
      if (s.rebuild) {
        s.rebuild = false;
        s.entries.forEach(function (entry) { s.dirty.add(entry); });
        s.adopted.forEach(function (entry) { s.dirty.add(entry); });
        s.inline.forEach(function (box) {
          box.rules.forEach(function (rule) { rule.source = null; s.inlineDirty.add(rule.el); });
        });
      }
      var entries = Array.from(s.dirty);
      s.dirty.clear();
      entries.forEach(function (entry) { try { processEntry(s, entry); } catch (_) {} });
      var inlines = Array.from(s.inlineDirty);
      s.inlineDirty.clear();
      var touched = new Set();
      inlines.forEach(function (el) { try { processInline(s, el, touched); } catch (_) {} });
      touched.forEach(function (box) { writeInline(s, box); });
      var roots = Array.from(s.adoptedDirty);
      s.adoptedDirty.clear();
      roots.forEach(function (root) { try { syncAdopted(s, root); } catch (_) {} });
    }

    // ------- sheets

    function readRulesFor(s, entry) {
      return function (sheet) {
        try { return sheet.cssRules; } catch (_) {}
        var rules = foreignRules(sheet.href, entry);
        if (!rules && !pendingForeign(sheet.href)) entry.unreadable = true;
        return rules;
      };
    }

    function refreshFallback(s) {
      var broken = false;
      s.entries.forEach(function (entry) { if (entry.unreadable) broken = true; });
      s.adopted.forEach(function (entry) { if (entry.unreadable) broken = true; });
      if (broken && !s.fallback) {
        s.fallback = makeStyle(s, fallbackCss(s.theme));
        s.fallback.disabled = s.suspended;
        document.documentElement.appendChild(s.fallback);
      } else if (!broken && s.fallback) {
        removeStyle(s, s.fallback);
        s.fallback = null;
      }
    }

    function processEntry(s, entry) {
      if (s.dead) return;
      var owner = entry.owner;
      var isElement = entry.kind === 'element';
      if (isElement && !owner.isConnected) { untrack(s, entry); return; }
      var sheet = isElement ? owner.sheet : owner;
      if (!sheet) return;
      s.byInner.set(sheet, entry);
      entry.unreadable = false;
      var read = readRulesFor(s, entry);
      var ctx = {
        base: sheet.href || document.baseURI,
        readRules: function (inner) { s.byInner.set(inner, entry); return read(inner); }
      };
      var rules = read(sheet);
      refreshFallback(s);
      if (!rules) return;
      var css = rulesToCss(rules, s.theme, ctx);
      var disabled = s.suspended || !!sheet.disabled;
      if (isElement) {
        if (!entry.out) entry.out = makeStyle(s, '');
        var out = entry.out;
        var media = owner.getAttribute('media');
        if (media) out.setAttribute('media', media);
        else out.removeAttribute('media');
        if (entry.css !== css) { entry.css = css; out.textContent = css; }
        if (!out.isConnected || out.previousSibling !== owner) {
          if (owner.parentNode) owner.parentNode.insertBefore(out, owner.nextSibling);
        }
        out.disabled = disabled;
      } else {
        if (!entry.out) {
          entry.out = new CSSStyleSheet();
          ours.add(entry.out);
          s.sheets.push(entry.out);
        }
        var mediaText = sheet.media && sheet.media.mediaText;
        var text = mediaText ? '@media ' + mediaText + '{' + css + '}' : css;
        if (entry.css !== text) { entry.css = text; entry.out.replaceSync(text); }
        entry.out.disabled = disabled;
      }
    }

    function trackElement(s, el) {
      if (s.entries.has(el) || !html(el)) return;
      if (el.hasAttribute(OWN) || el.hasAttribute(RECIPE_STYLE)) return;
      var name = el.localName;
      var entry = { kind: 'element', owner: el, out: null, css: null, unreadable: false, onLoad: null };
      if (name === 'style') {
        var type = el.getAttribute('type');
        if (type && type.toLowerCase() !== 'text/css') return;
      } else if (name === 'link') {
        if (!/(^|\s)stylesheet(\s|$)/i.test(el.getAttribute('rel') || '')) return;
        entry.onLoad = function () { markDirty(s, entry); };
        el.addEventListener('load', entry.onLoad);
      } else return;
      s.entries.set(el, entry);
      markDirty(s, entry);
    }

    function untrack(s, entry) {
      s.entries.delete(entry.owner);
      if (entry.onLoad) entry.owner.removeEventListener('load', entry.onLoad);
      if (entry.out) removeStyle(s, entry.out);
      refreshFallback(s);
    }

    function syncAdopted(s, root) {
      var list = readAdopted(root);
      var originals = list.filter(function (sheet) { return !ours.has(sheet); });
      var extra = [];
      originals.forEach(function (sheet) {
        var entry = s.adopted.get(sheet);
        if (!entry) {
          entry = { kind: 'adopted', owner: sheet, out: null, css: null, unreadable: false };
          s.adopted.set(sheet, entry);
          processEntry(s, entry);
        }
        if (entry.out) extra.push(entry.out);
      });
      var desired = originals.concat(extra);
      var same = desired.length === list.length && desired.every(function (sheet, i) { return sheet === list[i]; });
      if (!same) writeAdopted(root, desired);
      s.originalCount.set(root, originals.length);
    }

    function topEntry(s, sheet) {
      var guard = 0;
      while (sheet && guard++ < 16) {
        var entry = s.byInner.get(sheet);
        if (entry) return entry;
        sheet = sheet.parentStyleSheet;
      }
      return null;
    }

    function touch(sheet) {
      var s = session;
      if (!s || !sheet || ours.has(sheet)) return;
      var entry = topEntry(s, sheet);
      if (entry) markDirty(s, entry);
    }

    // ------- patches that catch what the page does to sheets after load

    function patch(s, target, name, wrap) {
      var original = target && target[name];
      if (typeof original !== 'function') return;
      var wrapper = wrap(original);
      target[name] = wrapper;
      s.undo.push(function () { if (target[name] === wrapper) target[name] = original; });
    }

    function startPatches(s) {
      adoptedDescriptor(document);
      adoptedDescriptor({ nodeType: 11 });
      if (typeof CSSStyleSheet === 'function') {
        ['insertRule', 'deleteRule', 'replaceSync'].forEach(function (name) {
          patch(s, CSSStyleSheet.prototype, name, function (original) {
            return function () {
              var result = original.apply(this, arguments);
              try { touch(this); } catch (_) {}
              return result;
            };
          });
        });
        patch(s, CSSStyleSheet.prototype, 'replace', function (original) {
          return function () {
            var sheet = this;
            var result = original.apply(sheet, arguments);
            if (result && typeof result.then === 'function') {
              result.then(function () { try { touch(sheet); } catch (_) {} }, function () {});
            }
            return result;
          };
        });
      }
      if (typeof CSSGroupingRule === 'function') {
        ['insertRule', 'deleteRule'].forEach(function (name) {
          patch(s, CSSGroupingRule.prototype, name, function (original) {
            return function () {
              var result = original.apply(this, arguments);
              try { touch(this.parentStyleSheet); } catch (_) {}
              return result;
            };
          });
        });
      }
      if (typeof Element === 'function') {
        patch(s, Element.prototype, 'attachShadow', function (original) {
          return function () {
            var root = original.apply(this, arguments);
            try { if (session === s) registerRoot(s, root); } catch (_) {}
            return root;
          };
        });
      }
      [['document', typeof Document === 'function' ? Document.prototype : null],
        ['shadow', typeof ShadowRoot === 'function' ? ShadowRoot.prototype : null]].forEach(function (pair) {
        var proto = pair[1];
        var descriptor = proto && Object.getOwnPropertyDescriptor(proto, 'adoptedStyleSheets');
        if (!descriptor || !descriptor.set || !descriptor.configurable) return;
        Object.defineProperty(proto, 'adoptedStyleSheets', {
          configurable: true,
          enumerable: descriptor.enumerable,
          get: descriptor.get,
          set: function (value) {
            descriptor.set.call(this, value);
            try { if (session === s) syncAdopted(s, this); } catch (_) {}
          }
        });
        s.undo.push(function () { Object.defineProperty(proto, 'adoptedStyleSheets', descriptor); });
      });
      // A page may also push onto the live adopted list, which no setter sees.
      var watch = setInterval(function () {
        s.roots.forEach(function (root) {
          try {
            var count = readAdopted(root).filter(function (sheet) { return !ours.has(sheet); }).length;
            if (count !== (s.originalCount.get(root) || 0)) {
              s.originalCount.set(root, count);
              s.adoptedDirty.add(root);
              schedule(s);
            }
          } catch (_) {}
        });
      }, 1500);
      s.undo.push(function () { clearInterval(watch); });
    }

    // ------- inline style attributes

    var INLINE_HINT = /color|background|border|outline|shadow|fill|stroke|--|scrollbar|accent|caret|stop|flood|lighting|tap-highlight|decoration|column-rule|emphasis/i;

    function inlineBox(s, root) {
      var box = s.inline.get(root);
      if (box) return box;
      box = { root: root, style: makeStyle(s, ''), rules: new Map(), dirty: false };
      box.style.disabled = s.suspended;
      (root.nodeType === 9 ? document.documentElement : root).appendChild(box.style);
      s.inline.set(root, box);
      return box;
    }

    function processInline(s, el, touched) {
      if (!el.isConnected) return;
      var root = el.getRootNode();
      if (!s.roots.has(root)) return;
      var text = el.getAttribute('style') || '';
      var box = inlineBox(s, root);
      var id = el.getAttribute(INLINE_ID);
      var previous = id ? box.rules.get(id) : null;
      if (previous && previous.source === text) return;
      var body = INLINE_HINT.test(text) ? rewriteDeclarations(text, s.theme, document.baseURI, true) : '';
      if (!body) {
        if (previous) { box.rules.delete(id); touched.add(box); box.dirty = true; }
        if (id) el.removeAttribute(INLINE_ID);
        return;
      }
      if (!id) {
        id = String(++idCounter);
        el.setAttribute(INLINE_ID, id);
      }
      box.rules.set(id, { el: el, source: text, css: '[' + INLINE_ID + '="' + id + '"]{' + body + '}' });
      box.dirty = true;
      touched.add(box);
    }

    function writeInline(s, box) {
      if (!box.dirty) return;
      box.dirty = false;
      var css = '';
      box.rules.forEach(function (rule, id) {
        if (!rule.el.isConnected) { box.rules.delete(id); return; }
        css += rule.css;
      });
      box.style.textContent = css;
    }

    // ------- roots and mutation

    function registerRoot(s, root) {
      if (s.roots.has(root)) return;
      s.roots.add(root);
      if (s.observer) {
        s.observer.observe(root, s.dynamic ?
          { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'media', 'disabled', 'href'], characterData: true } :
          { childList: true, subtree: true });
      }
      if (s.images) {
        var onLoad = function (event) {
          if (event.target && event.target.localName === 'img') analyseImage(s, event.target);
        };
        root.addEventListener('load', onLoad, true);
        s.undo.push(function () { root.removeEventListener('load', onLoad, true); });
      }
      scanNode(s, root, true);
      if (s.dynamic) syncAdopted(s, root);
    }

    function scanNode(s, node, deep) {
      if (node.nodeType === 1) {
        var name = node.localName;
        if (s.dynamic && (name === 'style' || name === 'link')) trackElement(s, node);
        if (s.dynamic && node.hasAttribute('style')) queueInline(s, node);
        if (s.images && name === 'img') analyseImage(s, node);
        if (node.shadowRoot && deep) registerRoot(s, node.shadowRoot);
      }
      if (!node.querySelectorAll) return;
      if (s.dynamic) {
        Array.prototype.forEach.call(node.querySelectorAll('style,link[rel~="stylesheet" i]'), function (el) { trackElement(s, el); });
        Array.prototype.forEach.call(node.querySelectorAll('[style]'), function (el) { queueInline(s, el); });
      }
      if (s.images) Array.prototype.forEach.call(node.querySelectorAll('img'), function (el) { analyseImage(s, el); });
      if (deep) {
        Array.prototype.forEach.call(node.querySelectorAll('*'), function (el) {
          if (el.shadowRoot) registerRoot(s, el.shadowRoot);
        });
      }
    }

    function queueInline(s, el) {
      s.inlineDirty.add(el);
      schedule(s);
    }

    function owningStyle(node) {
      var el = node.nodeType === 1 ? node : node.parentNode;
      while (el && el.nodeType === 1 && el.localName !== 'style') el = el.parentNode;
      return el && el.nodeType === 1 && el.localName === 'style' ? el : null;
    }

    function onRemoved(s, node) {
      if (node.nodeType !== 1 || (node.hasAttribute && node.hasAttribute(OWN))) return;
      var entry = s.entries.get(node);
      if (entry) untrack(s, entry);
      if (node.querySelectorAll) {
        Array.prototype.forEach.call(node.querySelectorAll('style,link'), function (el) {
          var inner = s.entries.get(el);
          if (inner) untrack(s, inner);
        });
      }
    }

    function onMutations(s, records) {
      if (s.dead) return;
      records.forEach(function (record) {
        try {
          var target = record.target;
          if (record.type === 'childList') {
            if (target.nodeType === 1 && target.hasAttribute(OWN)) return;
            Array.prototype.forEach.call(record.removedNodes, function (node) { onRemoved(s, node); });
            Array.prototype.forEach.call(record.addedNodes, function (node) {
              if (node.nodeType === 1 && node.hasAttribute(OWN)) return;
              scanNode(s, node, false);
            });
            var style = s.dynamic ? owningStyle(target) : null;
            if (style && s.entries.has(style)) markDirty(s, s.entries.get(style));
          } else if (record.type === 'characterData') {
            var parent = s.dynamic ? owningStyle(target) : null;
            if (parent && s.entries.has(parent)) markDirty(s, s.entries.get(parent));
          } else if (record.type === 'attributes') {
            if (record.attributeName === 'style') queueInline(s, target);
            else if (s.entries.has(target)) markDirty(s, s.entries.get(target));
          }
        } catch (_) {}
      });
    }

    function startObserving(s) {
      if (typeof MutationObserver !== 'function') return;
      s.observer = new MutationObserver(function (records) { onMutations(s, records); });
      s.undo.push(function () { s.observer.disconnect(); s.observer = null; });
    }

    // ------- image analysis

    function analyseImage(s, img) {
      var url = img.currentSrc || img.src;
      if (!url || !img.complete || !img.naturalWidth) return;
      if (s.imageTimes.get(img) === url) return;
      s.imageTimes.set(img, url);
      loadVerdict(s, url, function (verdict) {
        if (s.dead || !img.isConnected) return;
        var mark = null;
        if (verdict && verdict.kind === 'icon') mark = 'invert';
        else if (verdict && verdict.kind === 'diagram') {
          var box = img.getBoundingClientRect();
          var width = box.width || img.naturalWidth;
          var height = box.height || img.naturalHeight;
          if (width >= 120 && height >= 120) mark = 'tone';
        }
        if (mark) img.setAttribute(IMAGE_MARK, mark);
        else img.removeAttribute(IMAGE_MARK);
      });
    }

    // Sized for the analysis only; pixels past 64 px on a side add nothing to the verdict.
    function loadVerdict(s, url, done) {
      var known = imageResults.get(url);
      if (known) {
        if (known.verdict !== undefined) done(known.verdict);
        else known.waiting.push(done);
        return;
      }
      var record = { verdict: undefined, inverted: null, waiting: [done], wanted: false };
      imageResults.set(url, record);
      imageQueue.push(function (release) {
        var finish = function (verdict) {
          record.verdict = verdict;
          release();
          var waiting = record.waiting;
          record.waiting = [];
          waiting.forEach(function (callback) { try { callback(verdict); } catch (_) {} });
          if (record.wanted && session) { session.rebuild = true; schedule(session); }
        };
        var image = new Image();
        image.crossOrigin = 'anonymous';
        image.onload = function () {
          try {
            var width = image.naturalWidth;
            var height = image.naturalHeight;
            if (!width || !height) return finish(null);
            var scale = Math.min(1, 64 / Math.max(width, height));
            var canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(width * scale));
            canvas.height = Math.max(1, Math.round(height * scale));
            var context = canvas.getContext('2d', { willReadFrequently: true });
            context.drawImage(image, 0, 0, canvas.width, canvas.height);
            var verdict = analysePixels(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
            if (verdict.kind === 'icon' && width <= 512 && height <= 512) record.inverted = invertedDataUrl(image, width, height);
            finish(verdict);
          } catch (_) { finish(null); }
        };
        image.onerror = function () { finish(null); };
        image.src = url;
      });
      pumpImages();
    }

    function pumpImages() {
      while (imageRunning < 4 && imageQueue.length) {
        var job = imageQueue.shift();
        imageRunning++;
        var released = false;
        job(function () {
          if (released) return;
          released = true;
          imageRunning--;
          pumpImages();
        });
      }
    }

    function invertedDataUrl(image, width, height) {
      var canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      var context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0);
      var frame = context.getImageData(0, 0, width, height);
      var data = frame.data;
      for (var i = 0; i < data.length; i += 4) {
        data[i] = 255 - data[i];
        data[i + 1] = 255 - data[i + 1];
        data[i + 2] = 255 - data[i + 2];
      }
      context.putImageData(frame, 0, 0);
      return canvas.toDataURL('image/png');
    }

    // The data URL of an inverted dark icon used as a CSS background, once it is known; the first
    // call starts the analysis and a rebuild picks the answer up.
    function backgroundImage(s, url) {
      var record = imageResults.get(url);
      if (!record) {
        loadVerdict(s, url, function () {});
        record = imageResults.get(url);
        if (record) record.wanted = true;
        return undefined;
      }
      record.wanted = true;
      return record.verdict === undefined ? undefined : record.inverted;
    }

    // ------- dark-page detection

    function pageIsDark() {
      var meta = document.querySelector('meta[name="color-scheme" i]');
      var content = meta && (meta.getAttribute('content') || '').trim().toLowerCase();
      if (content && content.split(/\s+/)[0] === 'dark') return true;
      var cover = function (el) {
        if (!el) return null;
        var c = parseColor(getComputedStyle(el).backgroundColor);
        return c && c.a >= 0.1 ? c : null;
      };
      var paint = cover(document.body) || cover(document.documentElement);
      if (paint) return luma(paint) < 0.4;
      var ink = parseColor(getComputedStyle(document.body || document.documentElement).color);
      return !!ink && luma(ink) > 0.6;
    }

    function detect() {
      detected = true;
      var s = session;
      if (!s || activeForced) return;
      var dark = false;
      try {
        setSuspended(s, true);
        dark = pageIsDark();
      } catch (_) {}
      if (session === s) setSuspended(s, false);
      if (dark) {
        skippedDark = true;
        evaluate();
      }
    }

    function detectSoon() {
      if (document.readyState === 'loading') {
        if (detectSoon.listening) return;
        detectSoon.listening = true;
        var onReady = function () { detectSoon.listening = false; if (!detected && session) detect(); };
        document.addEventListener('DOMContentLoaded', onReady, { once: true });
        undo.push(function () { document.removeEventListener('DOMContentLoaded', onReady); });
      } else {
        detect();
      }
    }

    // ------- the decision

    function prefersDark() {
      try { return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); } catch (_) { return false; }
    }

    function decide() {
      var fixes = mergeFixes(document[FIXES]);
      var mode = site.mode || fixes.mode;
      var method = site.method || fixes.method || global.method;
      if (mode === 'off') return { on: false, reason: site.mode ? 'site-off' : 'recipe-off' };
      if (mode === 'on') return { on: true, method: method, forced: true, reason: site.mode ? 'site-on' : 'recipe-on' };
      if (!cfg.enabled) return { on: false, reason: 'disabled' };
      if (!scheduleActive(cfg.schedule, new Date(), prefersDark())) return { on: false, reason: 'schedule' };
      return { on: true, method: method, forced: false, reason: 'enabled' };
    }

    function whenElement(fn) {
      if (document.documentElement) { fn(); return; }
      var wait = new MutationObserver(function () {
        if (!document.documentElement) return;
        wait.disconnect();
        fn();
      });
      wait.observe(document, { childList: true });
      undo.push(function () { wait.disconnect(); });
    }

    function evaluate() {
      if (dead) return;
      var decision = decide();
      if (decision.on && skippedDark && !decision.forced) decision = { on: false, reason: 'dark-page' };
      setState(decision.on, decision.reason);
      var key = decision.on ? decision.method + (decision.forced ? '!' : '') : 'off';
      if (key !== activeKey) {
        stopSession();
        activeKey = key;
        activeForced = !!decision.forced;
        if (decision.on) {
          whenElement(function () {
            if (!dead && activeKey === key && !session) startSession(decision.method, decision.forced);
          });
        }
      }
    }

    Object.defineProperty(document, KEY, {
      configurable: true,
      value: function () {
        dead = true;
        stopSession();
        undo.forEach(function (step) { try { step(); } catch (_) {} });
        undo.length = 0;
        delete document[KEY];
        delete document[STATE];
      }
    });

    if (cfg.schedule.kind === 'system' && window.matchMedia) {
      var query = window.matchMedia('(prefers-color-scheme: dark)');
      query.addEventListener('change', evaluate);
      undo.push(function () { query.removeEventListener('change', evaluate); });
    }
    if (cfg.schedule.kind === 'time') {
      var timer = setInterval(evaluate, 30000);
      undo.push(function () { clearInterval(timer); });
    }
    evaluate();
  } catch (_) {}
})
