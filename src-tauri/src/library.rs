use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        Mutex, MutexGuard,
        atomic::{AtomicU64, Ordering},
    },
};

use serde::{Deserialize, Serialize};
use tauri_plugin_siteview::validate::parse_web_url;
use url::Url;
use uuid::Uuid;

use crate::accessibility::Accessibility;
use crate::ai::{AiSettings, MAX_PROVIDERS, ProviderConfig, ProviderInput};
use crate::dark_mode::{DarkMode, SiteDark};
use crate::error::{Error, Result};
use crate::recipes::{OptionChoices, OptionValue};
use crate::tiles::Tiles;
use crate::video_controls::{MAX_HEIGHT as MAX_VIDEO_HEIGHT, SiteVideo, VideoControls};
use tauri_plugin_siteview::site::site_of_host;

const FORMAT_VERSION: u32 = 4;
const MAX_HISTORY: usize = 100;
const MAX_BACK: usize = 20;
pub const MAX_FAVORITE_NAME_CHARS: usize = 20;
/// A page title longer than this is cut; the fan shows only the start of it anyway.
const MAX_BOOKMARK_TITLE_CHARS: usize = 80;
const MAX_ICON_CHARS: usize = 200_000;
/// The most site icons the app keeps. Each one is a small PNG, so this stays well under a
/// megabyte.
const MAX_ICONS: usize = 200;
/// Enough to clear a home indicator and a tab bar; more would leave no page to look at.
pub const MAX_BOTTOM_MARGIN: u32 = 200;
const ICON_PREFIX: &str = "data:image/png;base64,";

const YOUTUBE_FAVORITE: (&str, &str) = ("YouTube", "https://m.youtube.com/");
/// The four favorites a version 2 library started with. Only the upgrade to version 3 reads them,
/// to recognise a library that was never changed.
const VERSION_2_FAVORITES: [(&str, &str); 4] = [
    ("Instagram", "https://www.instagram.com/"),
    ("Facebook", "https://www.facebook.com/"),
    ("Twitter", "https://twitter.com/"),
    ("Reddit", "https://www.reddit.com/"),
];

/// What a new library holds when the person picks nothing in the guide: the default search
/// engine, so the app opens on a page and the quick-access menu has one entry.
const DEFAULT_FAVORITES: [(&str, &str); 1] = [("Google", "https://www.google.com/")];

/// How many sites the onboarding guide, the importer and the recipe library put in quick access.
/// Mirrors `QUICK_ACCESS_LIMIT` in the shell.
pub const FAVORITE_LIMIT: usize = 5;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
}

/// The search engine the command bar uses for text that is not an address. The shell owns the
/// search address of each one; Rust knows only its home page, for the start page.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SearchEngine {
    DuckDuckGo,
    #[default]
    Google,
    Bing,
    Brave,
    Ecosia,
    Startpage,
    Yahoo,
}

impl SearchEngine {
    /// The engine's front page, which the app opens at launch when the start page asks for it.
    /// Same hosts as the shell's `searchEngines.ts`.
    pub fn home_url(self) -> &'static str {
        match self {
            Self::DuckDuckGo => "https://duckduckgo.com/",
            Self::Google => "https://www.google.com/",
            Self::Bing => "https://www.bing.com/",
            Self::Brave => "https://search.brave.com/",
            Self::Ecosia => "https://www.ecosia.org/",
            Self::Startpage => "https://www.startpage.com/",
            Self::Yahoo => "https://search.yahoo.com/",
        }
    }
}

/// What the app opens at launch.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StartPage {
    /// The page the user was last on, else the first favorite.
    #[default]
    LastPage,
    /// The home page of the search engine the user picked.
    SearchHome,
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
    /// Whether a rise in the page's unread count raises a local notification. On by default,
    /// so favorites saved before the setting existed keep notifying.
    #[serde(default = "enabled")]
    pub notify: bool,
    /// Where a new session of this favorite starts instead of `url`; always an address on the
    /// favorite's own registrable domain. None opens `url`, which is also what a file saved
    /// before landing pages existed means.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub landing: Option<String>,
    /// The folder this favorite is filed in; favorites that share a name share a folder. None
    /// keeps it loose, which is also what a file saved before folders existed means.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
}

/// The longest icon name a folder or profile may carry.
pub const MAX_ICON_NAME_CHARS: usize = 24;

/// Whether `name` can name one of the icons the shell draws (`briefcase`, `music`): lowercase
/// letters, digits and hyphens, starting with a letter. The shell owns the drawings, so a name it
/// does not know is drawn as no icon.
pub fn is_icon_name(name: &str) -> bool {
    name.len() <= MAX_ICON_NAME_CHARS
        && name.starts_with(|c: char| c.is_ascii_lowercase())
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// The emoji earlier versions offered as folder icons, and the drawn icon that took each one's
/// place. Read only when a library is loaded, to carry a saved choice over.
const EMOJI_ICONS: [(&str, &str); 24] = [
    ("📁", "folder"),
    ("⭐", "star"),
    ("❤", "heart"),
    ("🏠", "home"),
    ("💼", "briefcase"),
    ("🎬", "film"),
    ("🎵", "music"),
    ("🎮", "game"),
    ("📚", "book"),
    ("📰", "news"),
    ("🛒", "cart"),
    ("✈", "plane"),
    ("🍔", "food"),
    ("💬", "chat"),
    ("📷", "camera"),
    ("🎓", "school"),
    ("💰", "money"),
    ("🔧", "wrench"),
    ("🧪", "flask"),
    ("🌍", "globe"),
    ("⚽", "ball"),
    ("🧠", "brain"),
    ("🔒", "lock"),
    ("🎨", "palette"),
];

/// A folder as the user manages it: a name and, when chosen, an icon. Favorites name the folder
/// they are in; a folder with no favorites lives only here. Without an icon the folder shows the
/// icons of what is in it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Folder {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// How the desktop window manager arranges the folder's favorites when the folder is dropped
    /// on the page; each window is a favorite of the folder, by its address. None opens a default
    /// arrangement.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout: Option<Tiles>,
}

impl Favorite {
    /// The address a new session of this favorite opens.
    pub fn start_url(&self) -> &str {
        self.landing.as_deref().unwrap_or(&self.url)
    }
}

/// The one page the user saved in the fan's bookmark slot, free of charge. Unlike a favorite it
/// is a page, not a site: it opens exactly where it was saved.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Bookmark {
    pub url: String,
    pub title: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FavoriteInput {
    pub name: String,
    pub url: String,
    #[serde(default = "enabled")]
    pub notify: bool,
    /// An address, or a path such as `/feed` on the favorite's own site; blank means none.
    #[serde(default)]
    pub landing: Option<String>,
    /// A folder name; blank means none. At most `MAX_FAVORITE_NAME_CHARS` characters.
    #[serde(default)]
    pub folder: Option<String>,
}

