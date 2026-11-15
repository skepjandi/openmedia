//! The page script that cleans links the user follows: tracking query parameters are removed and
//! redirect-tracker addresses are replaced by their destination.
//!
//! The data is Brave's (MPL-2.0): `query-filter` strips parameters everywhere, `clean-urls` only on
//! the sites it lists, `debounce` unwraps redirect trackers. This module validates it, joins it
//! and puts it in front of `openmedia-link-cleaner.js`, which does the matching in the page.
//! Nothing is downloaded at runtime.

use std::sync::LazyLock;

use serde_json::{Value, json};

use crate::error::{Error, Result};

const QUERY_FILTER: &str = include_str!("../../blocklists/brave-query-filter.json");
const CLEAN_URLS: &str = include_str!("../../blocklists/brave-clean-urls.json");
const DEBOUNCE: &str = include_str!("../../blocklists/brave-debounce.json");
const CLEANER: &str = include_str!("../../blocklists/openmedia-link-cleaner.js");

static SCRIPT: LazyLock<std::result::Result<String, String>> =
    LazyLock::new(|| build().map_err(|error| error.to_string()));

/// The script that installs the cleaner, built once.
pub fn script() -> Result<&'static str> {
    SCRIPT
        .as_deref()
        .map_err(|message| Error::AdBlock(message.clone()))
}

fn build() -> Result<String> {
    let mut strip = rules(QUERY_FILTER, "query-filter")?;
    strip.extend(rules(CLEAN_URLS, "clean-urls")?);
    let data = json!({ "strip": strip, "debounce": rules(DEBOUNCE, "debounce")? });
    // `</script>` cannot appear in a string injected as script, but a data string with a line
    // separator could end a literal in old engines; JSON escapes both.
    let data = serde_json::to_string(&data)
        .map_err(|error| Error::AdBlock(format!("link-cleaning data: {error}")))?
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029");
    Ok(format!("window.__openmediaLinkRules={data};\n{CLEANER}"))
}

fn rules(text: &str, name: &str) -> Result<Vec<Value>> {
    let parsed: Value = serde_json::from_str(text)
        .map_err(|error| Error::AdBlock(format!("invalid {name} data: {error}")))?;
    match parsed {
        Value::Array(rules) if !rules.is_empty() => Ok(rules),
        _ => Err(Error::AdBlock(format!("{name} data holds no rules"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_script_carries_every_data_set_in_front_of_the_cleaner() {
        let script = script().expect("bundled data is valid");
        assert!(script.starts_with("window.__openmediaLinkRules={"));
        assert!(script.ends_with(CLEANER));
        let data = script
            .strip_prefix("window.__openmediaLinkRules=")
            .and_then(|rest| rest.split_once(";\n"))
            .map(|(data, _)| data)
            .expect("data comes first");
        let parsed: Value = serde_json::from_str(data).expect("data is JSON");
        let strip = parsed["strip"].as_array().expect("strip rules").len();
        let debounce = parsed["debounce"].as_array().expect("debounce rules").len();
        assert!(strip > 30, "{strip} strip rules");
        assert!(debounce > 30, "{debounce} debounce rules");
    }

    #[test]
    fn malformed_or_empty_data_is_an_error() {
        assert!(matches!(rules("not json", "x"), Err(Error::AdBlock(_))));
        assert!(matches!(rules("[]", "x"), Err(Error::AdBlock(_))));
        assert!(matches!(rules("{}", "x"), Err(Error::AdBlock(_))));
    }
}
