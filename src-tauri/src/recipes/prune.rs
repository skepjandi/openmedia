//! The `prune` rule: removes items from the JSON a page's own same-origin `fetch` and
//! `XMLHttpRequest` calls receive, before the page's code reads them. Everything here is data
//! and a closed grammar; the runtime that applies it is `prune_runtime.js`.

use serde::{Deserialize, Serialize};

use super::share::is_plain_text;
use crate::error::{Error, Result};

pub const MAX_PRUNE_RULES: usize = 8;
const MAX_URLS: usize = 8;
const MAX_REMOVES: usize = 8;
const MAX_URL_CHARS: usize = 120;
const MAX_URL_WILDCARDS: usize = 4;
const MAX_PATH_CHARS: usize = 120;
const MAX_STEPS: usize = 10;
const MAX_KEY_CHARS: usize = 40;
const MAX_INDEX: u32 = 9_999;
const MAX_TEXT_CHARS: usize = 80;
/// The wildcard step of a compiled path. Keys cannot contain `*`, so it never clashes with one.
const ANY: &str = "*";
/// Keys that could reach an object's prototype; a path never names them.
const FORBIDDEN_KEYS: [&str; 3] = ["__proto__", "constructor", "prototype"];

/// The value a `when` condition compares to: a scalar, never an object or a pattern.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PruneScalar {
    Bool(bool),
    Number(serde_json::Number),
    Text(String),
}

/// Applies a removal only to values that are objects holding `key` equal to `equals`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PruneWhen {
    pub key: String,
    pub equals: PruneScalar,
}

/// One removal: the value `path` reaches is deleted from its array or object, when `when` holds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PruneRemove {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when: Option<PruneWhen>,
}

/// One step of a parsed path: a key (the wildcard is the key `*`) or an array index.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum Step {
    Key(String),
    Index(u32),
}

/// A removal as the page's runtime reads it.
#[derive(Debug, Serialize)]
pub struct PageRemove {
    steps: Vec<Step>,
    when: Option<PruneWhen>,
}

/// A `prune` rule as the page's runtime reads it: path regexes for the request URL and removals.
#[derive(Debug, Serialize)]
pub struct PagePrune {
    urls: Vec<String>,
    remove: Vec<PageRemove>,
}

/// The runtime of the `prune` rules, embedded only in a page script that has some.
pub const PRUNE_RUNTIME: &str = include_str!("../prune_runtime.js");

/// A path is dot-separated keys, each optionally followed by `[*]` or `[n]` selectors; a path
/// may also start with a selector (a response that is an array). `data.items[*]` reaches every
/// element of `data.items`; `[*].node.tags[0]` the first tag of every element's node.
pub fn parse_path(path: &str) -> Option<Vec<Step>> {
    if path.is_empty() || path.chars().count() > MAX_PATH_CHARS {
        return None;
    }
    let mut steps = Vec::new();
    let mut rest = path;
    let mut after_key_or_selector = false;
    while !rest.is_empty() {
        if let Some(selector) = rest.strip_prefix('[') {
            let (inside, tail) = selector.split_once(']')?;
            steps.push(if inside == ANY {
                Step::Key(ANY.to_owned())
            } else {
                let digits = !inside.is_empty()
                    && inside.len() <= 4
                    && inside.chars().all(|c| c.is_ascii_digit());
                let index: u32 = inside.parse().ok().filter(|n| digits && *n <= MAX_INDEX)?;
                Step::Index(index)
            });
            rest = tail;
            after_key_or_selector = true;
            continue;
        }
        let key_start = if let Some(tail) = rest.strip_prefix('.') {
            if !after_key_or_selector {
                return None;
            }
            rest = tail;
            true
        } else {
            !after_key_or_selector
        };
        if !key_start {
            return None;
        }
        let end = rest.find(['.', '[']).unwrap_or(rest.len());
        let key = &rest[..end];
        if !is_key(key) {
            return None;
        }
        steps.push(Step::Key(key.to_owned()));
        rest = &rest[end..];
        after_key_or_selector = true;
    }
    (!steps.is_empty() && steps.len() <= MAX_STEPS).then_some(steps)
}

fn is_key(key: &str) -> bool {
    !key.is_empty()
        && key.chars().count() <= MAX_KEY_CHARS
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '$' | '-'))
        && !FORBIDDEN_KEYS.contains(&key)
}

/// A request path on the page's own origin: `/`, ASCII only, no query or fragment, `*` for any
/// run of characters. A host cannot be written, so a rule can never name another origin.
fn is_path_pattern(url: &str) -> bool {
    url.starts_with('/')
        && !url.starts_with("//")
        && url.chars().count() <= MAX_URL_CHARS
        && url.matches('*').count() <= MAX_URL_WILDCARDS
        && url
            .chars()
            .all(|c| c.is_ascii_graphic() && !matches!(c, '\\' | '?' | '#'))
}

fn path_regex(pattern: &str) -> String {
    format!(
        "^{}$",
        pattern
            .split('*')
            .map(regex::escape)
            .collect::<Vec<_>>()
            .join(".*")
    )
}

fn is_plain_scalar(scalar: &PruneScalar) -> bool {
    match scalar {
        PruneScalar::Text(text) => {
            text.chars().count() <= MAX_TEXT_CHARS && is_plain_text(text, MAX_TEXT_CHARS)
        }
        PruneScalar::Bool(_) | PruneScalar::Number(_) => true,
    }
}

