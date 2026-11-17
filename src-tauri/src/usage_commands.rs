//! The commands behind the daily site limits: the policies the user set, and the native block
//! that closes a site for the day.
//!
//! These are app commands, not plugin commands, so no capability reaches them from a site view.
//! The plugin's own block method is Rust-only: the plugin registers no command for it, so the
//! shell cannot call it either. Only the app decides that a site is closed.
//!
//! The settings lock is enforced here and in `Usage`, not in the shell: every command that can
//! relax a limit, a schedule, a pause screen or a protected recipe option goes through the lock,
//! so a modified shell gets the same refusal.

use tauri::{AppHandle, State};
use tauri_plugin_siteview::{
    AuthenticateRequest, SetBlockedRequest, SiteviewExt, validate::parse_session_id,
};

use crate::entitlement::Entitlement;
use crate::error::{Error, Result};
use crate::library::{Library, Mode};
use crate::recipes::Recipes;
use crate::schedule::Schedule;
use crate::usage::{Usage, UsageLimits, UsagePolicy};
use crate::usage_lock::LockStatus;

/// The daily warning and limit of every site and every part of a site the user set one for.
#[tauri::command]
pub fn get_usage_limits(
    usage: State<'_, Usage>,
    entitlement: State<'_, Entitlement>,
) -> Result<UsageLimits> {
    entitlement.require_pro()?;
    usage.limits()
}

/// Saves the daily warning and limit for one site and returns every limit. A policy with
/// neither step removes the site's policy, which is how a limit is lifted.
#[tauri::command]
pub fn set_usage_limit(
    usage: State<'_, Usage>,
    entitlement: State<'_, Entitlement>,
    host: String,
    policy: UsagePolicy,
) -> Result<UsageLimits> {
    entitlement.require_pro()?;
    usage.set_limit(&host, policy)
}

/// Saves the daily warning and limit for one part of a site, such as Reels inside Instagram,
/// and returns every limit. A policy with neither step removes the part's policy, which is how
/// a limit is lifted.
#[tauri::command]
pub fn set_usage_section_limit(
    usage: State<'_, Usage>,
    entitlement: State<'_, Entitlement>,
    host: String,
    section: String,
    policy: UsagePolicy,
) -> Result<UsageLimits> {
    entitlement.require_pro()?;
    usage.set_section_limit(&host, &section, policy)
}

/// Closes one open site for the day, or opens it again. The block is native: a shield covers
/// the page, the page takes no touches, stops loading and stops playing media, and every
/// navigation it asks for is refused, so it cannot work around the block or open another site
/// in its place.
///
/// Async because the plugin waits for native code that needs the main thread: a synchronous
/// command would deadlock the app.
#[tauri::command]
pub async fn set_usage_blocked(
    app: AppHandle,
    entitlement: State<'_, Entitlement>,
    session: String,
    blocked: bool,
) -> Result<()> {
    if blocked {
        entitlement.require_pro()?;
    }
    parse_session_id(&session)?;
    app.siteview()
        .set_blocked(SetBlockedRequest { session, blocked })?;
    Ok(())
}

/// Saves the downtime schedule of one site and returns every limit. A schedule without windows
/// removes it. The shell passes its local date and time when it enforces the schedule, so Rust
/// keeps no time zone.
#[tauri::command]
pub fn set_usage_schedule(
    usage: State<'_, Usage>,
    entitlement: State<'_, Entitlement>,
    host: String,
    schedule: Schedule,
) -> Result<UsageLimits> {
    entitlement.require_pro()?;
    usage.set_schedule(&host, schedule)
}

/// Saves the pause-screen delay of one site, or removes it with `null`, and returns every limit.
#[tauri::command]
pub fn set_usage_pause(
    usage: State<'_, Usage>,
    entitlement: State<'_, Entitlement>,
    host: String,
    seconds: Option<u32>,
) -> Result<UsageLimits> {
    entitlement.require_pro()?;
    usage.set_pause(&host, seconds)
}

