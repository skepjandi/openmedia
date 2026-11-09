use std::collections::BTreeMap;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_siteview::{
    ContentRuleList, EvaluateRequest, FetchFaviconRequest, OpenRequest, Rect, SessionRequest,
    SetContentRuleListsRequest, SetDocumentStartScriptRequest, SetRectRequest, SiteviewExt,
    validate::{parse_session_id, parse_web_url},
};
use url::Url;
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::ad_block::AdBlock;
use crate::ai::{
    ProviderConfig, ProviderInput,
    agent::{
        self, Accepted, Agent, Model, Page, PrepareInput, PreparedRequest, Proposal, RecipeContext,
    },
    connection::{list_models, models_request},
    prompt::Prompt,
    provider, validate_key,
};
use crate::boot::{Boot, Startup};
use crate::entitlement::Entitlement;
use crate::error::{Error, Result};
use crate::incognito::Incognito;
use crate::library::{Favorite, FavoriteInput, Library, Mode, SearchEngine, Theme};
use crate::recipes::Recipes;
use crate::secrets::SecretStore;
use crate::sites::{self, SiteSettings};
use crate::usage::{Usage, UsageReport};

/// The secret store, behind a trait so tests can swap it.
pub struct Secrets(pub Box<dyn SecretStore>);

/// Async so it runs off the main thread: at launch that thread is busy creating web views.
#[tauri::command]
pub async fn get_state(library: State<'_, Library>, boot: State<'_, Boot>) -> Result<Startup> {
    Ok(Startup {
        state: library.state()?,
        boot_session: boot.session(),
    })
}

#[tauri::command]
pub fn set_favorites(
    library: State<'_, Library>,
    favorites: Vec<FavoriteInput>,
) -> Result<Vec<Favorite>> {
    library.set_favorites(favorites)
}

/// Adds a recipe's site to the favorites, or removes it; returns the new list.
#[tauri::command]
pub fn set_site_favorite(
    library: State<'_, Library>,
    recipes: State<'_, Recipes>,
    recipe_id: String,
    favorite: bool,
) -> Result<Vec<Favorite>> {
    let inputs = sites::with_site_favorite(&recipes, &library.favorites()?, &recipe_id, favorite)?;
    library.set_favorites(inputs)
}

/// Remembers the page for the next launch, except while incognito: a restart is always back in
/// the normal set, so an incognito page must never be what it reopens.
#[tauri::command(async)]
pub fn set_last_url(
    library: State<'_, Library>,
    incognito: State<'_, Incognito>,
    url: String,
) -> Result<()> {
    if incognito.is_active() {
        return Ok(());
    }
    library.set_last_url(&url)
}

/// Records an address the user typed; returns the history, newest first. Nothing is recorded
/// while incognito.
#[tauri::command(async)]
pub fn add_history(
    library: State<'_, Library>,
    incognito: State<'_, Incognito>,
    url: String,
) -> Result<Vec<String>> {
    if incognito.is_active() {
        return library.history();
    }
    library.add_history(&url)
}

/// Forgets every searched address and the remembered last page.
#[tauri::command]
pub fn clear_history(library: State<'_, Library>) -> Result<()> {
    library.clear_history()
}

/// Adds seconds spent in one section of a site to the local usage stats for `day` (the shell's
/// local date). Shell-only: site webviews have no IPC.
#[tauri::command(async)]
pub fn record_usage(
    usage: State<'_, Usage>,
    day: String,
    host: String,
    section: String,
    seconds: u32,
) -> Result<()> {
    usage.record(&day, &host, &section, seconds)
}

/// Totals for the last `days` days ending at `today`, with bundled recipe names for known sites.
#[tauri::command]
pub fn get_usage(
    usage: State<'_, Usage>,
    recipes: State<'_, Recipes>,
    entitlement: State<'_, Entitlement>,
    today: String,
    days: u32,
) -> Result<UsageReport> {
    entitlement.require_pro()?;
    let mut report = usage.report(&today, days)?;
    for site in &mut report.sites {
        site.name = Url::parse(&format!("https://{}/", site.host))
            .ok()
            .and_then(|url| recipes.for_url(&url).map(|recipe| recipe.name.clone()));
    }
    Ok(report)
}

