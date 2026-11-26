import AVFoundation
import LocalAuthentication
import SafariServices
import SwiftRs
import Tauri
import UIKit
import UserNotifications
import WebKit

private let bridgeHandlerName = "openmedia"
/// A page is shown only once it has painted: until then the backdrop shows, never the blank white
/// or black a new web view draws. The page reports its first frames through this native-only
/// handler (it reaches no Tauri IPC and nothing else); a page that fakes it only shows itself.
private let paintHandlerName = "openmediaPaint"
/// Reports, at the start of every touch, whether it began inside a container scrolled away from its
/// top. A feed of full-screen videos scrolls inside such a container while the page itself stays at
/// its top, so without this a swipe down to the previous item pulls to refresh and reloads the page.
private let scrollHandlerName = "openmediaScroll"
/// Asks for the video in view to be played natively when the engine refuses the page's own
/// `play()`; see `playFeedVideo`.
private let playHandlerName = "openmediaPlay"
/// The page says whether its small player is up (true) or gone (false).
private let miniHandlerName = "openmediaMini"
private let playFeedVideoScript =
  "(function(){var play=document[Symbol.for('openmedia.feedPlayNow')];if(typeof play==='function')play()})()"
/// The same flag the Android and macOS pause scripts set, which the feed player reads.
private let holdMediaScript = "window.__openmediaHold=true"
/// True while a video of the page plays.
private let isPlayingScript =
  "(function(){var v=document.querySelectorAll('video');for(var i=0;i<v.length;i++){if(!v[i].paused&&!v[i].ended)return true}return false})()"
/// The page is no longer away: the feed player may play again.
private let resumeAwayScript =
  "window.__openmediaAway=false;document.dispatchEvent(new Event('openmedia-resume'))"
private let resumeMediaScript =
  "window.__openmediaHold=false;document.dispatchEvent(new Event('openmedia-resume'))"
/// The script world of the picture-in-picture guard. It shares the page's DOM and nothing else,
/// so the page can neither read the list of sites nor call `__openmediaPipApply`.
private let pictureInPictureWorld = WKContentWorld.world(name: "openmedia.pip")
/// Keeps a video from offering picture-in-picture unless its page's site is on the list in
/// `window.__openmediaPip` (registrable domains). WebKit reads the `disablepictureinpicture`
/// attribute, so every video gets it, and only the ones this script marked lose it again: a page
/// that sets the attribute itself is left alone. `__openmediaPipApply` re-runs the check when the
/// list changes. The host is the top page's, so a player in a frame follows the page around it.
private let pictureInPictureGuardScript = """
  (function () {
    if (window.__openmediaPipApply) return;
    var marked = new WeakSet();
    function host() {
      try {
        var origins = location.ancestorOrigins;
        if (origins && origins.length) return new URL(origins[origins.length - 1]).hostname;
      } catch (error) {}
      return location.hostname;
    }
    function allowed() {
      var name = host().toLowerCase();
      return window.__openmediaPip.some(function (site) {
        return name === site || name.endsWith('.' + site);
      });
    }
    function apply() {
      var ok = allowed();
      var videos = document.querySelectorAll('video');
      for (var i = 0; i < videos.length; i++) {
        var video = videos[i];
        if (ok) {
          if (marked.has(video)) {
            video.removeAttribute('disablepictureinpicture');
            marked.delete(video);
          }
        } else if (!video.hasAttribute('disablepictureinpicture')) {
          video.setAttribute('disablepictureinpicture', '');
          marked.add(video);
        }
      }
    }
    window.__openmediaPipApply = apply;
    // A video announces itself when it loads or plays; watching every mutation of a busy feed
    // for new ones cost more than it saved.
    document.addEventListener('play', apply, true);
    document.addEventListener('loadstart', apply, true);
  })();
  """
/// Floats the largest playing video that has sound, as leaving the app would for a player. Answers
/// true only when this call started it, so a window the reader opened themselves is left alone.
/// `evaluateJavaScript` runs with a user gesture, which WebKit requires for this.
private let enterPictureInPictureScript = """
  (function () {
    var best = null, area = 0, videos = document.querySelectorAll('video');
    for (var i = 0; i < videos.length; i++) {
      var video = videos[i];
      if (video.paused || video.ended || video.muted || video.volume === 0 || !video.videoWidth) continue;
      if (video.hasAttribute('disablepictureinpicture')) continue;
      if (typeof video.webkitSetPresentationMode !== 'function') continue;
      var size = video.clientWidth * video.clientHeight;
      if (size > area) { area = size; best = video; }
    }
    if (!best || best.webkitPresentationMode === 'picture-in-picture') return false;
    if (!best.webkitSupportsPresentationMode('picture-in-picture')) return false;
    best.webkitSetPresentationMode('picture-in-picture');
    return true;
  })()
  """
/// Floats the playing video that has sound as a page is left for another, whatever its site: the
/// page's own guard keeps picture-in-picture off videos of sites the reader did not list, and the
/// attribute is lifted for this one video only.
private let floatForNavigationScript = """
  (function () {
    // The small player is the page's own: it stays up as it is, and the app moves the page.
    if (document.querySelector('[data-openmedia-mini]')) return true;
    var best = null, area = 0, videos = document.querySelectorAll('video');
    // A video the reader already floated, from the panel's button, is the one to keep.
    for (var j = 0; j < videos.length; j++) {
      if (videos[j].webkitPresentationMode === 'picture-in-picture') return true;
    }
    for (var i = 0; i < videos.length; i++) {
      var video = videos[i];
      if (video.paused || video.ended || video.muted || video.volume === 0 || !video.videoWidth) continue;
      if (typeof video.webkitSetPresentationMode !== 'function') continue;
      var size = video.clientWidth * video.clientHeight;
      if (size > area) { area = size; best = video; }
    }
    if (!best || best.webkitPresentationMode === 'picture-in-picture') return false;
    best.removeAttribute('disablepictureinpicture');
    if (!best.webkitSupportsPresentationMode('picture-in-picture')) return false;
    best.webkitSetPresentationMode('picture-in-picture');
    return true;
  })()
  """
private let floatCheckEvery: TimeInterval = 2
/// How long a page gets to answer before the next one is shown anyway.
private let floatAnswerWait: TimeInterval = 0.6
/// The corner radius of the small player's window, the same as the page draws its box with.
private let cornerWindowRadius: CGFloat = 12
/// How long a picture-in-picture window asked for on leaving the app gets to appear.
private let floatSettleWait: TimeInterval = 0.8
/// How long a page kept ready for the next float (`SiteViewPlugin.standby`) lives unused.
private let standbyLifetime: TimeInterval = 300
private let exitPictureInPictureScript = """
  (function () {
    var videos = document.querySelectorAll('video');
    for (var i = 0; i < videos.length; i++) {
      if (videos[i].webkitPresentationMode === 'picture-in-picture') {
        videos[i].webkitSetPresentationMode('inline');
      }
    }
  })()
  """
/// True while a video of the page is in native fullscreen (presentation mode or element fullscreen).
private let inFullscreenScript = """
  (function () {
    if (document.webkitFullscreenElement) return true;
    var videos = document.querySelectorAll('video');
    for (var i = 0; i < videos.length; i++) {
      if (videos[i].webkitPresentationMode === 'fullscreen') return true;
    }
    return false;
  })()
  """
/// Closes native fullscreen. Coming back from picture-in-picture can leave the video in a native
/// fullscreen player that covers the app, so nothing in it can be touched.
private let exitFullscreenScript = """
  (function () {
    var videos = document.querySelectorAll('video');
    for (var i = 0; i < videos.length; i++) {
      if (videos[i].webkitPresentationMode === 'fullscreen') videos[i].webkitSetPresentationMode('inline');
      else if (videos[i].webkitDisplayingFullscreen && videos[i].webkitExitFullscreen) videos[i].webkitExitFullscreen();
    }
    if (document.webkitFullscreenElement && document.webkitExitFullscreen) document.webkitExitFullscreen();
  })()
  """
private let inPictureInPictureScript = """
  (function () {
    if (document.querySelector('[data-openmedia-mini]')) return true;
    var videos = document.querySelectorAll('video');
    for (var i = 0; i < videos.length; i++) {
      if (videos[i].webkitPresentationMode === 'picture-in-picture') return true;
    }
    return false;
  })()
  """
/// True only for a real picture-in-picture window. The page's own small player lives inside the
/// app, so it is gone from the screen when the app is left and must not keep the media going.
private let inSystemPictureInPictureScript = """
  (function () {
    var videos = document.querySelectorAll('video');
    for (var i = 0; i < videos.length; i++) {
      if (videos[i].webkitPresentationMode === 'picture-in-picture') return true;
    }
    return false;
  })()
  """
/// Puts the small player's video back in its place in its own page.
private let miniCloseScript =
  "(function(){var f=document[Symbol.for('openmedia.miniClose')];if(typeof f==='function')f()})()"
/// True while the page has its small player up.
private let miniActiveScript = "!!document.querySelector('[data-openmedia-mini]')"
/// Makes the small player fill the whole page (a page that is itself a small window in a corner of
/// the screen), or puts it back as a box over the page.
private func miniWindowScript(_ on: Bool) -> String {
  "(function(){var f=document[Symbol.for('openmedia.miniWindow')];if(typeof f==='function')f(\(on))})()"
}
private let touchScrollScript = """
  (function () {
    window.addEventListener('touchstart', function (event) {
      var node = event.target;
      var scrolled = false;
      while (node && node.nodeType === 1) {
        if (node.scrollTop > 0) { scrolled = true; break; }
        node = node.parentElement;
      }
      if (document[Symbol.for('openmedia.holdRefresh')]) scrolled = true;
      try { window.webkit.messageHandlers.\(scrollHandlerName).postMessage(scrolled ? 1 : 0); } catch (error) {}
    }, { capture: true, passive: true });
  })();
  """
/// Reports the page's first contentful paint, so the page is shown when it has something to show
/// rather than when the document merely exists. A WebKit without paint timing reports after two
/// animation frames instead.
private let firstPaintScript = """
  (function () {
    var sent = false;
    function report() {
      if (sent) return;
      sent = true;
      window.webkit.messageHandlers.\(paintHandlerName).postMessage(0);
    }
    function afterFrames(count) {
      requestAnimationFrame(function () { if (count > 1) afterFrames(count - 1); else report(); });
    }
    try {
      new PerformanceObserver(function (list, observer) {
        if (list.getEntriesByName('first-contentful-paint').length === 0) return;
        observer.disconnect();
        report();
      }).observe({ type: 'paint', buffered: true });
    } catch (error) {
      afterFrames(2);
    }
  })();
  """
/// A page that commits but never reports a frame is shown after this long.
private let paintTimeout: TimeInterval = 1.5
private let revealDuration: TimeInterval = 0.15
/// A WKWebView's default user agent has no `Safari` token, which Google reads as an embedded
/// browser and refuses to sign in from. Report what Mobile Safari reports (it freezes the OS
/// version in the string and shows the real one after `Version/`).
private let safariUserAgent: String = {
  let major = UIDevice.current.systemVersion.split(separator: ".").first.map(String.init) ?? "18"
  return "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/\(major).0 Mobile/15E148 Safari/604.1"
}()
/// What Safari on a Mac reports, for a site the reader asked for the desktop page of. Mobile
/// Safari sends the same string when "Request Desktop Website" is on.
private let desktopUserAgent: String = {
  let major = UIDevice.current.systemVersion.split(separator: ".").first.map(String.init) ?? "18"
  return "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/\(major).0 Safari/605.1.15"
}()
private let allowedSchemes: Set<String> = ["http", "https"]
/// `evaluate` gives up after this long; a hung page must not hang the caller.
private let evaluateTimeout: TimeInterval = 5
/// `evaluate` refuses a result larger than this many UTF-8 bytes.
private let evaluateMaxBytes = 200_000
/// How often each page is asked whether it is playing sound or video.
private let playingCheckEvery: TimeInterval = 2
/// True while a media element of the page's own document plays with sound the reader can hear.
private let playingScript =
  "(function(){var m=document.querySelectorAll('video,audio');for(var i=0;i<m.length;i++){var e=m[i];if(!e.paused&&!e.ended&&!e.muted&&e.volume>0&&e.readyState>2)return true}return false})()"
/// What the native shield says when the app has closed a site for the day.
private let shieldMessage = "This site is closed for today. It opens again tomorrow."
/// How many closed sessions are remembered. A closed session stays closed, so it cannot be
/// reopened and walked past the limit; the oldest entries are forgotten first.
private let maxRememberedBlocked = 32
/// The shell's own background (`--color-ink` in `index.css`, the splash in `index.html`): light
/// `#f4f7fc`, dark `#070b14`. It follows the view's interface style, which the shell's theme sets.
private let backdropColor = UIColor { traits in
  traits.userInterfaceStyle == .light
    ? UIColor(red: 0xF4 / 255, green: 0xF7 / 255, blue: 0xFC / 255, alpha: 1)
    : UIColor(red: 0x07 / 255, green: 0x0B / 255, blue: 0x14 / 255, alpha: 1)
}

struct RectArgs: Decodable {
  let x: Double
  let y: Double
  let width: Double
  let height: Double

  var cgRect: CGRect { CGRect(x: x, y: y, width: width, height: height) }
}

struct RuleListArgs: Decodable {
  let id: String
  let path: String
}

class OpenArgs: Decodable {
  let session: String
  let profile: String
  let url: String
  let rect: RectArgs?
  let documentStartScript: String?
  let adBlockScriptlet: String?
  let adBlockEnabled: Bool
  let blockPopups: Bool
  let contentRuleLists: [RuleListArgs]?
  /// False when `contentRuleLists` are the variants without element hiding; see `Session.elementHiding`.
  let elementHiding: Bool?
  let onEvent: Channel
}

