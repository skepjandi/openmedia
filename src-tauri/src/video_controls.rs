//! Controls for the video in view in a full-screen feed: a seek bar with the time left, a speed
//! button, the last speed and sound remembered between videos, looping off, and moving on when a
//! video ends. Each is a choice the user makes in Settings and stays off until made. This module
//! turns the choices into one script that runs in the top frame after the feed player.

use serde::{Deserialize, Serialize};

const PAGE_SCRIPT: &str = include_str!("video_controls.js");

/// What the user switched on. Everything is off until chosen.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VideoControls {
    /// A bar to seek along, with the time left.
    pub seek_bar: bool,
    /// A button that steps through the playback speeds.
    pub speed: bool,
    /// The speed and sound the reader last chose, applied to the next video.
    pub remember: bool,
    /// Stops a video from restarting by itself when it ends.
    pub loop_off: bool,
    /// Scrolls on to the next video when one ends. The page's own buttons are never clicked.
    pub auto_advance: bool,
}

impl VideoControls {
    /// The script for every page. With every choice off it still runs, to take away what an
    /// earlier run left on a page that is already open.
    pub fn page_script(&self) -> String {
        let config = serde_json::to_string(self).unwrap_or_else(|_| "{}".into());
        format!("({PAGE_SCRIPT})({config});")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn everything_is_off_until_chosen() {
        assert_eq!(
            serde_json::to_value(VideoControls::default()).unwrap(),
            serde_json::json!({
                "seekBar": false,
                "speed": false,
                "remember": false,
                "loopOff": false,
                "autoAdvance": false
            })
        );
    }

    #[test]
    fn the_script_calls_the_runtime_with_the_choices() {
        let script = VideoControls {
            speed: true,
            ..VideoControls::default()
        }
        .page_script();
        assert!(script.ends_with(r#"({"seekBar":false,"speed":true,"remember":false,"loopOff":false,"autoAdvance":false});"#));
    }

    #[test]
    fn a_saved_choice_missing_a_field_keeps_it_off() {
        let saved: VideoControls = serde_json::from_str(r#"{"speed":true}"#).unwrap();
        assert!(saved.speed);
        assert!(!saved.auto_advance);
    }
}
