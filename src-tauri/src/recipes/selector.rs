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

/// A deliberately small safe subset: enough for real selectors, nothing that can open a
/// declaration block, start an at-rule, or reference a URL.
pub fn validate_selector(selector: &str) -> Result<()> {
    let bad_char = |c: char| c.is_control() || "{};\\<`@".contains(c);
    if selector.trim().is_empty()
        || selector.chars().count() > MAX_SELECTOR_CHARS
        || selector.chars().any(bad_char)
        || selector.contains("/*")
        || selector.matches(',').count() >= MAX_UNION
        || selector.matches(":has(").count() > MAX_HAS
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
}
