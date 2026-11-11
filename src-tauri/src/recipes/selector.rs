use std::collections::BTreeMap;

use crate::error::{Error, Result};

const MAX_SELECTOR_CHARS: usize = 300;
const MAX_UNION: usize = 20;
const MAX_HAS: usize = 2;
const MAX_VALUE_CHARS: usize = 60;
pub(crate) const CSS_PROPERTIES: [&str; 14] = [
    "display",
    "visibility",
    "opacity",
    "overflow",
    "overflow-x",
    "overflow-y",
    "position",
    "pointer-events",
    "filter",
    "height",
    "max-height",
    "min-height",
    "touch-action",
    "backdrop-filter",
];

fn invalid(what: &str, value: &str) -> Error {
    Error::Recipe(format!("{what} is not allowed: {value}"))
}
/// Whether a selector picks the page root or every element under it (`body`, `html > body`,
/// `body:not(.x)`, `:is(body)`, `html *`), which would hide or restyle the whole page. A comma
/// list is global when any part is.
pub(crate) fn targets_page_root(selector: &str) -> bool {
    split_top_level(selector, |c| c == ',')
        .into_iter()
        .any(is_root_part)
}

fn is_root_part(part: &str) -> bool {
    let lowered = part.trim().to_ascii_lowercase().replace('\'', "\"");
    let stripped = strip_not_groups(&lowered);
    let compounds: Vec<&str> = split_top_level(&stripped, |c| {
        c.is_whitespace() || matches!(c, '>' | '+' | '~')
    })
    .into_iter()
    .filter(|compound| !compound.is_empty())
    .collect();
    let Some((last, ancestors)) = compounds.split_last() else {
        return false;
    };
    ancestors.iter().all(|compound| is_root_name(compound)) && is_root_compound(last)
}

fn is_root_name(compound: &str) -> bool {
    matches!(compound, "html" | "body" | ":root")
}

fn is_root_compound(compound: &str) -> bool {
    if is_root_name(compound)
        || matches!(compound, "*" | "main" | "[role=main]" | "[role=\"main\"]")
    {
        return true;
    }
    let inner = compound
        .strip_prefix(":is(")
        .or_else(|| compound.strip_prefix(":where("))
        .and_then(|rest| rest.strip_suffix(')'));
    inner.is_some_and(|inner| {
        let parts = split_top_level(inner, |c| c == ',');
        !parts.is_empty() && parts.into_iter().all(is_root_part)
    })
}

/// Splits at characters accepted by `is_separator`, outside parentheses, brackets and quotes.
fn split_top_level(text: &str, is_separator: impl Fn(char) -> bool) -> Vec<&str> {
    let (mut depth, mut quote, mut start) = (0_i32, None::<char>, 0);
    let mut parts = Vec::new();
    for (index, c) in text.char_indices() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), _) => {}
            (None, '"' | '\'') => quote = Some(c),
            (None, '(' | '[') => depth += 1,
            (None, ')' | ']') => depth -= 1,
            (None, c) if is_separator(c) && depth == 0 => {
                parts.push(&text[start..index]);
                start = index + c.len_utf8();
            }
            _ => {}
        }
    }
    parts.push(&text[start..]);
    parts
}

/// Removes every `:not(...)` group, so `body:not(.x)` reads as `body`.
fn strip_not_groups(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find(":not(") {
        out.push_str(&rest[..at]);
        let mut depth = 0_i32;
        let mut end = rest.len();
        for (index, c) in rest[at..].char_indices() {
            match c {
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        end = at + index + 1;
                        break;
                    }
                }
                _ => {}
            }
        }
        rest = &rest[end..];
    }
    out.push_str(rest);
    out
}

