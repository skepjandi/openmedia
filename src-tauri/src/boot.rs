//! Starts loading the user's page while the shell is still starting.
//!
//! The shell takes a few hundred milliseconds to boot before it can ask for a page. The page does
//! not depend on the shell, so Rust opens the start page itself, at launch, and the shell adopts it
//! when it is ready. The page's network request, web process and first paint all overlap the
//! shell's own startup instead of following it.

use std::{net::ToSocketAddrs, sync::Mutex};

use serde::Serialize;
use tauri::{AppHandle, async_runtime::JoinHandle};
use url::Url;
use uuid::Uuid;

use crate::commands::open_session;
use crate::error::Result;
use crate::library::{AppState, Library};

/// What the shell needs to take over the page Rust already opened.
#[derive(Debug, Clone, Serialize)]
pub struct BootSession {
    pub id: String,
    pub url: String,
}

/// Everything the shell needs at startup: the saved state, and the page opened for it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Startup {
    #[serde(flatten)]
    pub state: AppState,
    pub boot_session: Option<BootSession>,
    /// The page is a child webview beside the shell, not a native layer under it; see
    /// `tauri-plugin-siteview/src/desktop`.
    pub desktop: bool,
}

/// The ad-blocking warning an open produced, if any: the page opened, but unblocked.
type Opened = Result<Option<String>>;

pub struct Boot {
    session: Option<BootSession>,
    opening: Mutex<Option<JoinHandle<Opened>>>,
}

impl Boot {
    /// Begins opening the start page, if there is one. Needs the library, recipes and ad-block
    /// state to be managed already, because the open runs at once on another thread.
    pub fn start(app: &AppHandle, library: &Library) -> Result<Self> {
        let Some(url) = library.start_url()? else {
            return Ok(Self::idle());
        };
        warm_dns(&url);
        let session = BootSession {
            id: Uuid::new_v4().to_string(),
            url,
        };
        let opening = {
            let app = app.clone();
            let session = session.clone();
            tauri::async_runtime::spawn(async move {
                open_session(&app, session.id, session.url, None).await
            })
        };
        Ok(Self {
            session: Some(session),
            opening: Mutex::new(Some(opening)),
        })
    }

    fn idle() -> Self {
        Self {
            session: None,
            opening: Mutex::new(None),
        }
    }

    pub fn session(&self) -> Option<BootSession> {
        self.session.clone()
    }

    /// Waits for the start page's open and hands over its warning. `None` means there is nothing
    /// to adopt: `id` is not the start page, it was already adopted, or opening it failed.
    pub async fn adopt(&self, id: &str) -> Option<Option<String>> {
        if self.session.as_ref().is_none_or(|session| session.id != id) {
            return None;
        }
        let opening = self
            .opening
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()?;
        opening.await.ok()?.ok()
    }
}

/// Resolves the start page's host now. The web view that will load the page needs a few hundred
/// milliseconds to start; the answer waits in the system's resolver cache by then, so the page's
/// first request does not spend a round trip on DNS. Only the host the user is about to open is
/// looked up.
fn warm_dns(url: &str) {
    let Ok(url) = Url::parse(url) else { return };
    let (Some(host), Some(port)) = (
        url.host_str().map(str::to_owned),
        url.port_or_known_default(),
    ) else {
        return;
    };
    tauri::async_runtime::spawn_blocking(move || {
        let _ = (host.as_str(), port).to_socket_addrs();
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::Error;

    fn boot_opening(result: Opened) -> Boot {
        Boot {
            session: Some(BootSession {
                id: "boot".into(),
                url: "https://www.instagram.com/".into(),
            }),
            opening: Mutex::new(Some(tauri::async_runtime::spawn(async move { result }))),
        }
    }

    fn adopt(boot: &Boot, id: &str) -> Option<Option<String>> {
        tauri::async_runtime::block_on(boot.adopt(id))
    }

    #[test]
    fn adopting_hands_over_the_open_result_once() {
        let boot = boot_opening(Ok(Some("lists failed".into())));
        assert_eq!(adopt(&boot, "boot"), Some(Some("lists failed".into())));
        assert_eq!(adopt(&boot, "boot"), None);
    }

    #[test]
    fn another_session_cannot_take_the_start_page() {
        let boot = boot_opening(Ok(None));
        assert_eq!(adopt(&boot, "other"), None);
        assert_eq!(adopt(&boot, "boot"), Some(None));
    }

    #[test]
    fn a_failed_open_leaves_nothing_to_adopt() {
        let boot = boot_opening(Err(Error::AdBlock("x".into())));
        assert_eq!(adopt(&boot, "boot"), None);
    }

    #[test]
    fn with_no_start_page_nothing_can_be_adopted() {
        let boot = Boot::idle();
        assert!(boot.session().is_none());
        assert_eq!(adopt(&boot, "boot"), None);
    }
}
