use std::collections::BTreeMap;

use serde::Serialize;
use url::Url;

use crate::error::{Error, Result};
use crate::library::{Favorite, FavoriteInput};
use crate::recipes::{OptionChoices, OptionGroup, Recipes};

/// One toggle as Settings shows it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OptionView {
    pub id: String,
    pub label: String,
    pub description: String,
    pub group: OptionGroup,
    pub enabled: bool,
    #[serde(rename = "default")]
    pub enabled_by_default: bool,
}

/// A recipe as Settings shows it: its toggles with the user's choices applied, its
/// own bottom margin if it has one, and whether the user has it among their favorites.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteSettings {
    pub recipe_id: String,
    pub name: String,
    /// Where a favorite of this site opens; `None` means the site cannot be favorited.
    pub homepage: Option<String>,
    pub favorite: bool,
    pub options: Vec<OptionView>,
    pub bottom_margin: Option<u32>,
    /// The site runs on the user's own changed copy of the bundled recipe.
    pub customized: bool,
    /// The app now ships a different version than the one the copy was made from.
    pub original_updated: bool,
}

pub fn site_settings(
    recipes: &Recipes,
    choices: &OptionChoices,
    margins: &BTreeMap<String, u32>,
    favorites: &[Favorite],
) -> Vec<SiteSettings> {
    recipes
        .all()
        .into_iter()
        .map(|recipe| {
            let saved = choices.get(&recipe.id);
            let mut options: Vec<OptionView> = recipe
                .options
                .iter()
                .map(|option| OptionView {
                    id: option.id.clone(),
                    label: option.label.clone(),
                    description: option.description.clone(),
                    group: option.group,
                    enabled: saved
                        .and_then(|saved| saved.get(&option.id))
                        .copied()
                        .unwrap_or(option.enabled_by_default),
                    enabled_by_default: option.enabled_by_default,
                })
                .collect();
            options.sort_by_key(|option| option.group);
            let customized = recipe.forked_from.is_some();
            SiteSettings {
                recipe_id: recipe.id.clone(),
                name: recipe.name.clone(),
                homepage: recipe.homepage().map(str::to_owned),
                favorite: favorites
                    .iter()
                    .any(|favorite| is_favorite_of(recipes, &recipe.id, favorite)),
                options,
                bottom_margin: margins.get(&recipe.id).copied(),
                customized,
                original_updated: customized
                    && recipes.bundled_version(&recipe.id) != recipe.forked_from.as_deref(),
            }
        })
        .collect()
}

fn is_favorite_of(recipes: &Recipes, recipe_id: &str, favorite: &Favorite) -> bool {
    Url::parse(&favorite.url)
        .ok()
        .and_then(|url| recipes.for_url(&url).map(|recipe| recipe.id == recipe_id))
        .unwrap_or(false)
}

/// The favorites after adding or removing a recipe's site. Adding appends the site's
/// homepage unless it is already there; removing drops every favorite that opens this site.
pub fn with_site_favorite(
    recipes: &Recipes,
    favorites: &[Favorite],
    recipe_id: &str,
    favorite: bool,
) -> Result<Vec<FavoriteInput>> {
    let recipe = recipes.get(recipe_id).ok_or(Error::UnknownSite)?;
    let already = favorites
        .iter()
        .any(|existing| is_favorite_of(recipes, recipe_id, existing));
    let mut inputs: Vec<FavoriteInput> = favorites
        .iter()
        .filter(|existing| favorite || !is_favorite_of(recipes, recipe_id, existing))
        .map(|existing| FavoriteInput {
            name: existing.name.clone(),
            url: existing.url.clone(),
        })
        .collect();
    if favorite && !already {
        inputs.push(FavoriteInput {
            name: recipe.name.clone(),
            url: recipe.homepage().ok_or(Error::UnknownSite)?.to_owned(),
        });
    }
    Ok(inputs)
}