/// Wipes every recorded usage second.
#[tauri::command]
pub fn clear_usage(usage: State<'_, Usage>) -> Result<()> {
    usage.clear()
}

#[tauri::command]
pub fn complete_onboarding(library: State<'_, Library>) -> Result<()> {
    library.set_onboarded(true)
}

#[tauri::command]
pub fn reset_onboarding(library: State<'_, Library>) -> Result<()> {
    library.set_onboarded(false)
}

#[tauri::command]
pub fn set_theme(library: State<'_, Library>, theme: Theme) -> Result<()> {
    library.set_theme(theme)
}

/// Remembers the language the user picked. `None` puts the app back on the device's language.
#[tauri::command]
pub fn set_locale(library: State<'_, Library>, locale: Option<String>) -> Result<()> {
    library.set_locale(locale)
}

/// Remembers which search engine the command bar uses for text that is not an address.
#[tauri::command]
pub fn set_search_engine(library: State<'_, Library>, engine: SearchEngine) -> Result<()> {
    library.set_search_engine(engine)
}

/// Reads the local favicon cache without making a network request.
#[tauri::command]
pub fn get_icons(library: State<'_, Library>) -> Result<BTreeMap<String, String>> {
    library.icons()
}

/// Fetches missing icons only when sites are added or entered in history.
#[tauri::command]
pub async fn refresh_icons(
    app: AppHandle,
    library: State<'_, Library>,
    urls: Vec<String>,
) -> Result<BTreeMap<String, String>> {
    for (host, url) in library.missing_icons(&urls)? {
        if let Ok(Some(icon)) = app.siteview().fetch_favicon(FetchFaviconRequest { url }) {
            library.set_icon(&host, &icon)?;
        }
    }
    library.icons_for(&urls)
}

/// The site view reports its errors on this event; the shell shows them in a banner.
const SITE_ERROR_EVENT: &str = "siteview:error";

/// Builds the rule lists on a blocking thread: the first run converts the bundled lists, which
/// parses several megabytes.
async fn build_rule_lists(ad_block: &AdBlock) -> Result<Vec<ContentRuleList>> {
    let ad_block = ad_block.clone();
    tauri::async_runtime::spawn_blocking(move || ad_block.rule_lists())
        .await
        .map_err(|e| Error::AdBlock(e.to_string()))?
}

/// Opens the page in the native site view with the recipe script and the ad-blocking rule lists
/// attached. Every page the shell shows is opened through here: the plugin's own `open` is not
/// granted to it.
///
/// A failure to build the rule lists does not stop browsing; the page opens unblocked and the
/// reason comes back as the `Ok` value, for the caller to tell the shell.
///
/// Plugin calls wait for native code that needs the main thread, so this must never run there.
pub(crate) async fn open_session(
    app: &AppHandle,
    session: String,
    url: String,
    rect: Option<Rect>,
) -> Result<Option<String>> {
    let library = app.state::<Library>();
    let recipes = app.state::<Recipes>();
    parse_session_id(&session)?;
    parse_web_url(&url)?;
    let mut blocking_failure = None;
    let content_rule_lists = if library.ad_block_enabled()? {
        build_rule_lists(&app.state::<AdBlock>())
            .await
            .unwrap_or_else(|e| {
                blocking_failure = Some(e.to_string());
                Vec::new()
            })
    } else {
        Vec::new()
    };
    app.siteview().open(OpenRequest {
        session,
        profile: library.profile_id()?.to_string(),
        url,
        rect,
        document_start_script: Some(current_script(app, &library, &recipes)?),
        content_rule_lists,
    })?;
    Ok(blocking_failure)
}

fn report_site_error(app: &AppHandle, message: Option<String>) {
    if let Some(message) = message {
        let _ = app.emit(SITE_ERROR_EVENT, message);
    }
}

