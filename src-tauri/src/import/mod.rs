//! Bringing in what another browser held, from the files it exports.
//!
//! The person picks the files (bookmarks, history, passwords, a Chromium `Preferences`); the shell
//! reads each one's text once and hands it to [`ImportState::absorb`], which keeps what it found
//! in memory for [`PENDING_MINUTES`]. The shell gets back only a [`Preview`]: counts, the sites
//! the person uses and the official recipes that match them, never a password. [`apply`] then does
//! what the person ticked: installs recipes, adds favorites (within the free or Pro limit), fills
//! history, sets the search engine and seals the logins in the vault (`vault.rs`). Nothing leaves
//! the device, and the pending data is dropped when it is applied, cancelled or too old.

#[cfg(desktop)]
pub mod browsers;
pub mod parse;

use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri_plugin_siteview::site::registrable_domain;
use zeroize::Zeroizing;

use crate::error::{Error, Result};
use crate::library::{
    FAVORITE_LIMIT, FavoriteInput, Library, MAX_FAVORITE_NAME_CHARS, SearchEngine,
};
use crate::recipes::bundled::Bundled;
use crate::vault::{NewEntry, Vault};
use parse::{Credential, Link, Parsed};

/// How long parsed files wait for the person to choose.
pub const PENDING_MINUTES: u64 = 10;
/// A bookmark counts this many visits when ranking sites.
const BOOKMARK_WEIGHT: u64 = 3;
/// How many suggestions of each kind the preview lists.
const MAX_SUGGESTIONS: usize = 12;

/// What one source (a file or a browser profile) held.
#[derive(Default)]
pub struct Found {
    pub bookmarks: Vec<Link>,
    pub history: Vec<Link>,
    pub credentials: Vec<Credential>,
    pub search_engine: Option<SearchEngine>,
    /// Saved passwords the source has but this app cannot open.
    pub unreadable_passwords: usize,
}

#[derive(Default)]
struct Pending {
    bookmarks: Vec<Link>,
    history: Vec<Link>,
    credentials: Vec<Credential>,
    search_engine: Option<SearchEngine>,
    unreadable_passwords: usize,
    /// Browser profiles already read, so choosing one twice does not count it twice.
    sources: Vec<String>,
    since: Option<Instant>,
}

/// What has been read and not yet applied.
#[derive(Default)]
pub struct ImportState(Mutex<Pending>);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeSuggestion {
    pub recipe_id: String,
    pub name: String,
    pub site: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteSuggestion {
    pub site: String,
    pub name: String,
}

/// What the files hold, for the person to choose from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub bookmarks: usize,
    pub history: usize,
    pub passwords: usize,
    pub password_sites: usize,
    pub unreadable_passwords: usize,
    pub search_engine: Option<SearchEngine>,
    pub recipes: Vec<RecipeSuggestion>,
    pub sites: Vec<SiteSuggestion>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Choices {
    pub recipes: Vec<String>,
    pub sites: Vec<String>,
    pub history: bool,
    pub search_engine: bool,
    pub passwords: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub recipes: usize,
    pub favorites: usize,
    pub history: usize,
    pub search_engine: bool,
    pub passwords: usize,
}

impl ImportState {
    fn pending(&self) -> Result<std::sync::MutexGuard<'_, Pending>> {
        let mut pending = self.0.lock().map_err(|_| Error::Poisoned)?;
        if pending
            .since
            .is_some_and(|since| since.elapsed() > Duration::from_secs(PENDING_MINUTES * 60))
        {
            *pending = Pending::default();
        }
        Ok(pending)
    }

    /// Reads one file's text and adds what it holds to what is pending.
    pub fn absorb(&self, text: &str) -> Result<()> {
        if text.len() > parse::MAX_FILE_BYTES {
            return Err(Error::Import("that file is too large".into()));
        }
        let Parsed {
            links,
            is_history,
            credentials,
            search_engine,
        } = parse::parse(text);
        let (bookmarks, history) = if is_history {
            (Vec::new(), links)
        } else {
            (links, Vec::new())
        };
        self.add(
            None,
            Found {
                bookmarks,
                history,
                credentials,
                search_engine,
                unreadable_passwords: 0,
            },
        )
    }

