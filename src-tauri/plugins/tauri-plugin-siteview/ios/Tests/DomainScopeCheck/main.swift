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
  userInitiated: Bool = false, signIn: Bool = false
) -> NavigationVerdict {
  DomainScope.verdict(
    scheme: scheme, host: host, scope: scope, settled: settled, isMainFrame: mainFrame,
    userInitiated: userInitiated, signIn: signIn)
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
expect(verdict("https", "evil.io", scope: "instagram.com"), .cancel, "automatic redirect to an unrelated domain is an ad")
expect(verdict("https", "accounts.google.com", scope: "instagram.com", signIn: true), .popup, "sign-in goes to an app window")
expect(verdict("https", "evil.io", scope: "instagram.com", userInitiated: true), .allow, "clicked external link stays in the web view")
expect(verdict("https", "evil.io", scope: "instagram.com", mainFrame: false), .allow, "subframe")
expect(verdict("https", "x.com", scope: "twitter.com", settled: false), .allow, "first-load redirect")
expect(verdict("https", "x.com", scope: "twitter.com"), .cancel, "redirect after the first load")

func signIn(_ url: String) -> Bool {
  let parts = URLComponents(string: url)!
  return DomainScope.looksLikeSignIn(host: parts.host, path: parts.path, query: parts.query)
}
expect(signIn("https://accounts.google.com/o/oauth2/v2/auth?x=1"), true, "google")
expect(signIn("https://appleid.apple.com/auth/authorize?a=b"), true, "apple")
expect(signIn("https://sub.okta.com/app/x"), true, "identity provider subdomain")
expect(signIn("https://idp.example/oauth2/authorize?client_id=1"), true, "oauth path")
expect(signIn("https://idp.example/start?client_id=1&redirect_uri=https%3A%2F%2Fa"), true, "oauth query")
expect(signIn("https://idp.example/x?SAMLRequest=abc"), true, "saml query")
expect(signIn("https://shop.example/login"), true, "login path")
expect(signIn("https://mv.auditsupcast.click/sbx/b/abc?xy=1"), false, "ad network")
expect(signIn("https://unodepurreic.rest/lp/i/df/df.png"), false, "ad landing")
expect(signIn("https://evil.io/author/page"), false, "auth inside a longer word")
expect(signIn("https://notpaypal.com/"), false, "lookalike host")
expect(signIn("https://x.example/?client_id=1"), false, "client_id alone")
expect(verdict("about", nil, scope: "a.com"), .allow, "about:blank")
expect(verdict("javascript", nil, scope: "a.com"), .cancel, "javascript:")
expect(verdict("tel", nil, scope: "a.com"), .cancel, "tel:")
expect(verdict("https", nil, scope: "a.com"), .cancel, "no host")

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