/// Opens a page as a new session; earlier sessions stay open underneath it. Async for the reason
/// given at `open_session`: a synchronous command runs on the main thread and would deadlock.
#[tauri::command]
pub async fn open_site(app: AppHandle, session: String, url: String, rect: Rect) -> Result<()> {
    let warning = open_session(&app, session, url, Some(rect)).await?;
    report_site_error(&app, warning);
    Ok(())
}

/// Takes over the page opened at launch (`boot.rs`): waits for its open to finish, gives it the
/// shell's real rectangle and re-announces its state, which the shell was not yet listening for.
/// If there is no such page, or opening it failed, opens `url` as `open_site` would.
#[tauri::command]
pub async fn adopt_boot_session(
    app: AppHandle,
    boot: State<'_, Boot>,
    session: String,
    url: String,
    rect: Rect,
) -> Result<()> {
    let warning = match boot.adopt(&session).await {
        Some(warning) => {
            let plugin = app.siteview();
            plugin.set_rect(SetRectRequest { rect })?;
            plugin.activate(SessionRequest { session })?;
            warning
        }
        None => open_session(&app, session, url, Some(rect)).await?,
    };
    report_site_error(&app, warning);
    Ok(())
}

/// Turns ad blocking on or off. An open page reloads under the new setting. Async for the same
/// reason as `open_site`.
#[tauri::command]
pub async fn set_ad_block(
    app: AppHandle,
    library: State<'_, Library>,
    ad_block: State<'_, AdBlock>,
    enabled: bool,
) -> Result<()> {
    let lists = if enabled {
        build_rule_lists(&ad_block).await?
    } else {
        Vec::new()
    };
    app.siteview()
        .set_content_rule_lists(SetContentRuleListsRequest { lists })?;
    library.set_ad_block(enabled)
}

#[tauri::command(async)]
pub fn get_sites(
    library: State<'_, Library>,
    recipes: State<'_, Recipes>,
    incognito: bool,
) -> Result<Vec<SiteSettings>> {
    let mode = Mode::from(incognito);
    let favorites = match mode {
        Mode::Normal => library.favorites()?,
        Mode::Incognito => library.incognito_favorites()?,
    };
    Ok(sites::site_settings(
        &recipes,
        &library.site_options(mode)?,
        &library.site_bottom_margins()?,
        &favorites,
    ))
}

/// Saves one site toggle in the normal or the incognito set. The open page reloads under the
/// recompiled recipe script only when that set is the one in play. Async for the same reason as
/// `open_site`.
#[tauri::command]
pub async fn set_site_option(
    app: AppHandle,
    library: State<'_, Library>,
    recipes: State<'_, Recipes>,
    recipe_id: String,
    option_id: String,
    enabled: bool,
    incognito: bool,
) -> Result<()> {
    recipes
        .get(&recipe_id)
        .filter(|recipe| recipe.option(&option_id).is_some())
        .ok_or(Error::UnknownOption)?;
    let mode = Mode::from(incognito);
    library.set_site_option(mode, &recipe_id, &option_id, enabled)?;
    if mode == app.state::<Incognito>().mode() {
        reload_script(&app, &library, &recipes)?;
    }
    Ok(())
}

/// The recipe script for the set in play: the normal choices, or the incognito ones.
pub(crate) fn current_script(
    app: &AppHandle,
    library: &Library,
    recipes: &Recipes,
) -> Result<String> {
    recipes.script(&library.site_options(app.state::<Incognito>().mode())?)
}

/// Recompiles the page script from the current recipes and choices and hands it to the open
/// pages.
fn reload_script(app: &AppHandle, library: &Library, recipes: &Recipes) -> Result<()> {
    let script = current_script(app, library, recipes)?;
    app.siteview()
        .set_document_start_script(SetDocumentStartScriptRequest { script })?;
    Ok(())
}

/// Saves a changed copy of a bundled site's recipe (a fork) and applies it. The copy lives in the
/// app data folder, so app updates never overwrite it. Called by the step that accepts the
/// assistant's or the user's change; the recipe is validated in Rust and must be a copy of a
/// bundled recipe with origin `user` or `ai`. Async for the same reason as `open_site`.
#[tauri::command]
pub async fn save_recipe_fork(
    app: AppHandle,
    library: State<'_, Library>,
    recipes: State<'_, Recipes>,
    recipe: String,
) -> Result<()> {
    recipes.save_fork(&recipe)?;
    reload_script(&app, &library, &recipes)
}

