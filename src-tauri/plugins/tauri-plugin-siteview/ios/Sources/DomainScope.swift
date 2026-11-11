import Foundation

/// What to do with a main-frame navigation requested by a session.
enum NavigationVerdict: Equatable {
  case allow
  /// The target is outside the session's domain: show it in the popup browser instead.
  case popup
  case cancel
}

/// A clicked link from a favorite opens outside the session; other clicked links and their redirects
/// stay in the same view. This file keeps the rule pure for checks without UIKit or WebKit.
enum DomainScope {
  private static let searchEngineDomains: Set<String> = [
    "duckduckgo.com", "google.com", "bing.com", "brave.com", "ecosia.org", "startpage.com", "yahoo.com",
  ]

  /// `www.instagram.com` and `m.instagram.com` both give `instagram.com`; `news.bbc.co.uk` gives
  /// `bbc.co.uk`, and `bob.github.io` stays `bob.github.io` (Public Suffix List). Hosts without a
  /// registrable part (IP addresses, `localhost`) are kept whole.
  static func registrableDomain(of host: String) -> String {
    PublicSuffix.shared.registrableDomain(of: host)
      ?? (host.hasSuffix(".") ? String(host.dropLast()) : host).lowercased()
  }
  static func searchEngineDomain(of host: String?) -> String? {
    guard let host, !host.isEmpty else { return nil }
    let domain = registrableDomain(of: host)
    return searchEngineDomains.contains(domain) ? domain : nil
  }


  /// True for the scope itself and any subdomain of it, never for a lookalike such as
  /// `notinstagram.com`.
  static func contains(scope: String, host: String) -> Bool {
    let host = (host.hasSuffix(".") ? String(host.dropLast()) : host).lowercased()
    let scope = (scope.hasSuffix(".") ? String(scope.dropLast()) : scope).lowercased()
    return host == scope || host.hasSuffix("." + scope)
  }

  /// Favorite-site links open outside the session. Clicked links from other sites stay in the view.
  static func verdict(
    scheme: String?, host: String?, scope: String, settled: Bool, isMainFrame: Bool,
    searchDomain: String? = nil, sourceHost: String? = nil, userGesture: Bool = false,
    sourceFavorite: Bool = false, navigationPending: Bool = false
  ) -> NavigationVerdict {
    switch scheme?.lowercased() {
    case "about":
      return .allow
    case "http", "https":
      guard let host, !host.isEmpty else { return .cancel }
      if !isMainFrame || !settled || contains(scope: scope, host: host) { return .allow }
      if navigationPending
        || (!sourceFavorite && (
          searchDomain.map({ contains(scope: $0, host: host) }) == true
            || isSearchResultNavigation(
              scheme: scheme, targetHost: host, sourceHost: sourceHost, searchDomain: searchDomain,
              userGesture: userGesture
            )
            || userGesture
        ))
      {
        return .allow
      }
      return .popup
    default:
      return .cancel
    }
  }

  /// True for a user-initiated web navigation from the original search-engine page.
  static func isSearchResultNavigation(
    scheme: String?, targetHost: String?, sourceHost: String?, searchDomain: String?, userGesture: Bool
  ) -> Bool {
    guard userGesture, ["http", "https"].contains(scheme?.lowercased() ?? ""),
      let targetHost, !targetHost.isEmpty, let sourceHost, let searchDomain
    else { return false }
    return contains(scope: searchDomain, host: sourceHost)
  }
}
