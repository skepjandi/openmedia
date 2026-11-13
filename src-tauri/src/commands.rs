use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, ipc::Channel};
use tauri_plugin_siteview::{
    ColorScheme, ContentRuleList, EvaluateRequest, FetchFaviconRequest, OpenRequest, Rect,
    SessionRequest, SetBackgroundMediaRequest, SetColorSchemeRequest, SetContentRuleListsRequest,
    SetDocumentStartScriptRequest, SetRectRequest, SiteviewExt,
    validate::{parse_session_id, parse_web_url},
};
use url::Url;
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::accessibility::Accessibility;
use crate::ad_block::AdBlock;
use crate::ai::{
    ProviderConfig, ProviderInput,
    activity::Activity,
    agent::{
        self, Accepted, Agent, Model, Page, PrepareInput, PreparedRequest, Proposal, RecipeContext,
    },
    chats::{ChatSession, Chats},
    connection::{list_models, models_request},
    hub::{self, HubProposal, SavedHub},
    prompt::{EarlierTurn, Prompt},
    provider::{self, ModelReply, ToolDefinition, Turn},
    validate_key,
};
use crate::boot::{Boot, Startup};
use crate::entitlement::Entitlement;
use crate::error::{Error, Result};
use crate::incognito::Incognito;
use crate::library::{
    Favorite, FavoriteInput, Library, Mode, SearchEngine, Theme, favorites_need_pro,
};
use crate::recipes::{
    Recipe, Recipes,
    bundled::{self, SearchHit},
};
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
        desktop: cfg!(desktop),
    })
}

/// A free user may not grow the favorites past `FREE_FAVORITE_LIMIT`; see `favorites_need_pro`.
fn check_favorites_allowed(
    library: &Library,
    entitlement: &Entitlement,
    new_count: usize,
) -> Result<()> {
    if favorites_need_pro(library.favorite_count()?, new_count) {
        entitlement.require_pro()?;
    }
    Ok(())
}

#[tauri::command]
pub fn set_favorites(
    library: State<'_, Library>,
    entitlement: State<'_, Entitlement>,
    favorites: Vec<FavoriteInput>,
) -> Result<Vec<Favorite>> {
    check_favorites_allowed(&library, &entitlement, favorites.len())?;
    library.set_favorites(favorites)
}

/// Adds a recipe's site to the favorites, or removes it; returns the new list.
#[tauri::command]
pub fn set_site_favorite(
    library: State<'_, Library>,
    entitlement: State<'_, Entitlement>,
    recipes: State<'_, Recipes>,
    recipe_id: String,
    favorite: bool,
) -> Result<Vec<Favorite>> {
    let inputs = sites::with_site_favorite(&recipes, &library.favorites()?, &recipe_id, favorite)?;
    check_favorites_allowed(&library, &entitlement, inputs.len())?;
    library.set_favorites(inputs)
}