    /// Adds what one source held. A `source` already added is not added again.
    pub fn add(&self, source: Option<&str>, found: Found) -> Result<()> {
        let mut pending = self.pending()?;
        if let Some(source) = source {
            if pending.sources.iter().any(|known| known == source) {
                return Ok(());
            }
            pending.sources.push(source.to_owned());
        }
        pending.since.get_or_insert_with(Instant::now);
        pending.bookmarks.extend(found.bookmarks);
        pending.history.extend(found.history);
        pending.credentials.extend(found.credentials);
        pending.unreadable_passwords += found.unreadable_passwords;
        pending.search_engine = found.search_engine.or(pending.search_engine);
        Ok(())
    }

    pub fn preview(&self, recipes: &[Bundled]) -> Result<Preview> {
        let pending = self.pending()?;
        Ok(preview_of(&pending, recipes))
    }

    pub fn cancel(&self) {
        if let Ok(mut pending) = self.0.lock() {
            *pending = Pending::default();
        }
    }
}

struct SiteStat {
    score: u64,
    /// The address visited or saved most, and how often.
    best: (u64, String),
}

fn site_stats(pending: &Pending) -> HashMap<String, SiteStat> {
    let mut stats: HashMap<String, SiteStat> = HashMap::new();
    let weighted = pending
        .bookmarks
        .iter()
        .map(|link| (link, BOOKMARK_WEIGHT))
        .chain(
            pending
                .history
                .iter()
                .map(|link| (link, u64::from(link.visits))),
        );
    for (link, weight) in weighted {
        let Some(site) = url::Url::parse(&link.url)
            .ok()
            .and_then(|url| url.host_str().and_then(registrable_domain))
        else {
            continue;
        };
        let stat = stats.entry(site).or_insert_with(|| SiteStat {
            score: 0,
            best: (0, link.url.clone()),
        });
        stat.score += weight;
        if weight > stat.best.0 || (weight == stat.best.0 && link.url.len() < stat.best.1.len()) {
            stat.best = (weight, link.url.clone());
        }
    }
    stats
}

/// The site's first label with a capital: `reddit.com` becomes `Reddit`.
fn display_name(site: &str) -> String {
    let label = site.split('.').next().unwrap_or(site);
    let mut chars = label.chars();
    let name: String = chars
        .next()
        .map(|first| first.to_uppercase().chain(chars).collect())
        .unwrap_or_default();
    name.chars().take(MAX_FAVORITE_NAME_CHARS).collect()
}

fn recipe_site(bundled: &Bundled) -> Option<String> {
    bundled
        .hosts()
        .iter()
        .find_map(|host| registrable_domain(host))
}

fn preview_of(pending: &Pending, recipes: &[Bundled]) -> Preview {
    let stats = site_stats(pending);
    let mut matched: Vec<(u64, RecipeSuggestion)> = recipes
        .iter()
        .filter_map(|bundled| {
            let site = recipe_site(bundled)?;
            let stat = stats.get(&site)?;
            Some((
                stat.score,
                RecipeSuggestion {
                    recipe_id: bundled.recipe.id.clone(),
                    name: bundled.recipe.name.clone(),
                    site,
                },
            ))
        })
        .collect();
    matched.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.name.cmp(&b.1.name)));
    matched.truncate(MAX_SUGGESTIONS);
    let covered: Vec<String> = recipes.iter().filter_map(recipe_site).collect();
    let mut others: Vec<(&String, &SiteStat)> = stats
        .iter()
        .filter(|(site, _)| !covered.contains(site))
        .collect();
    others.sort_by(|a, b| b.1.score.cmp(&a.1.score).then_with(|| a.0.cmp(b.0)));
    others.truncate(MAX_SUGGESTIONS);
    let mut password_sites: Vec<String> = pending
        .credentials
        .iter()
        .filter_map(credential_site)
        .collect();
    password_sites.sort();
    password_sites.dedup();
    Preview {
        bookmarks: pending.bookmarks.len(),
        history: pending.history.len(),
        passwords: pending.credentials.len(),
        password_sites: password_sites.len(),
        unreadable_passwords: pending.unreadable_passwords,
        search_engine: pending.search_engine,
        recipes: matched
            .into_iter()
            .map(|(_, suggestion)| suggestion)
            .collect(),
        sites: others
            .into_iter()
            .map(|(site, _)| SiteSuggestion {
                site: site.clone(),
                name: display_name(site),
            })
            .collect(),
    }
}

