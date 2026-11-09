use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
};

use serde::{Deserialize, Serialize};
use tauri_plugin_siteview::validate::parse_web_url;
use uuid::Uuid;

use crate::ai::{AiSettings, MAX_PROVIDERS, ProviderConfig, ProviderInput};
use crate::error::{Error, Result};
use crate::recipes::OptionChoices;
use tauri_plugin_siteview::site::site_of_host;

const FORMAT_VERSION: u32 = 4;
const MAX_HISTORY: usize = 100;
const MAX_FAVORITE_NAME_CHARS: usize = 20;
const MAX_ICON_CHARS: usize = 200_000;
/// The most site icons the app keeps. Each one is a small PNG, so this stays well under a
/// megabyte.
const MAX_ICONS: usize = 200;
/// Enough to clear a home indicator and a tab bar; more would leave no page to look at.
pub const MAX_BOTTOM_MARGIN: u32 = 200;
const ICON_PREFIX: &str = "data:image/png;base64,";

const YOUTUBE_FAVORITE: (&str, &str) = ("YouTube", "https://m.youtube.com/");
const DEFAULT_FAVORITES: [(&str, &str); 5] = [
    ("Instagram", "https://www.instagram.com/"),
    ("Facebook", "https://www.facebook.com/"),
    ("Twitter", "https://twitter.com/"),
    ("Reddit", "https://www.reddit.com/"),
    YOUTUBE_FAVORITE,
];

/// How many favorites a free user can have; more needs Pro. Mirrors `FREE_QUICK_ACCESS_LIMIT` in
/// the shell, which shows the Pro slots grayed out.
pub const FREE_FAVORITE_LIMIT: usize = 4;

/// True when saving `new` favorites over `current` grows the list past what a free user may have.
/// A list already longer than the limit (Pro lapsed, or the five defaults) can still shrink, be
/// reordered or edited; it just cannot grow.
pub fn favorites_need_pro(current: usize, new: usize) -> bool {
    new > FREE_FAVORITE_LIMIT && new > current
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
}

/// The search engine the command bar uses for text that is not an address. The shell owns the
/// address of each one; Rust only remembers which was picked.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SearchEngine {
    #[default]
    DuckDuckGo,
    Google,
    Bing,
    Brave,
    Ecosia,
    Startpage,
    Yahoo,
}

/// Which set of favorites and recipe choices is in play. Incognito is the second, separate set
/// the user switches to; nothing in it shows in the normal one, or the other way round.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Normal,
    Incognito,
}