/// Drops the user's changed copy so the bundled recipe applies again. Async for the same reason
/// as `open_site`.
#[tauri::command]
pub async fn restore_recipe_original(
    app: AppHandle,
    library: State<'_, Library>,
    recipes: State<'_, Recipes>,
    recipe_id: String,
) -> Result<()> {
    recipes.restore_original(&recipe_id)?;
    reload_script(&app, &library, &recipes)
}

#[tauri::command]
pub fn set_bottom_margin(library: State<'_, Library>, pixels: u32) -> Result<()> {
    library.set_bottom_margin(pixels)
}

/// `pixels: None` returns the site to the shared margin.
#[tauri::command]
pub fn set_site_bottom_margin(
    library: State<'_, Library>,
    recipes: State<'_, Recipes>,
    recipe_id: String,
    pixels: Option<u32>,
) -> Result<()> {
    recipes.get(&recipe_id).ok_or(Error::UnknownOption)?;
    library.set_site_bottom_margin(&recipe_id, pixels)
}

/// The margin to keep under the page at `url`.
#[tauri::command(async)]
pub fn bottom_margin_for(
    library: State<'_, Library>,
    recipes: State<'_, Recipes>,
    url: String,
) -> Result<u32> {
    let url = parse_web_url(&url)?;
    Ok(sites::bottom_margin_for(
        &recipes,
        &library.site_bottom_margins()?,
        library.bottom_margin()?,
        &url,
    ))
}

/// Shows or hides the floating back button. The shell draws it; nothing native changes.
#[tauri::command]
pub fn set_back_button(library: State<'_, Library>, enabled: bool) -> Result<()> {
    library.set_back_button(enabled)
}

/// Turns the "show what will be sent" step of the AI assistant on or off.
#[tauri::command]
pub fn set_ai_preview(
    library: State<'_, Library>,
    entitlement: State<'_, Entitlement>,
    enabled: bool,
) -> Result<()> {
    entitlement.require_pro()?;
    library.set_ai_preview(enabled)
}

/// A provider as the shell sees it: settings plus whether a key exists, never the key itself.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderView {
    #[serde(flatten)]
    config: ProviderConfig,
    has_key: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiState {
    providers: Vec<ProviderView>,
    active_id: Option<Uuid>,
}

fn save_key(library: &Library, store: &dyn SecretStore, id: Uuid, key: &str) -> Result<()> {
    library.provider(id)?;
    validate_key(key)?;
    store.set(id, key)
}

fn forget_provider(library: &Library, store: &dyn SecretStore, id: Uuid) -> Result<()> {
    library.delete_provider(id)?;
    store.delete(id)
}

fn view(secrets: &Secrets, config: ProviderConfig) -> Result<ProviderView> {
    let has_key = secrets.0.exists(config.id)?;
    Ok(ProviderView { config, has_key })
}

#[tauri::command]
pub fn ai_state(library: State<'_, Library>, secrets: State<'_, Secrets>) -> Result<AiState> {
    let settings = library.ai_settings()?;
    Ok(AiState {
        providers: settings
            .providers
            .into_iter()
            .map(|config| view(&secrets, config))
            .collect::<Result<_>>()?,
        active_id: settings.active_id,
    })
}

#[tauri::command]
pub fn ai_save_provider(
    library: State<'_, Library>,
    secrets: State<'_, Secrets>,
    entitlement: State<'_, Entitlement>,
    provider: ProviderInput,
) -> Result<ProviderView> {
    entitlement.require_pro()?;
    view(&secrets, library.upsert_provider(provider)?)
}

#[tauri::command]
pub fn ai_delete_provider(
    library: State<'_, Library>,
    secrets: State<'_, Secrets>,
    id: Uuid,
) -> Result<()> {
    forget_provider(&library, secrets.0.as_ref(), id)
}

