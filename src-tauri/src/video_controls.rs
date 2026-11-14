//! Controls for the video in view in a full-screen feed. A tap on the video shows OpenMedia's own
//! panel (pause, skip 6 seconds, mute, speed, a seek bar with the time left) in place of the
//! site's tap, and the user can switch it off, or move it up or down, for one site. Around it: the
//! last speed and sound remembered between videos, looping off, and moving on when a video ends.
//! This module turns the choices into one script that runs in the top frame after the feed player.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

const PAGE_SCRIPT: &str = include_str!("video_controls.js");

/// Pixels between the panel and the bottom of the page, before the device's safe area.
pub const DEFAULT_HEIGHT: u32 = 16;
/// The highest the panel can be put, and the same cap as the bottom margin.
pub const MAX_HEIGHT: u32 = 200;

fn on() -> bool {
    true
}

fn default_height() -> u32 {
    DEFAULT_HEIGHT
}

/// What the user chose for every site that has no choice of its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VideoControls {
    /// OpenMedia's panel on a tap, in place of the site's own tap. On until switched off.
    pub panel: bool,
    /// Pixels between the panel and the bottom of the page.
    pub height: u32,
    /// The panel on a watch page too, in place of the site's own player controls. Off: those
    /// have more than the panel does (captions, quality, chapters), so they are left alone.
    pub full_videos: bool,
    /// The speed and sound the reader last chose, applied to the next video.
    pub remember: bool,
    /// Stops a video from restarting by itself when it ends.
    pub loop_off: bool,
    /// Scrolls on to the next video when one ends. The page's own buttons are never clicked.
    pub auto_advance: bool,
}

impl Default for VideoControls {
    fn default() -> Self {
        Self {
            panel: on(),
            height: default_height(),
            full_videos: false,
            remember: false,
            loop_off: false,
            auto_advance: false,
        }
    }
}

/// What the user chose for one site (a registrable domain); a missing field follows
/// [`VideoControls`]. A site with nothing chosen has no entry at all.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SiteVideo {
    /// `Some(false)` gives the site its own controls back.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub panel: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub full_videos: Option<bool>,
}

impl SiteVideo {
    pub fn is_empty(&self) -> bool {
        self.panel.is_none() && self.height.is_none() && self.full_videos.is_none()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PageConfig<'a> {
    #[serde(flatten)]
    controls: &'a VideoControls,
    sites: &'a BTreeMap<String, SiteVideo>,
}

impl VideoControls {
    /// The script for every page. The page picks its own site's entry out of `sites`. With the
    /// panel off everywhere it still runs, to take away what an earlier run left on a page that
    /// is already open.
    pub fn page_script(&self, sites: &BTreeMap<String, SiteVideo>) -> String {
        let config = serde_json::to_string(&PageConfig {
            controls: self,
            sites,
        })
        .unwrap_or_else(|_| "{}".into());
        format!("({PAGE_SCRIPT})({config});")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_panel_is_on_until_switched_off_and_the_rest_is_off_until_chosen() {
        assert_eq!(
            serde_json::to_value(VideoControls::default()).unwrap(),
            serde_json::json!({
                "panel": true,
                "height": 16,
                "fullVideos": false,
                "remember": false,
                "loopOff": false,
                "autoAdvance": false
            })
        );
    }

    #[test]
    fn the_script_calls_the_runtime_with_the_choices_and_the_sites() {
        let mut sites = BTreeMap::new();
        sites.insert(
            "youtube.com".to_owned(),
            SiteVideo {
                panel: Some(false),
                height: None,
                full_videos: None,
            },
        );
        let script = VideoControls::default().page_script(&sites);
        assert!(script.ends_with(
            r#"({"panel":true,"height":16,"fullVideos":false,"remember":false,"loopOff":false,"autoAdvance":false,"sites":{"youtube.com":{"panel":false}}});"#
        ));
    }

    #[test]
    fn a_saved_choice_missing_a_field_keeps_its_default() {
        let saved: VideoControls = serde_json::from_str(r#"{"remember":true}"#).unwrap();
        assert!(saved.remember);
        assert!(saved.panel);
        assert_eq!(saved.height, DEFAULT_HEIGHT);
        assert!(!saved.auto_advance);
    }

    #[test]
    fn choices_saved_before_the_panel_existed_load_without_error() {
        let saved: VideoControls =
            serde_json::from_str(r#"{"seekBar":true,"speed":true,"autoAdvance":true}"#).unwrap();
        assert!(saved.panel);
        assert!(saved.auto_advance);
    }

    #[test]
    fn a_site_with_nothing_chosen_is_empty() {
        assert!(SiteVideo::default().is_empty());
        assert!(
            !SiteVideo {
                height: Some(40),
                panel: None,
                full_videos: None
            }
            .is_empty()
        );
    }
}
