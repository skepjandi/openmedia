//! Saved window layouts. A workspace is a name and the arrangement of pages (each by the address
//! it opens, as a favorite's would) that the desktop window manager restores in one step. It
//! lives beside the favorites, never inside them: a favorite is one site, and everything that
//! reads favorites by their site (icons, unread counts, usage, recipes) stays about one site.

use serde::{Deserialize, Serialize};
use tauri_plugin_siteview::validate::{MAX_PANES, parse_web_url};
use uuid::Uuid;

use crate::error::{Error, Result};
use crate::library::MAX_FAVORITE_NAME_CHARS;

/// The least and most of a split one half may take; the shell keeps to a narrower range.
const MIN_RATIO: f64 = 0.05;
const MAX_RATIO: f64 = 0.95;
/// A workspace holds at most this many saved ones.
pub const MAX_WORKSPACES: usize = 24;

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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Workspace {
    pub id: Uuid,
    pub name: String,
    pub layout: Tiles,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WorkspaceInput {
    /// Kept when a workspace is saved again, so what refers to it by id still finds it.
    #[serde(default)]
    pub id: Option<Uuid>,
    pub name: String,
    pub layout: Tiles,
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
                    return Err(Error::InvalidWorkspace);
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

/// The workspaces as saved: names trimmed and bounded, each layout holding two to `MAX_PANES`
/// pages that are web addresses. Nothing is kept when any one is refused.
pub fn from_inputs(inputs: Vec<WorkspaceInput>) -> Result<Vec<Workspace>> {
    if inputs.len() > MAX_WORKSPACES {
        return Err(Error::InvalidWorkspace);
    }
    inputs
        .into_iter()
        .map(|input| {
            let name = input.name.trim();
            if name.is_empty() || name.chars().count() > MAX_FAVORITE_NAME_CHARS {
                return Err(Error::InvalidWorkspace);
            }
            if !(2..=MAX_PANES).contains(&input.layout.pane_count()) {
                return Err(Error::InvalidWorkspace);
            }
            Ok(Workspace {
                id: input.id.unwrap_or_else(Uuid::new_v4),
                name: name.to_owned(),
                layout: input.layout.checked()?,
            })
        })
        .collect()
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

    fn input(name: &str, layout: Tiles) -> WorkspaceInput {
        WorkspaceInput {
            id: None,
            name: name.into(),
            layout,
        }
    }

    fn two() -> Tiles {
        split(pane("https://a.example/"), pane("https://b.example/x?y=1"))
    }

    #[test]
    fn a_workspace_keeps_its_name_its_pages_and_the_id_it_was_given() {
        let id = Uuid::new_v4();
        let saved = from_inputs(vec![WorkspaceInput {
            id: Some(id),
            ..input("  Desk ", two())
        }])
        .unwrap();
        assert_eq!(saved[0].id, id);
        assert_eq!(saved[0].name, "Desk");
        assert_eq!(saved[0].layout, two());
    }

    #[test]
    fn a_new_workspace_gets_an_id_of_its_own() {
        let saved = from_inputs(vec![input("A", two()), input("B", two())]).unwrap();
        assert_ne!(saved[0].id, saved[1].id);
    }

    #[test]
    fn a_name_is_one_to_twenty_characters() {
        assert!(from_inputs(vec![input("", two())]).is_err());
        assert!(from_inputs(vec![input("   ", two())]).is_err());
        assert!(from_inputs(vec![input(&"x".repeat(21), two())]).is_err());
        assert!(from_inputs(vec![input(&"x".repeat(20), two())]).is_ok());
    }

    #[test]
    fn a_layout_is_two_to_eight_pages() {
        assert!(from_inputs(vec![input("One", pane("https://a.example/"))]).is_err());
        let mut many = pane("https://a.example/");
        for _ in 1..MAX_PANES {
            many = split(many, pane("https://b.example/"));
        }
        assert!(from_inputs(vec![input("Eight", many.clone())]).is_ok());
        assert!(from_inputs(vec![input("Nine", split(many, pane("https://c.example/")))]).is_err());
    }

    #[test]
    fn a_page_must_be_a_web_address() {
        for bad in ["file:///etc/passwd", "javascript:alert(1)", "not a url", ""] {
            assert!(
                from_inputs(vec![input(
                    "Bad",
                    split(pane("https://a.example/"), pane(bad))
                )])
                .is_err(),
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
            assert!(from_inputs(vec![input("Bad", layout)]).is_err(), "{ratio}");
        }
    }

    #[test]
    fn there_is_a_limit_on_how_many_are_saved() {
        let many: Vec<_> = (0..=MAX_WORKSPACES)
            .map(|n| input(&format!("W{n}"), two()))
            .collect();
        assert!(from_inputs(many).is_err());
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
    fn saved_workspaces_survive_a_reload_and_a_refused_save_keeps_the_old_ones() {
        use crate::library::Library;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("library.json");
        let library = Library::load(path.clone()).unwrap();
        assert!(library.state().unwrap().workspaces.is_empty());
        let saved = library.set_workspaces(vec![input("Desk", two())]).unwrap();
        assert!(library.set_workspaces(vec![input("", two())]).is_err());
        let reloaded = Library::load(path).unwrap().state().unwrap().workspaces;
        assert_eq!(reloaded, saved);
    }
}
