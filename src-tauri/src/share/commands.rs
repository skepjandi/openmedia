//! Shell-facing sharing commands. None is reachable from a site view: the shell capability names
//! only the `main` webview. The poll token and the sign-in address never leave Rust.

use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

use super::{ShareStatus, Shares, messages};
use crate::error::{Error, Result};
use crate::recipes::Recipes;

#[derive(Debug, Serialize)]
pub struct StartedShare {
    pub id: String,
}

fn open_in_browser(app: &AppHandle, url: &str) -> Result<()> {
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|_| Error::Share(messages::BROWSER.into()))
}

/// Whether this build knows a sharing service.
#[tauri::command]
pub fn share_status_available(shares: State<'_, Shares>) -> bool {
    shares.available()
}

/// Checks the recipe, sends it to the sharing service, and opens the GitHub sign-in in the
/// system browser. Free for everyone. Returns only the share id.
#[tauri::command]
pub async fn share_start(
    app: AppHandle,
    shares: State<'_, Shares>,
    recipes: State<'_, Recipes>,
    recipe_id: String,
    summary: String,
) -> Result<StartedShare> {
    let id = super::start(&shares, &recipes, &recipe_id, &summary, |url| {
        open_in_browser(&app, url)
    })
    .await?;
    Ok(StartedShare { id })
}

#[tauri::command]
pub async fn share_status(shares: State<'_, Shares>, id: String) -> Result<ShareStatus> {
    super::status(&shares, &id).await
}

/// Opens the pull request page of a finished share in the system browser.
#[tauri::command]
pub fn share_open(app: AppHandle, shares: State<'_, Shares>, id: String) -> Result<()> {
    super::open_pull_request(&shares, &id, |url| open_in_browser(&app, url))
}

/// Forgets a share in progress. Nothing is undone on GitHub: a pull request already opened stays.
#[tauri::command]
pub fn share_cancel(shares: State<'_, Shares>, id: String) {
    shares.cancel(&id);
}
