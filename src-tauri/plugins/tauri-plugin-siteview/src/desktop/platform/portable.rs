//! What Windows and Linux do the same way: Tauri's own webview calls plus the page's callbacks.

use std::{
    collections::HashMap,
    path::Path,
    process::Command,
    sync::{Mutex, PoisonError},
};

use tauri::{Runtime, Webview, webview::WebviewBuilder};
use url::Url;
use uuid::Uuid;

use super::{PageSnapshot, Track, history, zoomed};
use crate::{ContentRuleList, Rect, Result, ZoomAction};

/// The system web view's own user agent is one sites already accept for sign-in.
pub const USER_AGENT: Option<&str> = None;

/// There is no per-pixel click-through, so the page sits above the shell and keeps clear of what
/// the shell draws (`layout::fit_page`).
pub const CLICK_THROUGH: bool = false;

/// Request-level blocking is not wired on this system, so changing the lists reloads nothing.
pub const APPLIES_RULE_LISTS: bool = false;

/// Only macOS filters the shell's clicks by region; here the regions are kept in the plugin state.
pub fn set_regions(_regions: Vec<Rect>) {}

/// The shell's web view fills the window, so a page's coordinates need no offset.
pub fn content_insets<R: Runtime>(_webview: &Webview<R>) -> Result<(f64, f64, f64, f64)> {
    Ok((0.0, 0.0, 0.0, 0.0))
}

pub fn enable_gestures<R: Runtime>(_webview: &Webview<R>) -> Result<()> {
    Ok(())
}

/// A page's media is paused by its own script; frames of other origins are left to play.
pub fn set_media_suspended<R: Runtime>(_webview: &Webview<R>, _suspended: bool) -> Result<()> {
    Ok(())
}

/// The address and title come from Tauri and the page's callbacks; only the history is asked of
/// the system web view.
pub fn snapshot<R: Runtime>(webview: &Webview<R>, track: &Track) -> Result<PageSnapshot> {
    let (can_go_back, can_go_forward) = history(webview)?;
    Ok(PageSnapshot {
        url: webview.url().ok().map(|url| url.to_string()),
        title: track.title(),
        loading: track.loading(),
        can_go_back,
        can_go_forward,
    })
}

static ZOOMS: Mutex<Option<HashMap<String, f64>>> = Mutex::new(None);

/// Changes the page size, as Ctrl + / Ctrl - / Ctrl 0 do in a browser.
pub fn zoom<R: Runtime>(webview: &Webview<R>, action: ZoomAction) -> Result<()> {
    let mut zooms = ZOOMS.lock().unwrap_or_else(PoisonError::into_inner);
    let sizes = zooms.get_or_insert_with(HashMap::new);
    let next = zoomed(sizes.get(webview.label()).copied().unwrap_or(1.0), action);
    webview.set_zoom(next)?;
    sizes.insert(webview.label().to_owned(), next);
    Ok(())
}

/// A web view's init scripts cannot be swapped once built, so the caller rebuilds the view.
pub fn replace_user_script<R: Runtime>(
    _webview: &Webview<R>,
    _old: &str,
    _new: &str,
) -> Result<bool> {
    Ok(false)
}

/// Request-level blocking is not wired on this system: the lists are accepted and not applied.
pub fn set_rule_lists<R: Runtime>(
    _webview: &Webview<R>,
    _lists: Vec<ContentRuleList>,
) -> Result<()> {
    Ok(())
}

/// Each profile gets its own data folder, so cookies and storage stay apart.
pub fn configure_profile<R: Runtime>(
    builder: WebviewBuilder<R>,
    profiles: &Path,
    profile: Uuid,
) -> WebviewBuilder<R> {
    builder.data_directory(profiles.join(profile.to_string()))
}

/// Shows the folder holding a finished download.
pub fn reveal_file(file: &Path) {
    #[cfg(windows)]
    let _ = Command::new("explorer.exe")
        .arg(format!("/select,{}", file.display()))
        .spawn();
    #[cfg(target_os = "linux")]
    if let Some(folder) = file.parent() {
        let _ = Command::new("xdg-open").arg(folder).spawn();
    }
}

/// Hands a link to the user's browser. The URL is http or https and is passed as one argument.
pub fn open_in_browser(url: &Url) {
    #[cfg(windows)]
    let _ = Command::new("rundll32.exe")
        .arg("url.dll,FileProtocolHandler")
        .arg(url.as_str())
        .spawn();
    #[cfg(target_os = "linux")]
    let _ = Command::new("xdg-open").arg(url.as_str()).spawn();
}

/// Notifications for a hidden session are not offered here yet.
pub mod notify {
    use crate::{Error, Result};

    pub fn install(_on_tap: impl Fn(String) + Send + Sync + 'static) {}

    pub fn notify(_session: &str, _title: &str, _body: &str) -> Result<()> {
        Err(Error::DesktopUnsupported("notifications"))
    }
}
