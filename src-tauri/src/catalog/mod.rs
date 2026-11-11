//! The recipe marketplace, from the device's side. The server is untrusted: the signed index
//! (`index`) says what exists, every download is tied back to it, and the recipe goes through the
//! same validation as a pasted one before the user is asked anything. See `docs/wiki/marketplace.md`.

mod client;
pub mod commands;
mod community;
pub mod index;
mod onboarding;
mod state;

use std::{
    collections::BTreeMap,
    sync::{Mutex, PoisonError},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;

pub use client::{Market, ProUser, ReportReason, Submitted};
pub use community::{Comments, RatingSummary};
pub use onboarding::{OnboardingOption, OnboardingResult};
pub use state::State;

use crate::error::{Error, Result};
use crate::recipes::{self, Meta, Recipe, RecipePreview, Recipes};
use index::{Entry, Index};

/// What the marketplace needs to know about the person: whether they are Pro, and the store's
/// anonymous app user id. A trait so tests can stand in for the store.
pub trait Account {
    /// `Err(Error::ProRequired)` unless the entitlement is Pro.
    fn require_pro(&self) -> Result<()>;
    /// The store's app user id; `None` on a platform with no store. Blocks on native code.
    fn app_user_id(&self) -> Result<Option<String>>;
}

/// The id to send on a Pro-gated action, or a plain error when this platform cannot give one.
fn pro_user(account: &impl Account) -> Result<ProUser> {
    match account.app_user_id()? {
        Some(id) => ProUser::new(&id),
        None => Err(Error::Catalog(
            "this needs an app store subscription, which this device does not have".into(),
        )),
    }
}

const MAX_SUMMARY_CHARS: usize = 140;
const MAX_SLUG_CHARS: usize = 61;
const MAX_COMMENT_CHARS: usize = 280;

pub struct Catalog {
    market: Option<Market>,
    state: State,
    index: Mutex<Option<Index>>,
}

/// One row of the Marketplace screen.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub name: String,
    pub version: String,
    pub author: String,
    pub summary: String,
    pub hosts: Vec<String>,
    pub featured: bool,
    /// Platform and origin tags, plus `hub` when the recipe has launcher tabs.
    pub tags: Vec<String>,
    pub homepage: Option<String>,
    pub installs: Option<u64>,
    pub rating: Option<RatingSummary>,
    /// The stars this device gave it.
    pub my_rating: Option<u8>,
    pub installed_version: Option<String>,
    pub update_available: bool,
}

/// A bounded public catalog result exposed only to the in-process assistant tool loop.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSearchResult {
    pub id: String,
    pub name: String,
    pub summary: String,
    pub hosts: Vec<String>,
    pub hub: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub items: Vec<Item>,
    /// Names of installed recipes that were withdrawn; they were removed from this device.
    pub withdrawn: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub available: bool,
    pub count_installs: bool,
}

impl Catalog {
    pub fn new(market: Option<Market>, state: State) -> Self {
        Self {
            market,
            state,
            index: Mutex::new(None),
        }
    }

    pub fn status(&self) -> Status {
        Status {
            available: self.market.is_some(),
            count_installs: self.state.count_installs(),
        }
    }

    pub fn set_count_installs(&self, on: bool) -> Result<()> {
        self.state.set_count_installs(on)
    }

    /// Fetches and verifies the catalog, removes any installed recipe it withdrew, remembers it
    /// as the current one, and returns it with the names of what was withdrawn.
    async fn fetch(&self, recipes: &Recipes) -> Result<(Index, Vec<String>)> {
        let market = self.market()?;
        let index = market.fetch_index(now(), self.state.sequence()).await?;
        self.state.accept_sequence(index.sequence)?;
        let withdrawn = self.remove_withdrawn(recipes, &index)?;
        *self.index.lock().unwrap_or_else(PoisonError::into_inner) = Some(index.clone());
        Ok((index, withdrawn))
    }

