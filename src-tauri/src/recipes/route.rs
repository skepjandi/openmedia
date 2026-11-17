//! The address side of a `redirect` rule: the path glob it guards and the place it sends the page
//! to. The glob is compiled to a regular expression that the page script also tests, so Rust and
//! the page agree on what matches.

use regex::Regex;
use serde::Serialize;
use url::Url;

use crate::error::{Error, Result};

const MAX_GLOB_CHARS: usize = 200;
const MAX_WILDCARDS: usize = 4;
const MAX_TARGET_CHARS: usize = 300;

/// A path glob such as `/reels/**` or `!/watch`. `*` stands for any run of characters inside one
/// path segment, `**` for any run including `/`, and a trailing `/**` also covers the path without
/// it (`/reels/**` matches `/reels`). A leading `!` turns the glob into "every path but these".
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RouteGlob {
    pub regex: String,
    pub negate: bool,
}

impl RouteGlob {
    pub fn parse(glob: &str) -> Result<Self> {
        let bad = || Error::Recipe(format!("path glob is malformed: {glob}"));
        let (negate, body) = match glob.strip_prefix('!') {
            Some(rest) => (true, rest),
            None => (false, glob),
        };
        let plain = body
            .chars()
            .all(|c| c.is_ascii_graphic() && !matches!(c, '\\' | '?' | '#' | '!'));
        if glob.len() > MAX_GLOB_CHARS || !body.starts_with('/') || !plain {
            return Err(bad());
        }
        let (stem, open_ended) = match body.strip_suffix("/**") {
            Some(stem) => (stem, true),
            None => (body, false),
        };
        if stem.contains("***") {
            return Err(bad());
        }
        let mut regex = String::from("^");
        let mut wildcards = usize::from(open_ended);
        let mut rest = stem;
        while let Some(at) = rest.find('*') {
            wildcards += 1;
            regex.push_str(&regex::escape(&rest[..at]));
            if rest[at..].starts_with("**") {
                regex.push_str(".*");
                rest = &rest[at + 2..];
            } else {
                regex.push_str("[^/]*");
                rest = &rest[at + 1..];
            }
        }
        if wildcards > MAX_WILDCARDS {
            return Err(bad());
        }
        regex.push_str(&regex::escape(rest));
        regex.push_str(if open_ended { "(?:/.*)?$" } else { "$" });
        Ok(Self { regex, negate })
    }

    /// Whether the glob selects this path (`pathname`, no query or fragment).
    pub fn selects(&self, path: &str) -> bool {
        Regex::new(&self.regex).is_ok_and(|regex| regex.is_match(path)) != self.negate
    }
}

/// A redirect goes to a path of the same site: it starts with a single `/` and carries no
/// scheme, host, backslash, control character or space, so no address it can form leaves the
/// origin. Its own path must not be one the glob selects, which would send the page in circles.
pub fn validate_target(to: &str, glob: &RouteGlob) -> Result<()> {
    let bad = |reason: &str| Error::Recipe(format!("redirect target {to} {reason}"));
    if to.chars().count() > MAX_TARGET_CHARS
        || !to.starts_with('/')
        || to.starts_with("//")
        || to.contains('\\')
        || to.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return Err(bad("must be a path of the same site"));
    }
    let base = Url::parse("https://origin.invalid").map_err(|e| Error::Recipe(e.to_string()))?;
    let resolved = base.join(to).map_err(|_| bad("is not a valid path"))?;
    if resolved.origin() != base.origin() {
        return Err(bad("must stay on the same site"));
    }
    if glob.selects(resolved.path()) {
        return Err(bad("is itself selected by the rule's own path"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn selects(glob: &str, path: &str) -> bool {
        RouteGlob::parse(glob).unwrap().selects(path)
    }

    #[test]
    fn double_star_crosses_segments_and_the_bare_prefix_is_covered() {
        assert!(selects("/reels/**", "/reels/abc/def"));
        assert!(selects("/reels/**", "/reels/"));
        assert!(selects("/reels/**", "/reels"));
        assert!(!selects("/reels/**", "/reelsx"));
        assert!(!selects("/reels/**", "/p/reels/abc"));
    }

    #[test]
    fn single_star_stays_in_one_segment() {
        assert!(selects("/u/*/shorts", "/u/bob/shorts"));
        assert!(!selects("/u/*/shorts", "/u/bob/x/shorts"));
        assert!(selects("/u/**/shorts", "/u/bob/x/shorts"));
    }

    #[test]
    fn a_literal_path_matches_exactly() {
        assert!(selects("/watch", "/watch"));
        assert!(!selects("/watch", "/watch/1"));
        assert!(selects("/a.b+c", "/a.b+c"));
        assert!(!selects("/a.b+c", "/aXb+c"));
    }

    #[test]
    fn a_leading_bang_negates() {
        assert!(!selects("!/watch", "/watch"));
        assert!(selects("!/watch", "/"));
        assert!(selects("!/app/**", "/login"));
        assert!(!selects("!/app/**", "/app/x"));
    }

    #[test]
    fn malformed_globs_are_refused() {
        for glob in [
            "",
            "reels/**",
            "/a b",
            "/a?x=1",
            "/a#b",
            "/a\\b",
            "/***",
            "/a!b",
            "!!/a",
            "/*/*/*/*/*",
            "/**/**/**/**/**",
            &format!("/{}", "a".repeat(250)),
        ] {
            assert!(RouteGlob::parse(glob).is_err(), "{glob}");
        }
    }

    #[test]
    fn targets_stay_on_the_same_site() {
        let glob = RouteGlob::parse("/shorts/**").unwrap();
        for ok in ["/", "/feed", "/feed?x=1#top"] {
            assert!(validate_target(ok, &glob).is_ok(), "{ok}");
        }
        for bad in [
            "",
            "feed",
            "//evil.example/",
            "/\\evil.example",
            "https://evil.example/",
            "javascript:alert(1)",
            "/a b",
            "/a\nb",
            "/shorts/x",
            "/shorts",
        ] {
            assert!(validate_target(bad, &glob).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_negated_glob_may_send_to_the_path_it_spares() {
        let glob = RouteGlob::parse("!/home").unwrap();
        assert!(validate_target("/home", &glob).is_ok());
        assert!(validate_target("/other", &glob).is_err());
    }
}