class SessionArgs: Decodable {
  let session: String
}

class NotifyArgs: Decodable {
  let session: String
  let title: String
  let body: String
}

class SetRectArgs: Decodable {
  let rect: RectArgs
}

class SetInteractiveRegionsArgs: Decodable {
  let regions: [RectArgs]
}

class SetCoveredArgs: Decodable {
  let covered: Bool
}

class NavigateArgs: Decodable {
  let url: String
}

class SetColorSchemeArgs: Decodable {
  let scheme: String
}

class FetchFaviconArgs: Decodable {
  let url: String
}

class SetContentRuleListsArgs: Decodable {
  let enabled: Bool
  let lists: [RuleListArgs]
  /// The lists without element-hiding rules, for the sessions opened with `elementHiding: false`.
  let variants: [RuleListArgs]?
}

class SetDocumentStartScriptArgs: Decodable {
  let script: String
}

class SetBlockedArgs: Decodable {
  let session: String
  let blocked: Bool
}

class SetBackgroundMediaArgs: Decodable {
  let sites: [String]
}

class SetPictureInPictureArgs: Decodable {
  let sites: [String]
}

class SetDesktopSitesArgs: Decodable {
  let sites: [String]
}

class ShareArgs: Decodable {
  let url: String
  let title: String?
}

class ClearSiteDataArgs: Decodable {
  let site: String
}

class RemoveProfileArgs: Decodable {
  let profile: String
}

class AuthenticateArgs: Decodable {
  let reason: String
}

class EvaluateArgs: Decodable {
  let script: String
  let pageWorld: Bool?
}

class SampleColorArgs: Decodable {
  let x: Double
  let y: Double
}

struct StateEvent: Encodable {
  let type = "state"
  let session: String
  let url: String?
  let title: String?
  let loading: Bool
  let canGoBack: Bool
  let canGoForward: Bool
  let playing: Bool
  let painted: Bool
  let scope: String
}

struct ClosedEvent: Encodable {
  let type = "closed"
  let session: String
}

struct MemoryWarningEvent: Encodable {
  let type = "memoryWarning"
}

struct NotificationTappedEvent: Encodable {
  let type = "notificationTapped"
  let session: String
}

struct PopupBlockedEvent: Encodable {
  let type = "popupBlocked"
  let host: String
}

struct ErrorEvent: Encodable {
  let type = "error"
  let message: String
}

struct BridgeEvent: Encodable {
  let type = "bridge"
  let origin: String
  let body: String
}

private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
  weak var target: SiteViewPlugin?

  init(_ target: SiteViewPlugin) {
    self.target = target
  }

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    target?.receiveBridgeMessage(message)
  }
}

private final class WeakPaintHandler: NSObject, WKScriptMessageHandler {
  weak var target: SiteViewPlugin?

  init(_ target: SiteViewPlugin) {
    self.target = target
  }

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard message.frameInfo.isMainFrame, let view = message.webView else { return }
    target?.reveal(view)
  }
}

private final class WeakScrollHandler: NSObject, WKScriptMessageHandler {
  weak var target: SiteViewPlugin?

  init(_ target: SiteViewPlugin) {
    self.target = target
  }

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard message.frameInfo.isMainFrame, let view = message.webView else { return }
    target?.setInnerScrolled(view, (message.body as? Int) == 1)
  }
}

private final class WeakMiniHandler: NSObject, WKScriptMessageHandler {
  weak var target: SiteViewPlugin?

  init(_ target: SiteViewPlugin) {
    self.target = target
  }

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard message.frameInfo.isMainFrame, let view = message.webView else { return }
    if let body = message.body as? [String: Any], body["float"] != nil {
      target?.floatToCorner(view)
      return
    }
    if let body = message.body as? [String: Any], body["expand"] != nil {
      target?.expandFromCorner(view)
      return
    }
    target?.setMiniUp(view, (message.body as? Bool) == true)
  }
}

private final class WeakPlayHandler: NSObject, WKScriptMessageHandler {
  weak var target: SiteViewPlugin?

  init(_ target: SiteViewPlugin) {
    self.target = target
  }

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard message.frameInfo.isMainFrame, let view = message.webView else { return }
    target?.playFeedVideo(view)
  }
}

/// One open page: its native view and the domain it is currently pinned to.
private final class Session {
  let id: String
  let view: WKWebView
  let initialURL: URL
  /// The registrable domain the session may show; user-initiated navigation can move it after load.
  var scope: String
  /// Script data is held separately so blocker toggles cannot replace recipe behavior.
  var recipeScript: String?
  var adBlockScriptlet: String?
  var adBlockEnabled: Bool
  /// False for a session opened on the variant lists (its recipe turned element hiding off); it
  /// stays on the variants when the lists are swapped.
  var elementHiding = true
  /// False during the initial load and user-initiated navigation; see `DomainScope.verdict`.
  var settled = false
  /// True once the first load has committed; before that a timeout must not reveal a blank page.
  var committed = false
  /// True once the page has been shown. Until then the shell's splash stays up.
  var painted = false
  /// True while the page plays sound or video the reader can hear, as the last check found.
  var playing = false
  /// The pull-to-refresh control, detached from the scroll view while a touch began inside a
  /// container that is scrolled away from its top.
  var refreshControl: UIRefreshControl?
  /// A hidden session whose content rule lists changed reloads when it is shown again.
  var needsReload = false
  /// True while the page was asked for as a desktop page; a change of the site's choice reloads.
  var desktop = false
  /// True while the page has its small player up, as the page last said.
  var miniUp = false
  /// True while the page is shown as a small window in the corner.
  var inCorner = false
  /// Ids of the content rule lists attached to this view, so a late compile attaches each once.
  var ruleListIds: Set<String> = []
  /// The lists themselves and the profile, kept so the page can be replaced by a fresh view.
  var ruleLists: [WKContentRuleList] = []
  var profileId: UUID?
  /// True while the app has closed this site. The block lives in the native layer: the page
  /// cannot lift it, and switching to another session does not clear it.
  var blocked = false
  /// True while the page's media is suspended because the page went out of sight.
  var mediaSuspended = false
  /// True while a picture-in-picture window is open because the app was left, not because the
  /// reader opened it; coming back closes it.
  var autoPictureInPicture = false
  /// True when a video was in native fullscreen as the app was left: only a fullscreen that
  /// appeared during the absence (the restore from picture-in-picture) is closed on return.
  var fullscreenBeforeLeaving = false
  /// True when a video of the page was playing as the app was left.
  var playingBeforeLeaving = false
  /// True while a video floats because the page it played on was left for another.
  var floatedForNavigation = false
  /// True while one of the page's videos is in a picture-in-picture window, as last seen when the
  /// app was left: the window has to keep playing while the app is minimized, whatever the site.
  var windowOpen = false
  /// True when the page was replaced in its session: only its picture-in-picture window is left.
  var floatDetached = false
  /// A page made to take the place of one whose video went to the corner: shown at its first
  /// commit, not its first paint, so the screen is not left empty while the site boots.
  var revealOnCommit = false
  /// The native shield over a closed page. It covers the page and takes every touch.
  var shield: UIView?
  var observations: [NSKeyValueObservation] = []

  init(
    id: String,
    view: WKWebView,
    scope: String,
    initialURL: URL,
    recipeScript: String?,
    adBlockScriptlet: String?,
    adBlockEnabled: Bool
  ) {
    self.id = id
    self.view = view
    self.scope = scope
    self.initialURL = initialURL
    self.recipeScript = recipeScript
    self.adBlockScriptlet = adBlockScriptlet
    self.adBlockEnabled = adBlockEnabled
  }
}

/// Transparent view above both webviews. It never handles touches itself: it decides, per touch,
/// whether the shell (inside an interactive region) or the site view underneath receives it.
final class TouchRouter: UIView {
  weak var shell: WKWebView?
  weak var siteView: WKWebView?
  var regions: [CGRect] = []

  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
    guard let shell, bounds.contains(point) else { return nil }
    let inShell = convert(point, to: shell)
    let shellOwnsTouch = siteView == nil || regions.contains { $0.contains(inShell) }
    let target: UIView = shellOwnsTouch ? shell : (siteView ?? shell)
    return target.hitTest(convert(point, to: target), with: event)
  }
}

/// Hosts native WKWebViews *below* the Tauri shell webview, one per session, only one visible. The
/// shell is transparent and draws the floating controls; the shell owns layout and reports the
/// site rectangle. Site views never receive Tauri IPC, only the write-only `openmedia` bridge.
///
/// A session never leaves its domain: a main-frame navigation outside it is cancelled and shown in
/// a popup browser (`SFSafariViewController`, which shares nothing with the profile's data store).
/// A window the page opens with `window.open` is different: it is a sign-in window (Google,
/// Apple), and it has to live inside the app, sharing the profile's cookies, or the token it
/// carries never reaches the page. Which sessions to keep alive is the shell's decision; this
/// class only opens, shows and closes.
class SiteViewPlugin: Plugin, WKNavigationDelegate, WKUIDelegate, UNUserNotificationCenterDelegate {
  private var shell: WKWebView?
  private var sessions: [String: Session] = [:]
  private var activeId: String?
  private var router: TouchRouter?
  private var events: Channel?
  /// Drop windows and redirects a page makes on its own that are no sign-in; set by every `open`.
  private var blockPopups = true
  private var popup: SFSafariViewController?
  /// The window a page opened with `window.open`. It sits above the site view, shares the
  /// profile's data store and keeps `window.opener`, so the page can be told the sign-in is done.
  private var signInWindow: WKWebView?
  /// The session whose page opened the sign-in window.
  private var signInOwner: String?
  /// True when the sign-in window carries a redirect the page made (no `window.opener`): it ends
  /// by handing the address it returns to over to the page's own view.
  private var signInReturnsToSession = false
  /// The session whose page is loading the address the sign-in window handed back.
  private var handoffSession: String?
  private var colorScheme: UIUserInterfaceStyle = .unspecified
  /// The shell's page rectangle, in shell coordinates; every session's view fills it.
  private var pageRect: CGRect?
  /// The shell reports regions once per layout change, possibly before the router exists (the
  /// router is made with the first `open`), so keep them for the router to start with.
  private var interactiveRegions: [CGRect] = []
  /// Full-screen view under every page: the app's own background shows wherever a page has not
  /// painted yet, instead of the window's white or black.
  private var backdrop: UIView?
  private var launchLogo: UIImageView?
  /// Rule lists WebKit is still compiling; a list is compiled once however many pages open.
  private var compilingRuleListIds: Set<String> = []
  /// Bumped when the shell replaces the rule lists, so a late compile cannot undo that.
  private var ruleListGeneration = 0
  /// Sessions the app has closed, oldest first. A closed session stays closed until the app opens
  /// it again, so it cannot be reopened and walked past the limit.
  private var blockedSessions: [String] = []
  /// The sites (registrable domains) whose media keeps playing while hidden or in the background.
  private var backgroundMediaSites: Set<String> = []
  /// The sites (registrable domains) whose videos may open in picture-in-picture.
  private var pictureInPictureSites: Set<String> = []
  /// The sites (registrable domains) whose pages are asked for as a desktop page.
  private var desktopSites: Set<String> = []
  /// False from the app entering the background to it coming back.
  private var appForeground = true
  /// True from the screen being locked until the app is active again.
  private var screenLocked = false
  /// True while a timer is waiting to ask whether the windows kept open in the background are
  /// still open.
  private var watchingWindows = false
  /// True while the shell covers the page in front with a page of its own (a new tab).
  private var covered = false
  /// True while the keyboard is up, whoever asked for it. The page is not given the focus then: it
  /// would take the keyboard away from the shell's address field.
  private var keyboardUp = false
  /// Pages that were left for another while their video played: the page stays alive, hidden, so
  /// its picture-in-picture window keeps playing, until the window is closed or the page in front
  /// plays a video of its own.
  private var floatingSessions: [Session] = []
  private var watchingFloats = false
  /// At most one page kept ready, out of sight with its media suspended, to take the place of the
  /// page in front when its video goes to the corner, so the float does not wait for a cold load.
  /// It is made when the small player comes up (the drag has begun) and dropped if it goes down
  /// without a float, or kept from a float the reader expanded back. It is dropped after
  /// `standbyLifetime`, on a memory warning, in the background, when another page is shown or its
  /// own closes, and when scripts, rule lists, site choices or site data change under it.
  private var standby: Session?
  /// The address the standby was made for; nil for one kept from a float, which serves any.
  private var standbyTarget: URL?
  private var standbyGeneration = 0