fn credential_site(credential: &Credential) -> Option<String> {
    url::Url::parse(&credential.url)
        .ok()?
        .host_str()
        .and_then(registrable_domain)
}

/// Everything [`apply`] changes. Separate so a test can hand in plain values.
pub struct Targets<'a> {
    pub library: &'a Library,
    pub vault: &'a Vault,
    pub secrets: &'a dyn crate::secrets::SecretStore,
    pub official: &'a [Bundled],
    /// Installs one official recipe by id.
    pub install: &'a dyn Fn(&str) -> Result<()>,
}

/// Does what the person ticked, then forgets the pending files.
pub fn apply(
    state: &ImportState,
    targets: &Targets<'_>,
    choices: &Choices,
) -> Result<ImportResult> {
    let mut pending = state.pending()?;
    let stats = site_stats(&pending);
    let mut result = ImportResult::default();
    let mut additions: Vec<FavoriteInput> = Vec::new();

    for id in &choices.recipes {
        let Some(bundled) = targets.official.iter().find(|b| &b.recipe.id == id) else {
            return Err(Error::Import(
                "that recipe is not one of the official ones".into(),
            ));
        };
        (targets.install)(id)?;
        result.recipes += 1;
        if let Some(homepage) = bundled.recipe.homepage() {
            additions.push(favorite(&bundled.recipe.name, homepage));
        }
    }
    for site in &choices.sites {
        let Some(stat) = stats.get(site) else {
            return Err(Error::Import("that site was not in the files".into()));
        };
        additions.push(favorite(&display_name(site), &stat.best.1));
    }
    result.favorites = add_favorites(targets, additions)?;

    if choices.history {
        result.history = add_history(targets.library, &pending)?;
    }
    if choices.search_engine
        && let Some(engine) = pending.search_engine
    {
        targets.library.set_search_engine(engine)?;
        result.search_engine = true;
    }
    if choices.passwords {
        let entries = pending
            .credentials
            .iter()
            .filter_map(new_entry)
            .collect::<Vec<_>>();
        result.passwords = targets.vault.add_many(targets.secrets, entries)?;
    }
    *pending = Pending::default();
    Ok(result)
}

fn favorite(name: &str, url: &str) -> FavoriteInput {
    FavoriteInput {
        name: name.chars().take(MAX_FAVORITE_NAME_CHARS).collect(),
        url: url.to_owned(),
        notify: true,
        landing: None,
        folder: None,
    }
}

fn site_of_url(url: &str) -> Option<String> {
    url::Url::parse(url)
        .ok()?
        .host_str()
        .and_then(registrable_domain)
}

/// Adds to the favorites without removing any, skipping sites already there, up to the limit.
fn add_favorites(targets: &Targets<'_>, additions: Vec<FavoriteInput>) -> Result<usize> {
    let limit = FAVORITE_LIMIT;
    let mut list: Vec<FavoriteInput> = targets
        .library
        .favorites()?
        .into_iter()
        .map(|existing| FavoriteInput {
            name: existing.name,
            url: existing.url,
            notify: existing.notify,
            landing: existing.landing,
            folder: existing.folder,
        })
        .collect();
    let mut added = 0;
    for item in additions {
        let site = site_of_url(&item.url);
        let known = list.iter().any(|have| site_of_url(&have.url) == site);
        if known || list.len() >= limit {
            continue;
        }
        list.push(item);
        added += 1;
    }
    if added > 0 {
        targets.library.set_favorites(list)?;
    }
    Ok(added)
}

/// Fills the searched-address history, the most visited last so it ends up on top.
fn add_history(library: &Library, pending: &Pending) -> Result<usize> {
    let source = if pending.history.is_empty() {
        &pending.bookmarks
    } else {
        &pending.history
    };
    let mut links: Vec<&Link> = source.iter().collect();
    links.sort_by(|a, b| b.visits.cmp(&a.visits).then_with(|| a.url.cmp(&b.url)));
    links.dedup_by(|a, b| a.url == b.url);
    links.truncate(100);
    for link in links.iter().rev() {
        library.add_history(&link.url)?;
    }
    Ok(links.len())
}