/// The key travels shell to Rust once and is written straight to the secure store. It is never
/// returned, logged, or put in an error.
#[tauri::command]
pub fn ai_set_key(
    library: State<'_, Library>,
    secrets: State<'_, Secrets>,
    entitlement: State<'_, Entitlement>,
    id: Uuid,
    key: String,
) -> Result<()> {
    entitlement.require_pro()?;
    save_key(&library, secrets.0.as_ref(), id, &key)
}

#[tauri::command]
pub fn ai_remove_key(
    library: State<'_, Library>,
    secrets: State<'_, Secrets>,
    id: Uuid,
) -> Result<()> {
    library.provider(id)?;
    secrets.0.delete(id)
}

#[tauri::command]
pub fn ai_set_active(
    library: State<'_, Library>,
    entitlement: State<'_, Entitlement>,
    id: Option<Uuid>,
) -> Result<()> {
    entitlement.require_pro()?;
    library.set_active_provider(id)
}

/// Asks the provider for its model list: proves the key works and returns the choices.
#[tauri::command]
pub async fn ai_test(
    library: State<'_, Library>,
    secrets: State<'_, Secrets>,
    entitlement: State<'_, Entitlement>,
    id: Uuid,
) -> Result<Vec<String>> {
    entitlement.require_pro()?;
    let provider = library.provider(id)?;
    let key = secrets.0.get(id)?.ok_or(Error::NoKey)?;
    list_models(models_request(provider.kind, &provider.base_url, &key)).await
}

/// The page the user is looking at, as the assistant reads and previews it. The plugin's
/// `evaluate` is Rust-only: no webview can call it.
struct LivePage<'a>(&'a AppHandle);

impl Page for LivePage<'_> {
    fn evaluate(&self, script: String) -> Result<String> {
        Ok(self.0.siteview().evaluate(EvaluateRequest { script })?)
    }
}

/// The user's active provider. The key is read here, in Rust, and never leaves this struct except
/// inside the provider request.
struct LiveModel {
    config: ProviderConfig,
    key: Zeroizing<String>,
}

impl Model for LiveModel {
    async fn complete(&self, prompt: &Prompt, schema: &serde_json::Value) -> Result<String> {
        provider::complete(&self.config, &self.key, prompt, schema).await
    }
}

fn active_provider(
    library: &Library,
    secrets: &Secrets,
) -> Result<(ProviderConfig, Zeroizing<String>)> {
    let settings = library.ai_settings()?;
    let config = settings
        .active_id
        .and_then(|id| settings.providers.into_iter().find(|p| p.id == id))
        .ok_or_else(|| Error::Connection("Choose an AI provider in Settings first.".to_owned()))?;
    let key = secrets.0.get(config.id)?.ok_or(Error::NoKey)?;
    Ok((config, key))
}

/// Reads the page and builds what would be sent; nothing leaves the device. Async for the same
/// reason as `open_site`.
#[tauri::command]
pub async fn ai_prepare(
    app: AppHandle,
    library: State<'_, Library>,
    recipes: State<'_, Recipes>,
    secrets: State<'_, Secrets>,
    agent: State<'_, Agent>,
    entitlement: State<'_, Entitlement>,
    request: String,
) -> Result<PreparedRequest> {
    entitlement.require_pro()?;
    let (provider, _key) = active_provider(&library, &secrets)?;
    let choices = library.site_options(app.state::<Incognito>().mode())?;
    agent::prepare(
        &agent,
        &LivePage(&app),
        PrepareInput {
            request,
            provider,
            context: |host: &str, path: &str| {
                let base = Url::parse(&format!("https://{host}{path}"))
                    .ok()
                    .and_then(|url| recipes.for_url(&url));
                RecipeContext {
                    base_is_bundled: base
                        .as_ref()
                        .is_some_and(|recipe| recipes.bundled_version(&recipe.id).is_some()),
                    option_states: base
                        .as_ref()
                        .and_then(|recipe| choices.get(&recipe.id).cloned())
                        .unwrap_or_default(),
                    base,
                }
            },
        },
    )
}