/// Everything the shell needs at startup.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    pub profile_id: Uuid,
    pub favorites: Vec<Favorite>,
    /// The folders the user manages, with their icons; includes empty ones.
    pub folders: Vec<Folder>,
    pub history: Vec<String>,
    pub last_url: Option<String>,
    /// The pages behind `last_url`, oldest first, so Back still works after a restart.
    pub last_back: Vec<String>,
    pub onboarded: bool,
    pub theme: Theme,
    pub ad_block: bool,
    /// Drops the pop-ups and redirects a page opens on its own that are no sign-in. Part of ad
    /// blocking: it has no effect while ad blocking is off.
    pub block_popups: bool,
    /// Opens the most used favorites quietly once the first page has loaded, so switching to one is
    /// instant. On by default.
    pub preload_favorites: bool,
    /// Pixels kept clear under every page, unless the site has its own.
    pub bottom_margin: u32,
    /// The sites whose media keeps playing in the background.
    pub background_media_sites: Vec<String>,
    /// The sites whose videos may open in a picture-in-picture window.
    pub picture_in_picture_sites: Vec<String>,
    /// The sites whose pages are asked for as a desktop page.
    pub desktop_sites: Vec<String>,
    pub back_button: bool,
    /// Whether the floating button fans out the color picker. Off by default.
    pub color_picker: bool,
    /// Whether the floating button fans out the technology detector. Off by default.
    pub tech_detector: bool,
    /// Show the exact AI payload and ask before sending it.
    pub ai_preview: bool,
    /// The language the user picked, as a BCP 47 tag. `None` follows the device's language.
    pub locale: Option<String>,
    /// The engine the command bar searches with.
    pub search_engine: SearchEngine,
    pub accessibility: Accessibility,
    pub video_controls: VideoControls,
    /// What the user chose for one site's video controls, by registrable domain.
    pub video_sites: BTreeMap<String, SiteVideo>,
    pub dark_mode: DarkMode,
    /// What the user chose for one site's dark mode, by registrable domain.
    pub dark_sites: BTreeMap<String, SiteDark>,
    /// The page in the fan's bookmark slot, if one is saved.
    pub bookmark: Option<Bookmark>,
    /// What the app opens at launch.
    pub start_page: StartPage,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LibraryData {
    version: u32,
    profile_id: Uuid,
    favorites: Vec<Favorite>,
    #[serde(default)]
    folders: Vec<Folder>,
    last_url: Option<String>,
    #[serde(default)]
    last_back: Vec<String>,
    #[serde(default)]
    onboarded: bool,
    #[serde(default)]
    theme: Theme,
    /// On by default; the shell can turn blocking off.
    #[serde(default = "enabled")]
    ad_block: bool,
    /// On by default, and only in force while `ad_block` is on.
    #[serde(default = "enabled")]
    block_popups: bool,
    #[serde(default = "enabled")]
    preload_favorites: bool,
    /// Toggles the user changed, by recipe id and then option id. Anything absent keeps the
    /// recipe's default, so shipping a recipe with a new option needs no migration.
    #[serde(default)]
    site_options: OptionChoices,
    /// Recipe toggles for incognito mode, kept apart from `site_options`. Stored on the device
    /// like every other setting: the biometric check is a screen lock, not encryption.
    #[serde(default)]
    incognito_site_options: OptionChoices,
    /// The quick-access set shown while incognito. Never in `AppState`; the shell asks for it
    /// after a biometric check. `None` until first read or saved: the set then starts as the
    /// default favorites, with no recipe sites, and an emptied set stays empty.
    #[serde(default)]
    incognito_favorites: Option<Vec<Favorite>>,
    /// The incognito set's folders, kept apart from `folders`.
    #[serde(default)]
    incognito_folders: Vec<Folder>,
    #[serde(default)]
    bottom_margin: u32,
    /// Per-site bottom margins by recipe id; a site without an entry uses `bottom_margin`.
    #[serde(default)]
    site_bottom_margins: BTreeMap<String, u32>,
    /// The sites (registrable domains) whose media keeps playing while their page is hidden or the
    /// app is in the background. Every other site's media is paused then.
    #[serde(default)]
    background_media_sites: BTreeSet<String>,
    /// The sites (registrable domains) whose videos may open in picture-in-picture. Off for every
    /// other site.
    #[serde(default)]
    picture_in_picture_sites: BTreeSet<String>,
    /// The sites (registrable domains) asked for as a desktop page: a desktop user agent and
    /// layout. Off for every other site.
    #[serde(default)]
    desktop_sites: BTreeSet<String>,
    /// Off by default; the shell can show a floating back button over the page.
    #[serde(default)]
    back_button: bool,
    /// Off by default; the floating button can fan out the color picker.
    #[serde(default)]
    color_picker: bool,
    /// Off by default; the floating button can fan out the technology detector.
    #[serde(default)]
    tech_detector: bool,
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
    /// Google until the user picks another.
    #[serde(default)]
    search_engine: SearchEngine,
    /// Epilepsy protection and the reading aids for dyslexia; all off until chosen.
    #[serde(default)]
    accessibility: Accessibility,
    /// The controls for full-screen video feeds: the panel on a tap is off until switched on.
    #[serde(default)]
    video_controls: VideoControls,
    /// Per-site video controls choices by registrable domain; a site without an entry follows
    /// `video_controls`.
    #[serde(default)]
    video_sites: BTreeMap<String, SiteVideo>,
    /// Dark mode for pages; off until switched on.
    #[serde(default)]
    dark_mode: DarkMode,
    /// Per-site dark mode choices by registrable domain; a site without an entry follows
    /// `dark_mode`.
    #[serde(default)]
    dark_sites: BTreeMap<String, SiteDark>,
    /// The page in the fan's bookmark slot. Normal set only: nothing is saved while incognito.
    #[serde(default)]
    bookmark: Option<Bookmark>,
    /// The last page until the user picks the search engine's home page.
    #[serde(default)]
    start_page: StartPage,
}