/// Checks a `prune` rule's patterns and removals against the closed grammar and the caps.
pub fn validate(id: &str, urls: &[String], remove: &[PruneRemove]) -> Result<()> {
    let refuse = |reason: &str| Error::Recipe(format!("prune rule {id} {reason}"));
    if urls.is_empty() || urls.len() > MAX_URLS {
        return Err(refuse("needs 1 to 8 request paths"));
    }
    if urls.iter().any(|url| !is_path_pattern(url)) {
        return Err(refuse(
            "may only name paths of the page's own site: start with /, no host, query or fragment, at most 4 *",
        ));
    }
    if remove.is_empty() || remove.len() > MAX_REMOVES {
        return Err(refuse("needs 1 to 8 removals"));
    }
    for entry in remove {
        if parse_path(&entry.path).is_none() {
            return Err(refuse(
                "has a path outside the grammar: keys, [*] and [n], dot separated, 10 steps at most",
            ));
        }
        if let Some(when) = &entry.when
            && (!is_key(&when.key) || !is_plain_scalar(&when.equals))
        {
            return Err(refuse(
                "has a condition that is not a key and a plain value",
            ));
        }
    }
    Ok(())
}

/// The rule as the page's runtime reads it. Only called on validated rules.
pub fn page_rule(urls: &[String], remove: &[PruneRemove]) -> PagePrune {
    PagePrune {
        urls: urls.iter().map(|url| path_regex(url)).collect(),
        remove: remove
            .iter()
            .filter_map(|entry| {
                Some(PageRemove {
                    steps: parse_path(&entry.path)?,
                    when: entry.when.clone(),
                })
            })
            .collect(),
    }
}
/// The removals as one line of plain text for the review screen.
pub fn describe(remove: &[PruneRemove]) -> String {
    remove
        .iter()
        .map(|entry| match &entry.when {
            None => entry.path.clone(),
            Some(PruneWhen { key, equals }) => {
                let value = match equals {
                    PruneScalar::Bool(flag) => flag.to_string(),
                    PruneScalar::Number(number) => number.to_string(),
                    PruneScalar::Text(text) => format!("\"{text}\""),
                };
                format!("{} where {key} = {value}", entry.path)
            }
        })
        .collect::<Vec<_>>()
        .join("; ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(name: &str) -> Step {
        Step::Key(name.to_owned())
    }

    #[test]
    fn paths_follow_the_small_grammar() {
        assert_eq!(
            parse_path("data.items[*]"),
            Some(vec![key("data"), key("items"), key("*")])
        );
        assert_eq!(
            parse_path("[*].node.tags[0]"),
            Some(vec![key("*"), key("node"), key("tags"), Step::Index(0)])
        );
        assert_eq!(parse_path("items"), Some(vec![key("items")]));
        assert_eq!(
            parse_path("a[0][1]"),
            Some(vec![key("a"), Step::Index(0), Step::Index(1)])
        );
    }

    #[test]
    fn paths_outside_the_grammar_are_refused() {
        for path in [
            "",
            ".a",
            "a.",
            "a..b",
            "a[",
            "a[]",
            "a[x]",
            "a[-1]",
            "a[1:2]",
            "a[?(@.x)]",
            "a[*]b",
            "a b",
            "a.__proto__.b",
            "constructor",
            "a[10000]",
            "a[*",
            "$..a",
            "a.b\n",
            "a\u{200b}",
            "a.b.c.d.e.f.g.h.i.j.k",
        ] {
            assert_eq!(parse_path(path), None, "{path:?}");
        }
    }

    fn remove(path: &str) -> PruneRemove {
        PruneRemove {
            path: path.to_owned(),
            when: None,
        }
    }

    fn urls(list: &[&str]) -> Vec<String> {
        list.iter().map(|url| (*url).to_owned()).collect()
    }

    #[test]
    fn only_paths_of_the_pages_own_site_are_accepted() {
        let ok = |url: &str| validate("p", &urls(&[url]), &[remove("a")]).is_ok();
        assert!(ok("/api/v1/feed/*"));
        assert!(ok("/graphql"));
        for url in [
            "https://other.example/api",
            "//other.example/api",
            "api/feed",
            "/a?b=1",
            "/a#b",
            "/a\\b",
            "/a b",
            "/a\n",
            "/ä",
            "/*/*/*/*/*",
            "",
        ] {
            assert!(!ok(url), "{url:?}");
        }
    }

    #[test]
    fn counts_and_conditions_are_capped() {
        assert!(validate("p", &[], &[remove("a")]).is_err());
        assert!(validate("p", &urls(&["/a"]), &[]).is_err());
        assert!(validate("p", &vec!["/a".to_owned(); 9], &[remove("a")]).is_err());
        assert!(validate("p", &urls(&["/a"]), &vec![remove("a"); 9]).is_err());
        let when = |key: &str, equals: PruneScalar| PruneRemove {
            path: "items[*]".to_owned(),
            when: Some(PruneWhen {
                key: key.to_owned(),
                equals,
            }),
        };
        let ok = |entry: PruneRemove| validate("p", &urls(&["/a"]), &[entry]).is_ok();
        assert!(ok(when("media_type", PruneScalar::Text("reel".into()))));
        assert!(!ok(when("a.b", PruneScalar::Bool(true))));
        assert!(!ok(when("__proto__", PruneScalar::Bool(true))));
        assert!(!ok(when("k", PruneScalar::Text("a\u{7}b".into()))));
        assert!(!ok(when("k", PruneScalar::Text("x".repeat(81)))));
    }

    #[test]
    fn a_rule_reaches_the_page_as_regexes_and_steps() {
        let rule = page_rule(&urls(&["/api/*/feed"]), &[remove("data.items[*]")]);
        let json = serde_json::to_string(&rule).unwrap();
        assert_eq!(
            json,
            r#"{"urls":["^/api/.*/feed$"],"remove":[{"steps":["data","items","*"],"when":null}]}"#
        );
    }
}
