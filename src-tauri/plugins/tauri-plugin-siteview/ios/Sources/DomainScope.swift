import Foundation

/// What to do with a main-frame navigation requested by a session.
enum NavigationVerdict: Equatable {
  case allow
  /// The target is outside the session's domain and looks like a sign-in or a payment: show it in
  /// a window of the app instead.
  case popup
  case cancel
}

/// A session follows user-initiated navigation in its web view, then stays pinned to the
/// destination domain. This file holds the rule as pure functions so it can be compiled and tested
/// without UIKit or WebKit.
enum DomainScope {
  /// `www.instagram.com` and `m.instagram.com` both give `instagram.com`; `news.bbc.co.uk` gives
  /// `bbc.co.uk`, and `bob.github.io` stays `bob.github.io` (Public Suffix List). Hosts without a
  /// registrable part (IP addresses, `localhost`) are kept whole.
  static func registrableDomain(of host: String) -> String {
    PublicSuffix.shared.registrableDomain(of: host)
      ?? (host.hasSuffix(".") ? String(host.dropLast()) : host).lowercased()
  }

  /// True for the scope itself and any subdomain of it, never for a lookalike such as
  /// `notinstagram.com`.
  static func contains(scope: String, host: String) -> Bool {
    let host = (host.hasSuffix(".") ? String(host.dropLast()) : host).lowercased()
    let scope = (scope.hasSuffix(".") ? String(scope.dropLast()) : scope).lowercased()
    return host == scope || host.hasSuffix("." + scope)
  }

  /// Hosts, and their subdomains, that only identity providers and payment pages use.
  private static let signInHosts = [
    "accounts.google.com", "accounts.youtube.com", "appleid.apple.com", "login.microsoftonline.com",
    "login.live.com", "checkout.stripe.com", "paypal.com", "okta.com", "auth0.com",
  ]
  /// Path pieces that name a sign-in or an authorization step.
  private static let signInPaths = [
    "/oauth", "/authorize", "/saml", "/sso", "/openid", "/signin", "/sign-in", "/login", "/log-in",
  ]

  /// Whether an address outside the session's site is plausibly a sign-in or a payment, the only
  /// reason a page has to send the user somewhere else on its own. Ad networks send people to
  /// throwaway domains with none of these marks, so everything else a page opens or redirects to
  /// without a tap on a link is refused. Heuristic: an unknown identity provider that uses none of
  /// these marks is refused too.
  static func looksLikeSignIn(host: String?, path: String, query: String?) -> Bool {
    let host = (host ?? "").lowercased()
    if signInHosts.contains(where: { host == $0 || host.hasSuffix("." + $0) }) { return true }
    let path = path.lowercased()
    if signInPaths.contains(where: { path.contains($0) }) || path.hasSuffix("/auth")
      || path.contains("/auth/")
    {
      return true
    }
    let names = Set(
      (query ?? "").split(separator: "&").map { $0.split(separator: "=", maxSplits: 1)[0].lowercased() })
    return names.contains("samlrequest")
      || (names.contains("client_id") && (names.contains("redirect_uri") || names.contains("response_type")))
  }

  /// Decides a navigation.
  ///
  /// - `settled`: false during the initial load or a user-initiated navigation. Until then,
  ///   redirects may change the domain; after it settles, automatic cross-domain navigations open
  ///   in a popup.
  /// - `signIn`: whether the target looks like a sign-in (`looksLikeSignIn`). An automatic
  ///   cross-domain navigation that does not is cancelled: it is an ad redirect or a popunder.
  /// - Subframes are never blocked; only the page the user sees is pinned.
  static func verdict(
    scheme: String?, host: String?, scope: String, settled: Bool, isMainFrame: Bool,
    userInitiated: Bool = false, signIn: Bool = false
  ) -> NavigationVerdict {
    switch scheme?.lowercased() {
    case "about":
      return .allow
    case "http", "https":
      guard let host, !host.isEmpty else { return .cancel }
      if !isMainFrame || !settled || userInitiated || contains(scope: scope, host: host) { return .allow }
      return signIn ? .popup : .cancel
    default:
      return .cancel
    }
  }
}