/// The user's favorites, page, theme and provider settings, persisted as one JSON file per
/// profile. Holds no secrets and no cookies: site sessions live in the native data store of
/// `profile_id`, and API keys in the OS secure store. A switch of profile puts another profile's
/// file in place (`adopt`); the app keeps this one object.
pub struct Library {
    path: Mutex<PathBuf>,
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
            path: Mutex::new(path),
            data: Mutex::new(data),
        };
        if needs_save {
            let data = library.lock()?;
            library.save(&data)?;
        }
        Ok(library)
    }

    /// Writes a new profile's library at `path`: the defaults, with the site data store
    /// `profile_id`, in the language and theme given. The guide runs when it is first opened.
    pub fn create(
        path: &Path,
        profile_id: Uuid,
        locale: Option<String>,
        theme: Theme,
    ) -> Result<()> {
        let data = LibraryData {
            profile_id,
            locale,
            theme,
            ..default_data()
        };
        write_atomically(path, &serde_json::to_vec_pretty(&data)?)?;
        Ok(())
    }

    /// Takes over `other`'s file and everything in it, as a switch of profile does. Later changes
    /// are saved to that file.
    pub fn adopt(&self, other: Library) -> Result<()> {
        let mut data = self.lock()?;
        let mut path = self.path.lock().map_err(|_| Error::Poisoned)?;
        *data = other.data.into_inner().map_err(|_| Error::Poisoned)?;
        *path = other.path.into_inner().map_err(|_| Error::Poisoned)?;
        Ok(())
    }

    pub fn profile_id(&self) -> Result<Uuid> {
        Ok(self.lock()?.profile_id)
    }

    /// The language the user picked; `None` follows the device.
    pub fn locale(&self) -> Result<Option<String>> {
        Ok(self.lock()?.locale.clone())
    }

    /// The page to open at launch: the search engine's home page when the user asked for it,
    /// otherwise the last page the user was on, else the first favorite. An address that no
    /// longer parses is skipped, so a damaged file cannot leave the app empty.
    pub fn start_url(&self) -> Result<Option<String>> {
        let data = self.lock()?;
        if data.start_page == StartPage::SearchHome {
            return Ok(Some(data.search_engine.home_url().to_owned()));
        }
        Ok(data
            .last_url
            .iter()
            .map(String::as_str)
            .chain(data.favorites.iter().map(Favorite::start_url))
            .find(|url| parse_web_url(url).is_ok())
            .map(str::to_owned))
    }

    pub fn state(&self) -> Result<AppState> {
        let data = self.lock()?;
        Ok(AppState {
            profile_id: data.profile_id,
            favorites: with_icons(&data, &data.favorites),
            folders: data.folders.clone(),
            history: data.history.clone(),
            last_url: data.last_url.clone(),
            last_back: data.last_back.clone(),
            onboarded: data.onboarded,
            theme: data.theme,
            ad_block: data.ad_block,
            block_popups: data.block_popups,
            preload_favorites: data.preload_favorites,
            bottom_margin: data.bottom_margin,
            background_media_sites: data.background_media_sites.iter().cloned().collect(),
            picture_in_picture_sites: data.picture_in_picture_sites.iter().cloned().collect(),
            desktop_sites: data.desktop_sites.iter().cloned().collect(),
            back_button: data.back_button,
            color_picker: data.color_picker,
            tech_detector: data.tech_detector,
            ai_preview: data.ai_preview,
            locale: data.locale.clone(),
            search_engine: data.search_engine,
            accessibility: data.accessibility,
            video_controls: data.video_controls,
            video_sites: data.video_sites.clone(),
            dark_mode: data.dark_mode.clone(),
            dark_sites: data.dark_sites.clone(),
            bookmark: data
                .bookmark
                .clone()
                .filter(|bookmark| parse_web_url(&bookmark.url).is_ok()),
            start_page: data.start_page,
        })
    }

    /// Remembers the language the user picked. `None` puts the app back on the device's language.
    pub fn set_locale(&self, locale: Option<String>) -> Result<()> {
        let mut data = self.lock()?;
        data.locale = locale;
        self.save(&data)
    }

    pub fn bookmark(&self) -> Result<Option<Bookmark>> {
        Ok(self.lock()?.bookmark.clone())
    }

    /// Saves `url` in the bookmark slot, replacing what was there. An empty title falls back to
    /// the host, and a long one is cut.
    pub fn set_bookmark(&self, url: &str, title: &str) -> Result<Bookmark> {
        let parsed = parse_web_url(url)?;
        let bookmark = Bookmark {
            title: bookmark_title(title, parsed.host_str().unwrap_or_default()),
            url: parsed.to_string(),
        };
        let mut data = self.lock()?;
        data.bookmark = Some(bookmark.clone());
        self.save(&data)?;
        Ok(bookmark)
    }

    pub fn clear_bookmark(&self) -> Result<()> {
        let mut data = self.lock()?;
        data.bookmark = None;
        self.save(&data)
    }

    pub fn set_search_engine(&self, engine: SearchEngine) -> Result<()> {
        let mut data = self.lock()?;
        data.search_engine = engine;
        self.save(&data)
    }

    pub fn set_start_page(&self, start_page: StartPage) -> Result<()> {
        let mut data = self.lock()?;
        data.start_page = start_page;
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

    /// The folders of the normal set or, for incognito, of the private one.
    pub fn folders(&self, mode: Mode) -> Result<Vec<Folder>> {
        let data = self.lock()?;
        Ok(match mode {
            Mode::Normal => data.folders.clone(),
            Mode::Incognito => data.incognito_folders.clone(),
        })
    }

    /// Replaces a set's folders. Names are trimmed and a repeat of one already listed (ignoring
    /// case) is dropped.
    pub fn set_folders(&self, mode: Mode, folders: Vec<Folder>) -> Result<Vec<Folder>> {
        let folders = folders_from_input(folders)?;
        let mut data = self.lock()?;
        match mode {
            Mode::Normal => data.folders = folders.clone(),
            Mode::Incognito => data.incognito_folders = folders.clone(),
        }
        self.save(&data)?;
        Ok(folders)
    }

    /// The incognito quick-access set, icons filled in. Handed out only after a biometric check.
    pub fn incognito_favorites(&self) -> Result<Vec<Favorite>> {
        let mut data = self.lock()?;
        if data.incognito_favorites.is_none() {
            data.incognito_favorites = Some(default_favorites());
            self.save(&data)?;
        }
        Ok(with_icons(
            &data,
            data.incognito_favorites.as_deref().unwrap_or_default(),
        ))
    }

    pub fn set_incognito_favorites(&self, inputs: Vec<FavoriteInput>) -> Result<Vec<Favorite>> {
        let favorites = inputs
            .into_iter()
            .map(favorite_from_input)
            .collect::<Result<Vec<_>>>()?;
        let mut data = self.lock()?;
        data.incognito_favorites = Some(favorites);
        self.save(&data)?;
        Ok(with_icons(
            &data,
            data.incognito_favorites.as_deref().unwrap_or_default(),
        ))
    }

    /// Remembers the page and the pages behind it. Addresses that do not parse are dropped, and
    /// only the newest `MAX_BACK` are kept.
    pub fn set_last_url(&self, url: &str, back: &[String]) -> Result<()> {
        let url = parse_web_url(url)?.to_string();
        let mut back: Vec<String> = back
            .iter()
            .filter_map(|url| parse_web_url(url).ok())
            .map(|url| url.to_string())
            .collect();
        back.drain(..back.len().saturating_sub(MAX_BACK));
        let mut data = self.lock()?;
        data.last_url = Some(url);
        data.last_back = back;
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

    /// Forgets one searched address; returns the history that remains, newest first.
    pub fn remove_history(&self, url: &str) -> Result<Vec<String>> {
        let mut data = self.lock()?;
        data.history.retain(|seen| seen != url);
        prune_icons(&mut data);
        self.save(&data)?;
        Ok(data.history.clone())
    }

    /// Forgets the searched addresses and the remembered last page, like a browser's "clear
    /// history". Favorites, cookies and settings are untouched.
    pub fn clear_history(&self) -> Result<()> {
        let mut data = self.lock()?;
        data.history.clear();
        data.last_url = None;
        data.last_back.clear();
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

    pub fn theme(&self) -> Result<Theme> {
        Ok(self.lock()?.theme)
    }

    pub fn ad_block_enabled(&self) -> Result<bool> {
        Ok(self.lock()?.ad_block)
    }

    pub fn set_ad_block(&self, enabled: bool) -> Result<()> {
        let mut data = self.lock()?;
        data.ad_block = enabled;
        self.save(&data)
    }

    /// Whether pop-ups and redirects that are no sign-in are dropped: the saved choice, in force
    /// only while ad blocking is on.
    pub fn popup_blocking_enabled(&self) -> Result<bool> {
        let data = self.lock()?;
        Ok(data.ad_block && data.block_popups)
    }

    pub fn set_block_popups(&self, enabled: bool) -> Result<()> {
        let mut data = self.lock()?;
        data.block_popups = enabled;
        self.save(&data)
    }

    pub fn set_preload_favorites(&self, enabled: bool) -> Result<()> {
        let mut data = self.lock()?;
        data.preload_favorites = enabled;
        self.save(&data)
    }

    pub fn site_options(&self, mode: Mode) -> Result<OptionChoices> {
        let data = self.lock()?;
        Ok(match mode {
            Mode::Normal => data.site_options.clone(),
            Mode::Incognito => data.incognito_site_options.clone(),
        })
    }

    /// Records one option's value in the given mode's choices. The caller has already checked
    /// that the recipe and option exist and accept the value.
    pub fn set_site_option(
        &self,
        mode: Mode,
        recipe: &str,
        option: &str,
        value: OptionValue,
    ) -> Result<()> {
        let mut data = self.lock()?;
        let choices = match mode {
            Mode::Normal => &mut data.site_options,
            Mode::Incognito => &mut data.incognito_site_options,
        };
        choices
            .entry(recipe.to_owned())
            .or_default()
            .insert(option.to_owned(), value);
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

    pub fn background_media_sites(&self) -> Result<Vec<String>> {
        Ok(self
            .lock()?
            .background_media_sites
            .iter()
            .cloned()
            .collect())
    }

    /// Lets a site's media keep playing while hidden, or pauses it again. Returns the whole list.
    pub fn set_background_media(&self, site: &str, enabled: bool) -> Result<Vec<String>> {
        let site = checked_site(site)?;
        let mut data = self.lock()?;
        if enabled {
            data.background_media_sites.insert(site);
        } else {
            data.background_media_sites.remove(&site);
        }
        self.save(&data)?;
        Ok(data.background_media_sites.iter().cloned().collect())
    }

    pub fn picture_in_picture_sites(&self) -> Result<Vec<String>> {
        Ok(self
            .lock()?
            .picture_in_picture_sites
            .iter()
            .cloned()
            .collect())
    }

    /// Lets a site's videos open in a picture-in-picture window, or stops it. Returns the whole list.
    pub fn set_picture_in_picture(&self, site: &str, enabled: bool) -> Result<Vec<String>> {
        let site = checked_site(site)?;
        let mut data = self.lock()?;
        if enabled {
            data.picture_in_picture_sites.insert(site);
        } else {
            data.picture_in_picture_sites.remove(&site);
        }
        self.save(&data)?;
        Ok(data.picture_in_picture_sites.iter().cloned().collect())
    }

    pub fn desktop_sites(&self) -> Result<Vec<String>> {
        Ok(self.lock()?.desktop_sites.iter().cloned().collect())
    }

    /// Asks a site for its desktop page, or stops. Returns the whole list.
    pub fn set_desktop_site(&self, site: &str, enabled: bool) -> Result<Vec<String>> {
        let site = checked_site(site)?;
        let mut data = self.lock()?;
        if enabled {
            data.desktop_sites.insert(site);
        } else {
            data.desktop_sites.remove(&site);
        }
        self.save(&data)?;
        Ok(data.desktop_sites.iter().cloned().collect())
    }

    pub fn set_back_button(&self, enabled: bool) -> Result<()> {
        let mut data = self.lock()?;
        data.back_button = enabled;
        self.save(&data)
    }

    pub fn set_color_picker(&self, enabled: bool) -> Result<()> {
        let mut data = self.lock()?;
        data.color_picker = enabled;
        self.save(&data)
    }

    pub fn set_tech_detector(&self, enabled: bool) -> Result<()> {
        let mut data = self.lock()?;
        data.tech_detector = enabled;
        self.save(&data)
    }

    pub fn accessibility(&self) -> Result<Accessibility> {
        Ok(self.lock()?.accessibility)
    }

    pub fn set_accessibility(&self, accessibility: Accessibility) -> Result<()> {
        let mut data = self.lock()?;
        data.accessibility = accessibility;
        self.save(&data)
    }

    pub fn video_controls(&self) -> Result<VideoControls> {
        Ok(self.lock()?.video_controls)
    }

    pub fn set_video_controls(&self, video_controls: VideoControls) -> Result<()> {
        checked_video_height(video_controls.height)?;
        let mut data = self.lock()?;
        data.video_controls = video_controls;
        self.save(&data)
    }

    pub fn video_sites(&self) -> Result<BTreeMap<String, SiteVideo>> {
        Ok(self.lock()?.video_sites.clone())
    }

    /// Saves what the user chose for one site's video controls; a choice with nothing in it
    /// returns the site to the shared one.
    pub fn set_site_video(&self, site: &str, video: SiteVideo) -> Result<()> {
        let site = checked_site(site)?;
        if let Some(height) = video.height {
            checked_video_height(height)?;
        }
        let mut data = self.lock()?;
        if video.is_empty() {
            data.video_sites.remove(&site);
        } else {
            data.video_sites.insert(site, video);
        }
        self.save(&data)
    }

    pub fn dark_mode(&self) -> Result<DarkMode> {
        Ok(self.lock()?.dark_mode.clone())
    }

    pub fn set_dark_mode(&self, dark_mode: DarkMode) -> Result<()> {
        dark_mode.validate()?;
        let mut data = self.lock()?;
        data.dark_mode = dark_mode.normalized();
        self.save(&data)
    }

    pub fn dark_sites(&self) -> Result<BTreeMap<String, SiteDark>> {
        Ok(self.lock()?.dark_sites.clone())
    }

    /// Saves what the user chose for one site's dark mode; a choice with nothing in it returns
    /// the site to the global settings.
    pub fn set_site_dark(&self, site: &str, dark: SiteDark) -> Result<()> {
        let site = checked_site(site)?;
        dark.validate()?;
        let mut data = self.lock()?;
        if dark.is_empty() {
            data.dark_sites.remove(&site);
        } else {
            data.dark_sites.insert(site, dark.normalized());
        }
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
        let path = self.path.lock().map_err(|_| Error::Poisoned)?;
        write_atomically(&path, &serde_json::to_vec_pretty(data)?)?;
        Ok(())
    }
}

fn checked_margin(pixels: u32) -> Result<u32> {
    if pixels > MAX_BOTTOM_MARGIN {
        return Err(Error::InvalidMargin(MAX_BOTTOM_MARGIN));
    }
    Ok(pixels)
}

fn checked_video_height(pixels: u32) -> Result<()> {
    if pixels > MAX_VIDEO_HEIGHT {
        return Err(Error::InvalidMargin(MAX_VIDEO_HEIGHT));
    }
    Ok(())
}

/// A site as a registrable domain: letters, digits, dots and hyphens only, as the shell sends it.
fn checked_site(site: &str) -> Result<String> {
    let site = site.trim().to_ascii_lowercase();
    let valid = !site.is_empty()
        && site.len() <= 253
        && !site.starts_with(['.', '-'])
        && !site.ends_with(['.', '-'])
        && site
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
    if valid {
        Ok(site)
    } else {
        Err(Error::UnknownSite)
    }
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

/// The title as the bookmark keeps it: trimmed, without control characters, cut to
/// `MAX_BOOKMARK_TITLE_CHARS`, and the host (without `www.`) when nothing is left.
fn bookmark_title(title: &str, host: &str) -> String {
    let kept: String = title
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .trim()
        .chars()
        .take(MAX_BOOKMARK_TITLE_CHARS)
        .collect();
    if kept.is_empty() {
        host.trim_start_matches("www.").to_owned()
    } else {
        kept.trim_end().to_owned()
    }
}

/// Drops the icons of sites the user no longer has anywhere, and keeps the cache bounded: the
/// oldest visited sites go first, a favorite's icon (normal or incognito) never does.
fn prune_icons(data: &mut LibraryData) {
    let favorites: Vec<String> = data
        .favorites
        .iter()
        .chain(data.incognito_favorites.iter().flatten())
        .map(|favorite| favorite.url.as_str())
        .chain(data.bookmark.iter().map(|bookmark| bookmark.url.as_str()))
        .filter_map(host_of)
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
            let previous_defaults = &VERSION_2_FAVORITES;
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
                    notify: true,
                    landing: None,
                    folder: None,
                })?);
            }
        }
        3 | FORMAT_VERSION => {}
        version => return Err(Error::UnsupportedVersion(version)),
    }
    let dropped = drop_foreign_landings(&mut data.favorites)
        | data
            .incognito_favorites
            .as_deref_mut()
            .is_some_and(drop_foreign_landings);
    let redrawn =
        migrate_folder_icons(&mut data.folders) | migrate_folder_icons(&mut data.incognito_folders);
    let migrated = data.version != FORMAT_VERSION || dropped || redrawn;
    data.version = FORMAT_VERSION;
    Ok((data, migrated))
}

