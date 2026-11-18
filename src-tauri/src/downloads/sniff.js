(function () {
  var MAX = 4000;
  var out = [];
  var seen = Object.create(null);
  var base = document.baseURI;

  function add(raw, hint, label, width, height) {
    if (out.length >= MAX || typeof raw !== "string") return;
    raw = raw.trim();
    if (!raw || raw.length > 4096) return;
    var href;
    try {
      href = new URL(raw, base).href;
    } catch (e) {
      return;
    }
    if (href.indexOf("http") !== 0) return;
    var key = hint + " " + href;
    if (seen[key]) return;
    seen[key] = true;
    out.push({
      u: href,
      k: hint,
      t: typeof label === "string" ? label.trim().slice(0, 200) : "",
      w: width | 0,
      h: height | 0,
    });
  }

  function bestOfSrcset(srcset) {
    if (typeof srcset !== "string") return "";
    var best = "";
    var bestScore = -1;
    srcset.split(",").forEach(function (entry) {
      var parts = entry.trim().split(/\s+/);
      if (!parts[0]) return;
      var score = parseFloat(parts[1] || "1x") || 1;
      if (score >= bestScore) {
        bestScore = score;
        best = parts[0];
      }
    });
    return best;
  }

  var LAZY = ["data-src", "data-original", "data-lazy-src", "data-full-src"];

  document.querySelectorAll("img").forEach(function (img) {
    var label = img.alt || img.title || "";
    var w = img.naturalWidth || img.width;
    var h = img.naturalHeight || img.height;
    add(bestOfSrcset(img.srcset) || img.currentSrc || img.src, "image", label, w, h);
    LAZY.forEach(function (attribute) {
      add(img.getAttribute(attribute), "image", label, w, h);
    });
  });
  document.querySelectorAll("picture source").forEach(function (source) {
    add(bestOfSrcset(source.srcset), "image", "", 0, 0);
  });
  document.querySelectorAll("video").forEach(function (video) {
    var label = video.title || video.getAttribute("aria-label") || "";
    add(video.currentSrc || video.src, "video", label, video.videoWidth, video.videoHeight);
    add(video.poster, "image", label, 0, 0);
  });
  document.querySelectorAll("video source, audio source").forEach(function (source) {
    var parent = source.parentElement;
    add(source.src, parent && parent.tagName === "AUDIO" ? "audio" : "video", parent && parent.title, 0, 0);
  });
  document.querySelectorAll("audio").forEach(function (audio) {
    add(audio.currentSrc || audio.src, "audio", audio.title || "", 0, 0);
  });
  document.querySelectorAll('[style*="url("]').forEach(function (element) {
    var match = /url\(\s*['"]?([^'")]+)['"]?\s*\)/.exec(element.getAttribute("style") || "");
    if (match) add(match[1], "image", "", 0, 0);
  });
  document.querySelectorAll("a[href]").forEach(function (anchor) {
    var text = (anchor.textContent || anchor.title || "").replace(/\s+/g, " ").trim();
    add(anchor.href, "link", text, 0, 0);
  });
  try {
    performance.getEntriesByType("resource").forEach(function (entry) {
      var type = entry.initiatorType;
      var hint = type === "img" ? "image" : type === "video" ? "video" : type === "audio" ? "audio" : "resource";
      add(entry.name, hint, "", 0, 0);
    });
  } catch (e) {
    /* resource timing is optional */
  }
  return { page: { url: location.href, title: document.title }, items: out };
})()
