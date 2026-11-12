use regex::Regex;
use serde::Serialize;
use url::Url;

use tauri_plugin_siteview::site::is_public_suffix;

use crate::error::{Error, Result};

/// Each `*` in a path becomes a backtracking `.*` in the regex the page script runs, so a path
/// with many of them can freeze a page; shared recipes are refused above this too.
const MAX_PATH_WILDCARDS: usize = 4;

/// A parsed `match` pattern: scheme, host (optionally `*.` for any subdomain depth, apex
/// included) and a path glob. The regex strings are also what the injected script tests, so Rust
/// and the page agree on what matches.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Matcher {
    pub scheme: String,
    pub host: String,
    pub path: String,
    #[serde(skip)]
    suffix_wide: bool,
}

impl Matcher {
    pub fn parse(pattern: &str) -> Result<Self> {
        let bad = || Error::Recipe(format!("match pattern is malformed: {pattern}"));
        let (scheme, rest) = pattern.split_once("://").ok_or_else(bad)?;
        if !matches!(scheme, "http" | "https" | "*") {
            return Err(bad());
        }
        let (host, path) = rest.split_once('/').map_or((rest, "*"), |(h, p)| (h, p));
        let host = host.to_ascii_lowercase();
        let host = host.as_str();
        let host_ok = !host.is_empty()
            && host
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "-.*".contains(c))
            && (!host.contains('*') || host == "*" || host.starts_with("*."))
            && host.matches('*').count() <= 1;
        let path_ok = path.chars().all(|c| !c.is_control() && !c.is_whitespace())
            && path.matches('*').count() <= MAX_PATH_WILDCARDS;
        if !host_ok || !path_ok {
            return Err(bad());
        }

        let host_regex = match host.strip_prefix("*.") {
            Some(rest) => format!("^(?:[^.]+\\.)*{}$", regex::escape(rest)),
            None if host == "*" => "^.*$".to_owned(),
            None => format!("^{}$", regex::escape(host)),
        };
        let path_regex = format!(
            "^/{}$",
            path.split('*')
                .map(regex::escape)
                .collect::<Vec<_>>()
                .join(".*")
        );
        let suffix_wide = match host.strip_prefix("*.") {
            Some(apex) => !apex.contains('.') || is_public_suffix(apex),
            None => host != "*" && is_public_suffix(host),
        };
        Ok(Self {
            scheme: scheme.to_owned(),
            host: host_regex,
            path: path_regex,
            suffix_wide,
        })
    }

    /// Applies the same regex strings the injected script tests, so Rust and the page agree on
    /// what matches.
    pub fn matches(&self, url: &Url) -> bool {
        let tested =
            |pattern: &str, text: &str| Regex::new(pattern).is_ok_and(|regex| regex.is_match(text));
        (self.scheme == "*" || self.scheme == url.scheme())
            && url.host_str().is_some_and(|host| tested(&self.host, host))
            && tested(&self.path, url.path())
    }

    /// Patterns that cover every site are never acceptable in a recipe.
    pub fn is_broad(&self) -> bool {
        self.host == "^.*$"
    }

    /// A host that is itself a public suffix (`github.io`, `com.br`), or a wildcard over one or
    /// over a bare top-level domain (`*.com`): it names every site living under it.
    pub fn is_suffix_wide(&self) -> bool {
        self.suffix_wide
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn matches(pattern: &str, url: &str) -> bool {
        Matcher::parse(pattern)
            .unwrap()
            .matches(&Url::parse(url).unwrap())
    }

    #[test]
    fn subdomain_wildcard_covers_apex_and_subdomains_only() {
        let p = "https://*.reddit.com/*";
        assert!(matches(p, "https://reddit.com/"));
        assert!(matches(p, "https://www.reddit.com/r/rust/"));
        assert!(matches(p, "https://old.reddit.com/r/rust/comments/1/x/"));
        assert!(!matches(p, "https://notreddit.com/"));
        assert!(!matches(p, "https://reddit.com.evil.example/"));
        assert!(!matches(p, "http://www.reddit.com/"));
    }

    #[test]
    fn path_globs_anchor_both_ends() {
        let p = "https://www.instagram.com/reels/*";
        assert!(matches(p, "https://www.instagram.com/reels/abc"));
        assert!(!matches(p, "https://www.instagram.com/p/reels/abc"));
        assert!(!matches(p, "https://www.instagram.com/reels"));
    }

    #[test]
    fn regex_metacharacters_in_patterns_are_literal() {
        assert!(!matches("https://a.com/x+y", "https://a.com/xxy"));
        assert!(matches("https://a.com/x+y", "https://a.com/x+y"));
    }

    #[test]
    fn malformed_patterns_are_refused() {
        for p in [
            "reddit.com",
            "ftp://a.com/",
            "https://",
            "https://a*b.com/",
            "https://*.*.com/",
        ] {
            assert!(Matcher::parse(p).is_err(), "{p}");
        }
    }

    #[test]
    fn only_all_site_patterns_are_broad() {
        assert!(Matcher::parse("https://*/*").unwrap().is_broad());
        assert!(!Matcher::parse("https://*.reddit.com/*").unwrap().is_broad());
    }
    #[test]
    fn a_path_with_many_wildcards_is_refused_because_the_page_regex_would_backtrack() {
        assert!(Matcher::parse("https://a.com/*a*a*a*a").is_ok());
        assert!(Matcher::parse("https://a.com/*a*a*a*a*b").is_err());
    }

    #[test]
    fn hosts_are_matched_in_lower_case() {
        assert!(matches(
            "https://WWW.Example.com/*",
            "https://www.example.com/x"
        ));
    }

    #[test]
    fn wildcards_over_a_public_suffix_are_suffix_wide() {
        for p in [
            "https://*.com/*",
            "https://*.co.uk/*",
            "https://*.github.io/*",
            "https://github.io/*",
        ] {
            assert!(Matcher::parse(p).unwrap().is_suffix_wide(), "{p}");
        }
        for p in [
            "https://*.reddit.com/*",
            "https://alice.github.io/*",
            "https://localhost/*",
        ] {
            assert!(!Matcher::parse(p).unwrap().is_suffix_wide(), "{p}");
        }
    }
}
