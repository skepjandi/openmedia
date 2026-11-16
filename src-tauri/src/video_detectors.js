    // Spliced into video_controls.js at its DETECTORS marker, inside the page closure. It
    // defines libraryGroups(video) and reads PLAYERS, which the page script defines before it.
    // Players built with a common library are found from the video itself, so their options
    // need no recipe. A library object is the site's and may throw on any access, so every
    // touch of one is inside a try. What is found is kept for LIB_CACHE_MS per video (and the
    // scan of the window's own values for as long); the groups are built from it on each read.
    var LIB_CACHE_MS = 3000;
    var LIB_SCAN_KEYS = 400;
    var YT_QUALITY = { highres: 'Highest', hd2880: '2880p', hd2160: '2160p', hd1440: '1440p', hd1080: '1080p',
      hd720: '720p', large: '480p', medium: '360p', small: '240p', tiny: '144p', auto: 'Auto' };
    var libraryFinds = new WeakMap();
    var windowScan = { at: -Infinity, objects: [] };
    var ytChoice = new WeakMap();

    function windowObjects() {
      var now = Date.now();
      if (now - windowScan.at < LIB_CACHE_MS) return windowScan.objects;
      var objects = [];
      var keys = [];
      try { keys = Object.keys(window).slice(0, LIB_SCAN_KEYS); } catch (_) {}
      keys.forEach(function (key) {
        try {
          var value = window[key];
          if (value && typeof value === 'object') objects.push(value);
        } catch (_) {}
      });
      windowScan = { at: now, objects: objects };
      return objects;
    }

    function firstWindowObject(test) {
      var objects = (window[PLAYERS] || []).concat(windowObjects());
      for (var i = 0; i < objects.length; i++) {
        try { if (test(objects[i])) return objects[i]; } catch (_) {}
      }
      return null;
    }

    function levelLabel(height, bitrate, index) {
      if (height > 0) return height + 'p';
      if (bitrate > 0) return Math.round(bitrate / 1000) + ' kbps';
      return 'Level ' + (index + 1);
    }

    function qualityGroup(labels, selected, pick) {
      if (labels.length < 3) return null; // 'Auto' and one level is no choice
      return {
        kind: 'quality',
        label: 'Quality',
        items: labels.map(function (label, index) { return { label: label, selected: selected === index }; }),
        select: pick
      };
    }

    function containsVideo(element, video) {
      return element === video || (!!element && typeof element.contains === 'function' && element.contains(video));
    }

    // Each detector has find(video) -> the library's player or null, and group(player) -> a group or null.
    var LIBRARIES = [
      {
        // video.js: the qualityLevels plugin lists the levels; one is picked by enabling only it.
        find: function (video) {
          var lib = window.videojs;
          if (!lib) return null;
          var players = typeof lib.getAllPlayers === 'function' ? lib.getAllPlayers() :
            Object.keys(lib.players || {}).map(function (key) { return lib.players[key]; });
          for (var i = 0; i < players.length; i++) {
            var player = players[i];
            try {
              if (!player || typeof player.qualityLevels !== 'function') continue;
              if (containsVideo(player.el(), video)) return player;
              var tech = player.tech_ || player.tech({ IWillNotUseThisInPlugins: true });
              if (tech && tech.el() === video) return player;
            } catch (_) {}
          }
          return null;
        },
        group: function (player) {
          var list = player.qualityLevels();
          var levels = [];
          for (var i = 0; i < list.length; i++) levels.push(list[i]);
          var enabled = levels.filter(function (level) { return level.enabled; });
          var only = enabled.length === 1 ? levels.indexOf(enabled[0]) : -1;
          var labels = ['Auto'].concat(levels.map(function (level, index) {
            return levelLabel(level.height, level.bitrate, index);
          }));
          return qualityGroup(labels, only < 0 ? 0 : only + 1, function (at) {
            levels.forEach(function (level, index) { level.enabled = at === 0 || index === at - 1; });
          });
        }
      },
      {
        // hls.js: rarely a global of its own, so it is found among the window's values by the
        // video it is attached to. Level -1 is its automatic choice.
        find: function (video) {
          return firstWindowObject(function (o) {
            return Array.isArray(o.levels) && typeof o.currentLevel === 'number' &&
              typeof o.attachMedia === 'function' && o.media === video;
          });
        },
        group: function (hls) {
          var auto = hls.autoLevelEnabled !== undefined ? !!hls.autoLevelEnabled : hls.currentLevel === -1;
          var labels = ['Auto'].concat(hls.levels.map(function (level, index) {
            return levelLabel(level.height, level.bitrate, index);
          }));
          return qualityGroup(labels, auto ? 0 : hls.currentLevel + 1, function (at) { hls.currentLevel = at - 1; });
        }
      },
      {
        // dash.js: a fixed level is picked by turning its automatic switching off first.
        find: function (video) {
          return firstWindowObject(function (o) {
            return typeof o.getVideoElement === 'function' && o.getVideoElement() === video &&
              (typeof o.getBitrateInfoListFor === 'function' || typeof o.getTracksFor === 'function');
          });
        },
        group: function (dash) {
          var list = dash.getBitrateInfoListFor('video');
          if (!Array.isArray(list)) return null;
          var settings = typeof dash.getSettings === 'function' ? dash.getSettings() : null;
          var abr = settings && settings.streaming && settings.streaming.abr;
          var auto = !(abr && abr.autoSwitchBitrate && abr.autoSwitchBitrate.video === false);
          var labels = ['Auto'].concat(list.map(function (info, index) {
            return levelLabel(info.height, info.bitrate, index);
          }));
          var current = dash.getQualityFor('video');
          var autoSwitch = function (on) {
            dash.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: on } } } });
          };
          return qualityGroup(labels, auto ? 0 : current + 1, function (at) {
            autoSwitch(at === 0);
            if (at > 0) dash.setQualityFor('video', at - 1);
          });
        }
      },
      {
        // Shaka: one variant per video height (its best), picked with its automatic choice off.
        find: function (video) {
          return firstWindowObject(function (o) {
            return typeof o.getVariantTracks === 'function' && typeof o.getMediaElement === 'function' &&
              o.getMediaElement() === video;
          });
        },
        group: function (shaka) {
          var best = {};
          var active = 0;
          shaka.getVariantTracks().forEach(function (track) {
            if (!(track.height > 0)) return;
            var kept = best[track.height];
            if (!kept || (track.bandwidth || 0) > (kept.bandwidth || 0)) best[track.height] = track;
            if (track.active) active = track.height;
          });
          var tracks = Object.keys(best).map(Number).sort(function (a, b) { return b - a; })
            .map(function (height) { return best[height]; });
          var config = typeof shaka.getConfiguration === 'function' ? shaka.getConfiguration() : null;
          var auto = !(config && config.abr && config.abr.enabled === false);
          var labels = ['Auto'].concat(tracks.map(function (track) { return track.height + 'p'; }));
          var on = 0;
          tracks.forEach(function (track, index) { if (track.height === active) on = index + 1; });
          return qualityGroup(labels, auto ? 0 : on, function (at) {
            shaka.configure({ abr: { enabled: at === 0 } });
            if (at > 0) shaka.selectVariantTrack(tracks[at - 1], true);
          });
        }
      },
      {
        // Plyr sets itself on the video element.
        find: function (video) { return video.plyr || null; },
        group: function (plyr) {
          var list = plyr.options && plyr.options.quality;
          if (!Array.isArray(list) || list.length < 2) return null;
          var current = plyr.quality;
          return {
            kind: 'quality',
            label: 'Quality',
            items: list.map(function (value) {
              return { label: typeof value === 'number' ? value + 'p' : String(value), selected: value === current };
            }),
            select: function (at) { plyr.quality = list[at]; }
          };
        }
      },
      {
        // JW Player: its API is reached through the container the video is in.
        find: function (video) {
          if (typeof window.jwplayer !== 'function') return null;
          var holder = video.closest && video.closest('.jwplayer');
          var player = holder && holder.id ? window.jwplayer(holder.id) : null;
          return player && typeof player.getQualityLevels === 'function' ? player : null;
        },
        group: function (jw) {
          var levels = jw.getQualityLevels();
          if (!Array.isArray(levels)) return null;
          if (levels.length < 2) return null;
          var current = jw.getCurrentQuality();
          return {
            kind: 'quality',
            label: 'Quality',
            items: levels.map(function (level, index) { return { label: String(level.label), selected: index === current }; }),
            select: function (at) { jw.setCurrentQuality(at); }
          };
        }
      },
      {
        // Vidstack (a media-player element): `qualities` lists them, one of which can be selected.
        find: function (video) {
          var player = video.closest && video.closest('media-player');
          return player && player.qualities && typeof player.qualities.autoSelect === 'function' ? player : null;
        },
        group: function (player) {
          var list = Array.prototype.slice.call(player.qualities);
          list.sort(function (a, b) { return (b.height || 0) - (a.height || 0); });
          var labels = ['Auto'].concat(list.map(function (quality) { return quality.height ? quality.height + 'p' : String(quality.id); }));
          var on = 0;
          if (!player.qualities.auto) list.forEach(function (quality, index) { if (quality.selected) on = index + 1; });
          return qualityGroup(labels, on, function (at) {
            if (at === 0) player.qualities.autoSelect();
            else list[at - 1].selected = true;
          });
        }
      },
      {
        // A player object (YouTube's) that answers for its qualities and holds the video.
        find: function (video) {
          var places = [
            function () { return document.getElementById('movie_player'); },
            function () { return document.querySelector('.html5-video-player'); }
          ];
          for (var i = 0; i < places.length; i++) {
            try {
              var player = places[i]();
              if (player && typeof player.getAvailableQualityLevels === 'function' &&
                  typeof player.getPlaybackQuality === 'function' &&
                  (typeof player.setPlaybackQualityRange === 'function' || typeof player.setPlaybackQuality === 'function') &&
                  containsVideo(player, video)) return player;
            } catch (_) {}
          }
          return null;
        },
        group: function (player) {
          var levels = player.getAvailableQualityLevels();
          if (!Array.isArray(levels)) return null;
          var ids = ['auto'].concat(levels.filter(function (id) { return id !== 'auto'; }).map(String));
          // The player reports the level in play, not whether it was left on automatic.
          var chosen = ytChoice.has(player) ? ytChoice.get(player) : player.getPlaybackQuality();
          var labels = ids.map(function (id) {
            var hd = /^hd(\d+)$/.exec(id);
            return YT_QUALITY[id] || (hd ? hd[1] + 'p' : id);
          });
          return qualityGroup(labels, ids.indexOf(chosen), function (at) {
            var id = ids[at];
            ytChoice.set(player, id);
            if (typeof player.setPlaybackQualityRange === 'function') player.setPlaybackQualityRange(id, id);
            if (typeof player.setPlaybackQuality === 'function') player.setPlaybackQuality(id);
          });
        }
      }
    ];

    function libraryGroups(video) {
      var now = Date.now();
      var found = libraryFinds.get(video);
      if (!found || now - found.at >= LIB_CACHE_MS) {
        found = { at: now, players: [] };
        LIBRARIES.forEach(function (library) {
          try {
            var player = library.find(video);
            if (player) found.players.push({ library: library, player: player });
          } catch (_) {}
        });
        libraryFinds.set(video, found);
      }
      var groups = [];
      found.players.forEach(function (entry) {
        try {
          var group = entry.library.group(entry.player);
          if (group) groups.push(group);
        } catch (_) {}
      });
      return groups;
    }
