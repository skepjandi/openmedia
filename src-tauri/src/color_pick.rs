//! The color picker: a draggable loupe on the page whose center reads the color under it until the user accepts.
//!
//! The scripts run through the plugin's Rust-only `evaluate`, so the page is never handed a
//! channel to the app. What comes back is hostile page data: [`parse_page_reading`] accepts only
//! a status word, a `#rrggbb` color and the loupe's position as two finite numbers, and anything
//! else reads as "no pick". The page can only guess a color from the DOM; where the web view can
//! show the real pixel (the plugin's Rust-only `sample_color`), that value replaces the page's
//! and is pushed back with [`set_hex_script`], which is built from a validated color alone.

use serde::Serialize;
use serde_json::{Map, Value};
use tauri_plugin_siteview::validate::is_color_hex;

/// Installs the layer. Replaces one that is already waiting.
pub const START_SCRIPT: &str = include_str!("color_pick.js");

/// Asks the page what the layer found and where the loupe's center is.
pub const READ_SCRIPT: &str = "(function(){var s=window[Symbol.for('openmedia.colorPick')];return s?{status:s.status,hex:s.hex,x:s.x,y:s.y}:null})()";

/// Ends the pick on the color the loupe last read, and returns what [`READ_SCRIPT`] would.
pub const ACCEPT_SCRIPT: &str = "(function(){var s=window[Symbol.for('openmedia.colorPick')];if(!s)return null;if(s.accept)s.accept();return{status:s.status,hex:s.hex,x:s.x,y:s.y}})()";

/// Takes the layer down without a pick.
pub const CANCEL_SCRIPT: &str = "(function(){var s=window[Symbol.for('openmedia.colorPick')];if(s&&s.stop)s.stop();return 1})()";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Reading {
    /// No layer on the page: never started, or the page navigated away.
    Idle,
    /// The loupe is up; `hex` is the color under its center, `#rrggbb` lowercase, once read.
    Waiting {
        hex: Option<String>,
    },
    /// The user accepted; `hex` is `#rrggbb`, lowercase.
    Done {
        hex: String,
    },
    Cancelled,
}

impl Reading {
    /// The same reading with `hex` as its color. Idle and cancelled carry none and stay as they are.
    pub fn with_hex(self, hex: &str) -> Self {
        match self {
            Self::Waiting { .. } => Self::Waiting {
                hex: Some(hex.to_owned()),
            },
            Self::Done { .. } => Self::Done {
                hex: hex.to_owned(),
            },
            other => other,
        }
    }

    fn hex(&self) -> Option<&str> {
        match self {
            Self::Waiting { hex } => hex.as_deref(),
            Self::Done { hex } => Some(hex),
            Self::Idle | Self::Cancelled => None,
        }
    }

    /// Whether `hex` is a color this reading does not already have.
    pub fn differs_from(&self, hex: &str) -> bool {
        self.hex() != Some(hex)
    }
}

/// What the page reported: the reading for the shell, and where the loupe's center is in the
/// viewport (CSS pixels) while there is a pick to read a pixel for.
#[derive(Debug, Clone, PartialEq)]
pub struct PageReading {
    pub reading: Reading,
    pub point: Option<(f64, f64)>,
}

fn point_of(map: &Map<String, Value>) -> Option<(f64, f64)> {
    let x = map.get("x")?.as_f64().filter(|x| x.is_finite())?;
    let y = map.get("y")?.as_f64().filter(|y| y.is_finite())?;
    Some((x, y))
}

/// Reads the JSON the read script returned. Anything unexpected is [`Reading::Idle`].
pub fn parse_page_reading(json: &str) -> PageReading {
    let idle = PageReading {
        reading: Reading::Idle,
        point: None,
    };
    let Ok(Value::Object(map)) = serde_json::from_str::<Value>(json) else {
        return idle;
    };
    let hex = map
        .get("hex")
        .and_then(Value::as_str)
        .filter(|h| is_color_hex(h));
    let reading = match map.get("status").and_then(Value::as_str) {
        Some("waiting") => Reading::Waiting {
            hex: hex.map(str::to_owned),
        },
        Some("cancelled") => Reading::Cancelled,
        Some("done") => match hex {
            Some(hex) => Reading::Done {
                hex: hex.to_owned(),
            },
            None => Reading::Idle,
        },
        _ => Reading::Idle,
    };
    let point = match reading {
        Reading::Waiting { .. } | Reading::Done { .. } => point_of(&map),
        Reading::Idle | Reading::Cancelled => None,
    };
    PageReading { reading, point }
}

