use std::collections::BTreeMap;

use serde::Serialize;
use url::Url;

use crate::error::{Error, Result};
use crate::library::{Favorite, FavoriteInput};
use crate::recipes::{Hub, OptionChoice, OptionChoices, OptionGroup, OptionValue, Origin, Recipes};

/// One setting as Settings shows it. `choices` is empty for a switch, whose `value` and `default`
/// are booleans; for a choice option they are ids from `choices`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OptionView {
    pub id: String,
    pub label: String,
    pub description: String,
    pub group: OptionGroup,
    pub choices: Vec<OptionChoice>,
    pub value: OptionValue,
    #[serde(rename = "default")]
    pub default_value: OptionValue,
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
    /// Pages opened together by this recipe; ordinary recipes have no hub.
    pub hub: Option<Hub>,
    pub favorite: bool,
    pub options: Vec<OptionView>,
    pub bottom_margin: Option<u32>,
    /// Who the recipe is from: `imported` (including recipes added from the library) can be removed.
    pub origin: Origin,
    /// Who made the recipe, from its `meta.author`.
    pub author: Option<String>,
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
                    choices: option.choices.clone(),
                    value: option
                        .current(saved.and_then(|saved| saved.get(&option.id)))
                        .clone(),
                    default_value: option.default_value.clone(),
                })
                .collect();
            options.sort_by_key(|option| option.group);
            SiteSettings {
                recipe_id: recipe.id.clone(),
                name: recipe.name.clone(),
                homepage: recipe.homepage().map(str::to_owned),
                hub: recipe.hub.clone(),
                favorite: favorites
                    .iter()
                    .any(|favorite| is_favorite_of(recipes, &recipe.id, favorite)),
                options,
                bottom_margin: margins.get(&recipe.id).copied(),
                origin: recipe.origin,
                author: recipe.meta.as_ref().and_then(|meta| meta.author.clone()),
            }
        })
        .collect()
}

