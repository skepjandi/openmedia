//! Incognito mode: a second set of quick-access favorites and recipe choices, behind a biometric
//! check.
//!
//! Whether incognito is on lives only here, in memory. It is never saved, so every launch starts
//! in the normal set. Turning it on needs the device owner to pass Face ID, Touch ID or the device
//! passcode; turning it off does not, since it only returns to the normal set.
//!
//! These are app commands, not plugin commands, so no capability reaches them from a site view.
//! The check itself is a Rust-only plugin method: the plugin registers no command for it, so the
//! shell cannot raise or answer the prompt either; it can only ask these commands to. The
//! incognito favorites and choices are stored in `library.json` like everything else, so the check
//! is a screen lock for the person holding the phone, not encryption.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager, State};
use tauri_plugin_siteview::{
    AuthenticateRequest, BiometryKind, SetDocumentStartScriptRequest, SiteviewExt,
};

use crate::commands::{current_script, script_for};
use crate::entitlement::Entitlement;
use crate::error::Result;
use crate::library::{Favorite, FavoriteInput, Folder, Library, Mode};
use crate::recipes::Recipes;

#[derive(Default)]
pub struct Incognito {
    active: AtomicBool,
}

impl Incognito {
    pub fn is_active(&self) -> bool {
        self.active.load(Ordering::SeqCst)
    }

    pub fn mode(&self) -> Mode {
        Mode::from(self.is_active())
    }

    fn set_active(&self, active: bool) {
        self.active.store(active, Ordering::SeqCst);
    }
}

/// Puts incognito on or off and gives the open pages the recipe script of the set now in play.
/// The pages reload only when the two sets compile to different scripts, so switching between
/// two identical sets does not flash the page.
fn switch_mode(app: &AppHandle, active: bool) -> Result<()> {
    let library = app.state::<Library>();
    let recipes = app.state::<Recipes>();
    let incognito = app.state::<Incognito>();
    let before = current_script(app, &library, &recipes)?;
    let after = script_for(&library, &recipes, Mode::from(active))?;
    if before != after {
        app.siteview()
            .set_document_start_script(SetDocumentStartScriptRequest { script: after })?;
    }
    incognito.set_active(active);
    Ok(())
}

/// Leaves incognito when the entitlement is gone. Used when Pro is lost, so the private set is
/// not left open behind the paywall.
pub fn leave_incognito(app: &AppHandle) {
    if !app.state::<Incognito>().is_active() {
        return;
    }
    let _ = switch_mode(app, false);
}

/// Which biometric this device has, only so the shell draws Face ID or a fingerprint. Free of
/// charge and without a prompt. A failure counts as a fingerprint, the generic one.
#[tauri::command]
pub async fn biometry_kind(app: AppHandle) -> Result<BiometryKind> {
    Ok(app.siteview().biometry_kind().unwrap_or_default())
}

/// Asks the device owner to prove it is them, without changing anything. Settings uses this
/// before it shows the incognito favorites or recipes. `false` means they cancelled or failed.
///
/// Async because the plugin waits for native code that needs the main thread: a synchronous
/// command would deadlock the app.
#[tauri::command]
pub async fn unlock_incognito(
    app: AppHandle,
    entitlement: State<'_, Entitlement>,
    reason: String,
) -> Result<bool> {
    entitlement.require_pro()?;
    Ok(app
        .siteview()
        .authenticate(AuthenticateRequest { reason })?)
}

/// Turns incognito on after a successful check and returns its quick-access favorites. `None`
/// means the check was cancelled or failed, and nothing changed.
#[tauri::command]
pub async fn enter_incognito(
    app: AppHandle,
    entitlement: State<'_, Entitlement>,
    reason: String,
) -> Result<Option<Vec<Favorite>>> {
    entitlement.require_pro()?;
    if !app
        .siteview()
        .authenticate(AuthenticateRequest { reason })?
    {
        return Ok(None);
    }
    switch_mode(&app, true)?;
    Ok(Some(app.state::<Library>().incognito_favorites()?))
}

/// Back to the normal set. No check: nothing private is shown by leaving.
#[tauri::command]
pub async fn exit_incognito(app: AppHandle) -> Result<()> {
    app.state::<crate::downloads::Manager>().purge_private();
    switch_mode(&app, false)
}

#[tauri::command(async)]
pub fn get_incognito_favorites(
    library: State<'_, Library>,
    entitlement: State<'_, Entitlement>,
) -> Result<Vec<Favorite>> {
    entitlement.require_pro()?;
    library.incognito_favorites()
}

/// Replaces the incognito favorites and returns them, validated and with their icons.
#[tauri::command(async)]
pub fn set_incognito_favorites(
    library: State<'_, Library>,
    entitlement: State<'_, Entitlement>,
    favorites: Vec<FavoriteInput>,
) -> Result<Vec<Favorite>> {
    entitlement.require_pro()?;
    library.set_incognito_favorites(favorites)
}

/// The incognito folders, handed out only after a biometric check.
#[tauri::command(async)]
pub fn get_incognito_folders(
    library: State<'_, Library>,
    entitlement: State<'_, Entitlement>,
) -> Result<Vec<Folder>> {
    entitlement.require_pro()?;
    library.folders(Mode::Incognito)
}

/// Replaces the incognito folders and returns them, validated.
#[tauri::command(async)]
pub fn set_incognito_folders(
    library: State<'_, Library>,
    entitlement: State<'_, Entitlement>,
    folders: Vec<Folder>,
) -> Result<Vec<Folder>> {
    entitlement.require_pro()?;
    library.set_folders(Mode::Incognito, folders)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn incognito_starts_off_and_follows_the_switch() {
        let incognito = Incognito::default();
        assert!(!incognito.is_active());
        assert_eq!(incognito.mode(), Mode::Normal);
        incognito.set_active(true);
        assert_eq!(incognito.mode(), Mode::Incognito);
        incognito.set_active(false);
        assert_eq!(incognito.mode(), Mode::Normal);
    }

    #[test]
    fn the_two_sets_give_the_page_different_scripts_only_when_their_choices_differ() {
        let recipes = Recipes::official_installed();
        let normal = crate::recipes::OptionChoices::new();
        let incognito = crate::recipes::OptionChoices::from([(
            "market.official.youtube".to_owned(),
            [(
                "shorts".to_owned(),
                crate::recipes::OptionValue::Toggle(true),
            )]
            .into(),
        )]);
        assert_eq!(
            recipes.script(&normal).unwrap(),
            recipes.script(&normal).unwrap()
        );
        assert_ne!(
            recipes.script(&normal).unwrap(),
            recipes.script(&incognito).unwrap()
        );
    }
}