    /// Fetches and verifies the catalog and lists what it holds. Install counts and ratings are
    /// display-only extras: failing to fetch them is not an error.
    pub async fn refresh(&self, recipes: &Recipes) -> Result<Listing> {
        let (index, withdrawn) = self.fetch(recipes).await?;
        let market = self.market()?;
        let stats = market.fetch_stats().await;
        let ratings = market.fetch_ratings().await;
        let items = listing(&index, &stats, &ratings, &self.state.my_ratings(), |id| {
            recipes.imported_version(id)
        });
        Ok(Listing { items, withdrawn })
    }

    /// Searches the signed marketplace catalog for the assistant. Results are public metadata,
    /// capped at eight; each returned id still needs a separate hash-checked read.
    pub async fn search_for_agent(
        &self,
        recipes: &Recipes,
        query: &str,
    ) -> Result<Vec<AgentSearchResult>> {
        let query = query.trim();
        if query.is_empty() || query.chars().count() > 100 {
            return Err(Error::Catalog("search needs 1 to 100 characters".into()));
        }
        let index = match self.cached_index() {
            Ok(index) => index,
            Err(_) => self.fetch(recipes).await?.0,
        };
        let query = query.to_lowercase();
        Ok(index
            .recipes
            .iter()
            .filter(|entry| {
                entry.name.to_lowercase().contains(&query)
                    || entry.summary.to_lowercase().contains(&query)
                    || entry
                        .hosts
                        .iter()
                        .any(|host| host.to_lowercase().contains(&query))
                    || entry.id.to_lowercase().contains(&query)
            })
            .take(8)
            .map(|entry| AgentSearchResult {
                id: entry.id.clone(),
                name: entry.name.clone(),
                summary: entry.summary.clone(),
                hosts: entry.hosts.clone(),
                hub: entry.has_tag(index::TAG_HUB),
            })
            .collect())
    }

    /// Reads one public recipe only after verifying its bytes against the signed catalog entry.
    pub async fn read_for_agent(&self, id: &str) -> Result<Recipe> {
        self.download(id).await.map(|(recipe, _)| recipe)
    }

    /// What installing would add, rule by rule. Downloads and verifies; saves nothing.
    pub async fn preview(&self, recipes: &Recipes, id: &str) -> Result<RecipePreview> {
        let (recipe, _) = self.download(id).await?;
        Ok(recipes::preview_recipe(
            &recipe,
            recipes.imported_version(id).as_deref(),
        ))
    }

    /// Downloads again, re-verifies, and saves. The review the user saw was of the same signed
    /// bytes, but nothing is trusted from the earlier request.
    pub async fn install(&self, recipes: &Recipes, id: &str) -> Result<Recipe> {
        let (recipe, entry) = self.download(id).await?;
        let saved = recipes.save_catalog(recipe)?;
        self.state.record_install(id, &entry.sha256)?;
        if self.state.count_installs() {
            // The count is a courtesy to the author; it must never fail an install.
            let _ = self.market()?.report_install(id).await;
        }
        Ok(saved)
    }

    pub fn uninstall(&self, recipes: &Recipes, id: &str) -> Result<()> {
        recipes.remove_imported(id)?;
        self.state.forget(id)
    }

    pub async fn report(&self, id: &str, reason: ReportReason) -> Result<()> {
        let entry = self.entry(id)?;
        self.market()?.report(id, &entry.version, reason).await
    }

