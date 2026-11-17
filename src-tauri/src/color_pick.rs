//! The color picker: a transparent layer on the page that reads the color under the next tap.
//!
//! The scripts run through the plugin's Rust-only `evaluate`, so the page is never handed a
//! channel to the app. What comes back is hostile page data: [`parse_reading`] accepts only a
//! status word and a `#rrggbb` color, and anything else reads as "no pick".

use serde::Serialize;
use serde_json::Value;

/// Installs the layer. Replaces one that is already waiting.
pub const START_SCRIPT: &str = include_str!("color_pick.js");

/// Asks the page what the layer found.
pub const READ_SCRIPT: &str = "(function(){var s=window[Symbol.for('openmedia.colorPick')];return s?{status:s.status,hex:s.hex}:null})()";

/// Takes the layer down without a pick.
pub const CANCEL_SCRIPT: &str = "(function(){var s=window[Symbol.for('openmedia.colorPick')];if(s&&s.stop)s.stop();return 1})()";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Reading {
    /// No layer on the page: never started, or the page navigated away.
    Idle,
    /// Waiting for a tap.
    Waiting,
    /// The user tapped; `hex` is `#rrggbb`, lowercase.
    Done {
        hex: String,
    },
    Cancelled,
}

fn is_hex(text: &str) -> bool {
    text.len() == 7
        && text.starts_with('#')
        && text[1..]
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Reads the JSON the read script returned. Anything unexpected is [`Reading::Idle`].
pub fn parse_reading(json: &str) -> Reading {
    let Ok(Value::Object(map)) = serde_json::from_str::<Value>(json) else {
        return Reading::Idle;
    };
    match map.get("status").and_then(Value::as_str) {
        Some("waiting") => Reading::Waiting,
        Some("cancelled") => Reading::Cancelled,
        Some("done") => match map.get("hex").and_then(Value::as_str) {
            Some(hex) if is_hex(hex) => Reading::Done {
                hex: hex.to_owned(),
            },
            _ => Reading::Idle,
        },
        _ => Reading::Idle,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_finished_pick_carries_its_color() {
        assert_eq!(
            parse_reading(r##"{"status":"done","hex":"#1a2b3c"}"##),
            Reading::Done {
                hex: "#1a2b3c".into()
            }
        );
    }

    #[test]
    fn the_other_states_read_as_themselves() {
        assert_eq!(
            parse_reading(r#"{"status":"waiting","hex":null}"#),
            Reading::Waiting
        );
        assert_eq!(
            parse_reading(r#"{"status":"cancelled","hex":null}"#),
            Reading::Cancelled
        );
        assert_eq!(parse_reading("null"), Reading::Idle);
    }

    #[test]
    fn a_page_cannot_smuggle_anything_but_a_color_through() {
        for bad in [
            r##"{"status":"done","hex":"#1A2B3C"}"##,
            r##"{"status":"done","hex":"#12345"}"##,
            r##"{"status":"done","hex":"red"}"##,
            r##"{"status":"done","hex":"#12345é"}"##,
            r#"{"status":"done"}"#,
            r##"{"status":"other","hex":"#000000"}"##,
            "not json",
        ] {
            assert_eq!(parse_reading(bad), Reading::Idle, "{bad}");
        }
    }
}