  override func load(webview: WKWebView) {
    shell = webview
    webview.isOpaque = false
    webview.backgroundColor = .clear
    webview.scrollView.backgroundColor = .clear
    // The shell is app chrome: no pinch zoom, whatever the viewport meta says.
    webview.scrollView.minimumZoomScale = 1
    webview.scrollView.maximumZoomScale = 1
    webview.scrollView.pinchGestureRecognizer?.isEnabled = false
    // A web view's video floats in picture-in-picture, or plays on out of the app, only when the
    // app's audio session is in the playback category (the audio background mode alone is not
    // enough). Only the category is set here: WebKit activates the session when media plays, so
    // other apps' music is not interrupted until then.
    try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
    watchPlaying()
    NotificationCenter.default.addObserver(
      forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: .main
    ) { [weak self] _ in
      self?.dropStandby()
      self?.send(MemoryWarningEvent())
    }
    NotificationCenter.default.addObserver(
      forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
    ) { [weak self] _ in
      self?.appForeground = false
      self?.dropStandby()
      self?.refreshMedia()
    }
    NotificationCenter.default.addObserver(
      forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main
    ) { [weak self] _ in
      self?.appForeground = true
      self?.sessions.values.forEach { $0.windowOpen = false }
      self?.refreshMedia()
      self?.checkFloats()
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { self?.focusActivePage() }
    }
    NotificationCenter.default.addObserver(
      forName: UIResponder.keyboardWillShowNotification, object: nil, queue: .main
    ) { [weak self] _ in self?.keyboardUp = true }
    NotificationCenter.default.addObserver(
      forName: UIResponder.keyboardDidHideNotification, object: nil, queue: .main
    ) { [weak self] _ in
      self?.keyboardUp = false
      self?.focusActivePage()
    }
    NotificationCenter.default.addObserver(
      forName: UIApplication.willResignActiveNotification, object: nil, queue: .main
    ) { [weak self] _ in
      self?.noteWindowOpen()
      self?.noteFullscreen()
      self?.enterPictureInPicture()
      self?.tellPagesAway(true)
    }
    NotificationCenter.default.addObserver(
      forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
    ) { [weak self] _ in
      let wasLocked = self?.screenLocked ?? false
      self?.screenLocked = false
      self?.tellPagesAway(false)
      self?.recoverAfterAway(afterLock: wasLocked)
    }
    NotificationCenter.default.addObserver(
      forName: UIApplication.protectedDataWillBecomeUnavailableNotification, object: nil, queue: .main
    ) { [weak self] _ in self?.screenWasLocked() }
    UNUserNotificationCenter.current().delegate = self
    DispatchQueue.main.async { self.attachShell() }
  }

  // MARK: Commands

  /// Creates the session's view, shows it, and keeps every other session alive but hidden. The
  /// view starts loading at once, even before the shell's own view is in the window (the first page
  /// opens at launch, in parallel with the shell); it is mounted as soon as there is a window.
  @objc public func open(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(OpenArgs.self)
    guard let profileId = UUID(uuidString: args.profile) else {
      invoke.reject("invalid profile id")
      return
    }
    guard let url = webURL(args.url) else {
      invoke.reject("only http and https urls can be opened")
      return
    }
    Task { @MainActor in
      let lists = args.contentRuleLists ?? []
      let (cached, missing) = await self.lookUpRuleLists(lists)
      // The page in front when another is opened keeps its video going in a window, when it has one
      // playing; a page replaced in its own session stays alive, hidden, for the window's sake.
      if let previous = self.activeId.flatMap({ self.sessions[$0] }), previous.id != args.session,
        self.appForeground
      {
        _ = await self.floatIfPlaying(previous)
      }
      if let existing = self.sessions[args.session] {
        if self.appForeground, await self.floatIfPlaying(existing) {
          existing.floatDetached = true
          if !existing.miniUp { existing.view.isHidden = true }
          existing.observations.removeAll()
          self.sessions[existing.id] = nil
        } else {
          self.dispose(existing)
        }
      }
      if let rect = args.rect { self.pageRect = rect.cgRect }
      let view = self.makeSessionView(
        profileId: profileId,
        recipe: args.documentStartScript,
        adBlockScriptlet: args.adBlockScriptlet,
        adBlockEnabled: args.adBlockEnabled,
        ruleLists: cached)

      let session = Session(
        id: args.session,
        view: view,
        scope: DomainScope.registrableDomain(of: url.host ?? ""),
        initialURL: url,
        recipeScript: args.documentStartScript,
        adBlockScriptlet: args.adBlockScriptlet,
        adBlockEnabled: args.adBlockEnabled)
      session.elementHiding = args.elementHiding ?? true
      session.ruleListIds = Set(cached.map(\.identifier))
      session.ruleLists = cached
      session.profileId = profileId
      self.sessions[session.id] = session
      self.activeId = session.id
      self.events = args.onEvent
      self.blockPopups = args.blockPopups
      self.observe(session)
      self.mount(session)
      if self.isBlocked(args.session) {
        // The site is closed for the day: the page never loads and the shield goes up.
        self.applyBlocked(true, to: session)
      } else {
        view.load(URLRequest(url: url))
      }
      invoke.resolve()
      self.compileInBackground(missing, keeping: lists)
    }
  }

  @objc public func activate(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(SessionArgs.self)
    DispatchQueue.main.async {
      guard let session = self.sessions[args.session] else {
        invoke.reject("no such session")
        return
      }
      self.show(session)
      invoke.resolve()
    }
  }

  @objc public func close(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(SessionArgs.self)
    DispatchQueue.main.async {
      if let session = self.sessions[args.session] { self.dispose(session) }
      if self.standby?.id == args.session { self.dropStandby() }
      invoke.resolve()
    }
  }

  @objc public func setRect(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(SetRectArgs.self)
    DispatchQueue.main.async {
      self.pageRect = args.rect.cgRect
      if let shell = self.shell, let host = shell.superview {
        let frame = shell.convert(args.rect.cgRect, to: host)
        self.sessions.values.forEach { if !($0.floatedForNavigation && $0.miniUp) { $0.view.frame = frame } }
        self.signInWindow?.frame = frame
      }
      invoke.resolve()
    }
  }

  @objc public func setInteractiveRegions(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(SetInteractiveRegionsArgs.self)
    DispatchQueue.main.async {
      self.interactiveRegions = args.regions.map(\.cgRect)
      self.router?.regions = self.interactiveRegions
      invoke.resolve()
    }
  }

  /// The shell put a page of its own (a new tab) over the page in front, or took it away. The page
  /// underneath is then handled as one left for another: its media is suspended unless its site
  /// plays on in the background.
  @objc public func setCovered(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(SetCoveredArgs.self)
    DispatchQueue.main.async {
      self.covered = args.covered
      self.refreshMedia()
      self.focusActivePage()
      invoke.resolve()
    }
  }

  @objc public func navigate(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(NavigateArgs.self)
    guard let url = webURL(args.url) else {
      invoke.reject("only http and https urls can be opened")
      return
    }
    onActiveSession(invoke) { [weak self] session in
      let request = URLRequest(url: url)
      self?.navigateKeepingVideo(session, to: request) { session.view.load(request) }
    }
  }

  @objc public func goBack(_ invoke: Invoke) {
    onActiveSession(invoke) { [weak self] session in
      guard let self else { return }
      // Back leaves the sign-in window first: the page under it keeps its place.
      if self.signInWindow != nil {
        self.closeSignInWindow()
        return
      }
      guard let item = session.view.backForwardList.backItem else {
        session.view.goBack()
        return
      }
      self.navigateKeepingVideo(session, to: URLRequest(url: item.url)) { session.view.goBack() }
    }
  }

  @objc public func goForward(_ invoke: Invoke) {
    onActiveSession(invoke) { $0.view.goForward() }
  }

  @objc public func reload(_ invoke: Invoke) {
    onActiveSession(invoke) { $0.view.reload() }
  }