/// Remembers the page for the next launch, except while incognito: a restart is always back in
/// the normal set, so an incognito page must never be what it reopens.
#[tauri::command(async)]
pub fn set_last_url(
    library: State<'_, Library>,
    incognito: State<'_, Incognito>,
    url: String,
    back: Vec<String>,
) -> Result<()> {
    if incognito.is_active() {
        return Ok(());
    }
    library.set_last_url(&url, &back)
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

/// Totals for the last `days` days ending at `today`, with recipe names for sites a recipe covers.
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

/// Opens an address from the shell's own UI (a guide, a legal page) in the system browser. The shell
/// never navigates its own view or a site session for these. https only.
#[tauri::command]
pub fn open_external(app: AppHandle, url: String) -> Result<()> {
    use tauri_plugin_opener::OpenerExt;
    let url = parse_web_url(&url)?;
    if url.scheme() != "https" {
        return Err(Error::Connection(
            "only https addresses open outside the app".into(),
        ));
    }
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|e| Error::Connection(e.to_string()))
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

async fn build_scriptlets(ad_block: &AdBlock, url: String) -> Result<String> {
    let ad_block = AdBlock::clone(ad_block);
    tauri::async_runtime::spawn_blocking(move || ad_block.scriptlets_for_url(&url))
        .await
        .map_err(|error| Error::AdBlock(error.to_string()))?
}

/// Opens the page in the native site view with its recipe script, URL-matched adblock scriptlet,
/// and enabled network/CSS rule lists. Every page the shell shows is opened through here: the
/// plugin's own `open` is not granted to it.
///
/// A failure to build blocker data does not stop browsing; the reason comes back as the `Ok` value
/// for the caller to tell the shell.
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
    let ad_block = app.state::<AdBlock>();
    let ad_block_enabled = library.ad_block_enabled()?;
    let mut blocking_failures = Vec::new();
    let content_rule_lists = if ad_block_enabled {
        build_rule_lists(&ad_block).await.unwrap_or_else(|error| {
            blocking_failures.push(error.to_string());
            Vec::new()
        })
    } else {
        Vec::new()
    };
    let ad_block_scriptlet = match build_scriptlets(&ad_block, url.clone()).await {
        Ok(scriptlet) => Some(scriptlet),
        Err(error) => {
            blocking_failures.push(error.to_string());
            None
        }
    };
    // The page must load under the saved theme: the shell sets it only after it has booted, by
    // which time a page opened at launch has already read `prefers-color-scheme` once, and sites
    // such as Instagram keep parts of the old scheme when it flips mid-load. Platforms with no
    // site view reject this the same way they reject the open below.
    let _ = app.siteview().set_color_scheme(SetColorSchemeRequest {
        scheme: match library.theme()? {
            Theme::System => ColorScheme::System,
            Theme::Light => ColorScheme::Light,
            Theme::Dark => ColorScheme::Dark,
        },
    });
    app.siteview().open(OpenRequest {
        session,
        profile: library.profile_id()?.to_string(),
        url,
        rect,
        document_start_script: Some(current_script(app, &library, &recipes)?),
        ad_block_scriptlet,
        ad_block_enabled,
        content_rule_lists,
    })?;
    let blocking_failure = (!blocking_failures.is_empty()).then(|| blocking_failures.join("; "));
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
        .set_content_rule_lists(SetContentRuleListsRequest { enabled, lists })?;
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

/// The page script for the set in play: its recipes, then the accessibility choices.
pub(crate) fn current_script(
    app: &AppHandle,
    library: &Library,
    recipes: &Recipes,
) -> Result<String> {
    script_for(library, recipes, app.state::<Incognito>().mode())
}

/// The page script for `mode`. The accessibility choices follow the recipes and apply in both sets.
pub(crate) fn script_for(library: &Library, recipes: &Recipes, mode: Mode) -> Result<String> {
    let recipe_script = recipes.script(&library.site_options(mode)?)?;
    Ok(format!(
        "{recipe_script}\n{}",
        library.accessibility()?.page_script()
    ))
}

/// Recompiles the page script from the current recipes and choices and hands it to the open
/// pages.
pub(crate) fn reload_script(app: &AppHandle, library: &Library, recipes: &Recipes) -> Result<()> {
    let script = current_script(app, library, recipes)?;
    app.siteview()
        .set_document_start_script(SetDocumentStartScriptRequest { script })?;
    Ok(())
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

/// Lets a site's media keep playing while its page is hidden or the app is in the background, or
/// pauses it again. Every site pauses by default. `site` is a registrable domain.
#[tauri::command]
pub fn set_site_background_media(
    app: AppHandle,
    library: State<'_, Library>,
    site: String,
    enabled: bool,
) -> Result<()> {
    let sites = library.set_background_media(&site, enabled)?;
    push_background_media(&app, sites)
}

/// Tells the site views which sites may play in the background; the rest pause when hidden.
pub(crate) fn push_background_media(app: &AppHandle, sites: Vec<String>) -> Result<()> {
    app.siteview()
        .set_background_media(SetBackgroundMediaRequest { sites })?;
    Ok(())
}

/// Shows or hides the floating back button. The shell draws it; nothing native changes.
#[tauri::command]
pub fn set_back_button(library: State<'_, Library>, enabled: bool) -> Result<()> {
    library.set_back_button(enabled)
}

/// Saves the accessibility choices. The open pages take them at once, as with a recipe switch,
/// so this is async for the reason given at `open_site`.
#[tauri::command]
pub async fn set_accessibility(
    app: AppHandle,
    library: State<'_, Library>,
    recipes: State<'_, Recipes>,
    accessibility: Accessibility,
) -> Result<()> {
    library.set_accessibility(accessibility)?;
    reload_script(&app, &library, &recipes)
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
    let before = provider.id.and_then(|id| library.provider(id).ok());
    let saved = library.upsert_provider(provider)?;
    // A stored key belongs to the endpoint it was entered for: pointing the provider elsewhere
    // would send that key to a different host, so it has to be entered again.
    if before.is_some_and(|before| before.base_url != saved.base_url || before.kind != saved.kind) {
        secrets.0.delete(saved.id)?;
    }
    view(&secrets, saved)
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

/// What the shell sends with a request: the words, and the earlier turns of the chat it
/// continues (only the user's own words and how each ended).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    request: String,
    #[serde(default)]
    earlier: Vec<EarlierTurn>,
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
    chat: ChatRequest,
) -> Result<PreparedRequest> {
    entitlement.require_pro()?;
    let (provider, _key) = active_provider(&library, &secrets)?;
    let choices = library.site_options(app.state::<Incognito>().mode())?;
    agent::prepare(
        &agent,
        &LivePage(&app),
        PrepareInput {
            request: chat.request,
            earlier: chat.earlier,
            provider,
            context: |host: &str, path: &str| {
                let base = Url::parse(&format!("https://{host}{path}"))
                    .ok()
                    .and_then(|url| recipes.for_url(&url));
                RecipeContext {
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
/// returns what it would change. Each step is reported on `on_activity` as it happens, so the
/// shell can show the work while the model answers.
#[tauri::command]
pub async fn ai_send(
    app: AppHandle,
    library: State<'_, Library>,
    secrets: State<'_, Secrets>,
    agent: State<'_, Agent>,
    entitlement: State<'_, Entitlement>,
    id: Uuid,
    on_activity: Channel<Activity>,
) -> Result<Proposal> {
    entitlement.require_pro()?;
    // Send to the provider the preview named, not whichever one is active now.
    let reviewed = agent.get(id)?.provider;
    let config = library.provider(reviewed.id)?;
    if config != reviewed {
        return Err(Error::Connection(
            "The provider changed since this request was prepared. Ask again.".to_owned(),
        ));
    }
    let key = secrets.0.get(config.id)?.ok_or(Error::NoKey)?;
    agent::send(
        &agent,
        &LivePage(&app),
        &LiveModel { config, key },
        &|step| {
            let _ = on_activity.send(step);
        },
        id,
    )
    .await
}

/// Saves the previewed change as a `custom.` recipe of the user's own; installed recipes are never
/// edited. Then the page reloads under it.
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

/// The bundled recipe library, as the hub builder sees it. It only reads recipes that ship with
/// this build.
struct LiveLibrary;

impl hub::RecipeLibrary for LiveLibrary {
    fn search(&self, query: &str) -> Result<Vec<SearchHit>> {
        Ok(bundled::search(query))
    }

    fn read(&self, id: &str) -> Result<Recipe> {
        bundled::find(id)
            .map(|bundled| bundled.recipe.clone())
            .ok_or_else(|| Error::Library("not in the recipe library".into()))
    }
}

/// The provider, as the hub builder sees it. The key stays in Rust and goes only into the
/// provider request.
struct LiveToolModel {
    config: ProviderConfig,
    key: Zeroizing<String>,
}

impl hub::Model for LiveToolModel {
    async fn complete_with_tools(
        &self,
        system: &str,
        tools: &[ToolDefinition],
        turns: &[Turn],
    ) -> Result<ModelReply> {
        provider::complete_with_tools(&self.config, &self.key, system, tools, turns).await
    }
}

/// Asks the provider for a set of pages to open together as tabs. The model may only look
/// things up with the two read-only recipe tools, and nothing is saved: the answer comes
/// back as a proposal the user has to accept.
#[tauri::command]
pub async fn ai_hub_build(
    library: State<'_, Library>,
    secrets: State<'_, Secrets>,
    hubs: State<'_, hub::Hubs>,
    entitlement: State<'_, Entitlement>,
    request: String,
) -> Result<HubProposal> {
    entitlement.require_pro()?;
    let (config, key) = active_provider(&library, &secrets)?;
    let model = LiveToolModel { config, key };
    hub::build(&hubs, &LiveLibrary, &model, &request).await
}

/// Saves the proposed hub as a `custom.` recipe of the user's own. Installed recipes are never
/// edited, and nothing is saved before this call.
#[tauri::command]
pub async fn ai_hub_accept(
    app: AppHandle,
    library: State<'_, Library>,
    recipes: State<'_, Recipes>,
    hubs: State<'_, hub::Hubs>,
    entitlement: State<'_, Entitlement>,
    id: Uuid,
) -> Result<SavedHub> {
    entitlement.require_pro()?;
    let recipe = hub::accept(&hubs, id)?;
    let saved = recipes.save_made(&recipe)?;
    reload_script(&app, &library, &recipes)?;
    Ok(SavedHub {
        recipe_id: saved.id,
        name: saved.name,
    })
}

/// Forgets the proposal. Nothing was saved, so there is nothing to undo.
#[tauri::command]
pub async fn ai_hub_reject(hubs: State<'_, hub::Hubs>, id: Uuid) -> Result<()> {
    hub::reject(&hubs, id);
    Ok(())
}

/// The saved chats, newest first. Incognito has none: it neither reads nor writes them.
#[tauri::command]
pub fn chat_list(
    chats: State<'_, Chats>,
    incognito: State<'_, Incognito>,
) -> Result<Vec<ChatSession>> {
    if incognito.is_active() {
        return Ok(Vec::new());
    }
    chats.list()
}

/// Saves a chat. Nothing is written in incognito: the chat lives in the shell until it is left.
#[tauri::command]
pub fn chat_save(
    chats: State<'_, Chats>,
    incognito: State<'_, Incognito>,
    session: ChatSession,
) -> Result<()> {
    if incognito.is_active() {
        return Ok(());
    }
    chats.save(session)
}

#[tauri::command]
pub fn chat_delete(chats: State<'_, Chats>, id: Uuid) -> Result<()> {
    chats.delete(id)
}

/// Deletes every saved chat. Not Pro-gated: a user who lets Pro lapse can still erase them.
#[tauri::command]
pub fn chat_clear(chats: State<'_, Chats>) -> Result<()> {
    chats.clear()
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
