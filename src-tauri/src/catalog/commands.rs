//! Shell-facing marketplace commands. None of them is reachable from a site view: the shell
//! capability names only the `main` webview. Async so network waits stay off the main thread.

use tauri::{AppHandle, Manager, State};
use tauri_plugin_billing::BillingExt;

use super::{
    Account, Catalog, Comments, Listing, OnboardingOption, OnboardingResult, ReportReason, Status,
    Submitted,
};
use crate::commands::reload_script;
use crate::entitlement::Entitlement;
use crate::error::{Error, Result};
use crate::library::Library;
use crate::recipes::{RecipePreview, Recipes};

/// The device's store identity, for the actions the Worker only allows Pro users. The id is read
/// here in Rust and goes only into a request header; the shell never sees it.
struct LiveAccount<'a> {
    app: &'a AppHandle,
    entitlement: &'a Entitlement,
}

impl Account for LiveAccount<'_> {
    fn require_pro(&self) -> Result<()> {
        self.entitlement.require_pro()
    }

    fn app_user_id(&self) -> Result<Option<String>> {
        self.app.billing().app_user_id().map_err(Error::from)
    }
}

#[tauri::command]
pub fn marketplace_status(catalog: State<'_, Catalog>) -> Status {
    catalog.status()
}

#[tauri::command]
pub fn marketplace_set_counting(catalog: State<'_, Catalog>, enabled: bool) -> Result<()> {
    catalog.set_count_installs(enabled)
}

/// Fetches the signed catalog. If it withdrew a recipe that is installed, that recipe is gone
/// from this device and the page script is rebuilt without it.
#[tauri::command]
pub async fn marketplace_list(
    app: AppHandle,
    catalog: State<'_, Catalog>,
    recipes: State<'_, Recipes>,
    library: State<'_, Library>,
) -> Result<Listing> {
    let listing = catalog.refresh(&recipes).await?;
    if !listing.withdrawn.is_empty() {
        reload_script(&app, &library, &recipes)?;
    }
    Ok(listing)
}

#[tauri::command]
pub async fn marketplace_preview(
    catalog: State<'_, Catalog>,
    recipes: State<'_, Recipes>,
    recipe_id: String,
) -> Result<RecipePreview> {
    catalog.preview(&recipes, &recipe_id).await
}

#[tauri::command]
pub async fn marketplace_install(
    app: AppHandle,
    catalog: State<'_, Catalog>,
    recipes: State<'_, Recipes>,
    library: State<'_, Library>,
    recipe_id: String,
) -> Result<()> {
    catalog.install(&recipes, &recipe_id).await?;
    reload_script(&app, &library, &recipes)
}

#[tauri::command]
pub async fn marketplace_uninstall(
    app: AppHandle,
    catalog: State<'_, Catalog>,
    recipes: State<'_, Recipes>,
    library: State<'_, Library>,
    recipe_id: String,
) -> Result<()> {
    catalog.uninstall(&recipes, &recipe_id)?;
    reload_script(&app, &library, &recipes)
}

#[tauri::command]
pub async fn marketplace_report(
    catalog: State<'_, Catalog>,
    recipe_id: String,
    reason: ReportReason,
) -> Result<()> {
    catalog.report(&recipe_id, reason).await
}

/// Sends one of the user's own recipes to the marketplace. Pro only. The reply says whether this
/// was the first submission under that name; the edit token itself never reaches the shell.
#[tauri::command]
pub async fn marketplace_submit(
    app: AppHandle,
    catalog: State<'_, Catalog>,
    recipes: State<'_, Recipes>,
    recipe_id: String,
    slug: String,
    summary: String,
    author: String,
) -> Result<SubmitResult> {
    let entitlement = app.state::<Entitlement>();
    let account = LiveAccount {
        app: &app,
        entitlement: &entitlement,
    };
    let submitted: Submitted = catalog
        .submit(&account, &recipes, &recipe_id, &slug, &summary, &author)
        .await?;
    Ok(SubmitResult {
        submission_id: submitted.submission_id,
        first_submission: submitted.edit_token.is_some(),
    })
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitResult {
    pub submission_id: String,
    pub first_submission: bool,
}

/// One to five stars; sends the device token only. The shell reloads the listing to see it.
#[tauri::command]
pub async fn marketplace_set_rating(
    catalog: State<'_, Catalog>,
    recipe_id: String,
    stars: u8,
) -> Result<()> {
    catalog.rate(&recipe_id, stars).await
}

#[tauri::command]
pub async fn marketplace_comments(
    app: AppHandle,
    catalog: State<'_, Catalog>,
    entitlement: State<'_, Entitlement>,
    recipe_id: String,
) -> Result<Comments> {
    let account = LiveAccount {
        app: &app,
        entitlement: &entitlement,
    };
    catalog.comments(&account, &recipe_id).await
}

#[tauri::command]
pub async fn marketplace_post_comment(
    app: AppHandle,
    catalog: State<'_, Catalog>,
    entitlement: State<'_, Entitlement>,
    recipe_id: String,
    text: String,
) -> Result<()> {
    let account = LiveAccount {
        app: &app,
        entitlement: &entitlement,
    };
    catalog.post_comment(&account, &recipe_id, &text).await
}

#[tauri::command]
pub async fn marketplace_delete_comment(
    app: AppHandle,
    catalog: State<'_, Catalog>,
    entitlement: State<'_, Entitlement>,
    comment_id: String,
) -> Result<()> {
    let account = LiveAccount {
        app: &app,
        entitlement: &entitlement,
    };
    catalog.delete_comment(&account, &comment_id).await
}

#[tauri::command]
pub async fn marketplace_report_comment(
    catalog: State<'_, Catalog>,
    comment_id: String,
) -> Result<()> {
    catalog.report_comment(&comment_id).await
}

#[tauri::command]
pub fn marketplace_block_commenter(catalog: State<'_, Catalog>, commenter: String) -> Result<()> {
    catalog.block_commenter(&commenter)
}

#[tauri::command]
pub fn marketplace_unblock_commenter(catalog: State<'_, Catalog>, commenter: String) -> Result<()> {
    catalog.unblock_commenter(&commenter)
}

#[tauri::command]
pub fn marketplace_blocked(catalog: State<'_, Catalog>) -> Vec<String> {
    catalog.blocked_commenters()
}

/// The official recipes for this platform, for the first-run quick access step.
#[tauri::command]
pub async fn onboarding_options(
    catalog: State<'_, Catalog>,
    recipes: State<'_, Recipes>,
) -> Result<Vec<OnboardingOption>> {
    catalog.onboarding_options(&recipes).await
}

/// Installs the user's picks and makes them the quick access. The shell then completes
/// onboarding.
#[tauri::command]
pub async fn onboarding_apply(
    app: AppHandle,
    catalog: State<'_, Catalog>,
    recipes: State<'_, Recipes>,
    library: State<'_, Library>,
    entitlement: State<'_, Entitlement>,
    recipe_ids: Vec<String>,
) -> Result<OnboardingResult> {
    let account = LiveAccount {
        app: &app,
        entitlement: &entitlement,
    };
    let result = catalog
        .onboarding_apply(&account, &recipes, &library, &recipe_ids)
        .await?;
    if !result.installed.is_empty() {
        crate::commands::sync_favorite_domains(&app)?;
        reload_script(&app, &library, &recipes)?;
    }
    Ok(result)
}