impl From<bool> for Mode {
    fn from(incognito: bool) -> Self {
        if incognito {
            Self::Incognito
        } else {
            Self::Normal
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Favorite {
    pub id: Uuid,
    pub name: String,
    pub url: String,
    /// A small PNG `data:` URL fetched from the site itself; filled in when the state is read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FavoriteInput {
    pub name: String,
    pub url: String,
}

/// Everything the shell needs at startup.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    pub profile_id: Uuid,
    pub favorites: Vec<Favorite>,
    pub history: Vec<String>,
    pub last_url: Option<String>,
    pub onboarded: bool,
    pub theme: Theme,
    pub ad_block: bool,
    /// Pixels kept clear under every page, unless the site has its own.
    pub bottom_margin: u32,
    pub back_button: bool,
    /// Show the exact AI payload and ask before sending it.
    pub ai_preview: bool,
    /// The language the user picked, as a BCP 47 tag. `None` follows the device's language.
    pub locale: Option<String>,
    /// The engine the command bar searches with.
    pub search_engine: SearchEngine,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LibraryData {
    version: u32,
    profile_id: Uuid,
    favorites: Vec<Favorite>,
    last_url: Option<String>,
    #[serde(default)]
    onboarded: bool,
    #[serde(default)]
    theme: Theme,
    /// On by default; the shell can turn blocking off.
    #[serde(default = "enabled")]
    ad_block: bool,
    /// Toggles the user changed, by recipe id and then option id. Anything absent keeps the
    /// recipe's default, so shipping a recipe with a new option needs no migration.
    #[serde(default)]
    site_options: OptionChoices,
    /// Recipe toggles for incognito mode, kept apart from `site_options`. Stored on the device
    /// like every other setting: the biometric check is a screen lock, not encryption.
    #[serde(default)]
    incognito_site_options: OptionChoices,
    /// The quick-access set shown while incognito. Never in `AppState`; the shell asks for it
    /// after a biometric check.
    #[serde(default)]
    incognito_favorites: Vec<Favorite>,
    #[serde(default)]
    bottom_margin: u32,
    /// Per-site bottom margins by recipe id; a site without an entry uses `bottom_margin`.
    #[serde(default)]
    site_bottom_margins: BTreeMap<String, u32>,
    /// Off by default; the shell can show a floating back button over the page.
    #[serde(default)]
    back_button: bool,
    /// On by default: the assistant shows what it will send and waits for the user.
    #[serde(default = "enabled")]
    ai_preview: bool,
    /// Site icons by host. They come from the sites themselves and hold nothing private.
    #[serde(default)]
    icons: BTreeMap<String, String>,
    /// Addresses the user typed, newest first.
    #[serde(default)]
    history: Vec<String>,
    /// Provider settings without keys; keys live in the OS secure store.
    #[serde(default)]
    ai: AiSettings,
    /// The language the user picked, as a BCP 47 tag. `None` follows the device's language.
    /// The shell owns the list of languages, so an unknown tag is kept but never used.
    #[serde(default)]
    locale: Option<String>,
    /// DuckDuckGo until the user picks another.
    #[serde(default)]
    search_engine: SearchEngine,
}

/// The user's favorites, page, theme and provider settings, persisted as one JSON file. Holds no
/// secrets and no cookies: site sessions live in the native data store of `profile_id`, and API
/// keys in the OS secure store.
pub struct Library {
    path: PathBuf,
    data: Mutex<LibraryData>,
}

impl Library {
    pub fn load(path: PathBuf) -> Result<Self> {
        let (data, needs_save) = match fs::read_to_string(&path) {
            Ok(text) => parse(&text)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (default_data(), true),
            Err(e) => return Err(e.into()),
        };
        let library = Self {
            path,
            data: Mutex::new(data),
        };
        if needs_save {
            let data = library.lock()?;
            library.save(&data)?;
        }
        Ok(library)
    }

    pub fn profile_id(&self) -> Result<Uuid> {
        Ok(self.lock()?.profile_id)
    }

    /// The page to open at launch: the last page the user was on, else the first favorite. An
    /// address that no longer parses is skipped, so a damaged file cannot leave the app empty.
    pub fn start_url(&self) -> Result<Option<String>> {
        let data = self.lock()?;
        Ok(data
            .last_url
            .iter()
            .chain(data.favorites.iter().map(|favorite| &favorite.url))
            .find(|url| parse_web_url(url).is_ok())
            .cloned())
    }

    pub fn state(&self) -> Result<AppState> {
        let data = self.lock()?;
        Ok(AppState {
            profile_id: data.profile_id,
            favorites: with_icons(&data, &data.favorites),
            history: data.history.clone(),
            last_url: data.last_url.clone(),
            onboarded: data.onboarded,
            theme: data.theme,
            ad_block: data.ad_block,
            bottom_margin: data.bottom_margin,
            back_button: data.back_button,
            ai_preview: data.ai_preview,
            locale: data.locale.clone(),
            search_engine: data.search_engine,
        })
    }

    /// Remembers the language the user picked. `None` puts the app back on the device's language.
    pub fn set_locale(&self, locale: Option<String>) -> Result<()> {
        let mut data = self.lock()?;
        data.locale = locale;
        self.save(&data)
    }

    pub fn set_search_engine(&self, engine: SearchEngine) -> Result<()> {
        let mut data = self.lock()?;
        data.search_engine = engine;
        self.save(&data)
    }

    pub fn set_favorites(&self, inputs: Vec<FavoriteInput>) -> Result<Vec<Favorite>> {
        let favorites = inputs
            .into_iter()
            .map(favorite_from_input)
            .collect::<Result<Vec<_>>>()?;
        let mut data = self.lock()?;
        data.favorites = favorites;
        self.save(&data)?;
        Ok(with_icons(&data, &data.favorites))
    }

    /// The incognito quick-access set, icons filled in. Handed out only after a biometric check.
    pub fn incognito_favorites(&self) -> Result<Vec<Favorite>> {
        let data = self.lock()?;
        Ok(with_icons(&data, &data.incognito_favorites))
    }

    pub fn set_incognito_favorites(&self, inputs: Vec<FavoriteInput>) -> Result<Vec<Favorite>> {
        let favorites = inputs
            .into_iter()
            .map(favorite_from_input)
            .collect::<Result<Vec<_>>>()?;
        let mut data = self.lock()?;
        data.incognito_favorites = favorites;
        self.save(&data)?;
        Ok(with_icons(&data, &data.incognito_favorites))
    }

    pub fn set_last_url(&self, url: &str) -> Result<()> {
        let url = parse_web_url(url)?.to_string();
        let mut data = self.lock()?;
        data.last_url = Some(url);
        self.save(&data)
    }

    /// The addresses the user typed, newest first.
    pub fn history(&self) -> Result<Vec<String>> {
        Ok(self.lock()?.history.clone())
    }

    /// Remembers an address the user typed, newest first. A repeat moves to the front rather than
    /// listing twice; the list is capped.
    pub fn add_history(&self, url: &str) -> Result<Vec<String>> {
        let url = parse_web_url(url)?.to_string();
        let mut data = self.lock()?;
        data.history.retain(|seen| *seen != url);
        data.history.insert(0, url);
        data.history.truncate(MAX_HISTORY);
        self.save(&data)?;
        Ok(data.history.clone())
    }

    /// Forgets the searched addresses and the remembered last page, like a browser's "clear
    /// history". Favorites, cookies and settings are untouched.
    pub fn clear_history(&self) -> Result<()> {
        let mut data = self.lock()?;
        data.history.clear();
        data.last_url = None;
        prune_icons(&mut data);
        self.save(&data)
    }

    pub fn set_onboarded(&self, onboarded: bool) -> Result<()> {
        let mut data = self.lock()?;
        data.onboarded = onboarded;
        self.save(&data)
    }

    pub fn set_theme(&self, theme: Theme) -> Result<()> {
        let mut data = self.lock()?;
        data.theme = theme;
        self.save(&data)
    }

    pub fn ad_block_enabled(&self) -> Result<bool> {
        Ok(self.lock()?.ad_block)
    }

    pub fn set_ad_block(&self, enabled: bool) -> Result<()> {
        let mut data = self.lock()?;
        data.ad_block = enabled;
        self.save(&data)
    }

    pub fn site_options(&self, mode: Mode) -> Result<OptionChoices> {
        let data = self.lock()?;
        Ok(match mode {
            Mode::Normal => data.site_options.clone(),
            Mode::Incognito => data.incognito_site_options.clone(),
        })
    }

    /// Records one toggle in the given mode's choices. The caller has already checked that the
    /// recipe and option exist.
    pub fn set_site_option(
        &self,
        mode: Mode,
        recipe: &str,
        option: &str,
        enabled: bool,
    ) -> Result<()> {
        let mut data = self.lock()?;
        let choices = match mode {
            Mode::Normal => &mut data.site_options,
            Mode::Incognito => &mut data.incognito_site_options,
        };
        choices
            .entry(recipe.to_owned())
            .or_default()
            .insert(option.to_owned(), enabled);
        self.save(&data)
    }

    pub fn bottom_margin(&self) -> Result<u32> {
        Ok(self.lock()?.bottom_margin)
    }

    pub fn set_bottom_margin(&self, pixels: u32) -> Result<()> {
        let pixels = checked_margin(pixels)?;
        let mut data = self.lock()?;
        data.bottom_margin = pixels;
        self.save(&data)
    }

    pub fn site_bottom_margins(&self) -> Result<BTreeMap<String, u32>> {
        Ok(self.lock()?.site_bottom_margins.clone())
    }

    /// `None` returns the site to the shared margin.
    pub fn set_site_bottom_margin(&self, recipe: &str, pixels: Option<u32>) -> Result<()> {
        let pixels = pixels.map(checked_margin).transpose()?;
        let mut data = self.lock()?;
        match pixels {
            Some(pixels) => data.site_bottom_margins.insert(recipe.to_owned(), pixels),
            None => data.site_bottom_margins.remove(recipe),
        };
        self.save(&data)
    }

    pub fn set_back_button(&self, enabled: bool) -> Result<()> {
        let mut data = self.lock()?;
        data.back_button = enabled;
        self.save(&data)
    }

    pub fn set_ai_preview(&self, enabled: bool) -> Result<()> {
        let mut data = self.lock()?;
        data.ai_preview = enabled;
        self.save(&data)
    }

    /// The pages of `urls` whose site has no cached icon yet, as `(host, page url)`. A site is
    /// known by its domain, so `www.example.com` and `example.com` count as one.
    pub fn missing_icons(&self, urls: &[String]) -> Result<Vec<(String, String)>> {
        let data = self.lock()?;
        let mut missing: Vec<(String, String)> = Vec::new();
        for url in urls {
            let Some(host) = host_of(url) else { continue };
            if icon_for_host(&data, &host).is_some() {
                continue;
            }
            if missing.iter().any(|(known, _)| same_site(known, &host)) {
                continue;
            }
            missing.push((host, url.clone()));
        }
        Ok(missing)
    }

    /// Every icon the app has cached, by host.
    pub fn icons(&self) -> Result<BTreeMap<String, String>> {
        Ok(self.lock()?.icons.clone())
    }

    /// The icons the app has for these pages, by host.
    pub fn icons_for(&self, urls: &[String]) -> Result<BTreeMap<String, String>> {
        let data = self.lock()?;
        let mut icons = BTreeMap::new();
        for url in urls {
            let Some(host) = host_of(url) else { continue };
            if let Some(icon) = icon_for_host(&data, &host) {
                icons.insert(host, icon);
            }
        }
        Ok(icons)
    }

    /// Caches one site's icon. Anything that is not a small PNG data URL is ignored.
    pub fn set_icon(&self, host: &str, data_url: &str) -> Result<()> {
        if !data_url.starts_with(ICON_PREFIX) || data_url.len() > MAX_ICON_CHARS {
            return Ok(());
        }
        let mut data = self.lock()?;
        data.icons.insert(host.to_owned(), data_url.to_owned());
        prune_icons(&mut data);
        self.save(&data)
    }

    pub fn favorite_count(&self) -> Result<usize> {
        Ok(self.lock()?.favorites.len())
    }

    pub fn favorites(&self) -> Result<Vec<Favorite>> {
        let data = self.lock()?;
        Ok(with_icons(&data, &data.favorites))
    }

    /// The host of every favorite, for matching saved data to the sites the user opens.
    pub fn favorite_hosts(&self) -> Result<Vec<String>> {
        let data = self.lock()?;
        Ok(data
            .favorites
            .iter()
            .filter_map(|favorite| host_of(&favorite.url))
            .collect())
    }

    pub fn ai_settings(&self) -> Result<AiSettings> {
        Ok(self.lock()?.ai.clone())
    }

    pub fn provider(&self, id: Uuid) -> Result<ProviderConfig> {
        self.lock()?
            .ai
            .providers
            .iter()
            .find(|p| p.id == id)
            .cloned()
            .ok_or(Error::ProviderNotFound)
    }

    pub fn upsert_provider(&self, input: ProviderInput) -> Result<ProviderConfig> {
        let config = ProviderConfig::from_input(input)?;
        let mut data = self.lock()?;
        match data.ai.providers.iter().position(|p| p.id == config.id) {
            Some(index) => data.ai.providers[index] = config.clone(),
            None if data.ai.providers.len() >= MAX_PROVIDERS => {
                return Err(Error::TooManyProviders(MAX_PROVIDERS));
            }
            None => data.ai.providers.push(config.clone()),
        }
        if data.ai.active_id.is_none() {
            data.ai.active_id = Some(config.id);
        }
        self.save(&data)?;
        Ok(config)
    }

    pub fn delete_provider(&self, id: Uuid) -> Result<()> {
        let mut data = self.lock()?;
        let before = data.ai.providers.len();
        data.ai.providers.retain(|p| p.id != id);
        if data.ai.providers.len() == before {
            return Err(Error::ProviderNotFound);
        }
        if data.ai.active_id == Some(id) {
            data.ai.active_id = data.ai.providers.first().map(|p| p.id);
        }
        self.save(&data)
    }

    pub fn set_active_provider(&self, id: Option<Uuid>) -> Result<()> {
        let mut data = self.lock()?;
        if let Some(id) = id
            && !data.ai.providers.iter().any(|p| p.id == id)
        {
            return Err(Error::ProviderNotFound);
        }
        data.ai.active_id = id;
        self.save(&data)
    }

    fn lock(&self) -> Result<MutexGuard<'_, LibraryData>> {
        self.data.lock().map_err(|_| Error::Poisoned)
    }

    fn save(&self, data: &LibraryData) -> Result<()> {
        write_atomically(&self.path, &serde_json::to_vec_pretty(data)?)?;
        Ok(())
    }
}

fn checked_margin(pixels: u32) -> Result<u32> {
    if pixels > MAX_BOTTOM_MARGIN {
        return Err(Error::InvalidMargin(MAX_BOTTOM_MARGIN));
    }
    Ok(pixels)
}

fn enabled() -> bool {
    true
}

fn host_of(url: &str) -> Option<String> {
    parse_web_url(url).ok().and_then(|u| {
        u.host_str()
            .map(|host| host.trim_end_matches('.').to_owned())
    })
}

/// True for two hosts of one site: the same host, or two of the same domain.
fn same_site(one: &str, other: &str) -> bool {
    one.eq_ignore_ascii_case(other) || site_of_host(one) == site_of_host(other)
}

/// The cached icon for a host: the one stored for it, or the one stored for its domain.
fn icon_for_host(data: &LibraryData, host: &str) -> Option<String> {
    data.icons
        .get(host)
        .or_else(|| data.icons.get(&site_of_host(host)))
        .cloned()
}

/// Drops the icons of sites the user no longer has anywhere, and keeps the cache bounded: the
/// oldest visited sites go first, a favorite's icon (normal or incognito) never does.
fn prune_icons(data: &mut LibraryData) {
    let favorites: Vec<String> = data
        .favorites
        .iter()
        .chain(&data.incognito_favorites)
        .filter_map(|favorite| host_of(&favorite.url))
        .collect();
    let history: Vec<String> = data.history.iter().filter_map(|url| host_of(url)).collect();
    let mut wanted = favorites.clone();
    wanted.extend(history.iter().cloned());
    data.icons
        .retain(|host, _| wanted.iter().any(|keep| same_site(keep, host)));
    for host in history.iter().rev() {
        if data.icons.len() <= MAX_ICONS {
            break;
        }
        if favorites.iter().any(|keep| same_site(keep, host)) {
            continue;
        }
        data.icons.retain(|cached, _| !same_site(cached, host));
    }
}

fn with_icons(data: &LibraryData, favorites: &[Favorite]) -> Vec<Favorite> {
    favorites
        .iter()
        .map(|favorite| Favorite {
            icon: host_of(&favorite.url).and_then(|host| icon_for_host(data, &host)),
            ..favorite.clone()
        })
        .collect()
}

/// The library as stored, and whether reading it changed it so it must be written back.
fn parse(text: &str) -> Result<(LibraryData, bool)> {
    let mut data: LibraryData = serde_json::from_str(text)?;
    match data.version {
        2 => {
            let previous_defaults = &DEFAULT_FAVORITES[..4];
            if data.favorites.len() == previous_defaults.len()
                && data
                    .favorites
                    .iter()
                    .zip(previous_defaults)
                    .all(|(favorite, (name, url))| favorite.name == *name && favorite.url == *url)
            {
                data.favorites.push(favorite_from_input(FavoriteInput {
                    name: YOUTUBE_FAVORITE.0.to_owned(),
                    url: YOUTUBE_FAVORITE.1.to_owned(),
                })?);
            }
        }
        3 | FORMAT_VERSION => {}
        version => return Err(Error::UnsupportedVersion(version)),
    }
    let migrated = data.version != FORMAT_VERSION;
    data.version = FORMAT_VERSION;
    Ok((data, migrated))
}

fn default_data() -> LibraryData {
    LibraryData {
        version: FORMAT_VERSION,
        profile_id: Uuid::new_v4(),
        favorites: DEFAULT_FAVORITES
            .iter()
            .map(|(name, url)| Favorite {
                id: Uuid::new_v4(),
                name: (*name).to_owned(),
                url: (*url).to_owned(),
                icon: None,
            })
            .collect(),
        last_url: None,
        onboarded: false,
        theme: Theme::System,
        ad_block: true,
        site_options: OptionChoices::new(),
        bottom_margin: 0,
        site_bottom_margins: BTreeMap::new(),
        back_button: false,
        ai_preview: true,
        icons: BTreeMap::new(),
        history: Vec::new(),
        ai: AiSettings::default(),
        locale: None,
        search_engine: SearchEngine::DuckDuckGo,
        incognito_site_options: OptionChoices::new(),
        incognito_favorites: Vec::new(),
    }
}

fn favorite_from_input(input: FavoriteInput) -> Result<Favorite> {
    let name = input.name.trim();
    if name.is_empty() || name.chars().count() > MAX_FAVORITE_NAME_CHARS {
        return Err(Error::InvalidFavoriteName);
    }
    Ok(Favorite {
        id: Uuid::new_v4(),
        name: name.to_owned(),
        url: parse_web_url(&input.url)?.to_string(),
        icon: None,
    })
}

pub(crate) fn write_atomically(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, bytes)?;
    fs::rename(&temp, path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::ProviderKind;

    fn library() -> (tempfile::TempDir, Library) {
        let dir = tempfile::tempdir().unwrap();
        let library = Library::load(dir.path().join("library.json")).unwrap();
        (dir, library)
    }

    fn reload(dir: &tempfile::TempDir) -> Library {
        Library::load(dir.path().join("library.json")).unwrap()
    }

    fn input(name: &str, url: &str) -> FavoriteInput {
        FavoriteInput {
            name: name.into(),
            url: url.into(),
        }
    }

    fn provider(name: &str) -> ProviderInput {
        ProviderInput {
            id: None,
            name: name.into(),
            kind: ProviderKind::Anthropic,
            base_url: "https://api.anthropic.com".into(),
            model: None,
        }
    }

    #[test]
    fn youtube_is_available_as_a_favorite_on_first_run() {
        let (_dir, library) = library();
        let youtube = library
            .state()
            .unwrap()
            .favorites
            .into_iter()
            .find(|favorite| favorite.url == "https://m.youtube.com/")
            .expect("YouTube favorite");
        assert_eq!(youtube.name, "YouTube");
    }

    #[test]
    fn upgrading_original_favorites_adds_youtube_without_replacing_their_ids() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("library.json");
        let mut saved = default_data();
        saved.version = 2;
        saved.favorites.pop();
        let originals = saved.favorites.clone();
        let profile = saved.profile_id;
        fs::write(&path, serde_json::to_vec(&saved).unwrap()).unwrap();

        let state = Library::load(path.clone()).unwrap().state().unwrap();
        assert_eq!(state.profile_id, profile);
        assert_eq!(&state.favorites[..4], originals);
        assert_eq!(state.favorites[4].url, "https://m.youtube.com/");
        let saved: LibraryData = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(saved.version, FORMAT_VERSION);
    }

    #[test]
    fn upgrading_does_not_change_custom_or_empty_favorites() {
        let original = default_data().favorites[..4].to_vec();
        let mut reordered = original.clone();
        reordered.swap(0, 1);
        let mut renamed = original.clone();
        renamed[0].name = "Photos".into();
        for favorites in [vec![], original[..3].to_vec(), reordered, renamed] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("library.json");
            let mut saved = default_data();
            saved.version = 2;
            saved.favorites = favorites.clone();
            fs::write(&path, serde_json::to_vec(&saved).unwrap()).unwrap();
            assert_eq!(
                Library::load(path).unwrap().state().unwrap().favorites,
                favorites
            );
        }
    }