/// A folder icon saved as an emoji becomes the drawn icon that took its place; any other icon that
/// is not a name is dropped, so the folder shows what is in it. True when any changed.
fn migrate_folder_icons(folders: &mut [Folder]) -> bool {
    let mut changed = false;
    for folder in folders {
        let Some(icon) = folder.icon.as_deref() else {
            continue;
        };
        if is_icon_name(icon) {
            continue;
        }
        let emoji = icon.trim().trim_end_matches('\u{fe0f}');
        folder.icon = EMOJI_ICONS
            .iter()
            .find(|(saved, _)| *saved == emoji)
            .map(|(_, name)| (*name).to_owned());
        changed = true;
    }
    changed
}

/// A landing page the favorite's own site does not own can only come from a hand-edited file:
/// it is dropped, so the favorite opens its address. True when any was.
fn drop_foreign_landings(favorites: &mut [Favorite]) -> bool {
    let mut dropped = false;
    for favorite in favorites {
        let kept = favorite
            .landing
            .as_deref()
            .is_some_and(|landing| landing_on_site(&favorite.url, landing).is_some());
        if favorite.landing.is_some() && !kept {
            favorite.landing = None;
            dropped = true;
        }
    }
    dropped
}

/// A landing page for the favorite at `url`: an address, or a path of the favorite's own origin,
/// that is a web address on the same registrable domain, so a session never leaves its site.
fn landing_on_site(url: &str, landing: &str) -> Option<String> {
    let base = parse_web_url(url).ok()?;
    let landing = if landing.starts_with('/') && !landing.starts_with("//") {
        base.join(landing).ok()?
    } else {
        parse_web_url(landing).ok()?
    };
    let site = |url: &Url| url.host_str().map(site_of_host);
    (site(&base)? == site(&landing)?).then(|| landing.to_string())
}

fn default_favorites() -> Vec<Favorite> {
    DEFAULT_FAVORITES
        .iter()
        .map(|(name, url)| Favorite {
            id: Uuid::new_v4(),
            name: (*name).to_owned(),
            url: (*url).to_owned(),
            icon: None,
            notify: true,
            landing: None,
            folder: None,
        })
        .collect()
}

fn default_data() -> LibraryData {
    LibraryData {
        version: FORMAT_VERSION,
        profile_id: Uuid::new_v4(),
        favorites: default_favorites(),
        folders: Vec::new(),
        last_url: None,
        last_back: Vec::new(),
        onboarded: false,
        theme: Theme::System,
        ad_block: true,
        block_popups: true,
        preload_favorites: true,
        site_options: OptionChoices::new(),
        bottom_margin: 0,
        site_bottom_margins: BTreeMap::new(),
        background_media_sites: BTreeSet::new(),
        picture_in_picture_sites: BTreeSet::new(),
        desktop_sites: BTreeSet::new(),
        back_button: false,
        color_picker: false,
        tech_detector: false,
        ai_preview: true,
        icons: BTreeMap::new(),
        history: Vec::new(),
        ai: AiSettings::default(),
        locale: None,
        search_engine: SearchEngine::Google,
        accessibility: Accessibility::default(),
        video_controls: VideoControls::default(),
        video_sites: BTreeMap::new(),
        dark_mode: DarkMode::default(),
        dark_sites: BTreeMap::new(),
        bookmark: None,
        start_page: StartPage::LastPage,
        incognito_site_options: OptionChoices::new(),
        incognito_favorites: None,
        incognito_folders: Vec::new(),
    }
}

