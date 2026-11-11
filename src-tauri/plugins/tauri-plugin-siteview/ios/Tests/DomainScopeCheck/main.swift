import Foundation

// Standalone checks for DomainScope.swift. Run with scripts/test-domain-scope.sh; no Xcode project,
// UIKit or WebKit needed. Exits non-zero on the first run that has a failure.

var failures = 0

func expect<T: Equatable>(_ actual: T, _ expected: T, _ name: String) {
  if actual != expected {
    print("FAIL \(name): got \(actual), expected \(expected)")
    failures += 1
  }
}

func domain(_ host: String) -> String { DomainScope.registrableDomain(of: host) }
func contains(_ scope: String, _ host: String) -> Bool { DomainScope.contains(scope: scope, host: host) }
func verdict(
  _ scheme: String?, _ host: String?, scope: String, settled: Bool = true, mainFrame: Bool = true,
  searchDomain: String? = nil, sourceHost: String? = nil, userGesture: Bool = false,
  sourceFavorite: Bool = false, navigationPending: Bool = false
) -> NavigationVerdict {
  DomainScope.verdict(
    scheme: scheme, host: host, scope: scope, settled: settled, isMainFrame: mainFrame,
    searchDomain: searchDomain, sourceHost: sourceHost, userGesture: userGesture,
    sourceFavorite: sourceFavorite, navigationPending: navigationPending
  )
}

expect(domain("www.instagram.com"), "instagram.com", "www prefix")
expect(domain("m.youtube.com"), "youtube.com", "mobile prefix")
expect(domain("x.com"), "x.com", "apex domain")
expect(domain("a.b.c.example.com"), "example.com", "deep subdomain")
expect(domain("WWW.Reddit.COM"), "reddit.com", "case")
expect(domain("news.bbc.co.uk"), "bbc.co.uk", "co.uk")
expect(domain("bbc.co.uk"), "bbc.co.uk", "co.uk apex")
expect(domain("shop.example.com.au"), "example.com.au", "com.au")
expect(domain("foo.co.com"), "foo.co.com", "co.com is a public suffix")
expect(domain("www.alice.github.io"), "alice.github.io", "hosting suffix")
expect(domain("foo.com.br"), "foo.com.br", "com.br")
expect(domain("localhost"), "localhost", "localhost")
expect(domain("192.168.1.20"), "192.168.1.20", "ipv4 stays whole")
expect(domain("example.com."), "example.com", "DNS terminal dot")
expect(contains("example.com", "example.com."), true, "terminal dot within scope")

expect(contains("instagram.com", "www.instagram.com"), true, "subdomain")
expect(contains("instagram.com", "instagram.com"), true, "the scope itself")
expect(contains("instagram.com", "notinstagram.com"), false, "lookalike")
expect(contains("instagram.com", "instagram.com.evil.io"), false, "suffix trick")

expect(verdict("https", "l.instagram.com", scope: "instagram.com"), .allow, "same domain")
expect(verdict("https", "evil.io", scope: "instagram.com"), .popup, "outside domain")
expect(verdict("https", "evil.io", scope: "instagram.com", mainFrame: false), .allow, "subframe")
expect(verdict("https", "x.com", scope: "twitter.com", settled: false), .allow, "first-load redirect")
expect(verdict("https", "x.com", scope: "twitter.com"), .popup, "redirect after the first load")
expect(verdict("about", nil, scope: "a.com"), .allow, "about:blank")
expect(verdict("javascript", nil, scope: "a.com"), .cancel, "javascript:")
expect(verdict("tel", nil, scope: "a.com"), .cancel, "tel:")
expect(verdict("https", nil, scope: "a.com"), .cancel, "no host")

for (host, expected) in [
  ("duckduckgo.com", "duckduckgo.com"), ("www.google.com", "google.com"),
  ("www.bing.com", "bing.com"), ("search.brave.com", "brave.com"),
  ("www.ecosia.org", "ecosia.org"), ("www.startpage.com", "startpage.com"),
  ("search.yahoo.com", "yahoo.com"),
] {
  expect(DomainScope.searchEngineDomain(of: host), Optional(expected), "\(host) search origin")
}
expect(
  DomainScope.isSearchResultNavigation(
    scheme: "https", targetHost: "google.com", sourceHost: "www.google.com",
    searchDomain: "google.com", userGesture: true
  ),
  true,
  "same-engine redirect starts result chain"
)
expect(DomainScope.searchEngineDomain(of: "notgoogle.com"), nil as String?, "not a search engine")
expect(
  verdict(
    "https", "example.com", scope: "google.com", searchDomain: "google.com", sourceHost: "www.google.com",
    userGesture: true
  ),
  .allow,
  "clicked result stays in app"
)
expect(
  verdict("https", "example.com", scope: "google.com", searchDomain: "google.com", sourceHost: "google.com"),
  .popup,
  "scripted search navigation stays pinned"
)
expect(
  verdict("https", "final.example", scope: "tracker.example", navigationPending: true),
  .allow,
  "redirect chain from an in-app link stays in the view"
)
expect(
  verdict("https", "other.example", scope: "example.com", userGesture: true),
  .allow,
  "clicked link from an unfavorited site stays in app"
)
expect(
  verdict("https", "other.example", scope: "example.com", userGesture: true, sourceFavorite: true),
  .popup,
  "clicked link from favorite site opens outside"
)
expect(
  verdict("https", "evil.io", scope: "example.com", searchDomain: "google.com", sourceHost: "example.com"),
  .popup,
  "scripted cross-site navigation stays outside"
)
expect(
  verdict(
    "https", "example.com", scope: "google.com", searchDomain: "google.com",
    sourceHost: "www.google.com", userGesture: true, sourceFavorite: true
  ),
  .popup,
  "favorited search engine uses external link policy"
)

// The vectors every platform passes: the official Public Suffix List tests and the app's own.
// The first argument is the directory holding them (shared/public-suffix).
if CommandLine.arguments.count > 1 {
  let directory = URL(fileURLWithPath: CommandLine.arguments[1])
  for file in ["vectors.json", "app-vectors.json"] {
    guard let data = try? Data(contentsOf: directory.appendingPathComponent(file)),
      let vectors = try? JSONSerialization.jsonObject(with: data) as? [[Any]], !vectors.isEmpty
    else {
      print("FAIL \(file): cannot read the vectors")
      failures += 1
      continue
    }
    for pair in vectors {
      let host = pair[0] as? String ?? ""
      let expected = pair[1] as? String
      expect(PublicSuffix.shared.registrableDomain(of: host), expected, "\(file): \(host)")
    }
  }
}

if failures > 0 {
  print("\(failures) failed")
  exit(1)
}
print("DomainScope: all checks passed")