    #[test]
    fn removing_youtube_is_respected_on_later_launches() {
        let (dir, library) = library();
        let favorites = library
            .state()
            .unwrap()
            .favorites
            .into_iter()
            .filter(|favorite| favorite.name != "YouTube")
            .map(|favorite| input(&favorite.name, &favorite.url))
            .collect();
        let saved = library.set_favorites(favorites).unwrap();
        assert_eq!(reload(&dir).state().unwrap().favorites, saved);
    }

    #[test]
    fn the_profile_id_is_stable_across_reloads() {
        let (dir, library) = library();
        let first = library.state().unwrap().profile_id;
        assert_eq!(reload(&dir).state().unwrap().profile_id, first);
    }

    #[test]
    fn edited_favorites_and_last_url_survive_a_reload() {
        let (dir, library) = library();
        library
            .set_favorites(vec![input(" YouTube ", "https://m.youtube.com")])
            .unwrap();
        library.set_last_url("https://m.youtube.com/feed").unwrap();
        let state = reload(&dir).state().unwrap();
        assert_eq!(state.favorites.len(), 1);
        assert_eq!(state.favorites[0].name, "YouTube");
        assert_eq!(
            state.last_url.as_deref(),
            Some("https://m.youtube.com/feed")
        );
    }

    #[test]
    fn favorites_may_be_emptied() {
        let (_dir, library) = library();
        assert!(library.set_favorites(vec![]).unwrap().is_empty());
    }