fn folders_from_input(inputs: Vec<Folder>) -> Result<Vec<Folder>> {
    let mut folders: Vec<Folder> = Vec::with_capacity(inputs.len());
    for input in inputs {
        let name = input.name.trim();
        if name.is_empty() || name.chars().count() > MAX_FAVORITE_NAME_CHARS {
            return Err(Error::InvalidFolder);
        }
        let icon = match input.icon.as_deref().map(str::trim) {
            None | Some("") => None,
            Some(icon) if is_icon_name(icon) => Some(icon.to_owned()),
            Some(_) => return Err(Error::InvalidFolder),
        };
        if folders
            .iter()
            .any(|known| known.name.to_lowercase() == name.to_lowercase())
        {
            continue;
        }
        let layout = input.layout.map(crate::tiles::validated).transpose()?;
        folders.push(Folder {
            name: name.to_owned(),
            icon,
            layout,
        });
    }
    Ok(folders)
}

fn favorite_from_input(input: FavoriteInput) -> Result<Favorite> {
    let name = input.name.trim();
    if name.is_empty() || name.chars().count() > MAX_FAVORITE_NAME_CHARS {
        return Err(Error::InvalidFavoriteName);
    }
    let url = parse_web_url(&input.url)?.to_string();
    let landing = match input.landing.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(landing) => Some(landing_on_site(&url, landing).ok_or(Error::InvalidLanding)?),
    };
    let folder = match input.folder.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(folder) if folder.chars().count() > MAX_FAVORITE_NAME_CHARS => {
            return Err(Error::InvalidFavoriteName);
        }
        Some(folder) => Some(folder.to_owned()),
    };
    Ok(Favorite {
        id: Uuid::new_v4(),
        name: name.to_owned(),
        url,
        icon: None,
        notify: input.notify,
        landing,
        folder,
    })
}

