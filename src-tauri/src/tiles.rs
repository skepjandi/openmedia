//! Window layouts. A folder may carry one: the arrangement of its favorites that the desktop
//! window manager restores when the folder is dropped on the page. Each window is a favorite of
//! the folder, by its address, so a layout never holds a page the folder does not.

use serde::{Deserialize, Serialize};
use tauri_plugin_siteview::validate::{MAX_PANES, parse_web_url};

use crate::error::{Error, Result};

/// The least and most of a split one half may take; the shell keeps to a narrower range.
const MIN_RATIO: f64 = 0.05;
const MAX_RATIO: f64 = 0.95;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Direction {
    /// The halves stand side by side.
    Row,
    /// The halves are stacked.
    Column,
}

/// The arrangement: a page, or two halves of a rectangle.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Tiles {
    Pane {
        url: String,
    },
    Split {
        direction: Direction,
        /// The share the first half takes of the room.
        ratio: f64,
        first: Box<Tiles>,
        second: Box<Tiles>,
    },
}

impl Tiles {
    pub fn pane_count(&self) -> usize {
        match self {
            Tiles::Pane { .. } => 1,
            Tiles::Split { first, second, .. } => first.pane_count() + second.pane_count(),
        }
    }

    /// The same layout with every address parsed as a web address and written back out, or an
    /// error for an address that is none or a ratio that is not a share.
    fn checked(self) -> Result<Tiles> {
        match self {
            Tiles::Pane { url } => Ok(Tiles::Pane {
                url: parse_web_url(&url)?.to_string(),
            }),
            Tiles::Split {
                direction,
                ratio,
                first,
                second,
            } => {
                if !(MIN_RATIO..=MAX_RATIO).contains(&ratio) {
                    return Err(Error::InvalidFolder);
                }
                Ok(Tiles::Split {
                    direction,
                    ratio,
                    first: Box::new(first.checked()?),
                    second: Box::new(second.checked()?),
                })
            }
        }
    }
}

/// A layout to keep: two to `MAX_PANES` pages that are web addresses, in splits that are shares.
pub fn validated(layout: Tiles) -> Result<Tiles> {
    if !(2..=MAX_PANES).contains(&layout.pane_count()) {
        return Err(Error::InvalidFolder);
    }
    layout.checked()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pane(url: &str) -> Tiles {
        Tiles::Pane { url: url.into() }
    }

    fn split(first: Tiles, second: Tiles) -> Tiles {
        Tiles::Split {
            direction: Direction::Row,
            ratio: 0.5,
            first: Box::new(first),
            second: Box::new(second),
        }
    }

    fn two() -> Tiles {
        split(pane("https://a.example/"), pane("https://b.example/x?y=1"))
    }

    #[test]
    fn a_layout_keeps_its_pages_and_sizes() {
        assert_eq!(validated(two()).unwrap(), two());
    }

    #[test]
    fn a_layout_is_two_to_eight_pages() {
        assert!(validated(pane("https://a.example/")).is_err());
        let mut many = pane("https://a.example/");
        for _ in 1..MAX_PANES {
            many = split(many, pane("https://b.example/"));
        }
        assert!(validated(many.clone()).is_ok());
        assert!(validated(split(many, pane("https://c.example/"))).is_err());
    }

    #[test]
    fn a_page_must_be_a_web_address() {
        for bad in ["file:///etc/passwd", "javascript:alert(1)", "not a url", ""] {
            assert!(
                validated(split(pane("https://a.example/"), pane(bad))).is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn a_split_must_be_a_share() {
        for ratio in [0.0, 0.01, 0.99, 1.0, f64::NAN, f64::INFINITY, -0.5] {
            let layout = Tiles::Split {
                direction: Direction::Column,
                ratio,
                first: Box::new(pane("https://a.example/")),
                second: Box::new(pane("https://b.example/")),
            };
            assert!(validated(layout).is_err(), "{ratio}");
        }
    }

    #[test]
    fn a_layout_is_the_shape_the_shell_sends() {
        let text = r#"{"kind":"split","direction":"column","ratio":0.3,
            "first":{"kind":"pane","url":"https://a.example/"},
            "second":{"kind":"pane","url":"https://b.example/"}}"#;
        let tiles: Tiles = serde_json::from_str(text).unwrap();
        assert_eq!(tiles.pane_count(), 2);
        let again = serde_json::to_value(&tiles).unwrap();
        assert_eq!(again["direction"], "column");
        assert_eq!(again["first"]["kind"], "pane");
    }

    #[test]
    fn a_folders_layout_survives_a_reload_and_a_bad_one_is_refused() {
        use crate::library::{Folder, Library, Mode};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("library.json");
        let library = Library::load(path.clone()).unwrap();
        let folder = |layout| Folder {
            name: "Desk".into(),
            icon: None,
            layout,
        };
        let saved = library
            .set_folders(Mode::Normal, vec![folder(Some(two()))])
            .unwrap();
        assert!(
            library
                .set_folders(Mode::Normal, vec![folder(Some(pane("https://a.example/")))])
                .is_err()
        );
        let reloaded = Library::load(path).unwrap().state().unwrap().folders;
        assert_eq!(reloaded, saved);
        assert_eq!(reloaded[0].layout, Some(two()));
    }
}