    /// Sends one of the user's own recipes to the marketplace under `market.<slug>`. Pro only,
    /// checked before anything else. The recipe is checked here exactly as the server and every
    /// device will check it. The server checks it automatically and holds it before it is
    /// published; no person reviews it. Everything uploaded is community, never official.
    pub async fn submit(
        &self,
        account: &impl Account,
        recipes: &Recipes,
        recipe_id: &str,
        slug: &str,
        summary: &str,
        author: &str,
    ) -> Result<Submitted> {
        account.require_pro()?;
        let market = self.market()?;
        if !is_slug(slug) {
            return Err(Error::Catalog(
                "a name for the marketplace uses lowercase letters, digits, '.' and '-'".into(),
            ));
        }
        if summary.trim().is_empty() || !recipes::is_plain_text(summary, MAX_SUMMARY_CHARS) {
            return Err(Error::Catalog("write a one-line summary".into()));
        }
        let mut recipe = recipes.get(recipe_id).ok_or(Error::UnknownSite)?;
        recipe.id = format!("{}{slug}", recipes::MARKET_PREFIX);
        let homepage = recipe.homepage().map(str::to_owned);
        recipe.meta = Some(Meta {
            author: Some(author.trim().to_owned()),
            homepage,
            last_verified: None,
            notes: None,
        });
        let checked = recipes::parse_catalog_recipe(&serde_json::to_vec(&recipe)?)?;
        if checked.id.starts_with(index::OFFICIAL_ID_PREFIX) {
            return Err(Error::Catalog("that name is reserved".into()));
        }
        let pro = pro_user(account)?;
        let token = self.state.edit_token(&checked.id);
        let submitted = market
            .submit(&checked, summary.trim(), token.as_deref(), &pro)
            .await?;
        if let Some(token) = &submitted.edit_token {
            self.state.set_edit_token(&checked.id, token)?;
        }
        Ok(submitted)
    }

    /// Rates a recipe 1-5. Needs no account: only the device token and the app marker are sent.
    pub async fn rate(&self, id: &str, stars: u8) -> Result<()> {
        let market = self.market()?;
        self.entry(id)?;
        let token = self.state.device_token()?;
        market.rate(id, stars, &token).await?;
        self.state.set_my_rating(id, stars)
    }

    /// The comments on a recipe, without the ones from commenters this device blocked.
    pub async fn comments(&self, account: &impl Account, id: &str) -> Result<Comments> {
        let wire = self.market()?.comments(id).await?;
        let own = account
            .app_user_id()
            .ok()
            .flatten()
            .map(|user| community::commenter_of(&user));
        let comments = community::visible_comments(wire, &self.state.blocked(), own.as_deref())?;
        Ok(Comments { comments })
    }

    /// Posts a comment. Pro only: the gate is checked before any request.
    pub async fn post_comment(&self, account: &impl Account, id: &str, text: &str) -> Result<()> {
        account.require_pro()?;
        let market = self.market()?;
        let text = text.trim();
        let long = text.chars().count() > MAX_COMMENT_CHARS;
        if text.is_empty() || long || !recipes::is_plain_text(text, MAX_COMMENT_CHARS) {
            return Err(Error::Catalog("a comment is 1 to 280 characters".into()));
        }
        let pro = pro_user(account)?;
        market.post_comment(id, text, &pro).await
    }

    /// Removes the device's own comment. The Worker checks authorship; a lapsed Pro can still
    /// remove what they wrote.
    pub async fn delete_comment(&self, account: &impl Account, comment_id: &str) -> Result<()> {
        let market = self.market()?;
        let pro = pro_user(account)?;
        market.delete_comment(comment_id, &pro).await
    }

    /// Reports a comment with the device token; no account id is sent.
    pub async fn report_comment(&self, comment_id: &str) -> Result<()> {
        let market = self.market()?;
        let token = self.state.device_token()?;
        market.report_comment(comment_id, &token).await
    }

    pub fn block_commenter(&self, commenter: &str) -> Result<()> {
        self.state.block(commenter)
    }

    pub fn unblock_commenter(&self, commenter: &str) -> Result<()> {
        self.state.unblock(commenter)
    }

    pub fn blocked_commenters(&self) -> Vec<String> {
        self.state.blocked()
    }

    fn market(&self) -> Result<&Market> {
        self.market.as_ref().ok_or(Error::MarketplaceNotConfigured)
    }

    fn cached_index(&self) -> Result<Index> {
        self.index
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
            .ok_or_else(|| Error::Catalog("open the marketplace first".into()))
    }

    fn entry(&self, id: &str) -> Result<Entry> {
        index::entry(&self.cached_index()?, id)
            .cloned()
            .ok_or_else(|| Error::Catalog("not in the catalog".into()))
    }

    async fn download(&self, id: &str) -> Result<(Recipe, Entry)> {
        let index = self.cached_index()?;
        let entry = index::entry(&index, id)
            .cloned()
            .ok_or_else(|| Error::Catalog("not in the catalog".into()))?;
        let bytes = self.market()?.fetch_recipe(&entry).await?;
        Ok((index::check_download(&index, id, &bytes)?, entry))
    }