  /// Posts a local notification for a hidden session. The system permission prompt appears the
  /// first time one is due; if it is refused, notifications are silently skipped. A newer
  /// notification for the same session replaces the one still showing.
  @objc public func notify(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(NotifyArgs.self)
    let center = UNUserNotificationCenter.current()
    center.getNotificationSettings { settings in
      switch settings.authorizationStatus {
      case .notDetermined:
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
          if granted { self.post(args, to: center) }
          invoke.resolve()
        }
      case .authorized, .provisional, .ephemeral:
        self.post(args, to: center)
        invoke.resolve()
      default:
        invoke.resolve()
      }
    }
  }

  private func post(_ args: NotifyArgs, to center: UNUserNotificationCenter) {
    let content = UNMutableNotificationContent()
    content.title = args.title
    content.body = args.body
    content.sound = .default
    content.userInfo = ["session": args.session]
    center.add(UNNotificationRequest(identifier: "unread-\(args.session)", content: content, trigger: nil))
  }

  /// The app is open and showing another page, which is exactly when these notifications are raised.
  func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([.banner, .list, .sound])
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    if let session = response.notification.request.content.userInfo["session"] as? String {
      DispatchQueue.main.async { self.send(NotificationTappedEvent(session: session)) }
    }
    completionHandler()
  }

  @objc public func setColorScheme(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(SetColorSchemeArgs.self)
    DispatchQueue.main.async {
      switch args.scheme {
      case "light": self.colorScheme = .light
      case "dark": self.colorScheme = .dark
      default: self.colorScheme = .unspecified
      }
      self.backdrop?.overrideUserInterfaceStyle = self.colorScheme
      invoke.resolve()
    }
  }

  @objc public func fetchFavicon(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(FetchFaviconArgs.self)
    guard let page = webURL(args.url) else {
      invoke.reject("only http and https urls can be opened")
      return
    }
    Task {
      let icon = await FaviconFetcher.fetch(for: page)
      invoke.resolve(["dataUrl": icon])
    }
  }

  /// Swaps the rule lists on every open session. The visible page reloads under them now; hidden
  /// ones reload when they are next shown. With no session open there is nothing to change; the
  /// next `open` carries the lists.
  @objc public func setContentRuleLists(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(SetContentRuleListsArgs.self)
    Task { @MainActor in
      guard !self.sessions.isEmpty else {
        invoke.resolve()
        return
      }
      self.ruleListGeneration += 1
      self.dropStandby()
      let (fullLists, failure) = await self.loadRuleLists(args.lists)
      let (variantLists, variantFailure) = await self.loadRuleLists(args.variants ?? [])
      for session in self.sessions.values {
        let ruleLists = session.elementHiding || variantLists.isEmpty ? fullLists : variantLists
        let controller = session.view.configuration.userContentController
        session.adBlockEnabled = args.enabled
        self.installUserScripts(
          on: controller,
          recipe: session.recipeScript,
          adBlockScriptlet: session.adBlockScriptlet,
          adBlockEnabled: session.adBlockEnabled)
        controller.removeAllContentRuleLists()
        ruleLists.forEach { controller.add($0) }
        session.ruleListIds = Set(ruleLists.map(\.identifier))
        if session.id == self.activeId && !session.blocked {
          session.view.reload()
        } else {
          session.needsReload = true
        }
      }
      if let failure = failure ?? variantFailure { self.send(ErrorEvent(message: failure)) }
      invoke.resolve()
    }
  }

  /// Swaps the document-start script on every live session, for the pages each loads next, and
  /// runs it on the page each shows now, so a switch changed in Settings shows at once and the
  /// page keeps its place. Frames inside the page pick the new script up when they next load.
  /// With no session there is nothing to change; the next `open` carries the script.
  @objc public func setDocumentStartScript(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(SetDocumentStartScriptArgs.self)
    let live =
      "document.querySelectorAll('style[data-openmedia]').forEach(function(s){s.remove()});"
      + (args.script ?? "")
    DispatchQueue.main.async {
      self.dropStandby()
      for session in self.sessions.values {
        let controller = session.view.configuration.userContentController
        session.recipeScript = args.script
        self.installUserScripts(
          on: controller,
          recipe: session.recipeScript,
          adBlockScriptlet: session.adBlockScriptlet,
          adBlockEnabled: session.adBlockEnabled)
        session.view.evaluateJavaScript(live)
      }
      invoke.resolve()
    }
  }

  /// Names the sites whose media may keep playing while hidden or in the background. Rust-only:
  /// the plugin registers no command for it, so neither the shell nor a site view can reach it.
  @objc public func setBackgroundMedia(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(SetBackgroundMediaArgs.self)
    DispatchQueue.main.async {
      self.backgroundMediaSites = Set(args.sites)
      self.refreshMedia()
      invoke.resolve()
    }
  }

  /// Names the sites whose videos may open in picture-in-picture. Rust-only: the plugin registers
  /// no command for it, so neither the shell nor a site view can reach it. Pages already open
  /// take the change at once.
  @objc public func setPictureInPicture(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(SetPictureInPictureArgs.self)
    DispatchQueue.main.async {
      self.pictureInPictureSites = Set(args.sites)
      self.dropStandby()
      for session in self.sessions.values {
        self.installUserScripts(
          on: session.view.configuration.userContentController,
          recipe: session.recipeScript,
          adBlockScriptlet: session.adBlockScriptlet,
          adBlockEnabled: session.adBlockEnabled)
        session.view.evaluateJavaScript(
          "\(self.pictureInPictureListScript());window.__openmediaPipApply&&window.__openmediaPipApply()",
          in: nil, in: pictureInPictureWorld, completionHandler: nil)
      }
      invoke.resolve()
    }
  }

  /// The statement that hands the page the list of sites that may use picture-in-picture.
  private func pictureInPictureListScript() -> String {
    let list = (try? JSONEncoder().encode(pictureInPictureSites.sorted())) ?? Data("[]".utf8)
    return "window.__openmediaPip=\(String(decoding: list, as: UTF8.self))"
  }

  /// Names the sites whose pages are asked for as a desktop page. Rust-only: the plugin registers
  /// no command for it, so neither the shell nor a site view can reach it. A page open on a site
  /// whose choice changed reloads (a hidden one when it is shown again).
  @objc public func setDesktopSites(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(SetDesktopSitesArgs.self)
    DispatchQueue.main.async {
      self.desktopSites = Set(args.sites)
      self.dropStandby()
      for session in self.sessions.values
      where session.desktop != self.desktopSites.contains(session.scope) {
        if session.id == self.activeId && !session.blocked {
          self.loadAgain(session)
        } else {
          session.needsReload = true
        }
      }
      invoke.resolve()
    }
  }

  /// Loads the page's address as a new navigation, past the cache, so the site's desktop or mobile
  /// choice applies to it. A `reload()` keeps the content mode and user agent the page was first
  /// loaded with, which left a site on its desktop page after "Mobile site".
  private func loadAgain(_ session: Session) {
    guard let url = session.view.url else {
      session.view.reload()
      return
    }
    session.view.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
  }

  /// Opens the system share sheet for an address. Rust-only: no webview can raise it.
  @objc public func share(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ShareArgs.self)
    DispatchQueue.main.async {
      guard let url = self.webURL(args.url), self.presentShareSheet(for: url) else {
        invoke.reject("the share sheet could not be opened")
        return
      }
      invoke.resolve()
    }
  }

  @MainActor
  private func presentShareSheet(for url: URL) -> Bool {
    var top = shell?.window?.rootViewController
    while let presented = top?.presentedViewController { top = presented }
    guard let top else { return false }
    let controller = UIActivityViewController(activityItems: [url], applicationActivities: nil)
    if let popover = controller.popoverPresentationController {
      popover.sourceView = top.view
      popover.sourceRect = CGRect(x: top.view.bounds.midX, y: top.view.bounds.midY, width: 0, height: 0)
      popover.permittedArrowDirections = []
    }
    top.present(controller, animated: true)
    return true
  }

  /// Erases one site's cookies, storage and caches from the active page's profile, then reloads
  /// the page. Rust-only: no webview can call it. Other sites in the profile are untouched.
  @objc public func clearSiteData(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ClearSiteDataArgs.self)
    DispatchQueue.main.async {
      guard let id = self.activeId, let session = self.sessions[id] else {
        invoke.reject("no site view is open")
        return
      }
      self.dropStandby()
      let store = session.view.configuration.websiteDataStore
      let types = WKWebsiteDataStore.allWebsiteDataTypes()
      store.fetchDataRecords(ofTypes: types) { records in
        let matching = records.filter {
          let name = $0.displayName.drop(while: { $0 == "." }).lowercased()
          return DomainScope.contains(scope: args.site, host: name)
        }
        store.removeData(ofTypes: types, for: matching) {
          DispatchQueue.main.async {
            if !session.blocked { session.view.reload() }
            invoke.resolve()
          }
        }
      }
    }
  }

  /// Erases a deleted profile's whole data store. Rust-only: no webview can call it. WebKit
  /// refuses while a view of the profile is alive, so Rust tries again at the next launch.
  @objc public func removeProfile(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(RemoveProfileArgs.self)
    guard let profileId = UUID(uuidString: args.profile) else {
      invoke.reject("invalid profile id")
      return
    }
    DispatchQueue.main.async {
      let inUse =
        self.sessions.values.contains { $0.profileId == profileId }
        || self.standby?.profileId == profileId
      if inUse {
        invoke.reject("a page of the profile is still open")
        return
      }
      WKWebsiteDataStore.remove(forIdentifier: profileId) { error in
        if let error {
          invoke.reject(error.localizedDescription)
        } else {
          invoke.resolve()
        }
      }
    }
  }

  /// Leaving the app floats the playing video of the page in front, when its site is on the list,
  /// as a player does. Only a window opened here is closed again by `exitAutomaticPictureInPicture`.
  private func enterPictureInPicture() {
    guard let id = activeId, let session = sessions[id], !session.blocked,
      pictureInPictureSites.contains(session.scope)
    else { return }
    session.view.evaluateJavaScript(enterPictureInPictureScript) { [weak session] result, _ in
      if (result as? Bool) == true { session?.autoPictureInPicture = true }
    }
  }

  /// Just before the app is left: is the page in front floating a video in a system window? Read
  /// while the page can still answer, so minimizing never suspends it.
  private func noteWindowOpen() {
    guard let id = activeId, let session = sessions[id], !session.blocked else { return }
    session.view.evaluateJavaScript(inSystemPictureInPictureScript) { [weak session] result, _ in
      session?.windowOpen = (result as? Bool) == true
    }
  }

  private func noteFullscreen() {
    guard let id = activeId, let session = sessions[id], !session.blocked else { return }
    session.view.evaluateJavaScript(inFullscreenScript) { [weak session] result, _ in
      session?.fullscreenBeforeLeaving = (result as? Bool) == true
    }
    session.view.evaluateJavaScript(isPlayingScript) { [weak session] result, _ in
      session?.playingBeforeLeaving = (result as? Bool) == true
    }
  }

  /// WebKit may restore a video from picture-in-picture into native fullscreen, which covers the
  /// app and swallows every touch. Close it, now and again once the transition has settled (after
  /// a lock, the screen takes a while to come back).
  private func closeRestoredFullscreen() {
    guard let id = activeId, let session = sessions[id], !session.fullscreenBeforeLeaving else { return }
    for delay in [0.0, 0.3, 0.8, 1.5, 3.0] {
      DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak session] in
        session?.view.evaluateJavaScript(exitFullscreenScript)
        session?.view.scrollView.setZoomScale(1, animated: false)
      }
    }
  }

  /// Leaving a page for another in its own session (Back, an address) while it plays a video with
  /// sound: the video floats, and the page, which a load in the same view would destroy together
  /// with its window, stays alive in a hidden view of its own while a fresh view takes the session
  /// and loads `request`. Without a playing video it is the ordinary navigation, `inPlace`.
  private func navigateKeepingVideo(
    _ session: Session, to request: URLRequest, inPlace: @escaping () -> Void
  ) {
    guard appForeground, !session.blocked, !session.floatedForNavigation, session.profileId != nil
    else {
      inPlace()
      return
    }
    var answered = false
    let finish = { [weak self, weak session] (floated: Bool) in
      guard !answered else { return }
      answered = true
      guard let self, let session else { return }
      if floated { self.swapForFloatingVideo(session, loading: request) } else { inPlace() }
    }
    session.view.evaluateJavaScript(floatScript(for: session)) { result, _ in
      finish((result as? Bool) == true)
    }
    // A page that never answers must not keep the navigation from happening.
    DispatchQueue.main.asyncAfter(deadline: .now() + floatAnswerWait) { finish(false) }
  }

  /// What leaving a page for another asks of it. A video floats in a picture-in-picture window
  /// only when the reader switched that on for its site; without it the page's video stays in the
  /// page and is paused with the page. The page's own small player is the app's, so it stays up
  /// either way.
  private func floatScript(for session: Session) -> String {
    pictureInPictureSites.contains(session.scope) ? floatForNavigationScript : miniActiveScript
  }

  /// Puts a fresh view in the session, loading `request`, and keeps the old one alive, hidden, for
  /// its picture-in-picture window. The old view has no session any more, so it cannot navigate;
  /// it goes when its window closes. `ready` is a page already made for this (the standby), shown
  /// as it is, without a load.
  private func swapForFloatingVideo(_ old: Session, loading request: URLRequest, ready: Session? = nil) {
    if ready == nil, standby?.id == old.id { dropStandby() }
    guard sessions[old.id] === old,
      let session = ready ?? makeReplacement(for: old, url: request.url ?? old.initialURL)
    else {
      old.view.load(request)
      return
    }

    old.floatedForNavigation = true
    old.floatDetached = true
    old.autoPictureInPicture = true
    old.observations.removeAll()
    // A page with its small player up goes to the corner at once, never hidden on the way: a view
    // hidden and shown again draws its video torn or black.
    if old.miniUp { placeCorner(old) } else { old.view.isHidden = true }
    floatingSessions.append(old)
    watchFloats()
    cornerIfMini(old)

    sessions[session.id] = session
    activeId = session.id
    observe(session)
    // A standby sits under the page it stood in for; it moves up to where pages are shown.
    session.view.removeFromSuperview()
    mount(session)
    if ready == nil { session.view.load(request) }
  }

  /// A view for `old`'s session, with its profile, scripts and rule lists, not loaded yet.
  private func makeReplacement(for old: Session, url: URL) -> Session? {
    guard let profileId = old.profileId else { return nil }
    let view = makeSessionView(
      profileId: profileId,
      recipe: old.recipeScript,
      adBlockScriptlet: old.adBlockScriptlet,
      adBlockEnabled: old.adBlockEnabled,
      ruleLists: old.ruleLists)
    let session = Session(
      id: old.id,
      view: view,
      scope: DomainScope.registrableDomain(of: url.host ?? ""),
      initialURL: url,
      recipeScript: old.recipeScript,
      adBlockScriptlet: old.adBlockScriptlet,
      adBlockEnabled: old.adBlockEnabled)
    session.ruleListIds = old.ruleListIds
    session.ruleLists = old.ruleLists
    session.profileId = profileId
    // The shell already showed this session: it must not put its splash back up.
    session.painted = true
    session.revealOnCommit = true
    return session
  }

  /// Where the reader goes when the page in front sends its video to the corner: the page before
  /// it, else the site's start page.
  private func floatTarget(of session: Session) -> URL {
    let here = session.view.url ?? session.initialURL
    var start = URLComponents(url: here, resolvingAgainstBaseURL: false)
    start?.path = "/"
    start?.query = nil
    start?.fragment = nil
    return session.view.backForwardList.backItem?.url ?? start?.url ?? session.initialURL
  }

  /// The small player came up on the page in front (a drag down has begun, or its button was
  /// pressed): the page it would make way for starts loading now, out of sight under it.
  private func prepareStandby(for session: Session) {
    guard session.id == activeId, appForeground, !session.blocked, !session.floatedForNavigation,
      let host = session.view.superview
    else { return }
    let target = floatTarget(of: session)
    if let standby, standby.id == session.id, standbyTarget == nil || standbyTarget == target { return }
    dropStandby()
    guard let page = makeReplacement(for: session, url: target) else { return }
    page.view.frame = session.view.frame
    host.insertSubview(page.view, belowSubview: session.view)
    setMediaSuspended(true, in: page)
    keepAsStandby(page, target: target)
    page.view.load(URLRequest(url: target))
  }

  /// The page that took the place of a floated one, when the reader expands the float back: kept
  /// out of sight as the standby, so floating again shows it as the reader left it, at once.
  private func setAside(_ page: Session) {
    guard !page.blocked, signInOwner != page.id else {
      dispose(page)
      return
    }
    dropStandby()
    page.observations.removeAll()
    sessions[page.id] = nil
    page.view.isHidden = true
    setMediaSuspended(true, in: page)
    keepAsStandby(page, target: nil)
  }

  private func keepAsStandby(_ page: Session, target: URL?) {
    standby = page
    standbyTarget = target
    standbyGeneration += 1
    let generation = standbyGeneration
    DispatchQueue.main.asyncAfter(deadline: .now() + standbyLifetime) { [weak self] in
      guard let self, self.standbyGeneration == generation else { return }
      self.dropStandby()
    }
  }

  /// The standby, out of standby, when it was made for `session` and fits a float to `target`;
  /// one that does not fit is dropped.
  private func takeStandby(for session: Session, target: URL) -> Session? {
    guard let page = standby, page.id == session.id, standbyTarget == nil || standbyTarget == target
    else {
      dropStandby()
      return nil
    }
    standby = nil
    standbyTarget = nil
    standbyGeneration += 1
    return page
  }

  private func dropStandby() {
    guard let page = standby else { return }
    standby = nil
    standbyTarget = nil
    standbyGeneration += 1
    teardownView(page.view)
  }

  /// Floats the page's playing video, when it has one with sound, and keeps the page out of the
  /// media suspension while the window is up. True when a window opened.
  @MainActor
  private func floatIfPlaying(_ session: Session) async -> Bool {
    guard !session.blocked, !session.floatedForNavigation else { return false }
    let floated: Bool = await withCheckedContinuation { continuation in
      var answered = false
      let answer = { (value: Bool) in
        guard !answered else { return }
        answered = true
        continuation.resume(returning: value)
      }
      session.view.evaluateJavaScript(self.floatScript(for: session)) { result, _ in
        answer((result as? Bool) == true)
      }
      // A page that never answers must not keep the next one from opening.
      DispatchQueue.main.asyncAfter(deadline: .now() + floatAnswerWait) { answer(false) }
    }
    guard floated else { return false }
    session.floatedForNavigation = true
    floatingSessions.append(session)
    watchFloats()
    if session.miniUp { placeCorner(session) }
    cornerIfMini(session)
    return true
  }

  /// Puts a page that has its small player up in the bottom right corner of the screen, as a
  /// small window of its own above the app, so the player outlives the page the reader left. The
  /// page keeps running in it; its player fills it.
  private func placeCorner(_ session: Session) {
    guard !session.inCorner, let host = shell?.superview, session.view.superview != nil else { return }
    session.inCorner = true
    // Above the page in front: its video layers otherwise draw over and tear the corner window.
    session.view.layer.zPosition = 1000
    let width = min(240, host.bounds.width * 0.48)
    let height = (width * 9 / 16).rounded()
    let bottomInset = host.window?.safeAreaInsets.bottom ?? host.safeAreaInsets.bottom
    session.view.frame = CGRect(
      x: host.bounds.width - width - 12,
      y: host.bounds.height - height - 96 - bottomInset,
      width: width,
      height: height)
    // The window's corners are rounded by the page; what is behind them must show through. The
    // view is clipped to the same radius as well: a video layer is drawn over its page's own
    // rounded corners as a plain rectangle, which would leave black points.
    session.view.isOpaque = false
    session.view.backgroundColor = .clear
    session.view.scrollView.backgroundColor = .clear
    session.view.underPageBackgroundColor = .clear
    session.view.layer.cornerRadius = cornerWindowRadius
    session.view.layer.masksToBounds = true
    session.view.isHidden = false
    host.addSubview(session.view)
    session.view.evaluateJavaScript(miniWindowScript(true))
  }

  /// Puts the small player of a page that was moved to the corner back over its own page.
  private func leaveCorner(_ session: Session) {
    session.inCorner = false
    session.view.layer.cornerRadius = 0
    session.view.layer.masksToBounds = false
    session.view.evaluateJavaScript(miniWindowScript(false))
  }

  /// A page left with its small player up goes to the corner; one without stays hidden.
  private func cornerIfMini(_ session: Session) {
    session.view.evaluateJavaScript(miniActiveScript) { [weak self, weak session] result, _ in
      guard let self, let session, (result as? Bool) == true, session.floatedForNavigation else { return }
      self.placeCorner(session)
    }
  }

  private func watchFloats() {
    guard !watchingFloats else { return }
    watchingFloats = true
    DispatchQueue.main.asyncAfter(deadline: .now() + floatCheckEvery) { [weak self] in
      guard let self else { return }
      self.watchingFloats = false
      guard !self.floatingSessions.isEmpty else { return }
      self.checkFloats()
      self.watchFloats()
    }
  }

  /// A floating page ends when its window is closed (a small player that was closed or ended).
  private func checkFloats() {
    for session in floatingSessions {
      session.view.evaluateJavaScript(inPictureInPictureScript) { [weak self, weak session] result, _ in
        guard let self, let session, (result as? Bool) != true else { return }
        self.endFloat(session)
      }
    }
  }

  private func endFloat(_ session: Session) {
    session.floatedForNavigation = false
    session.autoPictureInPicture = false
    leaveCorner(session)
    session.view.evaluateJavaScript(exitPictureInPictureScript)
    if let index = floatingSessions.firstIndex(where: { $0 === session }) {
      floatingSessions.remove(at: index)
    }
    if session.floatDetached {
      teardownView(session.view)
    } else {
      refreshMedia()
    }
  }

  /// Coming back to the app puts a video floated by `enterPictureInPicture` back in the page.
  private func exitAutomaticPictureInPicture() {
    for session in sessions.values where session.autoPictureInPicture {
      session.autoPictureInPicture = false
      session.view.evaluateJavaScript(exitPictureInPictureScript)
    }
  }

  /// The screen was locked: no picture-in-picture window stays up over it and the media of the
  /// page is stopped (unless its site may play in the background), so the lock screen's own pause
  /// button has nothing left to fight a page that restarts its video.
  private func screenWasLocked() {
    screenLocked = true
    for session in sessions.values {
      if session.autoPictureInPicture || session.windowOpen {
        session.autoPictureInPicture = false
        session.windowOpen = false
        session.view.evaluateJavaScript(exitPictureInPictureScript)
      }
      session.view.closeAllMediaPresentations {}
    }
    refreshMedia()
  }

  /// Tells every page whether the app is away (inactive or in the background), so the feed player
  /// neither restarts a video the lock screen's or the system window's pause button stopped, nor
  /// leaves a page that was away stuck. Coming back also wakes the pages' feed players.
  private func tellPagesAway(_ away: Bool) {
    let script = away ? "window.__openmediaAway=true" : resumeAwayScript
    for session in sessions.values { session.view.evaluateJavaScript(script) }
    for session in floatingSessions { session.view.evaluateJavaScript(script) }
  }

  /// The app is active again after a lock or a minimize: undo what a system player left behind.
  private func recoverAfterAway(afterLock: Bool = false) {
    exitAutomaticPictureInPicture()
    closeRestoredFullscreen()
    DispatchQueue.main.async { [weak self] in
      guard let self, let id = self.activeId, let session = self.sessions[id] else { return }
      // After a lock nothing the reader opened is still up: close every native player (fullscreen
      // or picture-in-picture) that WebKit restored over the app.
      if afterLock { session.view.closeAllMediaPresentations {} }
      // A video that was in a native player can leave the page zoomed in.
      session.view.scrollView.setZoomScale(1, animated: false)
      self.shell?.superview?.setNeedsLayout()
      self.focusActivePage()
      // A video that played as the screen locked can come back in a half-finished native player
      // layer that stays over the app (not full screen, over the floating button, taking every
      // touch) and that nothing in the page can close. The page is loaded again: its video is
      // gone, and with it the layer.
      if afterLock, session.playingBeforeLeaving, !session.fullscreenBeforeLeaving {
        session.playingBeforeLeaving = false
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self, weak session] in
          guard let self, let session, self.appForeground, !session.blocked,
            session.id == self.activeId
          else { return }
          self.reloadPage(session)
        }
      } else {
        self.reloadIfFrozen(session)
      }
    }
  }

  private func reloadPage(_ session: Session) {
    session.mediaSuspended = false
    session.view.setAllMediaPlaybackSuspended(false)
    session.view.alpha = 0
    session.painted = false
    session.view.reload()
  }

  /// A page whose web process was frozen by the lock keeps its last frame (and its sound), takes no
  /// touch and answers nothing until the app is restarted. One that does not answer a script in
  /// time is reloaded, as one whose process died.
  private func reloadIfFrozen(_ session: Session) {
    var answered = false
    session.view.evaluateJavaScript("1") { _, _ in answered = true }
    DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self, weak session] in
      guard !answered, let self, let session, self.appForeground, !session.blocked,
        session.id == self.activeId
      else { return }
      self.reloadPage(session)
    }
  }

  /// Suspends the media of every page that is out of sight, unless its site may play on, and
  /// resumes what was suspended when the page is shown again. A closed page is left to
  /// `applyBlocked`.
  private func refreshMedia() {
    for session in sessions.values where !session.blocked && !session.floatedForNavigation {
      let shown = appForeground && !covered && session.id == activeId
      if !appForeground && session.id == activeId {
        // A window the reader opened (the panel's button, or an automatic one) keeps playing while
        // the app is minimized, on any site. Without one the page is suspended as usual. A locked
        // screen is no minimizing: nothing floats over it and its controls could not stop the
        // media, so the page is suspended whatever window was open.
        if screenLocked {
          setMediaSuspended(!backgroundMediaSites.contains(session.scope), in: session)
          continue
        }
        if session.windowOpen {
          watchWindows()
          continue
        }
        suspendUnlessFloating(session)
        continue
      }
      setMediaSuspended(!shown && !backgroundMediaSites.contains(session.scope), in: session)
    }
    // Pages kept alive for a small player (in the corner or hidden) are not in `sessions`: with the
    // app in the background they play on unless a system window shows them.
    for session in floatingSessions where !session.blocked {
      if appForeground {
        setMediaSuspended(false, in: session)
      } else if screenLocked {
        setMediaSuspended(!backgroundMediaSites.contains(session.scope), in: session)
      } else {
        suspendUnlessFloating(session)
      }
    }
  }

  /// A page that is left keeps playing only if its video floats in a system picture-in-picture
  /// window; otherwise it is suspended as any page out of sight is. A page that does not answer
  /// in time is suspended too: a video playing on with no window and no screen cannot be stopped
  /// from the app once it is back. A window asked for a moment ago takes a beat to appear, so a
  /// page that floated automatically is asked once more before it is suspended; suspending it
  /// at once would close the window just opened.
  private func suspendUnlessFloating(_ session: Session, retry: Bool = true) {
    var answered = false
    let settle = { [weak self, weak session] (floating: Bool) in
      guard !answered, let self, let session, !self.appForeground else { return }
      answered = true
      if !floating, retry, session.autoPictureInPicture {
        DispatchQueue.main.asyncAfter(deadline: .now() + floatSettleWait) { [weak self, weak session] in
          guard let self, let session, !self.appForeground else { return }
          self.suspendUnlessFloating(session, retry: false)
        }
        return
      }
      if !floating { session.autoPictureInPicture = false }
      session.windowOpen = floating
      if floating { self.watchWindows() }
      self.setMediaSuspended(
        !floating && !self.backgroundMediaSites.contains(session.scope), in: session)
    }
    session.view.evaluateJavaScript(inSystemPictureInPictureScript) { result, _ in
      settle((result as? Bool) == true)
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + floatAnswerWait) { settle(false) }
  }

  /// While the app is in the background, a window that is kept open is asked after every so often:
  /// when the reader closes it, a site may start its video again behind it, and nothing else would
  /// stop that sound. A window that is gone ends the exemption and the page is suspended.
  private func watchWindows() {
    guard !watchingWindows, !appForeground, sessions.values.contains(where: { $0.windowOpen })
    else { return }
    watchingWindows = true
    DispatchQueue.main.asyncAfter(deadline: .now() + floatCheckEvery) { [weak self] in
      guard let self else { return }
      self.watchingWindows = false
      guard !self.appForeground else { return }
      for session in self.sessions.values where session.windowOpen {
        session.view.evaluateJavaScript(inSystemPictureInPictureScript) {
          [weak self, weak session] result, _ in
          guard let self, let session, !self.appForeground, (result as? Bool) != true else { return }
          session.windowOpen = false
          session.autoPictureInPicture = false
          self.setMediaSuspended(!self.backgroundMediaSites.contains(session.scope), in: session)
        }
      }
      self.watchWindows()
    }
  }

  /// The one place media is suspended or resumed. WebKit counts every suspend and resumes only
  /// once each has been undone, so a second suspend of an already suspended page would leave it
  /// silent for good; `mediaSuspended` keeps the two in step. The page is told as well, so its
  /// feed player neither fights the pause nor waits for a resume that never comes.
  private func setMediaSuspended(_ suspend: Bool, in session: Session) {
    if suspend == session.mediaSuspended { return }
    session.mediaSuspended = suspend
    // Natively stopped as well: a page whose script is stuck or restarts its video cannot answer
    // the pause, and the lock screen's controls would keep a playing page on.
    if suspend { session.view.pauseAllMediaPlayback {} }
    session.view.setAllMediaPlaybackSuspended(suspend)
    session.view.evaluateJavaScript(suspend ? holdMediaScript : resumeMediaScript)
  }

  /// A page's feed player asks, when the engine refuses its `play()`, for the video in view to be
  /// played from here: `evaluateJavaScript` runs with a user gesture, which no page script can
  /// give itself. Only the page in front is served, and the script is fixed: the page sends no
  /// code and no argument, so all it can do is ask for what it could have done with a tap.
  /// The panel's float button: the page in front becomes the small player in the corner, as it is,
  /// and the reader is taken to the page before it (else the site's start page) in a fresh view.
  /// Nothing in the kept page navigates or restyles its player, so a site that disposes its player
  /// when it navigates inside the page (YouTube) cannot take the video away, and the reader can go
  /// anywhere in the fresh view. It is not the same page again: a second player of the same site
  /// starting makes the site pause the first (YouTube does). The fresh view has no history. It is
  /// the standby when one is ready, so it shows at once instead of loading cold.
  func floatToCorner(_ view: WKWebView) {
    guard let session = session(of: view), session.id == activeId, session.miniUp, appForeground,
      !session.blocked, !session.floatedForNavigation, session.profileId != nil
    else { return }
    // One small player at a time: the one up already is closed.
    for other in floatingSessions where other.inCorner { endFloat(other) }
    let target = floatTarget(of: session)
    swapForFloatingVideo(
      session, loading: URLRequest(url: target), ready: takeStandby(for: session, target: target))
  }

  /// The corner player's expand button: the page in the corner is the page in front again, as it
  /// was, with its video back in it, and the page that took its place is set aside as the standby.
  func expandFromCorner(_ view: WKWebView) {
    guard let old = floatingSessions.first(where: { $0.view === view }), old.inCorner,
      let shell, let host = shell.superview
    else {
      // Not a corner window (the player is still over its own page): the video goes back.
      view.evaluateJavaScript(miniCloseScript)
      return
    }
    if let current = sessions[old.id], current !== old { setAside(current) }
    floatingSessions.removeAll { $0 === old }
    old.floatedForNavigation = false
    old.floatDetached = false
    old.autoPictureInPicture = false
    old.miniUp = false
    leaveCorner(old)
    old.view.layer.zPosition = 0
    old.view.evaluateJavaScript(miniCloseScript)
    host.insertSubview(old.view, belowSubview: shell)
    sessions[old.id] = old
    observe(old)
    showNow(old)
  }

  func setMiniUp(_ view: WKWebView, _ up: Bool) {
    guard let session = session(of: view) else { return }
    session.miniUp = up
    if up {
      prepareStandby(for: session)
    } else if standby?.id == session.id, standbyTarget != nil {
      // The drag fell short: the page made for it is not kept.
      dropStandby()
    }
  }

  func playFeedVideo(_ view: WKWebView) {
    guard let session = session(of: view), !session.blocked, !session.mediaSuspended,
      session.id == activeId
    else { return }
    view.evaluateJavaScript(playFeedVideoScript)
  }

  /// Closes one site for the day, or opens it again. Rust-only: the plugin registers no command
  /// for it, so neither the shell nor a site view can reach it. The block is native: a shield
  /// covers the page, the load stops, the media pauses and every navigation is refused, so the
  /// page cannot work around it.
  @objc public func setBlocked(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(SetBlockedArgs.self)
    DispatchQueue.main.async {
      guard let session = self.sessions[args.session] else {
        if args.blocked {
          self.rememberBlocked(args.session)
        } else {
          self.forgetBlocked(args.session)
        }
        invoke.resolve()
        return
      }
      self.applyBlocked(args.blocked, to: session)
      if args.blocked, self.standby?.id == args.session { self.dropStandby() }
      invoke.resolve()
    }
  }

  /// Asks the device owner for Face ID or Touch ID, and the device passcode when the system
  /// offers it as the fallback. Resolves `authenticated: false` when the person cancels or fails
  /// the check, and rejects only when the check cannot run at all (no passcode set, no
  /// biometrics enrolled). Rust-only: the plugin registers no command for it, so neither the
  /// shell nor a site view can raise or answer the prompt.
  @objc public func authenticate(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(AuthenticateArgs.self)
    let context = LAContext()
    var unavailable: NSError?
    guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &unavailable) else {
      invoke.reject(
        unavailable?.localizedDescription ?? "this device cannot check who is holding it")
      return
    }
    context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: args.reason) {
      success, error in
      if success {
        invoke.resolve(["authenticated": true])
        return
      }
      let declined: [LAError.Code] = [.userCancel, .systemCancel, .appCancel, .authenticationFailed]
      if let code = (error as? LAError)?.code, declined.contains(code) {
        invoke.resolve(["authenticated": false])
        return
      }
      invoke.reject(error?.localizedDescription ?? "the check could not run")
    }
  }

  /// Whether this device's biometric is Face ID, so the shell can draw the right icon. Touch ID,
  /// and a device with no biometric, report a fingerprint. Raises no prompt. Rust-only: no Tauri
  /// command or permission exposes it. `biometryType` is only valid after `canEvaluatePolicy`.
  @objc public func biometryKind(_ invoke: Invoke) throws {
    let context = LAContext()
    _ = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
    invoke.resolve(["kind": context.biometryType == .faceID ? "face" : "fingerprint"])
  }

  /// Runs a Rust-supplied script in the active session's main frame and resolves with its JSON
  /// text. Rust-only: the Rust plugin handle calls this by name; no Tauri command or permission
  /// exposes it, so neither the shell nor a site view can reach it. The script runs in
  /// `WKContentWorld.defaultClient`: it sees the page's DOM but not the page's JS globals, so a
  /// hostile page cannot replace `JSON` or `Element.prototype.querySelectorAll` under it. The
  /// result is page-derived data and the caller must treat it as hostile.
  @objc public func evaluate(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(EvaluateArgs.self)
    DispatchQueue.main.async {
      guard let id = self.activeId, let session = self.sessions[id] else {
        invoke.reject("no site view is open")
        return
      }
      var finished = false
      func finish(_ run: () -> Void) {
        guard !finished else { return }
        finished = true
        run()
      }
      DispatchQueue.main.asyncAfter(deadline: .now() + evaluateTimeout) {
        finish { invoke.reject("the page did not answer in time") }
      }
      let world: WKContentWorld = args.pageWorld == true ? .page : .defaultClient
      session.view.evaluateJavaScript(args.script, in: nil, in: world) { result in
        DispatchQueue.main.async {
          finish {
            switch result {
            case .failure:
              invoke.reject("the script failed in the page")
            case .success(let value):
              guard let json = value as? String else {
                invoke.reject("the script returned no value")
                return
              }
              guard json.utf8.count <= evaluateMaxBytes else {
                invoke.reject("the script result is too large")
                return
              }
              invoke.resolve(["json": json])
            }
          }
        }
      }
    }
  }

  /// Resolves with the color the active session's web view shows at a point of its visible
  /// viewport, as `{"hex": "#rrggbb"}`: a one-pixel snapshot of what WebKit rendered, so images,
  /// video frames, gradients and text read as well as backgrounds do. Web view points equal CSS
  /// pixels at page zoom 1; a pinch-zoomed page is read at the point, unscaled. Rust-only: no Tauri
  /// command or permission exposes it, so neither the shell nor a site view can read the screen.
  @objc public func sampleColor(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(SampleColorArgs.self)
    DispatchQueue.main.async {
      guard let id = self.activeId, let session = self.sessions[id], !session.blocked else {
        invoke.reject("no site view is open")
        return
      }
      let bounds = session.view.bounds
      guard args.x.isFinite, args.y.isFinite, bounds.width >= 1, bounds.height >= 1 else {
        invoke.reject("the point is outside the site view")
        return
      }
      var finished = false
      func finish(_ run: () -> Void) {
        guard !finished else { return }
        finished = true
        run()
      }
      DispatchQueue.main.asyncAfter(deadline: .now() + evaluateTimeout) {
        finish { invoke.reject("the page did not answer in time") }
      }
      let configuration = WKSnapshotConfiguration()
      configuration.rect = CGRect(
        x: min(max(args.x.rounded(.down), 0), bounds.width - 1),
        y: min(max(args.y.rounded(.down), 0), bounds.height - 1),
        width: 1, height: 1)
      configuration.snapshotWidth = 1
      session.view.takeSnapshot(with: configuration) { image, _ in
        DispatchQueue.main.async {
          finish {
            guard let hex = image.flatMap(Self.pixelHex) else {
              invoke.reject("the pixel could not be read")
              return
            }
            invoke.resolve(["hex": hex])
          }
        }
      }
    }
  }

  /// The color of an image's pixel as `#rrggbb`, drawn over white so a see-through pixel reads
  /// as it looks on a page.
  private static func pixelHex(_ image: UIImage) -> String? {
    guard let cgImage = image.cgImage, let space = CGColorSpace(name: CGColorSpace.sRGB) else {
      return nil
    }
    var pixel = [UInt8](repeating: 0, count: 4)
    let drawn = pixel.withUnsafeMutableBytes { buffer -> Bool in
      guard
        let context = CGContext(
          data: buffer.baseAddress, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
          space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
      else { return false }
      context.setFillColor(red: 1, green: 1, blue: 1, alpha: 1)
      context.fill(CGRect(x: 0, y: 0, width: 1, height: 1))
      context.interpolationQuality = .none
      context.draw(cgImage, in: CGRect(x: 0, y: 0, width: 1, height: 1))
      return true
    }
    guard drawn else { return nil }
    return String(format: "#%02x%02x%02x", pixel[0], pixel[1], pixel[2])
  }

  // MARK: Bridge

  func receiveBridgeMessage(_ message: WKScriptMessage) {
    guard message.frameInfo.isMainFrame, JSONSerialization.isValidJSONObject(message.body) else { return }
    // A page kept alive only for its picture-in-picture window is not the session's page.
    guard let sender = message.webView, session(of: sender) != nil else { return }
    guard
      let data = try? JSONSerialization.data(withJSONObject: message.body),
      let body = String(data: data, encoding: .utf8)
    else { return }
    let origin = message.frameInfo.securityOrigin
    send(BridgeEvent(origin: "\(origin.protocol)://\(origin.host)", body: body))
  }

  // MARK: WKNavigationDelegate / WKUIDelegate

  /// Asks for the desktop page, or not, for each main-frame navigation by the site's choice, then
  /// decides as `decidePolicyFor:decisionHandler:` does. A custom user agent stays what Mobile
  /// Safari sends (Google refuses a sign-in without a Safari token), or what a Mac sends.
  func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationAction: WKNavigationAction,
    preferences: WKWebpagePreferences,
    decisionHandler: @escaping (WKNavigationActionPolicy, WKWebpagePreferences) -> Void
  ) {
    if navigationAction.targetFrame?.isMainFrame ?? true,
      let session = pageSession(of: webView),
      let host = navigationAction.request.url?.host
    {
      let desktop = desktopSites.contains(DomainScope.registrableDomain(of: host))
      session.desktop = desktop
      preferences.preferredContentMode = desktop ? .desktop : .recommended
      webView.customUserAgent = desktop ? desktopUserAgent : safariUserAgent
    }
    self.webView(webView, decidePolicyFor: navigationAction) { policy in
      decisionHandler(policy, preferences)
    }
  }

  func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    if webView === signInWindow {
      // The sign-in window follows its own redirects: the identity provider and the site it
      // returns to are different domains. Only web addresses load in it.
      let url = navigationAction.request.url
      let scheme = url?.scheme?.lowercased()
      guard allowedSchemes.contains(scheme ?? "") || scheme == "about" else {
        decisionHandler(.cancel)
        return
      }
      if signInReturnsToSession, navigationAction.targetFrame?.isMainFrame ?? true,
        navigationAction.request.httpMethod?.uppercased() == "GET",
        let url, let host = url.host,
        let owner = signInOwner.flatMap({ sessions[$0] }),
        DomainScope.contains(scope: owner.scope, host: host)
      {
        // The identity provider sent the user back to the site: that page belongs in the page's
        // own view, which shares this window's cookies.
        decisionHandler(.cancel)
        DispatchQueue.main.async { [weak self] in self?.handBack(url, to: owner) }
        return
      }
      decisionHandler(.allow)
      return
    }
    guard let session = pageSession(of: webView) else {
      decisionHandler(.cancel)
      return
    }
    if session.blocked {
      // A closed page does not navigate: the limit is on the site, not on this view.
      decisionHandler(.cancel)
      return
    }
    let url = navigationAction.request.url
    let isMainFrame = navigationAction.targetFrame?.isMainFrame ?? true
    let scheme = url?.scheme?.lowercased()
    let hasHost = url?.host?.isEmpty == false
    let historyNavigation = navigationAction.navigationType == .backForward
    let historyTargetLeavesScope =
      url?.host.map { !DomainScope.contains(scope: session.scope, host: $0) } ?? false
    let userInitiated = isMainFrame && hasHost &&
      (navigationAction.navigationType == .linkActivated ||
        (historyNavigation && historyTargetLeavesScope)) &&
      (scheme == "http" || scheme == "https")
    if userInitiated { session.settled = false }
    switch DomainScope.verdict(
      scheme: url?.scheme, host: url?.host, scope: session.scope, settled: session.settled,
      isMainFrame: isMainFrame, userInitiated: userInitiated, signIn: !blockPopups || looksLikeSignIn(url))
    {
    case .allow:
      decisionHandler(.allow)
    case .cancel:
      decisionHandler(.cancel)
      if session !== standby { notePopupBlocked(url) }
    case .popup:
      // A redirect the page made on its own (a sign-in that runs after the tap) has to stay in
      // the app: the system browser shares no cookies with the page. A page out of sight (the
      // standby) opens nothing over the one the reader is looking at.
      decisionHandler(.cancel)
      guard session !== standby else { return }
      if let url, !openRedirectWindow(url, for: session) { presentPopup(url) }
    }
  }

  /// While the initial load or a user-initiated navigation is unsettled, redirects may change the
  /// scope; it then stays pinned to the destination domain.
  func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
    let page = pageSession(of: webView)
    page?.committed = true
    if page?.revealOnCommit == true { reveal(webView) } else { scheduleReveal(webView) }
    guard let session = page, !session.settled, let host = webView.url?.host else { return }
    session.scope = DomainScope.registrableDomain(of: host)
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    if webView === signInWindow {
      // A return that arrived as a form post cannot be replayed in the page's view; the window
      // finished it (its cookies are the page's), so the page's view loads where it ended up.
      if signInReturnsToSession, let url = webView.url, let host = url.host,
        let owner = signInOwner.flatMap({ sessions[$0] }),
        DomainScope.contains(scope: owner.scope, host: host)
      {
        handBack(url, to: owner)
      }
      return
    }
    reveal(webView)
    pageSession(of: webView)?.settled = true
    finishHandoff(of: webView)
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    pageSession(of: webView)?.settled = true
    finishHandoff(of: webView)
    // A page that never committed never paints, so nothing else would take the launch logo down:
    // the error would sit over a dead logo screen. The blank page stays hidden (it would be white).
    dropLaunchLogo()
    reportFailure(error)
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    pageSession(of: webView)?.settled = true
    finishHandoff(of: webView)
    // A page that never committed never paints, so nothing else would take the launch logo down:
    // the error would sit over a dead logo screen. The blank page stays hidden (it would be white).
    dropLaunchLogo()
    reportFailure(error)
  }

  /// A navigation the app itself cancelled (a redirect handed to another view) is not a failure, and
  /// neither is a load WebKit hands to its media player (204, "Plug-in handled load") or to the
  /// system (102, "Frame load interrupted"): the page is fine, there is nothing to report.
  private func reportFailure(_ error: Error) {
    let nsError = error as NSError
    if nsError.domain == NSURLErrorDomain, nsError.code == NSURLErrorCancelled { return }
    if nsError.domain == "WebKitErrorDomain", nsError.code == 204 || nsError.code == 102 { return }
    send(ErrorEvent(message: error.localizedDescription))
  }

  /// The sign-in window stays over the page until the page has loaded the address it was handed,
  /// so the user sees the sign-in, not a blank page, while the site comes up.
  private func handBack(_ url: URL, to owner: Session) {
    owner.settled = false
    handoffSession = owner.id
    owner.view.load(URLRequest(url: url))
    DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in
      if self?.handoffSession == owner.id { self?.closeSignInWindow() }
    }
  }

  private func finishHandoff(of webView: WKWebView) {
    guard let id = handoffSession, session(of: webView)?.id == id else { return }
    closeSignInWindow()
  }

  /// The page closed its sign-in window: the sign-in is done (or gave up). Take the window down.
  func webViewDidClose(_ webView: WKWebView) {
    if webView === signInWindow { closeSignInWindow() }
  }

  /// A dead web content process leaves a blank view. The visible page reloads, with the backdrop
  /// showing until it commits; a hidden one is dropped and the shell is told, so it reopens fresh
  /// when the user comes back to it.
  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    if webView === standby?.view {
      dropStandby()
      return
    }
    guard let session = session(of: webView) else { return }
    if session.id == activeId {
      if session.blocked {
        // A closed page is not brought back: it stays closed until the app opens it.
        dispose(session)
        send(ClosedEvent(session: session.id))
        return
      }
      webView.alpha = 0
      session.painted = false
      webView.reload()
    } else {
      dispose(session)
      send(ClosedEvent(session: session.id))
    }
  }

  /// User-clicked `target=_blank` links stay in this view; a window the page opens with
  /// `window.open` gets a view of its own, inside the app.
  func webView(
    _ webView: WKWebView,
    createWebViewWith configuration: WKWebViewConfiguration,
    for navigationAction: WKNavigationAction,
    windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    if webView === signInWindow {
      // A window opened by the sign-in window stays in it; there is only one level of windows.
      webView.load(navigationAction.request)
      return nil
    }
    guard let session = session(of: webView), let url = navigationAction.request.url else { return nil }
    if session.blocked { return nil }
    let scheme = url.scheme?.lowercased()
    let userInitiated = navigationAction.navigationType == .linkActivated &&
      url.host?.isEmpty == false && (scheme == "http" || scheme == "https")
    if userInitiated { session.settled = false }
    switch DomainScope.verdict(
      scheme: url.scheme, host: url.host, scope: session.scope, settled: session.settled,
      isMainFrame: true, userInitiated: userInitiated, signIn: !blockPopups || looksLikeSignIn(url))
    {
    case .allow: webView.load(navigationAction.request)
    case .popup:
      // A sign-in window has to live inside the app: it shares the profile's cookies and keeps
      // `window.opener`, so the sign-in can hand its token back to the page.
      if let window = openSignInWindow(configuration, for: session) { return window }
      presentPopup(url)
    case .cancel: notePopupBlocked(url)  // A window the page opens on its own that is no sign-in.
    }
    return nil
  }

  /// Tells the shell a window or redirect was dropped, so a sign-in refused by mistake can be
  /// switched off. Other refusals (a scheme the app never loads) are not this.
  private func notePopupBlocked(_ url: URL?) {
    guard let url, let host = url.host, !host.isEmpty,
      ["http", "https"].contains(url.scheme?.lowercased() ?? "")
    else { return }
    send(PopupBlockedEvent(host: host))
  }

  private func looksLikeSignIn(_ url: URL?) -> Bool {
    guard let url, let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
    return DomainScope.looksLikeSignIn(host: parts.host, path: parts.path, query: parts.query)
  }

  /// The window a page opened with `window.open`: a sign-in window. WebKit hands over the
  /// configuration to use, which carries the opener's data store and the link to the opener, so
  /// the sign-in and the page share one cookie jar and the page can be told the sign-in is done.
  private func openSignInWindow(
    _ configuration: WKWebViewConfiguration, for session: Session
  ) -> WKWebView? {
    guard let host = shell?.superview else { return nil }
    closeSignInWindow()
    let view = WKWebView(frame: session.view.frame, configuration: configuration)
    view.navigationDelegate = self
    view.uiDelegate = self
    view.customUserAgent = safariUserAgent
    host.insertSubview(view, aboveSubview: session.view)
    signInWindow = view
    signInOwner = session.id
    router?.siteView = view
    return view
  }

  /// An address the page navigated to on its own, outside the session's domain: usually a sign-in
  /// redirect. It opens in a window of its own that shares the profile's data store, so the
  /// cookies it sets are the page's cookies; when the sign-in returns to the site, the page's own
  /// view loads that address and the window closes.
  private func openRedirectWindow(_ url: URL, for session: Session) -> Bool {
    guard let host = shell?.superview, webURL(url.absoluteString) != nil else { return false }
    closeSignInWindow()
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = session.view.configuration.websiteDataStore
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = true
    configuration.allowsInlineMediaPlayback = true
    let view = WKWebView(frame: session.view.frame, configuration: configuration)
    view.navigationDelegate = self
    view.uiDelegate = self
    view.customUserAgent = safariUserAgent
    host.insertSubview(view, aboveSubview: session.view)
    signInWindow = view
    signInOwner = session.id
    signInReturnsToSession = true
    router?.siteView = view
    view.load(URLRequest(url: url))
    return true
  }

  /// Takes the sign-in window down and gives the touches back to the page.
  private func closeSignInWindow() {
    guard let view = signInWindow else { return }
    view.stopLoading()
    view.navigationDelegate = nil
    view.uiDelegate = nil
    view.removeFromSuperview()
    signInWindow = nil
    signInOwner = nil
    signInReturnsToSession = false
    handoffSession = nil
    router?.siteView = activeId.flatMap { sessions[$0]?.view }
  }

  // MARK: Helpers

  private func session(of view: WKWebView) -> Session? {
    sessions.values.first { $0.view === view }
  }

  /// The session a view's page runs in, the standby included: what decides where it may go. The
  /// standby is not one of the sessions the shell sees, so it reports nothing to it.
  private func pageSession(of view: WKWebView) -> Session? {
    session(of: view) ?? (standby?.view === view ? standby : nil)
  }

  // MARK: Blocking

  /// Closes or opens one session. Closing is native: the page is covered by a shield, its load
  /// stops, its media pauses and every navigation it asks for is refused. The session itself
  /// lives on, so opening it again brings the page back as it was.
  private func applyBlocked(_ blocked: Bool, to session: Session) {
    if blocked {
      rememberBlocked(session.id)
      session.blocked = true
      session.view.stopLoading()
      setMediaSuspended(true, in: session)
      installShield(on: session)
      reveal(session.view)
    } else {
      forgetBlocked(session.id)
      session.blocked = false
      removeShield(from: session)
      setMediaSuspended(false, in: session)
      refreshMedia()
      if session.view.url == nil { session.needsReload = true }
      if session.id == activeId && session.needsReload { show(session) }
    }
  }

  /// Covers a closed page with a native blur that takes every touch and says why the site is
  /// closed. The shield is a native view: the page cannot see it, so it cannot remove it.
  private func installShield(on session: Session) {
    guard session.shield == nil else { return }
    let shield = makeShield()
    session.shield = shield
    shield.translatesAutoresizingMaskIntoConstraints = false
    session.view.addSubview(shield)
    NSLayoutConstraint.activate([
      shield.topAnchor.constraint(equalTo: session.view.topAnchor),
      shield.bottomAnchor.constraint(equalTo: session.view.bottomAnchor),
      shield.leadingAnchor.constraint(equalTo: session.view.leadingAnchor),
      shield.trailingAnchor.constraint(equalTo: session.view.trailingAnchor),
    ])
  }

  private func removeShield(from session: Session) {
    session.shield?.removeFromSuperview()
    session.shield = nil
  }

  /// The shield's look: a blur over the page with the reason on it.
  private func makeShield() -> UIView {
    let shield = UIView()
    shield.backgroundColor = .clear
    shield.isUserInteractionEnabled = true
    let blur = UIVisualEffectView(effect: UIBlurEffect(style: .systemMaterial))
    blur.translatesAutoresizingMaskIntoConstraints = false
    shield.addSubview(blur)
    let label = UILabel()
    label.translatesAutoresizingMaskIntoConstraints = false
    label.text = shieldMessage
    label.numberOfLines = 0
    label.textAlignment = .center
    label.font = .preferredFont(forTextStyle: .body)
    label.adjustsFontForContentSizeCategory = true
    label.textColor = .label
    shield.addSubview(label)
    NSLayoutConstraint.activate([
      blur.topAnchor.constraint(equalTo: shield.topAnchor),
      blur.bottomAnchor.constraint(equalTo: shield.bottomAnchor),
      blur.leadingAnchor.constraint(equalTo: shield.leadingAnchor),
      blur.trailingAnchor.constraint(equalTo: shield.trailingAnchor),
      label.centerXAnchor.constraint(equalTo: shield.centerXAnchor),
      label.centerYAnchor.constraint(equalTo: shield.centerYAnchor),
      label.widthAnchor.constraint(lessThanOrEqualTo: shield.widthAnchor, multiplier: 0.8),
    ])
    return shield
  }

  private func rememberBlocked(_ id: String) {
    if !blockedSessions.contains(id) { blockedSessions.append(id) }
    if blockedSessions.count > maxRememberedBlocked {
      blockedSessions.removeFirst(blockedSessions.count - maxRememberedBlocked)
    }
  }

  private func forgetBlocked(_ id: String) {
    blockedSessions.removeAll { $0 == id }
  }

  private func isBlocked(_ id: String) -> Bool {
    blockedSessions.contains(id)
  }

  /// Makes `session` the one visible page. The others stay alive underneath, hidden.
  /// Makes `session` the one visible page. A page that is playing a video with sound when another
  /// takes the screen (Back to a favorite, Home, another site) is not suspended: its video floats
  /// in a picture-in-picture window first, as a mini player does.
  private func show(_ session: Session) {
    guard let id = activeId, let previous = sessions[id], previous !== session, appForeground,
      !previous.blocked, !previous.floatedForNavigation
    else {
      showNow(session)
      return
    }
    var shown = false
    let proceed = { [weak self] in
      guard !shown else { return }
      shown = true
      self?.showNow(session)
    }
    previous.view.evaluateJavaScript(floatScript(for: previous)) { [weak self, weak previous] result, _ in
      if (result as? Bool) == true, let self, let previous {
        previous.floatedForNavigation = true
        self.floatingSessions.append(previous)
        self.watchFloats()
        proceed()
        if previous.miniUp { self.placeCorner(previous) }
        self.cornerIfMini(previous)
        return
      }
      proceed()
    }
    // A page that never answers must not keep the next one from showing.
    DispatchQueue.main.asyncAfter(deadline: .now() + floatAnswerWait) { proceed() }
  }

  private func showNow(_ session: Session) {
    // Coming back to a page whose video floats puts the video back in it.
    if session.floatedForNavigation { endFloat(session) }
    if let standby, standby.id != session.id { dropStandby() }
    // A sign-in window belongs to the page that opened it; another page takes the screen.
    if let owner = signInOwner, owner != session.id { closeSignInWindow() }
    for other in sessions.values where other !== session && !(other.floatedForNavigation && other.miniUp) {
      other.view.isHidden = true
    }
    session.view.isHidden = false
    activeId = session.id
    if let host = shell?.superview { session.view.frame = pageFrame(in: host) }
    router?.siteView = session.view
    refreshMedia()
    focusActivePage()
    if session.needsReload && !session.blocked {
      session.needsReload = false
      if session.view.url == nil {
        session.view.load(URLRequest(url: session.initialURL))
      } else if session.desktop != desktopSites.contains(session.scope) {
        loadAgain(session)
      } else {
        session.view.reload()
      }
    }
    sendState(session)
  }

  /// Where a page's view goes inside `host`: the shell's reported rectangle, or until the shell
  /// reports one, the screen below the top safe area.
  private func pageFrame(in host: UIView) -> CGRect {
    if let shell, let pageRect { return shell.convert(pageRect, to: host) }
    let top = host.window?.safeAreaInsets.top ?? host.safeAreaInsets.top
    return CGRect(x: 0, y: top, width: host.bounds.width, height: max(0, host.bounds.height - top))
  }

  /// The screen's size, for a view that exists before there is a window to measure.
  private var screenBounds: CGRect {
    UIApplication.shared.connectedScenes
      .compactMap { ($0 as? UIWindowScene)?.screen.bounds }.first ?? .zero
  }

  /// Puts the session's view in the window, under the shell, and shows it if it is the active
  /// one. Without a window yet it does nothing; `attachShell` mounts it later.
  private func mount(_ session: Session) {
    guard session.view.superview == nil, let shell, let host = shell.superview else { return }
    session.view.frame = pageFrame(in: host)
    host.insertSubview(session.view, belowSubview: shell)
    _ = installRouter(in: host)
    if session.id == activeId { show(session) }
    if session.committed { scheduleReveal(session.view) }
  }

  /// The shell's view joins the window shortly after the plugin loads. Waits for it, then puts the
  /// backdrop and any page opened in the meantime in place.
  private func attachShell(attempt: Int = 0) {
    guard shell?.superview != nil else {
      guard attempt < 150 else { return }
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.02) { self.attachShell(attempt: attempt + 1) }
      return
    }
    installBackdrop()
    for session in sessions.values { mount(session) }
  }

  /// Shows the outside page in the system's in-app browser. One at a time: a page cannot stack
  /// popups on top of each other.
  @MainActor
  private func presentPopup(_ url: URL) {
    guard popup?.presentingViewController == nil, webURL(url.absoluteString) != nil else { return }
    var top = shell?.window?.rootViewController
    while let presented = top?.presentedViewController { top = presented }
    guard let top else { return }
    let controller = SFSafariViewController(url: url)
    controller.dismissButtonStyle = .close
    popup = controller
    top.present(controller, animated: true)
  }

  /// Fades the page in and tells the shell, whose splash is waiting for it. A new web view draws
  /// one blank frame before its first, and a fade keeps that frame down to a few percent over the
  /// backdrop. Does nothing until the view is in the window: a view that is not drawing has not
  /// painted.
  /// Detaches pull to refresh for a touch that began inside a scrolled container, and restores it
  /// for any other touch. Ordinary pages and the first feed item keep the gesture.
  func setInnerScrolled(_ view: WKWebView, _ scrolled: Bool) {
    guard let session = session(of: view), let refresh = session.refreshControl else { return }
    let target: UIRefreshControl? = scrolled ? nil : refresh
    guard view.scrollView.refreshControl !== target else { return }
    // Swapping the control while the page is still moving or pulled past its top shifts the
    // content under the finger: the next touch settles it.
    let scroll = view.scrollView
    if scroll.isDecelerating || scroll.isDragging || scroll.contentOffset.y < 0 { return }
    scroll.refreshControl = target
  }

  private func dropLaunchLogo() {
    launchLogo?.removeFromSuperview()
    launchLogo = nil
  }

  func reveal(_ view: WKWebView) {
    guard view.alpha == 0, view.superview != nil else { return }
    dropLaunchLogo()
    UIView.animate(withDuration: revealDuration, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
      view.alpha = 1
    }
    guard let session = session(of: view) else { return }
    session.painted = true
    sendState(session)
    focusActivePage()
  }

  /// Makes the page in front the window's first responder, so its document has the focus. A web
  /// view that has not been touched is not focused, and a site that pauses its video when its page
  /// has lost focus (Instagram's Reels do) then stops every video it starts, leaving a still frame
  /// until the first tap. Nothing is done while the app is away, the shell has a page over this one,
  /// the keyboard is up, or a sign-in window is open. Focus is only a state: it raises no keyboard.
  private func focusActivePage() {
    DispatchQueue.main.async { [weak self] in
      guard let self, self.appForeground, !self.covered, !self.keyboardUp, self.signInWindow == nil,
        let session = self.activeId.flatMap({ self.sessions[$0] }),
        !session.blocked, !session.view.isHidden, session.view.window != nil,
        !session.view.isFirstResponder
      else { return }
      _ = session.view.becomeFirstResponder()
    }
  }

  private func scheduleReveal(_ view: WKWebView) {
    DispatchQueue.main.asyncAfter(deadline: .now() + paintTimeout) { [weak self, weak view] in
      if let view { self?.reveal(view) }
    }
  }

  private func installUserScripts(
    on controller: WKUserContentController,
    recipe: String?,
    adBlockScriptlet: String?,
    adBlockEnabled: Bool
  ) {
    controller.removeAllUserScripts()
    controller.addUserScript(
      WKUserScript(source: firstPaintScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    controller.addUserScript(
      WKUserScript(source: touchScrollScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    if adBlockEnabled, let adBlockScriptlet, !adBlockScriptlet.isEmpty {
      controller.addUserScript(
        WKUserScript(source: adBlockScriptlet, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }
    if let recipe, !recipe.isEmpty {
      controller.addUserScript(
        WKUserScript(source: recipe, injectionTime: .atDocumentStart, forMainFrameOnly: false))
    }
    controller.addUserScript(
      WKUserScript(
        source: "\(pictureInPictureListScript());\n\(pictureInPictureGuardScript)",
        injectionTime: .atDocumentStart, forMainFrameOnly: false, in: pictureInPictureWorld))
  }

  private func installBackdrop() {
    guard backdrop == nil, let host = shell?.superview else { return }
    // The web view can leave uncovered safe-area pixels; keep those on the app backdrop too.
    host.backgroundColor = backdropColor
    let view = UIView(frame: host.bounds)
    view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.backgroundColor = backdropColor
    view.overrideUserInterfaceStyle = colorScheme
    host.insertSubview(view, at: 0)
    backdrop = view
    installLaunchLogo(in: view)
  }

  /// The launch screen's logo, kept on screen from the moment the launch screen goes until the
  /// splash in the shell (same logo, same place) has painted, so the first seconds never show an
  /// empty screen. Gone once the first page shows.
  private func installLaunchLogo(in backdrop: UIView) {
    guard let image = UIImage(named: "LaunchLogo") else { return }
    let logo = UIImageView(image: image)
    logo.contentMode = .scaleAspectFit
    logo.translatesAutoresizingMaskIntoConstraints = false
    backdrop.addSubview(logo)
    let proportional = logo.widthAnchor.constraint(equalTo: backdrop.widthAnchor, multiplier: 0.52)
    proportional.priority = .defaultHigh
    NSLayoutConstraint.activate([
      logo.centerXAnchor.constraint(equalTo: backdrop.centerXAnchor),
      logo.centerYAnchor.constraint(equalTo: backdrop.centerYAnchor),
      proportional,
      logo.widthAnchor.constraint(lessThanOrEqualToConstant: 240),
      logo.heightAnchor.constraint(equalTo: logo.widthAnchor),
    ])
    launchLogo = logo
  }

  private func installRouter(in host: UIView) -> TouchRouter {
    if let router { return router }
    let router = TouchRouter(frame: host.bounds)
    router.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    router.backgroundColor = .clear
    router.shell = shell
    router.regions = interactiveRegions
    host.addSubview(router)
    self.router = router
    return router
  }

  /// Looks each list up in WebKit's persistent store and compiles it from its JSON file only on a
  /// miss, so the slow compile runs once per list version. A list that fails is skipped and
  /// reported: browsing without blocking beats not browsing, but the user must be told.
  @MainActor
  private func loadRuleLists(_ lists: [RuleListArgs]) async -> ([WKContentRuleList], String?) {
    guard !lists.isEmpty else { return ([], nil) }
    let (cached, missing) = await lookUpRuleLists(lists)
    let (compiled, failure) = await compileRuleLists(missing)
    if let store = WKContentRuleListStore.default() {
      await removeStaleRuleLists(keeping: Set(lists.map(\.id)), in: store)
    }
    return (cached + compiled, failure)
  }

  /// The lists WebKit already has compiled, and the ones it does not. Cheap, so a page can open
  /// without waiting for a compile.
  @MainActor
  private func lookUpRuleLists(_ lists: [RuleListArgs]) async -> ([WKContentRuleList], [RuleListArgs]) {
    guard let store = WKContentRuleListStore.default() else { return ([], lists) }
    var found: [WKContentRuleList] = []
    var missing: [RuleListArgs] = []
    for list in lists {
      if let cached = await lookUp(list.id, in: store) {
        found.append(cached)
      } else {
        missing.append(list)
      }
    }
    return (found, missing)
  }

  @MainActor
  private func compileRuleLists(_ lists: [RuleListArgs]) async -> ([WKContentRuleList], String?) {
    guard !lists.isEmpty else { return ([], nil) }
    guard let store = WKContentRuleListStore.default() else {
      return ([], "Ad blocking is off: the content rule store is unavailable.")
    }
    var compiled: [WKContentRuleList] = []
    var failure: String?
    for list in lists {
      do {
        let json = try String(contentsOfFile: list.path, encoding: .utf8)
        if let result = try await store.compileContentRuleList(
          forIdentifier: list.id, encodedContentRuleList: json)
        {
          compiled.append(result)
        }
      } catch {
        failure = "Ad blocking is partly off: a filter list could not be loaded."
      }
    }
    return (compiled, failure)
  }

  /// The first page after an install or a list update must not wait several seconds for WebKit to
  /// compile the lists: it opens now, and the lists attach to every open page when they are ready,
  /// protecting the next navigation. Nothing reloads, so the user's page is never disturbed.
  private func compileInBackground(_ missing: [RuleListArgs], keeping lists: [RuleListArgs]) {
    let fresh = missing.filter { compilingRuleListIds.insert($0.id).inserted }
    guard !fresh.isEmpty else { return }
    let generation = ruleListGeneration
    Task { @MainActor in
      let (compiled, failure) = await self.compileRuleLists(fresh)
      fresh.forEach { self.compilingRuleListIds.remove($0.id) }
      if let store = WKContentRuleListStore.default() {
        await self.removeStaleRuleLists(keeping: Set(lists.map(\.id)), in: store)
      }
      if generation == self.ruleListGeneration {
        for session in self.sessions.values { self.attach(compiled, to: session) }
      }
      if let failure { self.send(ErrorEvent(message: failure)) }
    }
  }

  private func attach(_ ruleLists: [WKContentRuleList], to session: Session) {
    let controller = session.view.configuration.userContentController
    for list in ruleLists where session.ruleListIds.insert(list.identifier).inserted {
      controller.add(list)
      session.ruleLists.append(list)
    }
  }

  private func lookUp(_ id: String, in store: WKContentRuleListStore) async -> WKContentRuleList? {
    await withCheckedContinuation { continuation in
      store.lookUpContentRuleList(forIdentifier: id) { list, _ in continuation.resume(returning: list) }
    }
  }

  /// A list named `X-net` is a variant of `X` (the same rules without element hiding, made for a
  /// site that asked for less; `VARIANT_SUFFIX` in the plugin's `models.rs`). The store keeps both
  /// while either is asked for, so opening one site does not delete what another site uses.
  private func ruleListBase(_ id: String) -> String {
    id.hasSuffix("-net") ? String(id.dropLast("-net".count)) : id
  }

  /// Old list versions stay in WebKit's store until removed; each is several megabytes.
  private func removeStaleRuleLists(keeping ids: Set<String>, in store: WKContentRuleListStore) async {
    let stored: [String] = await withCheckedContinuation { continuation in
      store.getAvailableContentRuleListIdentifiers { continuation.resume(returning: $0 ?? []) }
    }
    let bases = Set(ids.map(ruleListBase))
    for id in stored where !bases.contains(ruleListBase(id)) {
      await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
        store.removeContentRuleList(forIdentifier: id) { _ in continuation.resume() }
      }
    }
  }

  private func makeConfiguration(
    profileId: UUID,
    script: String?,
    adBlockScriptlet: String?,
    adBlockEnabled: Bool,
    ruleLists: [WKContentRuleList]
  ) -> WKWebViewConfiguration {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = WKWebsiteDataStore(forIdentifier: profileId)
    // iPhone defaults to fullscreen-only video, which covers the shell's controls. No playback
    // needs a tap: with `.audio` here, a Reel or Short that starts with sound is refused and sits
    // on a still frame until the reader taps.
    // Sign-in with Google or Apple opens a popup from script that runs after the tap; without
    // this WebKit blocks it and the button does nothing.
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = true
    configuration.allowsInlineMediaPlayback = true
    configuration.mediaTypesRequiringUserActionForPlayback = []
    let controller = WKUserContentController()
    installUserScripts(
      on: controller,
      recipe: script,
      adBlockScriptlet: adBlockScriptlet,
      adBlockEnabled: adBlockEnabled)
    ruleLists.forEach { controller.add($0) }
    controller.add(WeakMessageHandler(self), name: bridgeHandlerName)
    controller.add(WeakPaintHandler(self), name: paintHandlerName)
    controller.add(WeakScrollHandler(self), name: scrollHandlerName)
    controller.add(WeakPlayHandler(self), name: playHandlerName)
    controller.add(WeakMiniHandler(self), name: miniHandlerName)
    configuration.userContentController = controller
    return configuration
  }

  private func observe(_ session: Session) {
    func watch<Value>(_ keyPath: KeyPath<WKWebView, Value>) -> NSKeyValueObservation {
      session.view.observe(keyPath, options: [.new]) { [weak self, weak session] _, _ in
        if let session { self?.sendState(session) }
      }
    }
    session.observations = [
      watch(\.url), watch(\.title), watch(\.isLoading), watch(\.canGoBack), watch(\.canGoForward),
    ]
  }

  private func sendState(_ session: Session) {
    let view = session.view
    if !view.isLoading { view.scrollView.refreshControl?.endRefreshing() }
    send(
      StateEvent(
        session: session.id,
        url: view.url?.absoluteString,
        title: view.title,
        loading: view.isLoading,
        canGoBack: view.canGoBack,
        canGoForward: view.canGoForward,
        playing: session.playing,
        painted: session.painted,
        scope: session.scope
      )
    )
  }

  private func watchPlaying() {
    DispatchQueue.main.asyncAfter(deadline: .now() + playingCheckEvery) { [weak self] in
      guard let self else { return }
      self.sessions.values.forEach { self.probePlaying($0) }
      self.watchPlaying()
    }
  }

  private func probePlaying(_ session: Session) {
    session.view.evaluateJavaScript(playingScript) { [weak self, weak session] result, _ in
      guard let self, let session else { return }
      let playing = (result as? Bool) == true
      guard playing != session.playing else { return }
      session.playing = playing
      self.sendState(session)
    }
  }

  private func send<T: Encodable>(_ event: T) {
    try? events?.send(event)
  }

  private func dispose(_ session: Session) {
    if signInOwner == session.id { closeSignInWindow() }
    session.observations.removeAll()
    removeShield(from: session)
    teardownView(session.view)
    sessions[session.id] = nil
    if activeId == session.id {
      activeId = nil
      router?.siteView = nil
    }
  }

  /// A web view for a session: its data store, scripts and rule lists, hidden until it paints.
  @MainActor
  private func makeSessionView(
    profileId: UUID, recipe: String?, adBlockScriptlet: String?, adBlockEnabled: Bool,
    ruleLists: [WKContentRuleList]
  ) -> WKWebView {
    let view = WKWebView(
      frame: .zero,
      configuration: makeConfiguration(
        profileId: profileId,
        script: recipe,
        adBlockScriptlet: adBlockScriptlet,
        adBlockEnabled: adBlockEnabled,
        ruleLists: ruleLists))
    view.allowsBackForwardNavigationGestures = true
    view.customUserAgent = safariUserAgent
    view.navigationDelegate = self
    view.uiDelegate = self
    view.alpha = 0
    let refresh = UIRefreshControl()
    refresh.addAction(UIAction { [weak view] _ in view?.reload() }, for: .valueChanged)
    view.scrollView.refreshControl = refresh
    return view
  }

  /// Takes a web view apart: nothing it loads or posts reaches the app any more.
  private func teardownView(_ view: WKWebView) {
    view.stopLoading()
    view.configuration.userContentController.removeAllUserScripts()
    view.configuration.userContentController.removeScriptMessageHandler(forName: bridgeHandlerName)
    view.configuration.userContentController.removeScriptMessageHandler(forName: paintHandlerName)
    view.configuration.userContentController.removeScriptMessageHandler(forName: scrollHandlerName)
    view.configuration.userContentController.removeScriptMessageHandler(forName: playHandlerName)
    view.configuration.userContentController.removeScriptMessageHandler(forName: miniHandlerName)
    view.navigationDelegate = nil
    view.uiDelegate = nil
    view.removeFromSuperview()
  }

  private func onActiveSession(_ invoke: Invoke, _ action: @escaping (Session) -> Void) {
    DispatchQueue.main.async {
      guard let id = self.activeId, let session = self.sessions[id] else {
        invoke.reject("no site view is open")
        return
      }
      if session.blocked {
        // A closed page is frozen: the request is answered, but the page does not move.
        invoke.resolve()
        return
      }
      action(session)
      invoke.resolve()
    }
  }

  private func webURL(_ string: String) -> URL? {
    guard
      let url = URL(string: string),
      let scheme = url.scheme?.lowercased(),
      allowedSchemes.contains(scheme),
      url.host != nil
    else { return nil }
    return url
  }
}


@_cdecl("init_plugin_siteview")
public func initPlugin() -> Plugin {
  return SiteViewPlugin()
}
