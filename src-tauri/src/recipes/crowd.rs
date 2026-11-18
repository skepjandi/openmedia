//! The two rules that ask a public, crowd-sourced service about the video on the page: sponsor
//! segments to skip, and the dislike count the site no longer shows. The hosts are fixed in the
//! runtime (`crowd_data.js`); a recipe chooses neither the host nor what is sent, only where the
//! video's id is found, which categories to skip and where the count goes.

use serde::{Deserialize, Serialize};

use super::schema::Target;
use super::selector::validate_selector;
use crate::error::{Error, Result};

pub const CROWD_RUNTIME: &str = include_str!("../crowd_data.js");

/// Most rules of this kind in one recipe: one per service.
pub const MAX_CROWD_RULES: usize = 2;
const MAX_NAME_CHARS: usize = 24;

/// Where the page's own address holds the video's id: the value of one query parameter
/// (`/watch?v=ID`) or the path segment after a fixed one (`/shorts/ID`). Exactly one is set.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct VideoId {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after_segment: Option<String>,
}

/// The segment categories the service knows that a reader may want skipped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SegmentCategory {
    Sponsor,
    Selfpromo,
    Interaction,
    Intro,
    Outro,
    Preview,
    Filler,
}

/// A rule as the page's runtime reads it.
#[derive(Serialize)]
pub struct PageCrowd {
    pub id: String,
    pub kind: &'static str,
    #[serde(rename = "videoId")]
    pub video_id: VideoId,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub categories: Vec<SegmentCategory>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
}

fn name_ok(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_NAME_CHARS
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
}

pub fn validate_video_id(id: &str, video_id: &VideoId) -> Result<()> {
    let name = match (&video_id.query, &video_id.after_segment) {
        (Some(name), None) | (None, Some(name)) => name,
        _ => {
            return Err(Error::Recipe(format!(
                "rule {id}: videoId needs exactly one of query or afterSegment"
            )));
        }
    };
    if !name_ok(name) {
        return Err(Error::Recipe(format!(
            "rule {id}: videoId names a parameter or segment of 1-{MAX_NAME_CHARS} letters, digits, - or _"
        )));
    }
    Ok(())
}

pub fn validate_sponsor_block(
    id: &str,
    video_id: &VideoId,
    categories: &[SegmentCategory],
) -> Result<()> {
    validate_video_id(id, video_id)?;
    let mut seen = Vec::new();
    for category in categories {
        if seen.contains(category) {
            return Err(Error::Recipe(format!(
                "rule {id}: a category is listed twice"
            )));
        }
        seen.push(*category);
    }
    if seen.is_empty() {
        return Err(Error::Recipe(format!(
            "rule {id}: needs at least one category"
        )));
    }
    Ok(())
}

pub fn validate_dislike_count(id: &str, video_id: &VideoId, target: &Target) -> Result<()> {
    validate_video_id(id, video_id)?;
    validate_selector(&target.css)
}

pub fn sponsor_block_page(
    id: &str,
    video_id: &VideoId,
    categories: &[SegmentCategory],
) -> PageCrowd {
    PageCrowd {
        id: id.to_owned(),
        kind: "sponsorBlock",
        video_id: video_id.clone(),
        categories: categories.to_vec(),
        target: None,
    }
}

pub fn dislike_count_page(id: &str, video_id: &VideoId, target: &Target) -> PageCrowd {
    PageCrowd {
        id: id.to_owned(),
        kind: "dislikeCount",
        video_id: video_id.clone(),
        categories: Vec::new(),
        target: Some(target.css.clone()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(query: Option<&str>, segment: Option<&str>) -> VideoId {
        VideoId {
            query: query.map(str::to_owned),
            after_segment: segment.map(str::to_owned),
        }
    }

    #[test]
    fn a_video_id_names_exactly_one_place() {
        assert!(validate_video_id("r", &id(Some("v"), None)).is_ok());
        assert!(validate_video_id("r", &id(None, Some("shorts"))).is_ok());
        assert!(validate_video_id("r", &id(None, None)).is_err());
        assert!(validate_video_id("r", &id(Some("v"), Some("shorts"))).is_err());
    }

    #[test]
    fn a_video_id_place_is_a_plain_name() {
        for bad in ["", "a b", "v=1", "a/b", "ünï", &"x".repeat(25)] {
            assert!(
                validate_video_id("r", &id(Some(bad), None)).is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn categories_are_non_empty_and_unique() {
        let place = id(Some("v"), None);
        assert!(validate_sponsor_block("r", &place, &[]).is_err());
        let twice = [SegmentCategory::Sponsor, SegmentCategory::Sponsor];
        assert!(validate_sponsor_block("r", &place, &twice).is_err());
        assert!(validate_sponsor_block("r", &place, &[SegmentCategory::Intro]).is_ok());
    }
}
