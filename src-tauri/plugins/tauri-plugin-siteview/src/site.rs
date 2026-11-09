//! Which site a host belongs to, by the Public Suffix List.
//!
//! The data is `shared/public-suffix/resources/public_suffix_rules.txt`, the same file the TypeScript, Kotlin and Swift
//! matchers read, and all four are tested against the same vectors. Refresh it with
//! `node scripts/public-suffix.mjs update`.

use std::{collections::HashSet, sync::LazyLock};

const RULES: &str =
    include_str!("../../../../shared/public-suffix/resources/public_suffix_rules.txt");
const MAX_LABEL_CHARS: usize = 63;

struct Rules {
    /// `a.b` rules.
    suffixes: HashSet<&'static str>,
    /// The part after `*.` of `*.a.b` rules.
    wildcards: HashSet<&'static str>,
    /// The part after `!` of `!x.a.b` rules.
    exceptions: HashSet<&'static str>,
}

static RULES_PARSED: LazyLock<Rules> = LazyLock::new(|| {
    let mut rules = Rules {
        suffixes: HashSet::new(),
        wildcards: HashSet::new(),
        exceptions: HashSet::new(),
    };
    for line in RULES.lines().filter(|line| !line.is_empty()) {
        if let Some(exception) = line.strip_prefix('!') {
            rules.exceptions.insert(exception);
        } else if let Some(wildcard) = line.strip_prefix("*.") {
            rules.wildcards.insert(wildcard);
        } else {
            rules.suffixes.insert(line);
        }
    }
    rules
});

/// The lowercase host without a trailing dot, when it is a plain ASCII host name with a
/// letter in its last label (so never an IP address).
fn normalize(host: &str) -> Option<String> {
    let host = host.to_ascii_lowercase();
    let host = host.strip_suffix('.').unwrap_or(&host);
    let well_formed = host.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= MAX_LABEL_CHARS
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    });
    let has_letter = host
        .rsplit('.')
        .next()
        .is_some_and(|tld| tld.bytes().any(|b| b.is_ascii_lowercase()));
    (well_formed && has_letter).then(|| host.to_owned())
}

/// How many trailing labels of `labels` form the public suffix.
fn suffix_len(labels: &[&str]) -> usize {
    let rules = &*RULES_PARSED;
    let mut longest = 1;
    for start in 0..labels.len() {
        let candidate = labels[start..].join(".");
        if rules.exceptions.contains(candidate.as_str()) {
            return labels.len() - start - 1;
        }
        let len = labels.len() - start;
        let wildcard_match = start + 1 < labels.len()
            && rules
                .wildcards
                .contains(labels[start + 1..].join(".").as_str());
        if (rules.suffixes.contains(candidate.as_str()) || wildcard_match) && len > longest {
            longest = len;
        }
    }
    longest
}

/// The part of a host a site owns: `m.youtube.com` is `youtube.com`, `news.bbc.co.uk` is
/// `bbc.co.uk` and `bob.github.io` stays `bob.github.io`. `None` for IP addresses, malformed
/// hosts and hosts that are themselves a public suffix (`com`, `github.io`).
pub fn registrable_domain(host: &str) -> Option<String> {
    let host = normalize(host)?;
    let labels: Vec<&str> = host.split('.').collect();
    let suffix = suffix_len(&labels);
    (labels.len() > suffix).then(|| labels[labels.len() - suffix - 1..].join("."))
}

/// True for a host that is itself a public suffix (`github.io`, `com.br`): it names no site, only
/// a place where many sites live.
pub fn is_public_suffix(host: &str) -> bool {
    normalize(host).is_some_and(|host| host.contains('.') && registrable_domain(&host).is_none())
}

/// The site of a host: its registrable domain, or the host itself (lowercased, without a
/// trailing dot) when it has none, as for `localhost` or an IP address.
pub fn site_of_host(host: &str) -> String {
    registrable_domain(host).unwrap_or_else(|| {
        let host = host.to_lowercase();
        host.strip_suffix('.').unwrap_or(&host).to_owned()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(path: &str) {
        let text =
            std::fs::read_to_string(format!("{}/../../../{path}", env!("CARGO_MANIFEST_DIR")))
                .unwrap();
        let vectors: Vec<(String, Option<String>)> = serde_json::from_str(&text).unwrap();
        assert!(!vectors.is_empty());
        for (host, expected) in vectors {
            assert_eq!(registrable_domain(&host), expected, "{host}");
        }
    }

    #[test]
    fn the_official_public_suffix_vectors() {
        check("shared/public-suffix/vectors.json");
    }

    #[test]
    fn the_app_vectors() {
        check("shared/public-suffix/app-vectors.json");
    }

    #[test]
    fn only_a_dotted_public_suffix_is_one() {
        for suffix in ["github.io", "com.br", "co.uk", "co.com"] {
            assert!(is_public_suffix(suffix), "{suffix}");
        }
        for site in [
            "alice.github.io",
            "bbc.co.uk",
            "localhost",
            "192.168.1.20",
            "com",
            "",
        ] {
            assert!(!is_public_suffix(site), "{site}");
        }
    }

    #[test]
    fn a_host_without_a_registrable_part_is_its_own_site() {
        assert_eq!(site_of_host("LocalHost."), "localhost");
        assert_eq!(site_of_host("192.168.1.20"), "192.168.1.20");
        assert_eq!(site_of_host("github.io"), "github.io");
        assert_eq!(site_of_host("www.alice.github.io"), "alice.github.io");
    }
}