    fn remove_withdrawn(&self, recipes: &Recipes, index: &Index) -> Result<Vec<String>> {
        let mut withdrawn = Vec::new();
        for (id, sha256) in self.state.installed() {
            if !index::is_revoked(index, &id, &sha256) {
                continue;
            }
            let name = recipes.get(&id).map(|recipe| recipe.name);
            match recipes.remove_imported(&id) {
                Ok(()) | Err(Error::UnknownSite) => {}
                Err(error) => return Err(error),
            }
            self.state.forget(&id)?;
            withdrawn.push(name.unwrap_or(id));
        }
        Ok(withdrawn)
    }
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|elapsed| i64::try_from(elapsed.as_secs()).ok())
        .unwrap_or(0)
}

/// Same shape the Worker accepts: `[a-z0-9][a-z0-9.-]{1,60}`.
fn is_slug(slug: &str) -> bool {
    let mut chars = slug.chars();
    slug.len() >= 2
        && slug.len() <= MAX_SLUG_CHARS
        && chars
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-')
}

fn is_newer(candidate: &str, installed: &str) -> bool {
    let parse = |version: &str| -> Option<Vec<u32>> {
        version.split('.').map(|part| part.parse().ok()).collect()
    };
    matches!((parse(candidate), parse(installed)), (Some(a), Some(b)) if a > b)
}

