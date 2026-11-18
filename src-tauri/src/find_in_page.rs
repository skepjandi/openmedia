//! Find in page: search the page in front for text, step through the matches, clear them.
//!
//! The search runs through the plugin's Rust-only `evaluate`, so the page is handed no channel to
//! the app. [`SCRIPT`] only reads the page's text and moves the selection. What comes back is
//! hostile page data: [`parse_result`] accepts two small counts and a flag, and anything else reads
//! as "no matches". The query is the user's own text, embedded as a JSON string, never as code.

use serde::Serialize;
use serde_json::Value;

use crate::error::{Error, Result};

/// The search function. Called with an operation and its argument.
const SCRIPT: &str = include_str!("find_in_page.js");

/// The longest text a search takes, in characters.
pub const MAX_QUERY_CHARS: usize = 200;

/// The most matches the page script counts; past it the answer says so.
const MAX_COUNT: u64 = 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Operation {
    Search,
    Next,
    Previous,
    Clear,
}

impl Operation {
    fn word(self) -> &'static str {
        match self {
            Self::Search => "search",
            Self::Next => "next",
            Self::Previous => "previous",
            Self::Clear => "clear",
        }
    }
}

/// Where the search stands. `index` counts from 1 and is 0 when nothing matches.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FindResult {
    pub count: u32,
    pub index: u32,
    /// True when the page has more matches than the count shows.
    pub capped: bool,
}

/// The query as the page script gets it: trimmed of line breaks, and at most [`MAX_QUERY_CHARS`].
pub fn check_query(query: &str) -> Result<&str> {
    let query = query.trim();
    if query.chars().count() > MAX_QUERY_CHARS || query.chars().any(char::is_control) {
        return Err(Error::Find(MAX_QUERY_CHARS));
    }
    Ok(query)
}

/// The expression to evaluate for `operation`. `query` is used by [`Operation::Search`] only.
pub fn script(operation: Operation, query: &str) -> Result<String> {
    let argument = if operation == Operation::Search {
        check_query(query)?
    } else {
        ""
    };
    let argument = serde_json::to_string(argument).map_err(|_| Error::Find(MAX_QUERY_CHARS))?;
    Ok(format!("({SCRIPT}\n)(\"{}\",{argument})", operation.word()))
}

/// Reads the page's answer. Anything unexpected is "no matches".
pub fn parse_result(json: &str) -> FindResult {
    let Ok(Value::Object(map)) = serde_json::from_str::<Value>(json) else {
        return FindResult::default();
    };
    let number = |key: &str| {
        map.get(key)
            .and_then(Value::as_u64)
            .map_or(0, |n| n.min(MAX_COUNT))
    };
    let count = number("count");
    let index = number("index");
    if index == 0 || index > count {
        return FindResult::default();
    }
    FindResult {
        count: count as u32,
        index: index as u32,
        capped: map.get("capped").and_then(Value::as_bool).unwrap_or(false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_well_formed_answer_is_read() {
        assert_eq!(
            parse_result(r#"{"count":12,"index":3,"capped":false}"#),
            FindResult {
                count: 12,
                index: 3,
                capped: false
            }
        );
        assert!(parse_result(r#"{"count":1000,"index":1,"capped":true}"#).capped);
    }

    #[test]
    fn a_malformed_or_hostile_answer_is_no_matches() {
        for json in [
            "null",
            "[]",
            "\"text\"",
            r#"{"count":-1,"index":1}"#,
            r#"{"count":3,"index":4}"#,
            r#"{"count":3,"index":0}"#,
            r#"{"count":"3","index":"1"}"#,
            "{",
        ] {
            assert_eq!(parse_result(json), FindResult::default(), "{json}");
        }
    }

    #[test]
    fn a_huge_count_is_held_to_the_cap() {
        let result = parse_result(r#"{"count":99999999999,"index":99999999999}"#);
        assert_eq!(result.count, 1000);
        assert_eq!(result.index, 1000);
    }

    #[test]
    fn the_query_travels_as_a_json_string_never_as_code() {
        let text = script(Operation::Search, r#"");alert(1);(""#).unwrap();
        assert!(text.ends_with(r#"("search","\");alert(1);(\"")"#));
        let stepping = script(Operation::Next, "ignored").unwrap();
        assert!(stepping.ends_with(r#"("next","")"#));
    }

    #[test]
    fn the_query_is_short_and_one_line() {
        assert_eq!(check_query("  hello ").unwrap(), "hello");
        assert!(check_query("two\nlines").is_err());
        assert!(check_query(&"x".repeat(MAX_QUERY_CHARS + 1)).is_err());
        assert!(check_query(&"é".repeat(MAX_QUERY_CHARS)).is_ok());
    }
}