fn is_favorite_of(recipes: &Recipes, recipe_id: &str, favorite: &Favorite) -> bool {
    Url::parse(&favorite.url).is_ok_and(|url| {
        recipes
            .covering(&url)
            .iter()
            .any(|recipe| recipe.id == recipe_id)
    })
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
            notify: existing.notify,
            landing: existing.landing.clone(),
        })
        .collect();
    if favorite && !already {
        inputs.push(FavoriteInput {
            name: recipe.name.clone(),
            url: recipe.homepage().ok_or(Error::UnknownSite)?.to_owned(),
            notify: true,
            landing: None,
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
        .covering(url)
        .iter()
        .find_map(|recipe| margins.get(&recipe.id).copied())
        .unwrap_or(shared)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn site<'a>(sites: &'a [SiteSettings], id: &str) -> &'a SiteSettings {
        sites.iter().find(|site| site.recipe_id == id).unwrap()
    }

    #[test]
    fn every_installed_site_is_listed_with_annoyances_first_and_defaults_applied() {
        let recipes = Recipes::official_installed();
        let sites = site_settings(&recipes, &OptionChoices::new(), &BTreeMap::new(), &[]);
        assert_eq!(sites.len(), recipes.all().len());
        for site in &sites {
            let groups: Vec<_> = site.options.iter().map(|option| option.group).collect();
            assert!(groups.is_sorted(), "{} is not grouped", site.name);
            assert!(
                site.options
                    .iter()
                    .all(|option| option.value == option.default_value)
            );
            assert_eq!(site.bottom_margin, None);
            assert!(!site.favorite);
            assert!(site.homepage.is_some(), "{} cannot be favorited", site.name);
        }
    }
    #[test]
    fn site_settings_exposes_hub_tabs_to_the_shell() {
        let directory = tempfile::tempdir().unwrap();
        let recipes = Recipes::load(directory.path().join("recipes")).unwrap();
        let hub = crate::recipes::Recipe::parse(
            r#"{
                "schema":1,"id":"custom.hub-messages","name":"Messages","version":"1.0.0",
                "origin":"ai","tags":["mobile"],
                "match":["https://*.instagram.com/*","https://*.reddit.com/*"],
                "rules":[],
                "hub":{"tabs":[
                    {"label":"Instagram","url":"https://www.instagram.com/direct/inbox/"},
                    {"label":"Reddit","url":"https://www.reddit.com/message/messages/"}
                ]}
            }"#,
        )
        .unwrap();
        recipes.save_made(&hub).unwrap();
        let sites = site_settings(&recipes, &OptionChoices::new(), &BTreeMap::new(), &[]);
        assert_eq!(sites[0].hub.as_ref().unwrap().tabs.len(), 2);
        assert_eq!(sites[0].hub.as_ref().unwrap().tabs[0].label, "Instagram");
    }

    #[test]
    fn saved_choices_show_up_in_the_listing_and_only_for_their_own_site() {
        let recipes = Recipes::official_installed();
        let choices = OptionChoices::from([(
            "market.official.youtube".to_owned(),
            [
                ("shorts".to_owned(), OptionValue::Toggle(true)),
                ("open-app".to_owned(), OptionValue::Toggle(false)),
            ]
            .into(),
        )]);
        let sites = site_settings(&recipes, &choices, &BTreeMap::new(), &[]);
        let youtube = site(&sites, "market.official.youtube");
        let state = |id: &str| {
            youtube
                .options
                .iter()
                .find(|o| o.id == id)
                .unwrap()
                .value
                .clone()
        };
        assert_eq!(state("shorts"), OptionValue::Toggle(true));
        assert_eq!(state("open-app"), OptionValue::Toggle(false));
        assert!(
            site(&sites, "market.official.instagram")
                .options
                .iter()
                .all(|option| option.value == option.default_value)
        );
    }

    #[test]
    fn a_page_uses_its_sites_margin_else_the_shared_one() {
        let recipes = Recipes::official_installed();
        let margins = BTreeMap::from([("market.official.youtube".to_owned(), 40)]);
        let margin =
            |url: &str| bottom_margin_for(&recipes, &margins, 12, &Url::parse(url).unwrap());
        assert_eq!(margin("https://m.youtube.com/watch?v=x"), 40);
        assert_eq!(margin("https://www.instagram.com/"), 12);
        assert_eq!(margin("https://example.com/"), 12);
    }

    #[test]
    fn a_made_recipe_beside_an_installed_one_leaves_the_installed_site_favoritable() {
        let dir = tempfile::tempdir().unwrap();
        let recipes = Recipes::load(dir.path().to_owned()).unwrap();
        let text = r#"{"schema":1,"id":"market.yt","name":"YT","version":"1.0.0","origin":"user","tags":["mobile"],"match":["https://*.youtube.com/*"],
          "options":[{"id":"mine","label":"Mine","description":"d","group":"content","default":false}],
          "rules":[{"id":"r","label":"l","type":"hide","option":"mine","target":{"css":"a"}}],"meta":{"homepage":"https://www.youtube.com/"}}"#;
        recipes
            .save_bundled(crate::recipes::parse_bundled_recipe(text.as_bytes()).unwrap())
            .unwrap();
        let favorites = [favorite("YT", "https://www.youtube.com/")];
        let sites = site_settings(
            &recipes,
            &OptionChoices::new(),
            &BTreeMap::new(),
            &favorites,
        );
        assert!(site(&sites, "market.yt").favorite);
        let margins = BTreeMap::from([("market.yt".to_owned(), 30)]);
        let url = Url::parse("https://www.youtube.com/").unwrap();
        assert_eq!(bottom_margin_for(&recipes, &margins, 12, &url), 30);
    }

    #[test]
    fn twitter_and_x_addresses_share_one_site() {
        let recipes = Recipes::official_installed();
        let id = |url: &str| {
            recipes
                .for_url(&Url::parse(url).unwrap())
                .map(|recipe| recipe.id.clone())
        };
        assert_eq!(
            id("https://x.com/home").as_deref(),
            Some("market.official.twitter")
        );
        assert_eq!(
            id("https://twitter.com/").as_deref(),
            Some("market.official.twitter")
        );
        assert_eq!(
            id("https://m.facebook.com/").as_deref(),
            Some("market.official.facebook")
        );
    }

    fn favorite(name: &str, url: &str) -> Favorite {
        Favorite {
            id: uuid::Uuid::new_v4(),
            name: name.to_owned(),
            url: url.to_owned(),
            icon: None,
            notify: true,
            landing: None,
        }
    }

    fn urls(inputs: &[FavoriteInput]) -> Vec<&str> {
        inputs.iter().map(|input| input.url.as_str()).collect()
    }

    #[test]
    fn every_homepage_belongs_to_its_own_site() {
        let recipes = Recipes::official_installed();
        let mut stolen = Vec::new();
        for recipe in recipes.all() {
            // A hub opens pages that belong to other sites' recipes, so it owns no page itself.
            if recipe.hub.is_some() {
                continue;
            }
            let url = Url::parse(recipe.homepage().unwrap()).unwrap();
            // A hub may also cover the page, as a launcher; the site's own recipe still owns it.
            let owner = recipes.covering(&url).into_iter().find(|r| r.hub.is_none());
            if owner.as_ref().map(|r| &r.id) != Some(&recipe.id) {
                stolen.push(format!(
                    "{} is claimed by {:?}",
                    recipe.id,
                    owner.map(|r| r.id)
                ));
            }
        }
        assert!(stolen.is_empty(), "{}", stolen.join("\n"));
    }

    #[test]
    fn a_site_is_a_favorite_when_any_favorite_opens_it() {
        let recipes = Recipes::official_installed();
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
        assert!(site(&sites, "market.official.twitter").favorite);
        assert!(!site(&sites, "market.official.youtube").favorite);
    }

    #[test]
    fn favoriting_a_site_appends_its_homepage_once() {
        let recipes = Recipes::official_installed();
        let favorites = [favorite("Mine", "https://example.com/")];
        let added =
            with_site_favorite(&recipes, &favorites, "market.official.youtube", true).unwrap();
        assert_eq!(
            urls(&added),
            ["https://example.com/", "https://www.youtube.com/"]
        );
        assert_eq!(added[1].name, "YouTube");

        let again = [
            favorite("Mine", "https://example.com/"),
            favorite("YT", "https://www.youtube.com/feed"),
        ];
        let unchanged =
            with_site_favorite(&recipes, &again, "market.official.youtube", true).unwrap();
        assert_eq!(
            urls(&unchanged),
            ["https://example.com/", "https://www.youtube.com/feed"]
        );
    }

    #[test]
    fn unfavoriting_a_site_drops_only_its_favorites() {
        let recipes = Recipes::official_installed();
        let favorites = [
            favorite("YT", "https://m.youtube.com/"),
            favorite("Mine", "https://example.com/"),
            favorite("Music", "https://music.youtube.com/"),
        ];
        let removed =
            with_site_favorite(&recipes, &favorites, "market.official.youtube", false).unwrap();
        // YouTube Music is a site of its own, so it stays.
        assert_eq!(
            urls(&removed),
            ["https://example.com/", "https://music.youtube.com/"]
        );
    }

    #[test]
    fn starring_a_site_keeps_the_other_favorites_notify_choice() {
        let recipes = Recipes::official_installed();
        let mut quiet = favorite("Mine", "https://example.com/");
        quiet.notify = false;
        let added =
            with_site_favorite(&recipes, &[quiet], "market.official.youtube", true).unwrap();
        assert_eq!(
            added.iter().map(|input| input.notify).collect::<Vec<_>>(),
            [false, true]
        );
    }

    #[test]
    fn an_unknown_site_cannot_be_favorited() {
        let recipes = Recipes::official_installed();
        assert!(matches!(
            with_site_favorite(&recipes, &[], "market.official.nope", true),
            Err(Error::UnknownSite)
        ));
    }
}
