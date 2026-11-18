//! The shell's side of importing and of the password vault.
//!
//! The shell sends a file's text once (`import_read`) and receives a preview without passwords.
//! Every vault command except [`vault_unlock`] and [`vault_count_for_page`] needs an unlock window
//! that a device owner check opened ([`Unlock`]); it closes by itself after [`UNLOCK_SECONDS`] and
//! when the app is left ([`vault_lock`]). Commands that touch the page or wait for the owner check
//! are async: the iOS plugin answers from the main thread, so a synchronous command would wait for
//! itself.

use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

use tauri::{AppHandle, Manager, State};
use tauri_plugin_siteview::{AuthenticateRequest, EvaluateRequest, SiteviewExt};
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::commands::Secrets;
use crate::entitlement::Entitlement;
use crate::error::{Error, Result};
use crate::fill;
use crate::import::{self, Choices, ImportResult, ImportState, Preview};
use crate::library::Library;
use crate::recipes::{bundled, current_platform_tag};
use crate::vault::{Meta, Vault};

/// How long the vault stays open after the owner proved they are present.
pub const UNLOCK_SECONDS: u64 = 120;

/// When the vault's unlock window ends, if one is open.
#[derive(Default)]
pub struct Unlock(Mutex<Option<Instant>>);

impl Unlock {
    fn open(&self) {
        if let Ok(mut until) = self.0.lock() {
            *until = Some(Instant::now() + Duration::from_secs(UNLOCK_SECONDS));
        }
    }

    fn close(&self) {
        if let Ok(mut until) = self.0.lock() {
            *until = None;
        }
    }

    fn require(&self) -> Result<()> {
        let open = self
            .0
            .lock()
            .map_err(|_| Error::Poisoned)?
            .is_some_and(|until| Instant::now() < until);
        if open {
            Ok(())
        } else {
            Err(Error::VaultLocked)
        }
    }
}

/// The official recipes for this platform, in the order the preview offers them.
fn official() -> Vec<bundled::Bundled> {
    bundled::all()
        .iter()
        .filter(|b| b.is_official() && b.has_tag(current_platform_tag()))
        .cloned()
        .collect()
}

/// Reads one exported file's text and returns what is pending from all the files so far.
#[tauri::command]
pub fn import_read(state: State<'_, ImportState>, text: String) -> Result<Preview> {
    state.absorb(&text)?;
    state.preview(&official())
}

/// Forgets every pending file.
#[tauri::command]
pub fn import_cancel(state: State<'_, ImportState>) {
    state.cancel();
}

/// Does what the person ticked in the preview.
#[tauri::command]
pub async fn import_apply(
    app: AppHandle,
    state: State<'_, ImportState>,
    library: State<'_, Library>,
    recipes: State<'_, crate::recipes::Recipes>,
    choices: Choices,
) -> Result<ImportResult> {
    let vault = app.state::<Vault>();
    let secrets = app.state::<Secrets>();
    let entitlement = app.state::<Entitlement>();
    let official = official();
    let install = |id: &str| crate::recipe_library::install(&recipes, id);
    let result = import::apply(
        &state,
        &import::Targets {
            library: &library,
            vault: &vault,
            secrets: secrets.0.as_ref(),
            official: &official,
            pro: entitlement.require_pro().is_ok(),
            install: &install,
        },
        &choices,
    )?;
    if result.recipes > 0 {
        crate::commands::reload_script(&app, &library, &recipes)?;
    }
    Ok(result)
}

/// Asks the device owner to prove they are present and opens the unlock window. `false` means
/// they cancelled or failed.
#[tauri::command]
pub async fn vault_unlock(
    app: AppHandle,
    unlock: State<'_, Unlock>,
    reason: String,
) -> Result<bool> {
    if !app
        .siteview()
        .authenticate(AuthenticateRequest { reason })?
    {
        return Ok(false);
    }
    unlock.open();
    Ok(true)
}

/// Closes the unlock window now.
#[tauri::command]
pub fn vault_lock(unlock: State<'_, Unlock>) {
    unlock.close();
}

/// Every saved login without its password.
#[tauri::command]
pub fn vault_list(
    unlock: State<'_, Unlock>,
    vault: State<'_, Vault>,
    secrets: State<'_, Secrets>,
) -> Result<Vec<Meta>> {
    unlock.require()?;
    vault.list(secrets.0.as_ref())
}

/// How many logins are saved for the page's site: a number and nothing else, so the shell can
/// offer a fill button without an owner check.
#[tauri::command]
pub fn vault_count_for_page(
    vault: State<'_, Vault>,
    secrets: State<'_, Secrets>,
    url: String,
) -> Result<usize> {
    let Some(page) = fill::page_origin(&url) else {
        return Ok(0);
    };
    vault.count_for_site(secrets.0.as_ref(), &page.site)
}

/// The logins that may be filled into the page, without passwords.
#[tauri::command]
pub fn vault_matches(
    unlock: State<'_, Unlock>,
    vault: State<'_, Vault>,
    secrets: State<'_, Secrets>,
    url: String,
) -> Result<Vec<Meta>> {
    unlock.require()?;
    let Some(page) = fill::page_origin(&url) else {
        return Ok(Vec::new());
    };
    Ok(vault
        .list(secrets.0.as_ref())?
        .into_iter()
        .filter(|meta| fill::allowed(&meta.origin, &meta.site, &page))
        .collect())
}

/// One password, to show on the person's screen.
#[tauri::command]
pub fn vault_reveal(
    unlock: State<'_, Unlock>,
    vault: State<'_, Vault>,
    secrets: State<'_, Secrets>,
    id: Uuid,
) -> Result<String> {
    unlock.require()?;
    let entry = vault
        .get(secrets.0.as_ref(), id)?
        .ok_or(Error::Vault("no such login"))?;
    Ok(entry.password.clone())
}

#[tauri::command]
pub fn vault_delete(
    unlock: State<'_, Unlock>,
    vault: State<'_, Vault>,
    secrets: State<'_, Secrets>,
    id: Uuid,
) -> Result<()> {
    unlock.require()?;
    vault.delete(secrets.0.as_ref(), id)
}

/// Forgets every login and the key that sealed them.
#[tauri::command]
pub fn vault_clear(
    unlock: State<'_, Unlock>,
    vault: State<'_, Vault>,
    secrets: State<'_, Secrets>,
) -> Result<()> {
    unlock.require()?;
    unlock.close();
    vault.clear(secrets.0.as_ref())
}

/// Fills a login into the page in front: its username field and its password field, nothing
/// submitted. `url` is the address the shell last heard the page report; the page is asked to
/// agree with it again as the fill happens.
#[tauri::command]
pub async fn vault_fill(
    app: AppHandle,
    unlock: State<'_, Unlock>,
    vault: State<'_, Vault>,
    secrets: State<'_, Secrets>,
    id: Uuid,
    url: String,
) -> Result<fill::Filled> {
    unlock.require()?;
    let page =
        fill::page_origin(&url).ok_or(Error::Vault("logins are filled into secure pages only"))?;
    let entry = vault
        .get(secrets.0.as_ref(), id)?
        .ok_or(Error::Vault("no such login"))?;
    if !fill::allowed(&entry.origin, &entry.site, &page) {
        return Err(Error::Vault("that login is for another site"));
    }
    let password = Zeroizing::new(entry.password.clone());
    let script = fill::script(&page, &entry.username, &password)?;
    let json = app.siteview().evaluate(EvaluateRequest {
        script: script.to_string(),
        page_world: false,
    })?;
    Ok(fill::parse_result(&json))
}