/// Turns pause screens on or off for every site at once and returns every limit.
#[tauri::command]
pub fn set_usage_pause_enabled(
    usage: State<'_, Usage>,
    entitlement: State<'_, Entitlement>,
    enabled: bool,
) -> Result<UsageLimits> {
    entitlement.require_pro()?;
    usage.set_pause_enabled(enabled)
}

/// Where the settings lock stands: off, locked, cooling off with the time left, or ready.
#[tauri::command]
pub fn get_usage_lock(
    usage: State<'_, Usage>,
    entitlement: State<'_, Entitlement>,
) -> Result<LockStatus> {
    entitlement.require_pro()?;
    usage.lock_status()
}

/// Turns the settings lock on. It only restricts, so it needs no check.
#[tauri::command]
pub fn enable_usage_lock(
    usage: State<'_, Usage>,
    entitlement: State<'_, Entitlement>,
) -> Result<LockStatus> {
    entitlement.require_pro()?;
    usage.enable_lock()
}

/// Asks the device owner to prove it is them, then starts the 24 hour cooling-off period. `None`
/// means the check was cancelled or failed and nothing changed. Async for the same reason as
/// `set_usage_blocked`.
#[tauri::command]
pub async fn request_usage_unlock(
    app: AppHandle,
    usage: State<'_, Usage>,
    entitlement: State<'_, Entitlement>,
    reason: String,
) -> Result<Option<LockStatus>> {
    entitlement.require_pro()?;
    if !app
        .siteview()
        .authenticate(AuthenticateRequest { reason })?
    {
        return Ok(None);
    }
    usage.request_unlock().map(Some)
}

/// Asks the device owner to prove it is them, then cancels the unlock request and keeps the lock
/// on. `None` means the check was cancelled or failed.
#[tauri::command]
pub async fn cancel_usage_unlock(
    app: AppHandle,
    usage: State<'_, Usage>,
    entitlement: State<'_, Entitlement>,
    reason: String,
) -> Result<Option<LockStatus>> {
    entitlement.require_pro()?;
    if !app
        .siteview()
        .authenticate(AuthenticateRequest { reason })?
    {
        return Ok(None);
    }
    usage.cancel_unlock().map(Some)
}

/// Lifts the lock once the cooling-off period is over, without relaxing anything. Before then it
/// is refused.
#[tauri::command]
pub fn lift_usage_lock(
    usage: State<'_, Usage>,
    entitlement: State<'_, Entitlement>,
) -> Result<LockStatus> {
    entitlement.require_pro()?;
    usage.lift_lock()
}

/// Marks one recipe option protected at the value it has now in the normal set. While the lock is
/// on, the option cannot be changed to another value.
#[tauri::command]
pub fn protect_usage_option(
    usage: State<'_, Usage>,
    library: State<'_, Library>,
    recipes: State<'_, Recipes>,
    entitlement: State<'_, Entitlement>,
    recipe_id: String,
    option_id: String,
) -> Result<LockStatus> {
    entitlement.require_pro()?;
    let choices = library.site_options(Mode::Normal)?;
    let recipe = recipes.get(&recipe_id).ok_or(Error::UnknownOption)?;
    let option = recipe.option(&option_id).ok_or(Error::UnknownOption)?;
    let saved = choices
        .get(&recipe_id)
        .and_then(|saved| saved.get(&option_id));
    let value = option.current(saved).clone();
    usage.protect_option(&recipe_id, &option_id, value)
}

/// Removes the protection mark from one recipe option. While the lock is on this is a relaxation.
#[tauri::command]
pub fn unprotect_usage_option(
    usage: State<'_, Usage>,
    entitlement: State<'_, Entitlement>,
    recipe_id: String,
    option_id: String,
) -> Result<LockStatus> {
    entitlement.require_pro()?;
    usage.unprotect_option(&recipe_id, &option_id)
}