/// The margin to keep under this page: its site's own, else the shared one.
pub fn bottom_margin_for(
    recipes: &Recipes,
    margins: &BTreeMap<String, u32>,
    shared: u32,
    url: &Url,
) -> u32 {
    recipes
        .for_url(url)
        .and_then(|recipe| margins.get(&recipe.id).copied())
        .unwrap_or(shared)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn site<'a>(sites: &'a [SiteSettings], id: &str) -> &'a SiteSettings {
        sites.iter().find(|site| site.recipe_id == id).unwrap()
    }

    #[test]
    fn every_bundled_site_is_listed_with_annoyances_first_and_defaults_applied() {
        let recipes = Recipes::bundled_only();
        let sites = site_settings(&recipes, &OptionChoices::new(), &BTreeMap::new(), &[]);
        assert_eq!(sites.len(), recipes.all().len());
        for site in &sites {
            let groups: Vec<_> = site.options.iter().map(|option| option.group).collect();
            assert!(groups.is_sorted(), "{} is not grouped", site.name);
            assert!(
                site.options
                    .iter()
                    .all(|option| option.enabled == option.enabled_by_default)
            );
            assert_eq!(site.bottom_margin, None);
            assert!(!site.favorite);
            assert!(site.homepage.is_some(), "{} cannot be favorited", site.name);
        }
    }

    #[test]
    fn saved_choices_show_up_in_the_listing_and_only_for_their_own_site() {
        let recipes = Recipes::bundled_only();
        let choices = OptionChoices::from([(
            "youtube.default".to_owned(),
            [("shorts".to_owned(), true), ("open-app".to_owned(), false)].into(),
        )]);
        let sites = site_settings(&recipes, &choices, &BTreeMap::new(), &[]);
        let youtube = site(&sites, "youtube.default");
        let state = |id: &str| youtube.options.iter().find(|o| o.id == id).unwrap().enabled;
        assert!(state("shorts"));
        assert!(!state("open-app"));
        assert!(
            site(&sites, "instagram.default")
                .options
                .iter()
                .all(|option| option.enabled == option.enabled_by_default)
        );
    }

    #[test]
    fn a_page_uses_its_sites_margin_else_the_shared_one() {
        let recipes = Recipes::bundled_only();
        let margins = BTreeMap::from([("youtube.default".to_owned(), 40)]);
        let margin =
            |url: &str| bottom_margin_for(&recipes, &margins, 12, &Url::parse(url).unwrap());
        assert_eq!(margin("https://m.youtube.com/watch?v=x"), 40);
        assert_eq!(margin("https://www.instagram.com/"), 12);
        assert_eq!(margin("https://example.com/"), 12);
    }

    #[test]
    fn a_customized_site_is_flagged_and_says_when_the_original_has_moved_on() {
        let dir = tempfile::tempdir().unwrap();
        let recipes = Recipes::load(dir.path().to_owned()).unwrap();
        let fork = r#"{"schema":1,"id":"reddit.default","name":"Reddit","version":"1.0.0","origin":"ai","match":["https://*.reddit.com/*"],
          "options":[{"id":"mine","label":"Mine","description":"d","group":"content","default":false}],
          "rules":[{"id":"r","label":"l","type":"hide","option":"mine","target":{"css":"a"}}]}"#;
        recipes.save_fork(fork).unwrap();
        let listing = |recipes: &Recipes| {
            site_settings(recipes, &OptionChoices::new(), &BTreeMap::new(), &[])
        };
        let sites = listing(&recipes);
        let reddit = site(&sites, "reddit.default");
        assert!(reddit.customized && !reddit.original_updated);
        assert_eq!(reddit.options.len(), 1);
        assert!(
            sites
                .iter()
                .filter(|s| s.recipe_id != "reddit.default")
                .all(|s| !s.customized)
        );

        let old = fork.replace(r#""origin":"ai""#, r#""origin":"ai","forkedFrom":"0.0.1""#);
        std::fs::write(dir.path().join("reddit.default.json"), old).unwrap();
        let restarted = Recipes::load(dir.path().to_owned()).unwrap();
        let sites = listing(&restarted);
        let reddit = site(&sites, "reddit.default");
        assert!(reddit.customized && reddit.original_updated);
    }

    #[test]
    fn twitter_and_x_addresses_share_one_site() {
        let recipes = Recipes::bundled_only();
        let id = |url: &str| {
            recipes
                .for_url(&Url::parse(url).unwrap())
                .map(|recipe| recipe.id.clone())
        };
        assert_eq!(id("https://x.com/home").as_deref(), Some("twitter.default"));
        assert_eq!(
            id("https://twitter.com/").as_deref(),
            Some("twitter.default")
        );
        assert_eq!(
            id("https://m.facebook.com/").as_deref(),
            Some("facebook.default")
        );
    }

    fn favorite(name: &str, url: &str) -> Favorite {
        Favorite {
            id: uuid::Uuid::new_v4(),
            name: name.to_owned(),
            url: url.to_owned(),
            icon: None,
        }
    }

    fn urls(inputs: &[FavoriteInput]) -> Vec<&str> {
        inputs.iter().map(|input| input.url.as_str()).collect()
    }

    #[test]
    fn every_homepage_belongs_to_its_own_site() {
        let recipes = Recipes::bundled_only();
        for recipe in recipes.all() {
            let url = Url::parse(recipe.homepage().unwrap()).unwrap();
            assert_eq!(recipes.for_url(&url).map(|r| r.id), Some(recipe.id));
        }
    }

    #[test]
    fn a_site_is_a_favorite_when_any_favorite_opens_it() {
        let recipes = Recipes::bundled_only();
        let favorites = [
            favorite("X", "https://x.com/home"),
            favorite("Mine", "https://example.com/"),
        ];
        let sites = site_settings(
            &recipes,
            &OptionChoices::new(),
            &BTreeMap::new(),
            &favorites,
        );
        assert!(site(&sites, "twitter.default").favorite);
        assert!(!site(&sites, "youtube.default").favorite);
    }

    #[test]
    fn favoriting_a_site_appends_its_homepage_once() {
        let recipes = Recipes::bundled_only();
        let favorites = [favorite("Mine", "https://example.com/")];
        let added = with_site_favorite(&recipes, &favorites, "youtube.default", true).unwrap();
        assert_eq!(
            urls(&added),
            ["https://example.com/", "https://www.youtube.com/"]
        );
        assert_eq!(added[1].name, "YouTube");

        let again = [
            favorite("Mine", "https://example.com/"),
            favorite("YT", "https://www.youtube.com/feed"),
        ];
        let unchanged = with_site_favorite(&recipes, &again, "youtube.default", true).unwrap();
        assert_eq!(
            urls(&unchanged),
            ["https://example.com/", "https://www.youtube.com/feed"]
        );
    }

    #[test]
    fn unfavoriting_a_site_drops_only_its_favorites() {
        let recipes = Recipes::bundled_only();
        let favorites = [
            favorite("YT", "https://m.youtube.com/"),
            favorite("Mine", "https://example.com/"),
            favorite("Music", "https://music.youtube.com/"),
        ];
        let removed = with_site_favorite(&recipes, &favorites, "youtube.default", false).unwrap();
        assert_eq!(urls(&removed), ["https://example.com/"]);
    }

    #[test]
    fn an_unknown_site_cannot_be_favorited() {
        let recipes = Recipes::bundled_only();
        assert!(matches!(
            with_site_favorite(&recipes, &[], "nope.default", true),
            Err(Error::UnknownSite)
        ));
    }
}