fn new_entry(credential: &Credential) -> Option<NewEntry> {
    let url = url::Url::parse(&credential.url).ok()?;
    let site = url.host_str().and_then(registrable_domain)?;
    Some(NewEntry {
        site,
        origin: url.origin().ascii_serialization(),
        name: credential.name.chars().take(100).collect(),
        username: credential.username.clone(),
        password: Zeroizing::new(credential.password.to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::recipes::bundled;
    use crate::secrets::MemoryStore;

    fn official() -> Vec<Bundled> {
        bundled::all()
            .iter()
            .filter(|b| b.is_official())
            .cloned()
            .collect()
    }

    const HISTORY: &str = r#"{"history":[
        {"url":"https://www.reddit.com/r/rust/","visit_count":50},
        {"url":"https://old.reddit.com/","visit_count":5},
        {"url":"https://www.youtube.com/","visit_count":30},
        {"url":"https://example.org/a","visit_count":9},
        {"url":"https://obscure.example.net/","visit_count":1}]}"#;

    #[test]
    fn the_preview_ranks_sites_and_matches_official_recipes() {
        let state = ImportState::default();
        state.absorb(HISTORY).unwrap();
        let preview = state.preview(&official()).unwrap();
        assert_eq!(preview.history, 5);
        let names: Vec<&str> = preview.recipes.iter().map(|r| r.site.as_str()).collect();
        assert_eq!(&names[..2], ["reddit.com", "youtube.com"]);
        let other: Vec<&str> = preview.sites.iter().map(|s| s.site.as_str()).collect();
        assert_eq!(other[0], "example.org");
        assert_eq!(preview.sites[0].name, "Example");
        assert!(!other.contains(&"reddit.com"));
    }

    #[test]
    fn the_preview_counts_passwords_without_showing_them() {
        let state = ImportState::default();
        state
            .absorb("url,username,password\nhttps://a.example.com,u,secret-one\nhttps://b.example.org,u,secret-two\nhttps://a.example.com/x,v,secret-three\n")
            .unwrap();
        let preview = state.preview(&official()).unwrap();
        assert_eq!((preview.passwords, preview.password_sites), (3, 2));
        assert!(!serde_json::to_string(&preview).unwrap().contains("secret"));
    }

    #[test]
    fn a_browser_profile_chosen_twice_counts_once() {
        let state = ImportState::default();
        let found = || Found {
            history: vec![Link {
                url: "https://www.reddit.com/".into(),
                title: String::new(),
                visits: 4,
            }],
            unreadable_passwords: 2,
            ..Found::default()
        };
        state.add(Some("chrome/Default"), found()).unwrap();
        state.add(Some("chrome/Default"), found()).unwrap();
        state.add(Some("brave/Default"), found()).unwrap();
        let preview = state.preview(&official()).unwrap();
        assert_eq!(preview.history, 2);
        assert_eq!(preview.unreadable_passwords, 4);
    }

    #[test]
    fn several_files_add_up_and_cancel_forgets_them() {
        let state = ImportState::default();
        state.absorb(HISTORY).unwrap();
        state
            .absorb("<A HREF=\"https://github.com/\">GitHub</A>")
            .unwrap();
        let preview = state.preview(&official()).unwrap();
        assert_eq!((preview.history, preview.bookmarks), (5, 1));
        state.cancel();
        let preview = state.preview(&official()).unwrap();
        assert_eq!(
            (preview.history, preview.bookmarks, preview.passwords),
            (0, 0, 0)
        );
    }

    #[test]
    fn an_oversized_file_is_refused() {
        let state = ImportState::default();
        let huge = " ".repeat(parse::MAX_FILE_BYTES + 1);
        assert!(state.absorb(&huge).is_err());
    }

    struct Fixture {
        _dir: tempfile::TempDir,
        library: Library,
        vault: Vault,
        secrets: MemoryStore,
        recipes: crate::recipes::Recipes,
        official: Vec<Bundled>,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        Fixture {
            library: Library::load(dir.path().join("library.json")).unwrap(),
            vault: Vault::new(dir.path().join("passwords.vault")),
            secrets: MemoryStore::default(),
            recipes: crate::recipes::Recipes::load(dir.path().join("recipes")).unwrap(),
            official: official(),
            _dir: dir,
        }
    }

    fn run(f: &Fixture, state: &ImportState, choices: &Choices) -> Result<ImportResult> {
        let install = |id: &str| -> Result<()> {
            let bundled = bundled::find(id).ok_or(Error::UnknownOption)?;
            f.recipes.save_bundled(bundled.recipe.clone())?;
            Ok(())
        };
        apply(
            state,
            &Targets {
                library: &f.library,
                vault: &f.vault,
                secrets: &f.secrets,
                official: &f.official,
                install: &install,
            },
            choices,
        )
    }

    #[test]
    fn applying_adds_favorites_within_the_limit_and_keeps_the_existing() {
        let f = fixture();
        let state = ImportState::default();
        let many: String = (0..8)
            .map(|n| format!("<A HREF=\"https://site{n}.com/\">s</A>"))
            .collect();
        state.absorb(&many).unwrap();
        let sites: Vec<String> = state
            .preview(&f.official)
            .unwrap()
            .sites
            .into_iter()
            .map(|s| s.site)
            .collect();
        let before = f.library.favorites().unwrap().len();
        let result = run(
            &f,
            &state,
            &Choices {
                sites,
                ..Choices::default()
            },
        )
        .unwrap();
        assert_eq!(result.favorites, FAVORITE_LIMIT - before);
        assert_eq!(f.library.favorites().unwrap().len(), FAVORITE_LIMIT);
    }

    #[test]
    fn applying_installs_recipes_history_search_and_passwords_then_forgets() {
        let f = fixture();
        let state = ImportState::default();
        state.absorb(HISTORY).unwrap();
        state
            .absorb(r#"{"default_search_provider_data":{"template_url_data":{"url":"https://duckduckgo.com/?q={searchTerms}"}}}"#)
            .unwrap();
        state
            .absorb("url,username,password\nhttps://www.reddit.com/login,me,pw1\n")
            .unwrap();
        let choices = Choices {
            recipes: vec!["market.official.youtube".into()],
            history: true,
            search_engine: true,
            passwords: true,
            ..Choices::default()
        };
        let result = run(&f, &state, &choices).unwrap();
        assert_eq!(result.recipes, 1);
        assert!(f.recipes.get("market.official.youtube").is_some());
        assert_eq!(result.history, 5);
        assert_eq!(
            f.library.history().unwrap()[0],
            "https://www.reddit.com/r/rust/"
        );
        assert!(result.search_engine);
        assert_eq!(
            f.library.state().unwrap().search_engine,
            SearchEngine::DuckDuckGo
        );
        assert_eq!(result.passwords, 1);
        assert_eq!(f.vault.list(&f.secrets).unwrap()[0].site, "reddit.com");
        let after = state.preview(&f.official).unwrap();
        assert_eq!((after.history, after.passwords), (0, 0));
    }

    #[test]
    fn what_is_not_ticked_is_left_alone() {
        let f = fixture();
        let state = ImportState::default();
        state.absorb(HISTORY).unwrap();
        state
            .absorb("url,username,password\nhttps://www.reddit.com/login,me,pw1\n")
            .unwrap();
        let result = run(&f, &state, &Choices::default()).unwrap();
        assert_eq!(result, ImportResult::default());
        assert!(f.library.history().unwrap().is_empty());
        assert!(f.vault.list(&f.secrets).unwrap().is_empty());
    }

    #[test]
    fn a_recipe_or_site_the_files_did_not_offer_is_refused() {
        let f = fixture();
        let state = ImportState::default();
        state.absorb(HISTORY).unwrap();
        let bad_recipe = Choices {
            recipes: vec!["market.nothing".into()],
            ..Choices::default()
        };
        assert!(run(&f, &state, &bad_recipe).is_err());
        let bad_site = Choices {
            sites: vec!["evil.example".into()],
            ..Choices::default()
        };
        assert!(run(&f, &state, &bad_site).is_err());
    }
}
