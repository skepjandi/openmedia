//! Keyboard control for the desktop shell: what its shortcuts do to the page in front, and who
//! has the keyboard. Every command here is raised by the shell's own shortcuts; a site view
//! reaches none of them.
//!
//! Scrolling runs through the plugin's Rust-only `evaluate` with a fixed script and an argument
//! that is one of a closed set of words, so the page is handed no channel to the app and no text
//! of the user's.

use serde::Deserialize;
use tauri::AppHandle;
use tauri_plugin_siteview::{EvaluateRequest, SiteviewExt, ZoomAction};

use crate::error::{Error, Result};

const SCROLL_SCRIPT: &str = include_str!("page_scroll.js");

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Scroll {
    Down,
    Up,
    Left,
    Right,
    HalfDown,
    HalfUp,
    PageDown,
    PageUp,
    Top,
    Bottom,
}

impl Scroll {
    fn word(self) -> &'static str {
        match self {
            Self::Down => "down",
            Self::Up => "up",
            Self::Left => "left",
            Self::Right => "right",
            Self::HalfDown => "halfDown",
            Self::HalfUp => "halfUp",
            Self::PageDown => "pageDown",
            Self::PageUp => "pageUp",
            Self::Top => "top",
            Self::Bottom => "bottom",
        }
    }
}

/// The expression that scrolls the page by `scroll`.
fn scroll_script(scroll: Scroll) -> String {
    format!("({SCROLL_SCRIPT}\n)(\"{}\")", scroll.word())
}

/// One menu item: what it is called, the menu it is under and the keys that run it.
#[derive(Debug, Clone, Deserialize)]
pub struct MenuShortcut {
    id: String,
    label: String,
    group: String,
    accelerator: Option<String>,
}

impl MenuShortcut {
    #[cfg(test)]
    pub fn new(id: &str, label: &str, group: &str, accelerator: Option<&str>) -> Self {
        Self {
            id: id.to_owned(),
            label: label.to_owned(),
            group: group.to_owned(),
            accelerator: accelerator.map(str::to_owned),
        }
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn label(&self) -> &str {
        &self.label
    }

    pub fn group(&self) -> &str {
        &self.group
    }

    pub fn accelerator(&self) -> Option<&str> {
        self.accelerator.as_deref()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Target {
    Page,
    Shell,
}

/// Scrolls the page in front. Async, like every command that evaluates in the page.
#[tauri::command]
pub async fn page_scroll(app: AppHandle, scroll: Scroll) -> Result<()> {
    app.siteview().evaluate(EvaluateRequest {
        script: scroll_script(scroll),
        page_world: false,
    })?;
    Ok(())
}

/// Zooms the page in front.
#[tauri::command]
pub async fn page_zoom(app: AppHandle, zoom: ZoomAction) -> Result<()> {
    #[cfg(desktop)]
    {
        app.siteview()
            .zoom(tauri_plugin_siteview::ZoomRequest { action: zoom })?;
        Ok(())
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, zoom);
        Err(crate::error::Error::NotDesktop)
    }
}

/// Gives the keyboard to the page in front, or to the shell so its shortcuts see every key.
#[tauri::command]
pub async fn focus_keyboard(app: AppHandle, target: Target) -> Result<()> {
    #[cfg(desktop)]
    {
        app.siteview().focus_keyboard(target == Target::Shell)?;
        Ok(())
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, target);
        Err(crate::error::Error::NotDesktop)
    }
}

const MAX_SHORTCUTS: usize = 256;
const MAX_ID_CHARS: usize = 64;
const MAX_TEXT_CHARS: usize = 80;

fn is_plain(text: &str, max: usize) -> bool {
    !text.is_empty() && text.chars().count() <= max && !text.chars().any(char::is_control)
}

/// The shell is trusted, but a bad list must not build a broken menu bar.
pub fn validate(shortcuts: &[MenuShortcut]) -> Result<()> {
    if shortcuts.len() > MAX_SHORTCUTS {
        return Err(Error::InvalidShortcuts("too many"));
    }
    for shortcut in shortcuts {
        let id_ok = is_plain(&shortcut.id, MAX_ID_CHARS)
            && shortcut
                .id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '#' | '-'));
        let accelerator_ok = shortcut
            .accelerator
            .as_deref()
            .is_none_or(|text| is_plain(text, MAX_TEXT_CHARS));
        if !id_ok
            || !is_plain(&shortcut.label, MAX_TEXT_CHARS)
            || !is_plain(&shortcut.group, MAX_TEXT_CHARS)
            || !accelerator_ok
        {
            return Err(Error::InvalidShortcuts("bad item"));
        }
    }
    Ok(())
}

/// Shows these items, with their keys, in the menu bar.
#[tauri::command]
pub async fn set_menu_shortcuts(app: AppHandle, shortcuts: Vec<MenuShortcut>) -> Result<()> {
    validate(&shortcuts)?;
    #[cfg(desktop)]
    {
        crate::desktop_menu::set(&app, &shortcuts)
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Err(crate::error::Error::NotDesktop)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shortcut(id: &str, group: &str) -> MenuShortcut {
        MenuShortcut::new(id, "Back", group, Some("CmdOrCtrl+["))
    }

    #[test]
    fn a_bad_item_or_too_long_a_list_is_refused() {
        assert!(validate(&[shortcut("nav.back", "Navigate")]).is_ok());
        assert!(validate(&[shortcut("nav back", "Navigate")]).is_err());
        assert!(validate(&[shortcut("nav.back", "")]).is_err());
        let many: Vec<MenuShortcut> = (0..=MAX_SHORTCUTS)
            .map(|n| shortcut(&format!("a{n}"), "Navigate"))
            .collect();
        assert!(validate(&many).is_err());
    }

    #[test]
    fn the_scroll_script_carries_only_the_chosen_word() {
        let script = scroll_script(Scroll::HalfDown);
        assert!(script.ends_with("\n)(\"halfDown\")"));
        assert_eq!(script.matches("\")").count(), 1);
    }
}