/// A deliberately small safe subset: enough for real selectors, nothing that can open a
/// declaration block, start an at-rule, or reference a URL.
pub fn validate_selector(selector: &str) -> Result<()> {
    let bad_char = |c: char| c.is_control() || "{};\\<`@".contains(c);
    if selector.trim().is_empty()
        || selector.chars().count() > MAX_SELECTOR_CHARS
        || selector.chars().any(bad_char)
        || selector.contains("/*")
        || selector.matches(',').count() >= MAX_UNION
        || selector.to_ascii_lowercase().matches(":has(").count() > MAX_HAS
    {
        return Err(invalid("selector", selector));
    }
    let (mut square, mut round, mut quote) = (0_i32, 0_i32, None::<char>);
    for c in selector.chars() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), _) => {}
            (None, '"' | '\'') => quote = Some(c),
            (None, '[') => square += 1,
            (None, ']') => square -= 1,
            (None, '(') => round += 1,
            (None, ')') => round -= 1,
            _ => {}
        }
        if square < 0 || round < 0 {
            return Err(invalid("selector", selector));
        }
    }
    if square != 0 || round != 0 || quote.is_some() {
        return Err(invalid("selector", selector));
    }
    Ok(())
}

pub fn validate_declarations(declarations: &BTreeMap<String, String>) -> Result<()> {
    if declarations.is_empty() {
        return Err(Error::Recipe("a css rule needs declarations".into()));
    }
    for (property, value) in declarations {
        let lowered = value.to_ascii_lowercase();
        let safe_value = !value.trim().is_empty()
            && value.chars().count() <= MAX_VALUE_CHARS
            && value
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || " .,%#()-".contains(c))
            && !lowered.contains("url(")
            && !lowered.contains("expression");
        if !CSS_PROPERTIES.contains(&property.as_str()) {
            return Err(invalid("css property", property));
        }
        if !safe_value {
            return Err(invalid("css value", value));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn real_selectors_pass() {
        for s in [
            "#open-app-header-cta",
            "configured-xpromo-modal, .configured-xpromo",
            "a[href^=\"/reels\"]",
            "nav > a:has([aria-label=\"Reels\"])",
        ] {
            assert!(validate_selector(s).is_ok(), "{s}");
        }
    }

    #[test]
    fn selectors_that_could_escape_the_rule_are_refused() {
        for s in [
            "a{color:red}",
            "a; b",
            "@import 'x'",
            "a /* c */",
            "a[",
            "a)",
            "a[b=\"c]",
            "",
            "a:has(b):has(c):has(d)",
        ] {
            assert!(validate_selector(s).is_err(), "{s}");
        }
    }

    #[test]
    fn only_whitelisted_declarations_pass() {
        let ok = BTreeMap::from([("overflow-y".to_string(), "auto".to_string())]);
        assert!(validate_declarations(&ok).is_ok());
        for (p, v) in [
            ("background", "red"),
            ("overflow-y", "url(x)"),
            ("display", "none; color: red"),
            ("filter", "expression(1)"),
        ] {
            let bad = BTreeMap::from([(p.to_string(), v.to_string())]);
            assert!(validate_declarations(&bad).is_err(), "{p}: {v}");
        }
        assert!(validate_declarations(&BTreeMap::new()).is_err());
    }
    #[test]
    fn selectors_that_pick_the_page_root_are_recognised_in_every_disguise() {
        for s in [
            "body",
            "html > body",
            "body:not(#never-here)",
            ":is(body)",
            ":where(html, body)",
            "html *",
            "body > *",
            "*:not(.x)",
            "a, body",
            "BODY",
        ] {
            assert!(targets_page_root(s), "{s}");
        }
        for s in [
            "body .promo",
            "main > .banner",
            "a:not(.x)",
            "div *",
            "[data-testid=\"body\"]",
            ".body",
        ] {
            assert!(!targets_page_root(s), "{s}");
        }
    }

    #[test]
    fn the_has_cap_ignores_case() {
        assert!(validate_selector("a:HAS(b):HAS(c):HAS(d)").is_err());
    }
}
