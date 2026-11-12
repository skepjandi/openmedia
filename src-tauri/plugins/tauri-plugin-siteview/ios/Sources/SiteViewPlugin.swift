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
private let touchScrollScript = """
  (function () {
    window.addEventListener('touchstart', function (event) {
      var node = event.target;
      var scrolled = false;
      while (node && node.nodeType === 1) {
        if (node.scrollTop > 0) { scrolled = true; break; }
        node = node.parentElement;
      }
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
private let allowedSchemes: Set<String> = ["http", "https"]
/// `evaluate` gives up after this long; a hung page must not hang the caller.
private let evaluateTimeout: TimeInterval = 5
/// `evaluate` refuses a result larger than this many UTF-8 bytes.
private let evaluateMaxBytes = 200_000
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
  let contentRuleLists: [RuleListArgs]?
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
  let lists: [RuleListArgs]
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

class AuthenticateArgs: Decodable {
  let reason: String
}

class EvaluateArgs: Decodable {
  let script: String
}

struct StateEvent: Encodable {
  let type = "state"
  let session: String
  let url: String?
  let title: String?
  let loading: Bool
  let canGoBack: Bool
  let canGoForward: Bool
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

/// One open page: its native view and the domain it is currently pinned to.
private final class Session {
  let id: String
  let view: WKWebView
  let initialURL: URL
  /// The registrable domain the session may show; user-initiated navigation can move it after load.
  var scope: String
  /// False during the initial load and user-initiated navigation; see `DomainScope.verdict`.
  var settled = false
  /// True once the first load has committed; before that a timeout must not reveal a blank page.
  var committed = false
  /// True once the page has been shown. Until then the shell's splash stays up.
  var painted = false
  /// The pull-to-refresh control, detached from the scroll view while a touch began inside a
  /// container that is scrolled away from its top.
  var refreshControl: UIRefreshControl?
  /// A hidden session whose content rule lists changed reloads when it is shown again.
  var needsReload = false
  /// Ids of the content rule lists attached to this view, so a late compile attaches each once.
  var ruleListIds: Set<String> = []
  /// True while the app has closed this site. The block lives in the native layer: the page
  /// cannot lift it, and switching to another session does not clear it.
  var blocked = false
  /// True while the page's media is suspended because the page went out of sight.
  var mediaSuspended = false
  /// The native shield over a closed page. It covers the page and takes every touch.
  var shield: UIView?
  var observations: [NSKeyValueObservation] = []

  init(id: String, view: WKWebView, scope: String, initialURL: URL) {
    self.id = id
    self.view = view
    self.scope = scope
    self.initialURL = initialURL
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
  /// False from the app entering the background to it coming back.
  private var appForeground = true

  override func load(webview: WKWebView) {
    shell = webview
    webview.isOpaque = false
    webview.backgroundColor = .clear
    webview.scrollView.backgroundColor = .clear
    // The shell is app chrome: no pinch zoom, whatever the viewport meta says.
    webview.scrollView.minimumZoomScale = 1
    webview.scrollView.maximumZoomScale = 1
    webview.scrollView.pinchGestureRecognizer?.isEnabled = false
    NotificationCenter.default.addObserver(
      forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: .main
    ) { [weak self] _ in self?.send(MemoryWarningEvent()) }
    NotificationCenter.default.addObserver(
      forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
    ) { [weak self] _ in
      self?.appForeground = false
      self?.refreshMedia()
    }
    NotificationCenter.default.addObserver(
      forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main
    ) { [weak self] _ in
      self?.appForeground = true
      self?.refreshMedia()
    }
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
      if let existing = self.sessions[args.session] { self.dispose(existing) }
      if let rect = args.rect { self.pageRect = rect.cgRect }
      let view = WKWebView(
        frame: self.shell?.superview.map { self.pageFrame(in: $0) } ?? self.screenBounds,
        configuration: self.makeConfiguration(
          profileId: profileId, script: args.documentStartScript, ruleLists: cached)
      )
      view.allowsBackForwardNavigationGestures = true
      view.customUserAgent = safariUserAgent
      view.navigationDelegate = self
      view.uiDelegate = self
      view.overrideUserInterfaceStyle = self.colorScheme
      view.alpha = 0
      let refresh = UIRefreshControl()
      refresh.addAction(UIAction { [weak view] _ in view?.reload() }, for: .valueChanged)
      view.scrollView.refreshControl = refresh

      let session = Session(
        id: args.session, view: view, scope: DomainScope.registrableDomain(of: url.host ?? ""), initialURL: url)
      session.refreshControl = refresh
      session.ruleListIds = Set(cached.map(\.identifier))
      self.sessions[session.id] = session
      self.activeId = session.id
      self.events = args.onEvent
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
      invoke.resolve()
    }
  }

  @objc public func setRect(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(SetRectArgs.self)
    DispatchQueue.main.async {
      self.pageRect = args.rect.cgRect
      if let shell = self.shell, let host = shell.superview {
        let frame = shell.convert(args.rect.cgRect, to: host)
        self.sessions.values.forEach { $0.view.frame = frame }
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

  @objc public func navigate(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(NavigateArgs.self)
    guard let url = webURL(args.url) else {
      invoke.reject("only http and https urls can be opened")
      return
    }
    onActiveSession(invoke) { $0.view.load(URLRequest(url: url)) }
  }

  @objc public func goBack(_ invoke: Invoke) {
    onActiveSession(invoke) { [weak self] session in
      guard let self else { return }
      // Back leaves the sign-in window first: the page under it keeps its place.
      if self.signInWindow != nil {
        self.closeSignInWindow()
        return
      }
      session.view.goBack()
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
      self.sessions.values.forEach { $0.view.overrideUserInterfaceStyle = self.colorScheme }
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
      let (ruleLists, failure) = await self.loadRuleLists(args.lists)
      for session in self.sessions.values {
        let controller = session.view.configuration.userContentController
        controller.removeAllContentRuleLists()
        ruleLists.forEach { controller.add($0) }
        session.ruleListIds = Set(ruleLists.map(\.identifier))
        if session.id == self.activeId && !session.blocked {
          session.view.reload()
        } else {
          session.needsReload = true
        }
      }
      if let failure { self.send(ErrorEvent(message: failure)) }
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
      for session in self.sessions.values {
        let controller = session.view.configuration.userContentController
        self.installUserScripts(on: controller, recipe: args.script)
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

  /// Suspends the media of every page that is out of sight, unless its site may play on, and
  /// resumes what was suspended when the page is shown again. A closed page is left to
  /// `applyBlocked`.
  private func refreshMedia() {
    for session in sessions.values where !session.blocked {
      let shown = appForeground && session.id == activeId
      let suspend = !shown && !backgroundMediaSites.contains(session.scope)
      if suspend == session.mediaSuspended { continue }
      session.mediaSuspended = suspend
      session.view.setAllMediaPlaybackSuspended(suspend)
    }
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
      session.view.evaluateJavaScript(args.script, in: nil, in: .defaultClient) { result in
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

  // MARK: Bridge

  func receiveBridgeMessage(_ message: WKScriptMessage) {
    guard message.frameInfo.isMainFrame, JSONSerialization.isValidJSONObject(message.body) else { return }
    guard
      let data = try? JSONSerialization.data(withJSONObject: message.body),
      let body = String(data: data, encoding: .utf8)
    else { return }
    let origin = message.frameInfo.securityOrigin
    send(BridgeEvent(origin: "\(origin.protocol)://\(origin.host)", body: body))
  }

  // MARK: WKNavigationDelegate / WKUIDelegate

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
    guard let session = session(of: webView) else {
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
      isMainFrame: isMainFrame, userInitiated: userInitiated)
    {
    case .allow:
      decisionHandler(.allow)
    case .cancel:
      decisionHandler(.cancel)
    case .popup:
      // A redirect the page made on its own (a sign-in that runs after the tap) has to stay in
      // the app: the system browser shares no cookies with the page.
      decisionHandler(.cancel)
      if let url, !openRedirectWindow(url, for: session) { presentPopup(url) }
    }
  }

  /// While the initial load or a user-initiated navigation is unsettled, redirects may change the
  /// scope; it then stays pinned to the destination domain.
  func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
    session(of: webView)?.committed = true
    scheduleReveal(webView)
    guard let session = session(of: webView), !session.settled, let host = webView.url?.host else { return }
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
    session(of: webView)?.settled = true
    finishHandoff(of: webView)
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    session(of: webView)?.settled = true
    finishHandoff(of: webView)
    reportFailure(error)
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    session(of: webView)?.settled = true
    finishHandoff(of: webView)
    reportFailure(error)
  }

  /// A navigation the app itself cancelled (a redirect handed to another view) is not a failure.
  private func reportFailure(_ error: Error) {
    if (error as NSError).domain == NSURLErrorDomain, (error as NSError).code == NSURLErrorCancelled { return }
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
      isMainFrame: true, userInitiated: userInitiated)
    {
    case .allow: webView.load(navigationAction.request)
    case .popup:
      // A sign-in window has to live inside the app: it shares the profile's cookies and keeps
      // `window.opener`, so the sign-in can hand its token back to the page.
      if let window = openSignInWindow(configuration, for: session) { return window }
      presentPopup(url)
    case .cancel: break
    }
    return nil
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
    view.overrideUserInterfaceStyle = colorScheme
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
    view.overrideUserInterfaceStyle = colorScheme
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

  // MARK: Blocking

  /// Closes or opens one session. Closing is native: the page is covered by a shield, its load
  /// stops, its media pauses and every navigation it asks for is refused. The session itself
  /// lives on, so opening it again brings the page back as it was.
  private func applyBlocked(_ blocked: Bool, to session: Session) {
    if blocked {
      rememberBlocked(session.id)
      session.blocked = true
      session.view.stopLoading()
      session.view.setAllMediaPlaybackSuspended(true)
      installShield(on: session)
      reveal(session.view)
    } else {
      forgetBlocked(session.id)
      session.blocked = false
      removeShield(from: session)
      session.view.setAllMediaPlaybackSuspended(false)
      session.mediaSuspended = false
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
  private func show(_ session: Session) {
    // A sign-in window belongs to the page that opened it; another page takes the screen.
    if let owner = signInOwner, owner != session.id { closeSignInWindow() }
    for other in sessions.values where other !== session { other.view.isHidden = true }
    session.view.isHidden = false
    activeId = session.id
    if let host = shell?.superview { session.view.frame = pageFrame(in: host) }
    router?.siteView = session.view
    refreshMedia()
    if session.needsReload && !session.blocked {
      session.needsReload = false
      if session.view.url == nil {
        session.view.load(URLRequest(url: session.initialURL))
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
    if view.scrollView.refreshControl !== target { view.scrollView.refreshControl = target }
  }

  func reveal(_ view: WKWebView) {
    guard view.alpha == 0, view.superview != nil else { return }
    launchLogo?.removeFromSuperview()
    launchLogo = nil
    UIView.animate(withDuration: revealDuration, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
      view.alpha = 1
    }
    guard let session = session(of: view) else { return }
    session.painted = true
    sendState(session)
  }

  private func scheduleReveal(_ view: WKWebView) {
    DispatchQueue.main.asyncAfter(deadline: .now() + paintTimeout) { [weak self, weak view] in
      if let view { self?.reveal(view) }
    }
  }

  private func installUserScripts(on controller: WKUserContentController, recipe: String?) {
    controller.removeAllUserScripts()
    controller.addUserScript(
      WKUserScript(source: firstPaintScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    controller.addUserScript(
      WKUserScript(source: touchScrollScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    if let recipe, !recipe.isEmpty {
      controller.addUserScript(
        WKUserScript(source: recipe, injectionTime: .atDocumentStart, forMainFrameOnly: false))
    }
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
    }
  }

  private func lookUp(_ id: String, in store: WKContentRuleListStore) async -> WKContentRuleList? {
    await withCheckedContinuation { continuation in
      store.lookUpContentRuleList(forIdentifier: id) { list, _ in continuation.resume(returning: list) }
    }
  }

  /// Old list versions stay in WebKit's store until removed; each is several megabytes.
  private func removeStaleRuleLists(keeping ids: Set<String>, in store: WKContentRuleListStore) async {
    let stored: [String] = await withCheckedContinuation { continuation in
      store.getAvailableContentRuleListIdentifiers { continuation.resume(returning: $0 ?? []) }
    }
    for id in stored where !ids.contains(id) {
      await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
        store.removeContentRuleList(forIdentifier: id) { _ in continuation.resume() }
      }
    }
  }

  private func makeConfiguration(profileId: UUID, script: String?, ruleLists: [WKContentRuleList])
    -> WKWebViewConfiguration
  {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = WKWebsiteDataStore(forIdentifier: profileId)
    // iPhone defaults to fullscreen-only video, which covers the shell's controls. Muted video may
    // autoplay inline; audio still needs a tap.
    // Sign-in with Google or Apple opens a popup from script that runs after the tap; without
    // this WebKit blocks it and the button does nothing.
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = true
    configuration.allowsInlineMediaPlayback = true
    configuration.mediaTypesRequiringUserActionForPlayback = .audio
    let controller = WKUserContentController()
    installUserScripts(on: controller, recipe: script)
    ruleLists.forEach { controller.add($0) }
    controller.add(WeakMessageHandler(self), name: bridgeHandlerName)
    controller.add(WeakPaintHandler(self), name: paintHandlerName)
    controller.add(WeakScrollHandler(self), name: scrollHandlerName)
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
        painted: session.painted,
        scope: session.scope
      )
    )
  }

  private func send<T: Encodable>(_ event: T) {
    try? events?.send(event)
  }

  private func dispose(_ session: Session) {
    if signInOwner == session.id { closeSignInWindow() }
    session.observations.removeAll()
    removeShield(from: session)
    let view = session.view
    view.stopLoading()
    view.configuration.userContentController.removeAllUserScripts()
    view.configuration.userContentController.removeScriptMessageHandler(forName: bridgeHandlerName)
    view.configuration.userContentController.removeScriptMessageHandler(forName: paintHandlerName)
    view.configuration.userContentController.removeScriptMessageHandler(forName: scrollHandlerName)
    view.navigationDelegate = nil
    view.uiDelegate = nil
    view.removeFromSuperview()
    sessions[session.id] = nil
    if activeId == session.id {
      activeId = nil
      router?.siteView = nil
    }
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