/// Featured first, then by install count, then by name.
fn listing(
    index: &Index,
    stats: &BTreeMap<String, u64>,
    ratings: &BTreeMap<String, RatingSummary>,
    my_ratings: &BTreeMap<String, u8>,
    installed_version: impl Fn(&str) -> Option<String>,
) -> Vec<Item> {
    let mut items: Vec<Item> = index
        .recipes
        .iter()
        .map(|entry| {
            let installed = installed_version(&entry.id);
            Item {
                id: entry.id.clone(),
                name: entry.name.clone(),
                version: entry.version.clone(),
                author: entry.author.clone(),
                summary: entry.summary.clone(),
                hosts: entry.hosts.clone(),
                featured: entry.featured,
                tags: entry.tags.clone(),
                homepage: entry.homepage.clone(),
                installs: stats.get(&entry.id).copied(),
                rating: ratings.get(&entry.id).cloned(),
                my_rating: my_ratings.get(&entry.id).copied(),
                update_available: installed
                    .as_deref()
                    .is_some_and(|installed| is_newer(&entry.version, installed)),
                installed_version: installed,
            }
        })
        .collect();
    items.sort_by(|a, b| {
        b.featured
            .cmp(&a.featured)
            .then(b.installs.unwrap_or(0).cmp(&a.installs.unwrap_or(0)))
            .then_with(|| a.name.cmp(&b.name))
    });
    items
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, name: &str, version: &str, featured: bool) -> Entry {
        Entry {
            id: id.into(),
            name: name.into(),
            version: version.into(),
            author: "Ada".into(),
            summary: "s".into(),
            hosts: vec![],
            sha256: "0".repeat(64),
            size: 10,
            published_at: 0,
            featured,
            tags: vec!["mobile".into(), "community".into()],
            homepage: None,
        }
    }

    fn index(entries: Vec<Entry>) -> Index {
        Index {
            format: 1,
            key_id: "k1".into(),
            sequence: 1,
            issued_at: 0,
            expires_at: 1,
            recipes: entries,
            revoked: vec![],
        }
    }

    #[test]
    fn versions_compare_numerically_not_as_text() {
        assert!(is_newer("1.10.0", "1.9.0"));
        assert!(!is_newer("1.0.0", "1.0.0"));
        assert!(!is_newer("1.0.0", "2.0.0"));
        assert!(!is_newer("x", "1.0.0"));
    }

    #[test]
    fn the_listing_puts_featured_first_then_popular_then_by_name() {
        let index = index(vec![
            entry("market.b", "Beta", "1.0.0", false),
            entry("market.a", "Alpha", "1.0.0", false),
            entry("market.c", "Gamma", "1.0.0", false),
            entry("market.f", "Zed", "1.0.0", true),
        ]);
        let stats = BTreeMap::from([("market.c".to_owned(), 50_u64), ("market.b".to_owned(), 5)]);
        let names: Vec<_> = listing(&index, &stats, &BTreeMap::new(), &BTreeMap::new(), |_| None)
            .into_iter()
            .map(|item| item.name)
            .collect();
        assert_eq!(names, ["Zed", "Gamma", "Beta", "Alpha"]);
    }

    #[test]
    fn the_listing_marks_installed_recipes_and_available_updates() {
        let index = index(vec![entry("market.a", "Alpha", "1.2.0", false)]);
        let items = listing(
            &index,
            &BTreeMap::new(),
            &BTreeMap::new(),
            &BTreeMap::new(),
            |_| Some("1.1.0".into()),
        );
        assert_eq!(items[0].installed_version.as_deref(), Some("1.1.0"));
        assert!(items[0].update_available);
        let items = listing(
            &index,
            &BTreeMap::new(),
            &BTreeMap::new(),
            &BTreeMap::new(),
            |_| Some("1.2.0".into()),
        );
        assert!(!items[0].update_available);
    }

    #[test]
    fn a_marketplace_name_has_the_shape_the_server_accepts() {
        assert!(is_slug("calm-youtube"));
        assert!(is_slug("a1"));
        for bad in ["a", "-a", ".a", "Calm", "a b", "a/b", &"a".repeat(62)] {
            assert!(!is_slug(bad), "{bad}");
        }
    }

    #[test]
    fn withdrawn_recipes_are_removed_from_the_device_and_forgotten() {
        let dir = tempfile::tempdir().unwrap();
        let recipes = Recipes::load(dir.path().join("recipes")).unwrap();
        let bundle = r#"{"openmediaBundle":1,"recipes":[{"schema":1,"id":"market.calm","name":"Calm","version":"1.0.0","origin":"user","tags":["mobile"],"match":["https://*.example.com/*"],
          "rules":[{"id":"r","label":"l","type":"hide","target":{"css":".x"}}]}]}"#;
        let catalog = Catalog::new(None, State::load(dir.path().join("catalog-state.json")));
        let imported = recipes
            .save_imported(bundle, &["imported.market.calm".to_owned()])
            .unwrap();
        let mut withdrawn = imported[0].clone();
        withdrawn.id = "market.calm".into();
        recipes.save_catalog(withdrawn).unwrap();
        catalog
            .state
            .record_install("market.calm", &"a".repeat(64))
            .unwrap();

        let mut signed = index(vec![]);
        signed.revoked.push(index::Revoked {
            id: "market.calm".into(),
            sha256: "a".repeat(64),
        });
        let names = catalog.remove_withdrawn(&recipes, &signed).unwrap();
        assert_eq!(names, ["Calm"]);
        assert!(recipes.get("market.calm").is_none());
        assert!(recipes.get("imported.market.calm").is_some());
        assert!(catalog.state.installed().is_empty());
    }

    #[test]
    fn the_listing_carries_tags_homepage_rating_and_my_rating() {
        let mut one = entry("market.a", "Alpha", "1.0.0", false);
        one.homepage = Some("https://a.example/".into());
        let index = index(vec![one, entry("market.b", "Beta", "1.0.0", false)]);
        let ratings = BTreeMap::from([(
            "market.a".to_owned(),
            RatingSummary {
                average: Some(4.3),
                count: 12,
            },
        )]);
        let mine = BTreeMap::from([("market.a".to_owned(), 5_u8)]);
        let items = listing(&index, &BTreeMap::new(), &ratings, &mine, |_| None);
        assert_eq!(items[0].tags, ["mobile", "community"]);
        assert_eq!(items[0].homepage.as_deref(), Some("https://a.example/"));
        assert_eq!(items[0].rating.as_ref().map(|r| r.count), Some(12));
        assert_eq!(items[0].my_rating, Some(5));
        assert_eq!(items[1].rating, None);
        assert_eq!(items[1].my_rating, None);
        assert_eq!(items[1].homepage, None);
    }
}

#[cfg(test)]
mod network_tests;
