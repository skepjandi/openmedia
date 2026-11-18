//! Controls for the video in view in a full-screen feed. A tap on the video shows OpenMedia's own
//! panel (pause, skip back and forward, mute, speed, a seek bar with the time left) in place of the
//! site's tap, and the user can switch it off, or move it up or down, for one site. Around it: the
//! last speed and sound remembered between videos, looping off, and moving on when a video ends.
//! This module turns the choices into one script that runs in the top frame after the feed player.

use std::collections::BTreeMap;

use serde::{Deserialize, Deserializer, Serialize};

const PAGE_SCRIPT: &str = include_str!("video_controls.js");
/// The detectors for players built with a common library, spliced into the page script.
const DETECTORS: &str = include_str!("video_detectors.js");
const DETECTORS_MARKER: &str = "/*@DETECTORS@*/";

/// Pixels between the panel and the bottom of the page, before the device's safe area.
pub const DEFAULT_HEIGHT: u32 = 16;
/// The highest the panel can be put, and the same cap as the bottom margin.
pub const MAX_HEIGHT: u32 = 200;

/// The seconds the skip buttons and a double tap can jump by.
pub const SKIP_CHOICES: [u32; 4] = [5, 10, 15, 30];
pub const DEFAULT_SKIP: u32 = 10;

fn on() -> bool {
    true
}

fn default_height() -> u32 {
    DEFAULT_HEIGHT
}

fn default_skip() -> u32 {
    DEFAULT_SKIP
}

/// The allowed skip nearest to `seconds`; halfway between two, the shorter one.
fn nearest_skip(seconds: u32) -> u32 {
    SKIP_CHOICES
        .into_iter()
        .min_by_key(|choice| choice.abs_diff(seconds))
        .unwrap_or(DEFAULT_SKIP)
}

/// Reads a skip and snaps it to an allowed value, so a stray number never reaches the page.
fn read_skip<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u32, D::Error> {
    u32::deserialize(deserializer).map(nearest_skip)
}

fn read_site_skip<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<u32>, D::Error> {
    Option::<u32>::deserialize(deserializer).map(|skip| skip.map(nearest_skip))
}

/// What the user chose for every site that has no choice of its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VideoControls {
    /// OpenMedia's panel on a tap, in place of the site's own tap. On until switched off.
    pub panel: bool,
    /// Pixels between the panel and the bottom of the page.
    pub height: u32,
    /// Seconds the back and forward buttons, and a double tap on either side, jump: 5, 10, 15 or 30.
    #[serde(deserialize_with = "read_skip")]
    pub skip: u32,
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
            skip: default_skip(),
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
    #[serde(
        skip_serializing_if = "Option::is_none",
        deserialize_with = "read_site_skip"
    )]
    pub skip: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub full_videos: Option<bool>,
    /// The speed and sound last chosen, applied to the next video.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remember: Option<bool>,
    /// Stops a video from restarting by itself when it ends.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub loop_off: Option<bool>,
    /// Scrolls on to the next video when one ends.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_advance: Option<bool>,
}

impl SiteVideo {
    pub fn is_empty(&self) -> bool {
        self.panel.is_none()
            && self.height.is_none()
            && self.skip.is_none()
            && self.full_videos.is_none()
            && self.remember.is_none()
            && self.loop_off.is_none()
            && self.auto_advance.is_none()
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
        let script = PAGE_SCRIPT.replace(DETECTORS_MARKER, DETECTORS);
        format!("({script})({config});")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_detectors_are_spliced_in_and_the_marker_is_gone() {
        let script = VideoControls::default().page_script(&BTreeMap::new());
        assert!(script.contains("function libraryGroups("));
        assert!(!script.contains(DETECTORS_MARKER));
    }

    #[test]
    fn the_panel_is_on_until_switched_off_and_the_rest_is_off_until_chosen() {
        assert_eq!(
            serde_json::to_value(VideoControls::default()).unwrap(),
            serde_json::json!({
                "panel": true,
                "height": 16,
                "skip": 10,
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
                ..SiteVideo::default()
            },
        );
        let script = VideoControls::default().page_script(&sites);
        assert!(script.ends_with(
            r#"({"panel":true,"height":16,"skip":10,"fullVideos":false,"remember":false,"loopOff":false,"autoAdvance":false,"sites":{"youtube.com":{"panel":false}}});"#
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
                ..SiteVideo::default()
            }
            .is_empty()
        );
    }

    #[test]
    fn every_new_field_makes_a_site_choice_non_empty_and_round_trips() {
        for json in [
            r#"{"remember":false}"#,
            r#"{"loopOff":true}"#,
            r#"{"autoAdvance":false}"#,
            r#"{"skip":30}"#,
        ] {
            let site: SiteVideo = serde_json::from_str(json).unwrap();
            assert!(!site.is_empty());
            assert_eq!(serde_json::to_string(&site).unwrap(), json);
        }
        let full = SiteVideo {
            panel: Some(true),
            height: Some(20),
            skip: Some(15),
            full_videos: Some(false),
            remember: Some(true),
            loop_off: Some(true),
            auto_advance: Some(false),
        };
        assert_eq!(
            serde_json::to_value(full).unwrap(),
            serde_json::json!({
                "panel": true,
                "height": 20,
                "skip": 15,
                "fullVideos": false,
                "remember": true,
                "loopOff": true,
                "autoAdvance": false
            })
        );
    }

    #[test]
    fn the_skip_is_ten_seconds_until_chosen() {
        assert_eq!(VideoControls::default().skip, 10);
        let saved: VideoControls = serde_json::from_str(r#"{"remember":true}"#).unwrap();
        assert_eq!(saved.skip, DEFAULT_SKIP);
    }

    #[test]
    fn a_skip_outside_the_allowed_set_snaps_to_the_nearest_one() {
        for (saved, snapped) in [
            (0, 5),
            (7, 5),
            (8, 10),
            (12, 10),
            (13, 15),
            (22, 15),
            (23, 30),
            (999, 30),
            (15, 15),
        ] {
            let general: VideoControls =
                serde_json::from_str(&format!(r#"{{"skip":{saved}}}"#)).unwrap();
            assert_eq!(general.skip, snapped, "general {saved}");
            let site: SiteVideo = serde_json::from_str(&format!(r#"{{"skip":{saved}}}"#)).unwrap();
            assert_eq!(site.skip, Some(snapped), "site {saved}");
        }
    }

    #[test]
    fn a_site_with_only_a_skip_is_not_empty_and_serializes_it() {
        let site = SiteVideo {
            skip: Some(5),
            ..SiteVideo::default()
        };
        assert!(!site.is_empty());
        assert_eq!(serde_json::to_string(&site).unwrap(), r#"{"skip":5}"#);
    }

    #[test]
    fn the_page_gets_the_skip_in_general_and_per_site() {
        let mut sites = BTreeMap::new();
        sites.insert(
            "youtube.com".to_owned(),
            SiteVideo {
                skip: Some(30),
                ..SiteVideo::default()
            },
        );
        let script = VideoControls::default().page_script(&sites);
        assert!(script.contains(r#""skip":10"#));
        assert!(script.contains(r#""youtube.com":{"skip":30}"#));
    }
}