/// Sends the prepared request to the user's provider, previews the answer on the page and
/// returns what it would change.
#[tauri::command]
pub async fn ai_send(
    app: AppHandle,
    library: State<'_, Library>,
    secrets: State<'_, Secrets>,
    agent: State<'_, Agent>,
    entitlement: State<'_, Entitlement>,
    id: Uuid,
) -> Result<Proposal> {
    entitlement.require_pro()?;
    let (config, key) = active_provider(&library, &secrets)?;
    agent::send(&agent, &LivePage(&app), &LiveModel { config, key }, id).await
}

/// Saves the previewed change: a new switch in a changed copy of the site's recipe, or a new
/// recipe for a site the app has none for. Then the page reloads under it.
#[tauri::command]
pub async fn ai_accept(
    app: AppHandle,
    library: State<'_, Library>,
    recipes: State<'_, Recipes>,
    agent: State<'_, Agent>,
    entitlement: State<'_, Entitlement>,
    id: Uuid,
) -> Result<()> {
    entitlement.require_pro()?;
    match agent::accept(&agent, &LivePage(&app), id)? {
        Accepted::EnableOption {
            recipe_id,
            option_id,
        } => library.set_site_option(
            app.state::<Incognito>().mode(),
            &recipe_id,
            &option_id,
            true,
        )?,
        Accepted::SaveRecipe(recipe) => {
            recipes.save_made(&recipe)?;
        }
    }
    reload_script(&app, &library, &recipes)
}

/// Takes the preview off the page and forgets the request.
#[tauri::command]
pub async fn ai_reject(app: AppHandle, agent: State<'_, Agent>, id: Uuid) -> Result<()> {
    agent::reject(&agent, &LivePage(&app), id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::ProviderKind;
    use crate::secrets::MemoryStore;

    fn setup() -> (tempfile::TempDir, Library, Secrets, ProviderConfig) {
        let dir = tempfile::tempdir().unwrap();
        let library = Library::load(dir.path().join("library.json")).unwrap();
        let provider = library
            .upsert_provider(ProviderInput {
                id: None,
                name: "Claude".into(),
                kind: ProviderKind::Anthropic,
                base_url: "https://api.anthropic.com".into(),
                model: None,
            })
            .unwrap();
        (
            dir,
            library,
            Secrets(Box::new(MemoryStore::default())),
            provider,
        )
    }

    #[test]
    fn a_saved_key_is_reported_as_present_but_never_serialized() {
        let (_dir, library, secrets, provider) = setup();
        assert!(!view(&secrets, provider.clone()).unwrap().has_key);
        save_key(
            &library,
            secrets.0.as_ref(),
            provider.id,
            "sk-ant-very-secret",
        )
        .unwrap();
        let shown = view(&secrets, provider).unwrap();
        assert!(shown.has_key);
        assert!(
            !serde_json::to_string(&shown)
                .unwrap()
                .contains("very-secret")
        );
    }

    #[test]
    fn the_key_never_reaches_the_library_file() {
        let (dir, library, secrets, provider) = setup();
        save_key(
            &library,
            secrets.0.as_ref(),
            provider.id,
            "sk-ant-very-secret",
        )
        .unwrap();
        let file = std::fs::read_to_string(dir.path().join("library.json")).unwrap();
        assert!(!file.contains("very-secret"));
    }

    #[test]
    fn bad_keys_and_unknown_providers_are_refused() {
        let (_dir, library, secrets, provider) = setup();
        assert!(save_key(&library, secrets.0.as_ref(), provider.id, "two words").is_err());
        assert!(save_key(&library, secrets.0.as_ref(), Uuid::new_v4(), "sk-fine").is_err());
        assert!(!secrets.0.exists(provider.id).unwrap());
    }

    #[test]
    fn deleting_a_provider_deletes_its_key() {
        let (_dir, library, secrets, provider) = setup();
        save_key(&library, secrets.0.as_ref(), provider.id, "sk-ant-abc").unwrap();
        forget_provider(&library, secrets.0.as_ref(), provider.id).unwrap();
        assert!(!secrets.0.exists(provider.id).unwrap());
        assert!(library.provider(provider.id).is_err());
    }
}