/// The script that hands the loupe the color read natively, or `None` unless `hex` is exactly
/// `#rrggbb` lowercase: nothing the page said ever reaches the script text.
pub fn set_hex_script(hex: &str) -> Option<String> {
    is_color_hex(hex).then(|| {
        format!(
            "(function(){{var s=window[Symbol.for('openmedia.colorPick')];if(s&&s.setHex)s.setHex('{hex}');return 1}})()"
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reading(json: &str) -> Reading {
        parse_page_reading(json).reading
    }

    #[test]
    fn a_finished_pick_carries_its_color() {
        assert_eq!(
            reading(r##"{"status":"done","hex":"#1a2b3c"}"##),
            Reading::Done {
                hex: "#1a2b3c".into()
            }
        );
    }

    #[test]
    fn the_other_states_read_as_themselves() {
        assert_eq!(
            reading(r#"{"status":"waiting","hex":null}"#),
            Reading::Waiting { hex: None }
        );
        assert_eq!(
            reading(r#"{"status":"cancelled","hex":null}"#),
            Reading::Cancelled
        );
        assert_eq!(reading("null"), Reading::Idle);
    }

    #[test]
    fn a_waiting_pick_carries_the_color_under_the_loupe() {
        assert_eq!(
            reading(r##"{"status":"waiting","hex":"#1a2b3c"}"##),
            Reading::Waiting {
                hex: Some("#1a2b3c".into())
            }
        );
    }

    #[test]
    fn a_waiting_pick_with_a_bad_color_reads_as_waiting_without_one() {
        for bad in [
            r##"{"status":"waiting","hex":"#1A2B3C"}"##,
            r##"{"status":"waiting","hex":"red"}"##,
            r#"{"status":"waiting","hex":7}"#,
            r#"{"status":"waiting"}"#,
        ] {
            assert_eq!(reading(bad), Reading::Waiting { hex: None }, "{bad}");
        }
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
            assert_eq!(reading(bad), Reading::Idle, "{bad}");
        }
    }

    #[test]
    fn the_loupe_position_is_two_numbers_while_there_is_a_pick() {
        let waiting =
            parse_page_reading(r##"{"status":"waiting","hex":"#1a2b3c","x":12.5,"y":300}"##);
        assert_eq!(waiting.point, Some((12.5, 300.0)));
        let done = parse_page_reading(r##"{"status":"done","hex":"#1a2b3c","x":1,"y":2}"##);
        assert_eq!(done.point, Some((1.0, 2.0)));
        // the position does not change what the shell sees
        assert_eq!(
            waiting.reading,
            Reading::Waiting {
                hex: Some("#1a2b3c".into())
            }
        );
    }

    #[test]
    fn a_position_that_is_not_two_numbers_is_no_position() {
        for bad in [
            r#"{"status":"waiting","hex":null}"#,
            r#"{"status":"waiting","x":1}"#,
            r#"{"status":"waiting","x":"1","y":2}"#,
            r#"{"status":"waiting","x":null,"y":2}"#,
            r#"{"status":"waiting","x":[1],"y":{"a":2}}"#,
            r#"{"status":"waiting","x":1e999,"y":2}"#,
        ] {
            assert_eq!(parse_page_reading(bad).point, None, "{bad}");
        }
    }

    #[test]
    fn no_position_is_read_without_a_pick() {
        for text in [
            r#"{"status":"cancelled","x":1,"y":2}"#,
            r#"{"status":"other","x":1,"y":2}"#,
            r#"{"status":"done","x":1,"y":2}"#,
            "null",
        ] {
            assert_eq!(parse_page_reading(text).point, None, "{text}");
        }
    }

    #[test]
    fn a_native_color_replaces_the_page_s_only_where_there_is_one() {
        let waiting = Reading::Waiting { hex: None };
        assert!(waiting.differs_from("#010203"));
        assert_eq!(
            waiting.with_hex("#010203"),
            Reading::Waiting {
                hex: Some("#010203".into())
            }
        );
        let done = Reading::Done {
            hex: "#010203".into(),
        };
        assert!(!done.differs_from("#010203"));
        assert_eq!(
            done.with_hex("#0a0b0c"),
            Reading::Done {
                hex: "#0a0b0c".into()
            }
        );
        assert_eq!(Reading::Idle.with_hex("#010203"), Reading::Idle);
        assert_eq!(Reading::Cancelled.with_hex("#010203"), Reading::Cancelled);
    }

    #[test]
    fn the_push_back_script_is_built_from_a_color_only() {
        assert_eq!(
            set_hex_script("#1a2b3c").as_deref(),
            Some(
                "(function(){var s=window[Symbol.for('openmedia.colorPick')];if(s&&s.setHex)s.setHex('#1a2b3c');return 1})()"
            )
        );
        for bad in [
            "#1A2B3C",
            "#12345",
            "#1234567",
            "red",
            "",
            "#12345'",
            "#1a2b3c');alert(1);('",
        ] {
            assert_eq!(set_hex_script(bad), None, "{bad}");
        }
    }
}