    #[test]
    fn the_start_page_is_the_last_page_else_the_first_favorite() {
        let (_dir, library) = library();
        assert_eq!(
            library.start_url().unwrap().as_deref(),
            Some("https://www.instagram.com/")
        );
        library.set_last_url("https://m.youtube.com/feed").unwrap();
        assert_eq!(
            library.start_url().unwrap().as_deref(),
            Some("https://m.youtube.com/feed")
        );
        library.set_favorites(vec![]).unwrap();
        library.clear_history().unwrap();
        assert_eq!(library.start_url().unwrap(), None);
    }

    #[test]
    fn a_damaged_last_page_falls_back_to_the_first_favorite() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("library.json");
        let mut saved = default_data();
        saved.last_url = Some("javascript:alert(1)".into());
        fs::write(&path, serde_json::to_vec(&saved).unwrap()).unwrap();
        assert_eq!(
            Library::load(path).unwrap().start_url().unwrap().as_deref(),
            Some("https://www.instagram.com/")
        );
    }

    #[test]
    fn loading_a_current_library_does_not_rewrite_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("library.json");
        let text = serde_json::to_string(&default_data()).unwrap();
        fs::write(&path, &text).unwrap();
        Library::load(path.clone()).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), text);
    }

    #[test]
    fn favorite_urls_must_be_web_urls_and_nothing_is_saved_on_error() {
        let (_dir, library) = library();
        let before = library.state().unwrap().favorites;
        for url in ["javascript:alert(1)", "file:///etc/passwd", "nope"] {
            assert!(
                library.set_favorites(vec![input("x", url)]).is_err(),
                "{url}"
            );
        }
        assert_eq!(library.state().unwrap().favorites, before);
    }

    #[test]
    fn favorite_names_are_trimmed_and_bounded() {
        let (_dir, library) = library();
        let bad = ["   ", &"x".repeat(21)];
        for name in bad {
            assert!(matches!(
                library.set_favorites(vec![input(name, "https://a.com")]),
                Err(Error::InvalidFavoriteName)
            ));
        }
    }

    #[test]
    fn favorites_have_no_count_limit_and_keep_their_order() {
        let (dir, library) = library();
        let many: Vec<_> = (0..40)
            .map(|i| input(&format!("s{i}"), &format!("https://a{i}.com")))
            .collect();
        assert_eq!(library.set_favorites(many).unwrap().len(), 40);
        let saved = reload(&dir).state().unwrap().favorites;
        assert_eq!(saved.len(), 40);
        assert_eq!(saved[39].name, "s39");
    }

    #[test]
    fn last_url_rejects_non_web_urls() {
        let (_dir, library) = library();
        assert!(library.set_last_url("javascript:1").is_err());
        assert_eq!(library.state().unwrap().last_url, None);
    }

    #[test]
    fn corrupt_or_foreign_files_are_reported_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("library.json");
        fs::write(&path, "{not json").unwrap();
        assert!(matches!(
            Library::load(path.clone()),
            Err(Error::Corrupt(_))
        ));
        assert_eq!(fs::read_to_string(&path).unwrap(), "{not json");

        let old = r#"{"version":1,"profileId":"6f1a1c1e-0000-4000-8000-00000000000a","favorites":[],"lastUrl":null}"#;
        fs::write(&path, old).unwrap();
        assert!(matches!(
            Library::load(path.clone()),
            Err(Error::UnsupportedVersion(1))
        ));
        assert_eq!(fs::read_to_string(path).unwrap(), old);
    }

    #[test]
    fn the_onboarding_flag_can_be_set_and_reset() {
        let (dir, library) = library();
        assert!(!library.state().unwrap().onboarded);
        library.set_onboarded(true).unwrap();
        assert!(reload(&dir).state().unwrap().onboarded);
        library.set_onboarded(false).unwrap();
        assert!(!reload(&dir).state().unwrap().onboarded);
    }

    #[test]
    fn the_theme_persists_and_defaults_to_system() {
        let (dir, library) = library();
        assert_eq!(library.state().unwrap().theme, Theme::System);
        library.set_theme(Theme::Dark).unwrap();
        assert_eq!(reload(&dir).state().unwrap().theme, Theme::Dark);
    }

    #[test]
    fn the_language_persists_and_defaults_to_the_device_language() {
        let (dir, library) = library();
        assert_eq!(library.state().unwrap().locale, None);
        library.set_locale(Some("si".to_owned())).unwrap();
        assert_eq!(reload(&dir).state().unwrap().locale.as_deref(), Some("si"));
        library.set_locale(None).unwrap();
        assert_eq!(reload(&dir).state().unwrap().locale, None);
    }

    #[test]
    fn the_search_engine_defaults_to_duckduckgo_and_the_choice_persists() {
        let (dir, library) = library();
        assert_eq!(
            library.state().unwrap().search_engine,
            SearchEngine::DuckDuckGo
        );
        library.set_search_engine(SearchEngine::Brave).unwrap();
        assert_eq!(
            reload(&dir).state().unwrap().search_engine,
            SearchEngine::Brave
        );
    }

    #[test]
    fn only_growing_past_the_free_limit_needs_pro() {
        assert!(!favorites_need_pro(0, FREE_FAVORITE_LIMIT));
        assert!(favorites_need_pro(
            FREE_FAVORITE_LIMIT,
            FREE_FAVORITE_LIMIT + 1
        ));
        // Already over the limit: editing, reordering and removing stay free, adding does not.
        assert!(!favorites_need_pro(8, 8));
        assert!(!favorites_need_pro(8, 5));
        assert!(favorites_need_pro(5, 6));
    }

    #[test]
    fn ad_blocking_is_on_by_default_and_the_choice_persists() {
        let (dir, library) = library();
        assert!(library.state().unwrap().ad_block);
        library.set_ad_block(false).unwrap();
        assert!(!library.ad_block_enabled().unwrap());
        assert!(!reload(&dir).state().unwrap().ad_block);
    }

    #[test]
    fn a_library_saved_before_ad_blocking_existed_loads_with_it_on() {
        let (dir, library) = library();
        let path = dir.path().join("library.json");
        let mut saved: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert!(saved.as_object_mut().unwrap().remove("adBlock").is_some());
        fs::write(&path, saved.to_string()).unwrap();
        drop(library);
        assert!(reload(&dir).state().unwrap().ad_block);
    }

    #[test]
    fn the_back_button_is_off_by_default_and_the_choice_persists() {
        let (dir, library) = library();
        assert!(!library.state().unwrap().back_button);
        library.set_back_button(true).unwrap();
        assert!(reload(&dir).state().unwrap().back_button);
    }

    #[test]
    fn the_ai_preview_is_on_by_default_and_the_choice_persists() {
        let (dir, library) = library();
        assert!(library.state().unwrap().ai_preview);
        library.set_ai_preview(false).unwrap();
        assert!(!reload(&dir).state().unwrap().ai_preview);
    }

    #[test]
    fn a_file_saved_before_the_ai_preview_existed_keeps_it_on() {
        let (dir, library) = library();
        let path = dir.path().join("library.json");
        let mut saved: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert!(saved.as_object_mut().unwrap().remove("aiPreview").is_some());
        fs::write(&path, saved.to_string()).unwrap();
        drop(library);
        assert!(reload(&dir).state().unwrap().ai_preview);
    }

    #[test]
    fn icons_are_cached_by_host_and_shown_on_matching_favorites() {
        let (dir, library) = library();
        let urls = vec!["https://www.reddit.com/".to_owned()];
        assert!(
            library
                .missing_icons(&urls)
                .unwrap()
                .iter()
                .any(|(host, _)| host == "www.reddit.com")
        );
        library
            .set_icon("www.reddit.com", "data:image/png;base64,AAAA")
            .unwrap();
        let reddit = reload(&dir)
            .favorites()
            .unwrap()
            .into_iter()
            .find(|f| f.name == "Reddit")
            .unwrap();
        assert_eq!(reddit.icon.as_deref(), Some("data:image/png;base64,AAAA"));
        assert!(
            library
                .missing_icons(&urls)
                .unwrap()
                .iter()
                .all(|(host, _)| host != "www.reddit.com")
        );
    }

    #[test]
    fn one_icon_serves_every_host_of_the_same_site() {
        let (_dir, library) = library();
        library
            .set_icon("reddit.com", "data:image/png;base64,AAAA")
            .unwrap();
        let urls = vec!["https://www.reddit.com/r/".to_owned()];
        assert!(library.missing_icons(&urls).unwrap().is_empty());
        let icons = library.icons_for(&urls).unwrap();
        assert_eq!(
            icons.get("www.reddit.com").map(String::as_str),
            Some("data:image/png;base64,AAAA")
        );
    }

    #[test]
    fn only_small_png_data_urls_are_accepted_as_icons() {
        let (_dir, library) = library();
        let urls = vec!["https://www.reddit.com/".to_owned()];
        let before = library.missing_icons(&urls).unwrap();
        library
            .set_icon("www.reddit.com", "https://evil.example/x.png")
            .unwrap();
        library
            .set_icon(
                "www.reddit.com",
                &format!("{ICON_PREFIX}{}", "A".repeat(MAX_ICON_CHARS)),
            )
            .unwrap();
        assert_eq!(library.missing_icons(&urls).unwrap(), before);
    }

    #[test]
    fn clearing_history_drops_the_icons_of_sites_the_user_no_longer_has() {
        let (dir, library) = library();
        library.add_history("https://a.example/").unwrap();
        library
            .set_icon("a.example", "data:image/png;base64,AAAA")
            .unwrap();
        assert!(!library.icons().unwrap().is_empty());
        library.clear_history().unwrap();
        assert!(library.icons().unwrap().is_empty());
        assert!(reload(&dir).icons().unwrap().is_empty());
    }

    #[test]
    fn a_favorites_icon_survives_clearing_the_history() {
        let (_dir, library) = library();
        library
            .set_icon("www.reddit.com", "data:image/png;base64,AAAA")
            .unwrap();
        library.clear_history().unwrap();
        assert!(library.icons().unwrap().contains_key("www.reddit.com"));
    }

    #[test]
    fn providers_hold_no_key_and_the_first_becomes_active() {
        let (dir, library) = library();
        let first = library.upsert_provider(provider("Claude")).unwrap();
        let second = library.upsert_provider(provider("Other")).unwrap();
        let settings = reload(&dir).ai_settings().unwrap();
        assert_eq!(settings.providers.len(), 2);
        assert_eq!(settings.active_id, Some(first.id));
        assert!(
            !fs::read_to_string(dir.path().join("library.json"))
                .unwrap()
                .contains("apiKey")
        );
        library.set_active_provider(Some(second.id)).unwrap();
        assert_eq!(library.ai_settings().unwrap().active_id, Some(second.id));
    }

    #[test]
    fn updating_a_provider_keeps_its_id_and_deleting_moves_the_active_one() {
        let (_dir, library) = library();
        let first = library.upsert_provider(provider("Claude")).unwrap();
        let second = library.upsert_provider(provider("Other")).unwrap();
        let mut edit = provider("Renamed");
        edit.id = Some(first.id);
        assert_eq!(library.upsert_provider(edit).unwrap().id, first.id);
        assert_eq!(library.provider(first.id).unwrap().name, "Renamed");
        library.delete_provider(first.id).unwrap();
        assert_eq!(library.ai_settings().unwrap().active_id, Some(second.id));
        assert!(matches!(
            library.delete_provider(first.id),
            Err(Error::ProviderNotFound)
        ));
    }

    #[test]
    fn the_provider_count_is_capped() {
        let (_dir, library) = library();
        for i in 0..MAX_PROVIDERS {
            library.upsert_provider(provider(&format!("p{i}"))).unwrap();
        }
        assert!(matches!(
            library.upsert_provider(provider("one too many")),
            Err(Error::TooManyProviders(_))
        ));
    }

    #[test]
    fn site_toggles_persist_per_site_and_leave_other_options_alone() {
        let (dir, library) = library();
        assert!(library.site_options(Mode::Normal).unwrap().is_empty());
        library
            .set_site_option(Mode::Normal, "a.default", "x", true)
            .unwrap();
        library
            .set_site_option(Mode::Normal, "a.default", "y", false)
            .unwrap();
        library
            .set_site_option(Mode::Normal, "b.default", "x", false)
            .unwrap();
        let choices = reload(&dir).site_options(Mode::Normal).unwrap();
        assert!(choices["a.default"]["x"]);
        assert!(!choices["a.default"]["y"]);
        assert!(!choices["b.default"]["x"]);
    }

    #[test]
    fn incognito_toggles_are_a_separate_set_that_persists() {
        let (dir, library) = library();
        library
            .set_site_option(Mode::Normal, "a.default", "x", true)
            .unwrap();
        library
            .set_site_option(Mode::Incognito, "a.default", "x", false)
            .unwrap();
        library
            .set_site_option(Mode::Incognito, "b.default", "y", true)
            .unwrap();
        let reloaded = reload(&dir);
        let normal = reloaded.site_options(Mode::Normal).unwrap();
        let incognito = reloaded.site_options(Mode::Incognito).unwrap();
        assert!(normal["a.default"]["x"]);
        assert!(!normal.contains_key("b.default"));
        assert!(!incognito["a.default"]["x"]);
        assert!(incognito["b.default"]["y"]);
    }

    #[test]
    fn incognito_favorites_are_validated_kept_apart_and_never_in_the_startup_state() {
        let (dir, library) = library();
        let normal = library.state().unwrap().favorites;
        let saved = library
            .set_incognito_favorites(vec![input(" Secret ", "https://secret.example")])
            .unwrap();
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].name, "Secret");
        assert_eq!(saved[0].url, "https://secret.example/");
        assert_eq!(library.state().unwrap().favorites, normal);
        assert_eq!(reload(&dir).incognito_favorites().unwrap(), saved);
        assert!(matches!(
            library.set_incognito_favorites(vec![input("", "https://a.example")]),
            Err(Error::InvalidFavoriteName)
        ));
        assert!(
            library
                .set_incognito_favorites(vec![input("Bad", "javascript:alert(1)")])
                .is_err()
        );
        assert_eq!(library.incognito_favorites().unwrap(), saved);
    }

    #[test]
    fn an_incognito_favorites_icon_survives_clearing_the_history() {
        let (_dir, library) = library();
        library
            .set_incognito_favorites(vec![input("Secret", "https://secret.example/")])
            .unwrap();
        let icon = format!("{ICON_PREFIX}AAAA");
        library.set_icon("secret.example", &icon).unwrap();
        library.clear_history().unwrap();
        let favorites = library.incognito_favorites().unwrap();
        assert_eq!(favorites[0].icon.as_deref(), Some(icon.as_str()));
    }

    #[test]
    fn the_bottom_margin_defaults_to_zero_is_bounded_and_persists() {
        let (dir, library) = library();
        assert_eq!(library.state().unwrap().bottom_margin, 0);
        library.set_bottom_margin(48).unwrap();
        assert!(matches!(
            library.set_bottom_margin(MAX_BOTTOM_MARGIN + 1),
            Err(Error::InvalidMargin(_))
        ));
        assert_eq!(reload(&dir).bottom_margin().unwrap(), 48);
    }

    #[test]
    fn a_site_margin_can_be_set_and_returned_to_the_shared_one() {
        let (dir, library) = library();
        library
            .set_site_bottom_margin("a.default", Some(24))
            .unwrap();
        assert_eq!(reload(&dir).site_bottom_margins().unwrap()["a.default"], 24);
        assert!(
            library
                .set_site_bottom_margin("a.default", Some(999))
                .is_err()
        );
        library.set_site_bottom_margin("a.default", None).unwrap();
        assert!(reload(&dir).site_bottom_margins().unwrap().is_empty());
    }

    #[test]
    fn a_library_saved_before_site_options_existed_loads_with_defaults() {
        let (dir, library) = library();
        library.set_bottom_margin(8).unwrap();
        let path = dir.path().join("library.json");
        let mut json: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        for key in [
            "siteOptions",
            "bottomMargin",
            "siteBottomMargins",
            "incognitoSiteOptions",
            "incognitoFavorites",
        ] {
            json.as_object_mut().unwrap().remove(key);
        }
        fs::write(&path, json.to_string()).unwrap();
        let reloaded = reload(&dir);
        assert!(reloaded.site_options(Mode::Normal).unwrap().is_empty());
        assert!(reloaded.site_options(Mode::Incognito).unwrap().is_empty());
        assert!(reloaded.incognito_favorites().unwrap().is_empty());
        assert_eq!(reloaded.bottom_margin().unwrap(), 0);
    }

    #[test]
    fn history_lists_newest_first_and_moves_a_repeat_to_the_front() {
        let (dir, library) = library();
        library.add_history("https://a.example/").unwrap();
        library.add_history("https://b.example/").unwrap();
        let history = library.add_history("https://a.example/").unwrap();
        assert_eq!(history, ["https://a.example/", "https://b.example/"]);
        assert_eq!(reload(&dir).state().unwrap().history, history);
    }

    #[test]
    fn history_is_capped_and_drops_the_oldest() {
        let (_dir, library) = library();
        for i in 0..=MAX_HISTORY {
            library
                .add_history(&format!("https://{i}.example/"))
                .unwrap();
        }
        let history = library.state().unwrap().history;
        assert_eq!(history.len(), MAX_HISTORY);
        assert_eq!(history[0], format!("https://{MAX_HISTORY}.example/"));
        assert!(!history.contains(&"https://0.example/".to_owned()));
    }

    #[test]
    fn history_rejects_non_web_addresses_and_stays_unchanged() {
        let (_dir, library) = library();
        library.add_history("https://a.example/").unwrap();
        assert!(library.add_history("javascript:alert(1)").is_err());
        assert_eq!(library.state().unwrap().history, ["https://a.example/"]);
    }

    #[test]
    fn clearing_history_forgets_the_last_page_but_keeps_favorites() {
        let (dir, library) = library();
        library.add_history("https://a.example/").unwrap();
        library.set_last_url("https://a.example/").unwrap();
        let favorites = library.state().unwrap().favorites;
        library.clear_history().unwrap();
        let state = reload(&dir).state().unwrap();
        assert!(state.history.is_empty());
        assert_eq!(state.last_url, None);
        assert_eq!(state.favorites, favorites);
    }

    #[test]
    fn a_version_three_library_loads_with_empty_history() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("library.json");
        let mut saved = serde_json::to_value(default_data()).unwrap();
        saved["version"] = 3.into();
        saved.as_object_mut().unwrap().remove("history");
        fs::write(&path, serde_json::to_vec(&saved).unwrap()).unwrap();
        let library = Library::load(path.clone()).unwrap();
        assert!(library.state().unwrap().history.is_empty());
        let saved: LibraryData = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(saved.version, FORMAT_VERSION);
    }
}