pub(crate) fn write_atomically(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    // A name of its own per write, so two writers of the same file never share a temp file.
    let unique = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temp = path.with_extension(format!("json.{}.{unique}.tmp", std::process::id()));
    let written = (|| {
        let mut file = fs::File::create_new(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temp, path)
    })();
    if written.is_err() {
        let _ = fs::remove_file(&temp);
    }
    written
}

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accessibility::{ReadingFont, Tint};
    use crate::ai::ProviderKind;
    use crate::dark_mode::{DarkMethod, DarkSchedule, ScheduleKind, SiteDarkMode};

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
            notify: true,
            landing: None,
            folder: None,
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

    fn version_2_favorites() -> Vec<Favorite> {
        VERSION_2_FAVORITES
            .iter()
            .map(|(name, url)| Favorite {
                id: Uuid::new_v4(),
                name: (*name).to_owned(),
                url: (*url).to_owned(),
                icon: None,
                notify: true,
                landing: None,
                folder: None,
            })
            .collect()
    }

    #[test]
    fn upgrading_original_favorites_adds_youtube_without_replacing_their_ids() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("library.json");
        let mut saved = default_data();
        saved.version = 2;
        saved.favorites = version_2_favorites();
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
        let original = version_2_favorites();
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
        library
            .set_last_url(
                "https://m.youtube.com/feed",
                &["https://m.youtube.com/".to_string()],
            )
            .unwrap();
        let state = reload(&dir).state().unwrap();
        assert_eq!(state.favorites.len(), 1);
        assert_eq!(state.favorites[0].name, "YouTube");
        assert_eq!(
            state.last_url.as_deref(),
            Some("https://m.youtube.com/feed")
        );
        assert_eq!(state.last_back, ["https://m.youtube.com/"]);
    }

    fn with_landing(name: &str, url: &str, landing: &str) -> FavoriteInput {
        FavoriteInput {
            landing: Some(landing.into()),
            ..input(name, url)
        }
    }

    #[test]
    fn a_landing_page_on_the_favorites_own_site_is_kept_across_a_reload() {
        let (dir, library) = library();
        let saved = library
            .set_favorites(vec![
                with_landing("YouTube", "https://m.youtube.com/", "/feed/subscriptions"),
                with_landing(
                    "Docs",
                    "https://example.com/",
                    "https://docs.example.com/start",
                ),
                input("Plain", "https://plain.example/"),
                with_landing("Blank", "https://blank.example/", "  "),
            ])
            .unwrap();
        let landings: Vec<_> = saved.iter().map(|f| f.landing.as_deref()).collect();
        assert_eq!(
            landings,
            [
                Some("https://m.youtube.com/feed/subscriptions"),
                Some("https://docs.example.com/start"),
                None,
                None
            ]
        );
        let again = reload(&dir).state().unwrap().favorites;
        assert_eq!(
            again[0].start_url(),
            "https://m.youtube.com/feed/subscriptions"
        );
        assert_eq!(again[2].start_url(), "https://plain.example/");
    }

    #[test]
    fn a_landing_page_cannot_leave_the_favorites_site() {
        let (_dir, library) = library();
        for landing in [
            "https://evil.example/",
            "//evil.example/",
            "javascript:alert(1)",
            "ftp://m.youtube.com/",
            "/\\evil.example",
            "not a url",
        ] {
            let result = library.set_favorites(vec![with_landing(
                "YouTube",
                "https://m.youtube.com/",
                landing,
            )]);
            assert!(matches!(result, Err(Error::InvalidLanding)), "{landing}");
        }
        assert_eq!(library.favorites().unwrap().len(), 1);
    }

    #[test]
    fn incognito_favorites_follow_the_same_landing_rules() {
        let (_dir, library) = library();
        let saved = library
            .set_incognito_favorites(vec![with_landing("A", "https://a.example/", "/inbox")])
            .unwrap();
        assert_eq!(saved[0].landing.as_deref(), Some("https://a.example/inbox"));
        assert!(
            library
                .set_incognito_favorites(vec![with_landing(
                    "A",
                    "https://a.example/",
                    "https://b.example/"
                )])
                .is_err()
        );
    }

    #[test]
    fn a_file_without_landing_pages_loads_unchanged_and_a_foreign_one_is_dropped() {
        let (dir, library) = library();
        library
            .set_favorites(vec![input("A", "https://a.example/")])
            .unwrap();
        let path = dir.path().join("library.json");
        let mut saved: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert!(saved["favorites"][0].get("landing").is_none());
        let before = fs::read_to_string(&path).unwrap();
        assert_eq!(reload(&dir).favorites().unwrap()[0].landing, None);
        assert_eq!(fs::read_to_string(&path).unwrap(), before);

        saved["favorites"][0]["landing"] = "https://evil.example/".into();
        fs::write(&path, saved.to_string()).unwrap();
        assert_eq!(reload(&dir).favorites().unwrap()[0].landing, None);
        let rewritten = fs::read_to_string(&path).unwrap();
        assert!(!rewritten.contains("evil.example"));
    }

    #[test]
    fn the_first_launch_opens_the_first_favorites_landing_page() {
        let (_dir, library) = library();
        library
            .set_favorites(vec![with_landing("A", "https://a.example/", "/inbox")])
            .unwrap();
        assert_eq!(
            library.start_url().unwrap().as_deref(),
            Some("https://a.example/inbox")
        );
    }

    #[test]
    fn folders_are_validated_and_kept_per_set() {
        let (_dir, library) = library();
        let folder = |name: &str, icon: Option<&str>| Folder {
            name: name.to_owned(),
            icon: icon.map(str::to_owned),
            layout: None,
        };
        let saved = library
            .set_folders(
                Mode::Normal,
                vec![
                    folder(" Work ", Some("briefcase")),
                    folder("work", None),
                    folder("Fun", Some(" ")),
                ],
            )
            .unwrap();
        assert_eq!(
            saved,
            vec![folder("Work", Some("briefcase")), folder("Fun", None)]
        );
        assert_eq!(library.state().unwrap().folders, saved);
        assert!(library.folders(Mode::Incognito).unwrap().is_empty());
        assert!(
            library
                .set_folders(Mode::Normal, vec![folder("", None)])
                .is_err()
        );
        for icon in ["💼", "Briefcase", "two words", "9lives", &"a".repeat(25)] {
            assert!(
                library
                    .set_folders(Mode::Normal, vec![folder("A", Some(icon))])
                    .is_err(),
                "{icon}"
            );
        }
    }

    #[test]
    fn emoji_folder_icons_from_earlier_versions_become_drawn_icons() {
        let (dir, library) = library();
        drop(library);
        let path = dir.path().join("library.json");
        let mut saved: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        saved["folders"] = serde_json::json!([
            { "name": "Work", "icon": "💼" },
            { "name": "Fun", "icon": "❤️" },
            { "name": "Odd", "icon": "🦄" },
            { "name": "Kept", "icon": "music" },
        ]);
        saved["incognitoFolders"] = serde_json::json!([{ "name": "Away", "icon": "✈️" }]);
        fs::write(&path, saved.to_string()).unwrap();

        let library = reload(&dir);
        let icons = |folders: Vec<Folder>| -> Vec<Option<String>> {
            folders.into_iter().map(|folder| folder.icon).collect()
        };
        assert_eq!(
            icons(library.folders(Mode::Normal).unwrap()),
            [Some("briefcase"), Some("heart"), None, Some("music")]
                .map(|icon| icon.map(str::to_owned))
        );
        assert_eq!(
            icons(library.folders(Mode::Incognito).unwrap()),
            [Some("plane".to_owned())]
        );
        assert!(!fs::read_to_string(&path).unwrap().contains('💼'));
    }

    #[test]
    fn an_adopted_library_is_read_and_written_in_its_own_file() {
        let (dir, library) = library();
        let first = library.profile_id().unwrap();
        let other = dir.path().join("other").join("library.json");
        let id = Uuid::new_v4();
        Library::create(&other, id, Some("de".into()), Theme::Dark).unwrap();

        library
            .adopt(Library::load(other.clone()).unwrap())
            .unwrap();
        let state = library.state().unwrap();
        assert_eq!(state.profile_id, id);
        assert!(!state.onboarded);
        assert_eq!(state.locale.as_deref(), Some("de"));
        assert_eq!(state.theme, Theme::Dark);

        library
            .set_favorites(vec![input("A", "https://a.example/")])
            .unwrap();
        assert_eq!(Library::load(other).unwrap().favorites().unwrap().len(), 1);
        let untouched = reload(&dir);
        assert_eq!(untouched.profile_id().unwrap(), first);
        assert_eq!(untouched.favorites().unwrap()[0].name, "Google");
    }

    #[test]
    fn favorites_may_be_emptied() {
        let (_dir, library) = library();
        assert!(library.set_favorites(vec![]).unwrap().is_empty());
    }

    #[test]
    fn a_favorites_folder_is_trimmed_kept_across_a_reload_and_blank_means_loose() {
        let (dir, library) = library();
        let filed = |name: &str, url: &str, folder: &str| FavoriteInput {
            folder: Some(folder.into()),
            ..input(name, url)
        };
        library
            .set_favorites(vec![
                filed("Chat", "https://chat.example/", "  Social "),
                filed("Mail", "https://mail.example/", "   "),
                input("News", "https://news.example/"),
            ])
            .unwrap();
        let folders: Vec<_> = reload(&dir)
            .favorites()
            .unwrap()
            .into_iter()
            .map(|favorite| favorite.folder)
            .collect();
        assert_eq!(folders, vec![Some("Social".to_owned()), None, None]);
    }

    #[test]
    fn a_folder_name_longer_than_a_favorite_name_may_be_is_refused() {
        let (_dir, library) = library();
        let long = "x".repeat(MAX_FAVORITE_NAME_CHARS + 1);
        let refused = library.set_favorites(vec![FavoriteInput {
            folder: Some(long),
            ..input("Chat", "https://chat.example/")
        }]);
        assert!(matches!(refused, Err(Error::InvalidFavoriteName)));
    }

    #[test]
    fn a_favorites_notify_choice_survives_a_reload_and_defaults_on() {
        let (dir, library) = library();
        let quiet = FavoriteInput {
            notify: false,
            ..input("Quiet", "https://quiet.example/")
        };
        library
            .set_favorites(vec![quiet, input("Loud", "https://loud.example/")])
            .unwrap();
        let notify: Vec<_> = reload(&dir)
            .state()
            .unwrap()
            .favorites
            .iter()
            .map(|favorite| favorite.notify)
            .collect();
        assert_eq!(notify, [false, true]);

        let saved_before_the_setting = r#"{"id":"67e55044-10b1-426f-9247-bb680e5fe0c8","name":"Old","url":"https://old.example/"}"#;
        assert!(
            serde_json::from_str::<Favorite>(saved_before_the_setting)
                .unwrap()
                .notify
        );
        let from_an_old_shell: FavoriteInput =
            serde_json::from_str(r#"{"name":"Old","url":"https://old.example/"}"#).unwrap();
        assert!(from_an_old_shell.notify);
    }

    #[test]
    fn the_start_page_is_the_last_page_else_the_first_favorite() {
        let (_dir, library) = library();
        assert_eq!(
            library.start_url().unwrap().as_deref(),
            Some("https://www.google.com/")
        );
        library
            .set_last_url("https://m.youtube.com/feed", &[])
            .unwrap();
        assert_eq!(
            library.start_url().unwrap().as_deref(),
            Some("https://m.youtube.com/feed")
        );
        library.set_favorites(vec![]).unwrap();
        library.clear_history().unwrap();
        assert_eq!(library.start_url().unwrap(), None);
    }

    #[test]
    fn the_search_home_start_page_opens_the_picked_engine_whatever_the_last_page() {
        let (dir, library) = library();
        library
            .set_last_url("https://m.youtube.com/feed", &[])
            .unwrap();
        library.set_search_engine(SearchEngine::Google).unwrap();
        library.set_start_page(StartPage::SearchHome).unwrap();
        assert_eq!(
            library.start_url().unwrap().as_deref(),
            Some("https://www.google.com/")
        );
        library.set_favorites(vec![]).unwrap();
        library.clear_history().unwrap();
        let reloaded = reload(&dir);
        assert_eq!(reloaded.state().unwrap().start_page, StartPage::SearchHome);
        assert_eq!(
            reloaded.start_url().unwrap().as_deref(),
            Some("https://www.google.com/")
        );
        library.set_start_page(StartPage::LastPage).unwrap();
        assert_eq!(library.start_url().unwrap(), None);
    }

    #[test]
    fn every_search_home_is_a_web_address() {
        for engine in [
            SearchEngine::DuckDuckGo,
            SearchEngine::Google,
            SearchEngine::Bing,
            SearchEngine::Brave,
            SearchEngine::Ecosia,
            SearchEngine::Startpage,
            SearchEngine::Yahoo,
        ] {
            assert!(parse_web_url(engine.home_url()).is_ok(), "{engine:?}");
        }
    }

    #[test]
    fn a_library_saved_before_the_start_page_opens_the_last_page() {
        let mut saved = serde_json::to_value(default_data()).unwrap();
        saved.as_object_mut().unwrap().remove("startPage");
        let data: LibraryData = serde_json::from_value(saved).unwrap();
        assert_eq!(data.start_page, StartPage::LastPage);
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
            Some("https://www.google.com/")
        );
    }

    #[test]
    fn a_new_library_has_only_the_default_search_engine_as_a_favorite() {
        let (_dir, library) = library();
        let favorites = library.state().unwrap().favorites;
        assert_eq!(favorites.len(), 1);
        assert_eq!(favorites[0].name, "Google");
        assert_eq!(favorites[0].url, "https://www.google.com/");
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
        assert!(library.set_last_url("javascript:1", &[]).is_err());
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
    fn the_bookmark_starts_empty_keeps_the_exact_page_and_survives_a_reload() {
        let (dir, library) = library();
        assert_eq!(library.state().unwrap().bookmark, None);
        let saved = library
            .set_bookmark("https://www.example.com/a/page?x=1", "  A page  ")
            .unwrap();
        assert_eq!(
            saved,
            Bookmark {
                url: "https://www.example.com/a/page?x=1".into(),
                title: "A page".into(),
            }
        );
        assert_eq!(reload(&dir).state().unwrap().bookmark, Some(saved));
        library.clear_bookmark().unwrap();
        assert_eq!(reload(&dir).state().unwrap().bookmark, None);
    }

    #[test]
    fn a_new_bookmark_replaces_the_old_one() {
        let (_dir, library) = library();
        library.set_bookmark("https://a.example/", "A").unwrap();
        library.set_bookmark("https://b.example/", "B").unwrap();
        assert_eq!(
            library.bookmark().unwrap().map(|bookmark| bookmark.url),
            Some("https://b.example/".into())
        );
    }

    #[test]
    fn a_bookmark_must_be_a_web_page() {
        let (_dir, library) = library();
        assert!(library.set_bookmark("javascript:alert(1)", "x").is_err());
        assert!(library.set_bookmark("file:///etc/passwd", "x").is_err());
        assert_eq!(library.bookmark().unwrap(), None);
    }

    #[test]
    fn a_bookmark_title_is_cleaned_cut_and_never_empty() {
        let (_dir, library) = library();
        let untitled = library
            .set_bookmark("https://www.example.com/", " \n\t ")
            .unwrap();
        assert_eq!(untitled.title, "example.com");
        let long = library
            .set_bookmark("https://a.example/", &"é".repeat(200))
            .unwrap();
        assert_eq!(long.title.chars().count(), MAX_BOOKMARK_TITLE_CHARS);
        let controls = library
            .set_bookmark("https://a.example/", "a\u{0}b\u{7}c")
            .unwrap();
        assert_eq!(controls.title, "abc");
    }

    #[test]
    fn clearing_history_keeps_the_bookmark_and_its_icon() {
        let (_dir, library) = library();
        library
            .set_bookmark("https://kept.example/page", "Kept")
            .unwrap();
        library
            .set_icon("kept.example", "data:image/png;base64,AAAA")
            .unwrap();
        library.clear_history().unwrap();
        assert!(library.bookmark().unwrap().is_some());
        assert!(library.icons().unwrap().contains_key("kept.example"));
    }

    #[test]
    fn a_damaged_bookmark_is_not_handed_to_the_shell() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("library.json");
        let mut saved = default_data();
        saved.bookmark = Some(Bookmark {
            url: "javascript:alert(1)".into(),
            title: "x".into(),
        });
        fs::write(&path, serde_json::to_vec(&saved).unwrap()).unwrap();
        assert_eq!(Library::load(path).unwrap().state().unwrap().bookmark, None);
    }

    #[test]
    fn the_search_engine_defaults_to_google_and_the_choice_persists() {
        let (dir, library) = library();
        assert_eq!(library.state().unwrap().search_engine, SearchEngine::Google);
        library.set_search_engine(SearchEngine::Brave).unwrap();
        assert_eq!(
            reload(&dir).state().unwrap().search_engine,
            SearchEngine::Brave
        );
    }

    #[test]
    fn accessibility_is_off_by_default_and_the_choices_persist() {
        let (dir, library) = library();
        assert_eq!(
            library.state().unwrap().accessibility,
            Accessibility::default()
        );
        let chosen = Accessibility {
            epilepsy_protection: true,
            font: ReadingFont::OpenDyslexic,
            spacing: true,
            tint: Tint::Mint,
        };
        library.set_accessibility(chosen).unwrap();
        assert_eq!(library.accessibility().unwrap(), chosen);
        assert_eq!(reload(&dir).state().unwrap().accessibility, chosen);
    }

    #[test]
    fn a_library_saved_before_accessibility_existed_loads_with_it_off() {
        let (dir, library) = library();
        library
            .set_accessibility(Accessibility {
                spacing: true,
                ..Accessibility::default()
            })
            .unwrap();
        let path = dir.path().join("library.json");
        let mut saved: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert!(
            saved
                .as_object_mut()
                .unwrap()
                .remove("accessibility")
                .is_some()
        );
        fs::write(&path, saved.to_string()).unwrap();
        drop(library);
        assert_eq!(
            reload(&dir).state().unwrap().accessibility,
            Accessibility::default()
        );
    }

    #[test]
    fn the_video_panel_is_off_by_default_and_the_choices_persist() {
        let (dir, library) = library();
        assert_eq!(
            library.state().unwrap().video_controls,
            VideoControls::default()
        );
        assert!(!library.state().unwrap().video_controls.panel);
        let chosen = VideoControls {
            panel: true,
            height: 40,
            skip: 15,
            auto_advance: true,
            ..VideoControls::default()
        };
        library.set_video_controls(chosen).unwrap();
        assert_eq!(library.video_controls().unwrap(), chosen);
        assert_eq!(reload(&dir).state().unwrap().video_controls, chosen);
        assert!(
            library
                .set_video_controls(VideoControls {
                    height: 201,
                    ..VideoControls::default()
                })
                .is_err()
        );
    }

    #[test]
    fn a_library_saved_before_video_controls_existed_loads_with_the_defaults() {
        let (dir, library) = library();
        library
            .set_video_controls(VideoControls {
                panel: true,
                ..VideoControls::default()
            })
            .unwrap();
        let path = dir.path().join("library.json");
        let mut saved: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert!(
            saved
                .as_object_mut()
                .unwrap()
                .remove("videoControls")
                .is_some()
        );
        fs::write(&path, saved.to_string()).unwrap();
        drop(library);
        assert_eq!(
            reload(&dir).state().unwrap().video_controls,
            VideoControls::default()
        );
    }

    #[test]
    fn a_site_keeps_its_own_video_choice_until_it_has_none() {
        let (dir, library) = library();
        assert!(library.state().unwrap().video_sites.is_empty());
        let own = SiteVideo {
            panel: Some(false),
            height: Some(48),
            skip: Some(30),
            full_videos: Some(true),
            drag_to_mini: Some(false),
            remember: Some(true),
            loop_off: Some(true),
            auto_advance: Some(false),
        };
        library.set_site_video("YouTube.com", own).unwrap();
        assert_eq!(reload(&dir).video_sites().unwrap()["youtube.com"], own);
        assert!(
            library
                .set_site_video(
                    "youtube.com",
                    SiteVideo {
                        height: Some(201),
                        ..SiteVideo::default()
                    }
                )
                .is_err()
        );
        let only_new = SiteVideo {
            auto_advance: Some(true),
            ..SiteVideo::default()
        };
        library.set_site_video("vimeo.com", only_new).unwrap();
        assert_eq!(reload(&dir).video_sites().unwrap()["vimeo.com"], only_new);
        assert!(library.set_site_video("https://a.example/", own).is_err());
        library
            .set_site_video("youtube.com", SiteVideo::default())
            .unwrap();
        library
            .set_site_video("vimeo.com", SiteVideo::default())
            .unwrap();
        assert!(reload(&dir).video_sites().unwrap().is_empty());
    }

    #[test]
    fn dark_mode_is_off_by_default_and_the_choices_persist() {
        let (dir, library) = library();
        assert_eq!(library.state().unwrap().dark_mode, DarkMode::default());
        assert!(!library.dark_mode().unwrap().enabled);
        let chosen = DarkMode {
            enabled: true,
            brightness: 80,
            background: "#101010".into(),
            ..DarkMode::default()
        };
        library.set_dark_mode(chosen.clone()).unwrap();
        assert_eq!(library.dark_mode().unwrap(), chosen);
        assert_eq!(reload(&dir).state().unwrap().dark_mode, chosen);
        let upper = DarkMode {
            text: "#FFFFFF".into(),
            ..chosen.clone()
        };
        library.set_dark_mode(upper).unwrap();
        assert_eq!(library.dark_mode().unwrap().text, "#ffffff");
        let bad = DarkMode {
            contrast: 200,
            ..chosen.clone()
        };
        assert!(library.set_dark_mode(bad).is_err());
        assert_eq!(library.dark_mode().unwrap().text, "#ffffff");
    }

    #[test]
    fn a_library_saved_before_dark_mode_existed_loads_with_the_defaults() {
        let (dir, library) = library();
        library
            .set_dark_mode(DarkMode {
                enabled: true,
                ..DarkMode::default()
            })
            .unwrap();
        library
            .set_site_dark(
                "a.example",
                SiteDark {
                    mode: Some(SiteDarkMode::On),
                    ..SiteDark::default()
                },
            )
            .unwrap();
        let path = dir.path().join("library.json");
        let mut saved: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let object = saved.as_object_mut().unwrap();
        assert!(object.remove("darkMode").is_some());
        assert!(object.remove("darkSites").is_some());
        fs::write(&path, saved.to_string()).unwrap();
        drop(library);
        let reloaded = reload(&dir);
        assert_eq!(reloaded.state().unwrap().dark_mode, DarkMode::default());
        assert!(reloaded.dark_sites().unwrap().is_empty());
    }

    #[test]
    fn a_site_keeps_its_own_dark_choice_until_it_has_none() {
        let (dir, library) = library();
        assert!(library.state().unwrap().dark_sites.is_empty());
        let own = SiteDark {
            mode: Some(SiteDarkMode::Off),
            method: Some(DarkMethod::Static),
            brightness: Some(90),
            text: Some("#ABCDEF".into()),
            schedule: Some(DarkSchedule {
                kind: ScheduleKind::Time,
                from: "20:00".into(),
                to: "06:00".into(),
            }),
            text_stroke: Some(2),
            images: Some(false),
            ..SiteDark::default()
        };
        library.set_site_dark("YouTube.com", own.clone()).unwrap();
        let stored = reload(&dir).dark_sites().unwrap()["youtube.com"].clone();
        assert_eq!(stored.text.as_deref(), Some("#abcdef"));
        assert_eq!(stored, own.clone().normalized());
        assert!(
            library
                .set_site_dark("https://a.example/", own.clone())
                .is_err()
        );
        for bad in [
            SiteDark {
                brightness: Some(151),
                ..SiteDark::default()
            },
            SiteDark {
                background: Some("red".into()),
                ..SiteDark::default()
            },
            SiteDark {
                schedule: Some(DarkSchedule {
                    from: "25:00".into(),
                    ..DarkSchedule::default()
                }),
                ..SiteDark::default()
            },
        ] {
            assert!(library.set_site_dark("youtube.com", bad).is_err());
        }
        assert_eq!(reload(&dir).dark_sites().unwrap()["youtube.com"], stored);
        library
            .set_site_dark("youtube.com", SiteDark::default())
            .unwrap();
        assert!(reload(&dir).dark_sites().unwrap().is_empty());
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
    fn preloading_favorites_is_on_by_default_and_remembered() {
        let (dir, library) = library();
        assert!(library.state().unwrap().preload_favorites);
        library.set_preload_favorites(false).unwrap();
        assert!(!reload(&dir).state().unwrap().preload_favorites);
    }

    #[test]
    fn popup_blocking_is_on_by_default_and_needs_ad_blocking() {
        let (dir, library) = library();
        assert!(library.popup_blocking_enabled().unwrap());
        library.set_block_popups(false).unwrap();
        assert!(!library.popup_blocking_enabled().unwrap());
        assert!(!reload(&dir).state().unwrap().block_popups);
        library.set_block_popups(true).unwrap();
        library.set_ad_block(false).unwrap();
        assert!(!library.popup_blocking_enabled().unwrap());
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
    fn the_color_picker_and_tech_detector_are_off_by_default_and_the_choices_persist() {
        let (dir, library) = library();
        let state = library.state().unwrap();
        assert!(!state.color_picker && !state.tech_detector);
        library.set_color_picker(true).unwrap();
        library.set_tech_detector(true).unwrap();
        let state = reload(&dir).state().unwrap();
        assert!(state.color_picker && state.tech_detector);
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
        library
            .set_favorites(vec![input("Reddit", "https://www.reddit.com/")])
            .unwrap();
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
            .set_favorites(vec![input("Reddit", "https://www.reddit.com/")])
            .unwrap();
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
            .set_favorites(vec![input("Reddit", "https://www.reddit.com/")])
            .unwrap();
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
            .set_site_option(Mode::Normal, "a.default", "x", OptionValue::Toggle(true))
            .unwrap();
        library
            .set_site_option(Mode::Normal, "a.default", "y", OptionValue::Toggle(false))
            .unwrap();
        library
            .set_site_option(Mode::Normal, "b.default", "x", OptionValue::Toggle(false))
            .unwrap();
        let choices = reload(&dir).site_options(Mode::Normal).unwrap();
        assert_eq!(choices["a.default"]["x"], OptionValue::Toggle(true));
        assert_eq!(choices["a.default"]["y"], OptionValue::Toggle(false));
        assert_eq!(choices["b.default"]["x"], OptionValue::Toggle(false));
    }

    #[test]
    fn a_choice_persists_and_booleans_saved_by_earlier_versions_still_load() {
        let (dir, library) = library();
        library
            .set_site_option(
                Mode::Normal,
                "a.default",
                "media",
                OptionValue::Choice("blur".into()),
            )
            .unwrap();
        let path = dir.path().join("library.json");
        let mut json: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        json["siteOptions"]["a.default"]["old"] = serde_json::Value::Bool(true);
        fs::write(&path, json.to_string()).unwrap();
        let choices = reload(&dir).site_options(Mode::Normal).unwrap();
        assert_eq!(
            choices["a.default"]["media"],
            OptionValue::Choice("blur".into())
        );
        assert_eq!(choices["a.default"]["old"], OptionValue::Toggle(true));
    }

    #[test]
    fn incognito_toggles_are_a_separate_set_that_persists() {
        let (dir, library) = library();
        library
            .set_site_option(Mode::Normal, "a.default", "x", OptionValue::Toggle(true))
            .unwrap();
        library
            .set_site_option(
                Mode::Incognito,
                "a.default",
                "x",
                OptionValue::Toggle(false),
            )
            .unwrap();
        library
            .set_site_option(Mode::Incognito, "b.default", "y", OptionValue::Toggle(true))
            .unwrap();
        let reloaded = reload(&dir);
        let normal = reloaded.site_options(Mode::Normal).unwrap();
        let incognito = reloaded.site_options(Mode::Incognito).unwrap();
        assert_eq!(normal["a.default"]["x"], OptionValue::Toggle(true));
        assert!(!normal.contains_key("b.default"));
        assert_eq!(incognito["a.default"]["x"], OptionValue::Toggle(false));
        assert_eq!(incognito["b.default"]["y"], OptionValue::Toggle(true));
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
    fn background_media_is_off_by_default_per_site_and_persists() {
        let (dir, library) = library();
        assert!(library.state().unwrap().background_media_sites.is_empty());
        library.set_background_media("Instagram.com", true).unwrap();
        library.set_background_media("music.example", true).unwrap();
        assert_eq!(
            reload(&dir).background_media_sites().unwrap(),
            vec!["instagram.com".to_string(), "music.example".to_string()]
        );
        let left = library
            .set_background_media("instagram.com", false)
            .unwrap();
        assert_eq!(left, vec!["music.example".to_string()]);
    }

    #[test]
    fn background_media_refuses_a_site_that_is_not_a_domain() {
        let (_dir, library) = library();
        for bad in [
            "",
            " ",
            "a b.example",
            "https://a.example/",
            "-a.example",
            "a.example.",
        ] {
            assert!(
                matches!(
                    library.set_background_media(bad, true),
                    Err(Error::UnknownSite)
                ),
                "{bad:?}"
            );
        }
        assert!(library.background_media_sites().unwrap().is_empty());
    }

    #[test]
    fn picture_in_picture_is_off_by_default_per_site_and_persists() {
        let (dir, library) = library();
        assert!(library.state().unwrap().picture_in_picture_sites.is_empty());
        library.set_picture_in_picture("YouTube.com", true).unwrap();
        library.set_picture_in_picture("vimeo.com", true).unwrap();
        assert_eq!(
            reload(&dir).picture_in_picture_sites().unwrap(),
            vec!["vimeo.com".to_string(), "youtube.com".to_string()]
        );
        let left = library
            .set_picture_in_picture("youtube.com", false)
            .unwrap();
        assert_eq!(left, vec!["vimeo.com".to_string()]);
        assert!(matches!(
            library.set_picture_in_picture("https://a.example/", true),
            Err(Error::UnknownSite)
        ));
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
        let names: Vec<_> = reloaded
            .incognito_favorites()
            .unwrap()
            .into_iter()
            .map(|favorite| favorite.name)
            .collect();
        assert_eq!(names, ["Google"]);
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
    fn removing_a_history_entry_keeps_the_others_in_order() {
        let (dir, library) = library();
        library.add_history("https://a.example/").unwrap();
        library.add_history("https://b.example/").unwrap();
        library.add_history("https://c.example/").unwrap();
        let history = library.remove_history("https://b.example/").unwrap();
        assert_eq!(history, ["https://c.example/", "https://a.example/"]);
        assert_eq!(reload(&dir).state().unwrap().history, history);
        assert_eq!(
            library.remove_history("https://zzz.example/").unwrap(),
            history
        );
    }

    #[test]
    fn clearing_history_forgets_the_last_page_but_keeps_favorites() {
        let (dir, library) = library();
        library.add_history("https://a.example/").unwrap();
        library.set_last_url("https://a.example/", &[]).unwrap();
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
    #[test]
    fn concurrent_writes_to_one_file_never_share_a_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("recipe.json");
        let writers: Vec<_> = (0..16)
            .map(|n| {
                let path = path.clone();
                std::thread::spawn(move || {
                    let body = format!("{{\"n\":{n}}}").repeat(2000);
                    write_atomically(&path, body.as_bytes()).unwrap();
                    body
                })
            })
            .collect();
        let bodies: Vec<String> = writers.into_iter().map(|w| w.join().unwrap()).collect();
        let stored = fs::read_to_string(&path).unwrap();
        assert!(
            bodies.contains(&stored),
            "the file is exactly one writer's content"
        );
        let leftovers = fs::read_dir(dir.path()).unwrap().count();
        assert_eq!(leftovers, 1, "no temp file is left behind");
    }
}
