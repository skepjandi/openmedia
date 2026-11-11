mod compile;
mod matcher;
mod schema;
mod selector;
mod share;

pub use compile::{OptionChoices, page_script};
pub use schema::{
    Hub, HubTab, MAX_HUB_LABEL_CHARS, MAX_HUB_TABS, MIN_HUB_TABS, Meta, OptionGroup, Origin,
    Recipe, Rule, SiteOption, Target, current_platform_tag,
};
pub(crate) use selector::{
    CSS_PROPERTIES, targets_page_root, validate_declarations, validate_selector,
};
pub(crate) use share::{MARKET_PREFIX, MAX_RECIPE_BYTES, is_catalog_id, is_plain_text, is_version};
pub use share::{RecipePreview, preview as preview_recipe};

use std::{
    collections::{BTreeMap, HashSet},
    fs,
    path::PathBuf,
    sync::{PoisonError, RwLock},
};

use url::Url;

use crate::error::{Error, Result};
use crate::library::write_atomically;

const MAX_MADE_BYTES: usize = 256 * 1024;

/// Ids of recipes the user or the assistant made. The app ships no recipes of its own: every
/// other recipe is installed from the marketplace or imported from a file.
const CUSTOM_PREFIX: &str = "custom.";

/// The recipes in effect: the ones the user or the assistant made (`custom.`) and the ones
/// installed or imported (`market.`, `imported.`). Files live in `dir`, so app updates never touch
/// them. The page script is compiled on demand, because it depends on the user's toggles.
pub struct Recipes {
    dir: PathBuf,
    custom: RwLock<BTreeMap<String, Recipe>>,
    imported: RwLock<BTreeMap<String, Recipe>>,
}

impl Recipes {
    /// Loads every valid recipe in `dir`. A file that is unreadable or invalid is skipped, so a
    /// damaged file can never stop the app from starting. A fresh install has no recipes.
    pub fn load(dir: PathBuf) -> Result<Self> {
        let mut custom = BTreeMap::new();
        let mut imported = BTreeMap::new();
        for entry in fs::read_dir(&dir).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.extension().is_none_or(|extension| extension != "json") {
                continue;
            }
            let Ok(text) = fs::read_to_string(&path) else {
                continue;
            };
            if let Ok(recipe) = parse_custom(&text) {
                custom.insert(recipe.id.clone(), recipe);
            } else if let Ok(recipe) = share::parse_shared(text.as_bytes(), share::Source::Stored) {
                imported.insert(recipe.id.clone(), recipe);
            }
        }
        Ok(Self {
            dir,
            custom: RwLock::new(custom),
            imported: RwLock::new(imported),
        })
    }

    /// Made recipes first, then installed ones, each in id order.
    pub fn all(&self) -> Vec<Recipe> {
        let custom = self.custom.read().unwrap_or_else(PoisonError::into_inner);
        let imported = self.imported.read().unwrap_or_else(PoisonError::into_inner);
        custom.values().chain(imported.values()).cloned().collect()
    }

    pub fn get(&self, id: &str) -> Option<Recipe> {
        self.all().into_iter().find(|recipe| recipe.id == id)
    }

    /// The first recipe whose `match` patterns cover this page: a made one before an installed one.
    pub fn for_url(&self, url: &Url) -> Option<Recipe> {
        self.all().into_iter().find(|recipe| recipe.covers(url))
    }

    /// Every recipe that covers this page. A made recipe and an installed one can both cover a
    /// site; both apply.
    pub fn covering(&self, url: &Url) -> Vec<Recipe> {
        self.all()
            .into_iter()
            .filter(|recipe| recipe.covers(url))
            .collect()
    }

    /// The script injected into every site view: all recipes, matched by the page itself.
    pub fn script(&self, choices: &OptionChoices) -> Result<String> {
        page_script(&self.all(), choices)
    }

    /// Saves a recipe the assistant made: a `custom.` recipe. It is validated again here,
    /// whatever produced it.
    pub fn save_made(&self, recipe: &Recipe) -> Result<Recipe> {
        let saved = parse_custom(&serde_json::to_string(recipe)?)?;
        write_atomically(
            &self.dir.join(format!("{}.json", saved.id)),
            &serde_json::to_vec_pretty(&saved)?,
        )?;
        self.custom
            .write()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(saved.id.clone(), saved.clone());
        Ok(saved)
    }

    /// The text a user can share: any recipe on the device, as a bundle.
    pub fn export(&self, ids: &[String]) -> Result<String> {
        if ids.is_empty() {
            return Err(Error::Recipe("choose at least one recipe".into()));
        }
        let recipes = ids
            .iter()
            .map(|id| self.get(id).ok_or(Error::UnknownSite))
            .collect::<Result<Vec<_>>>()?;
        share::export_bundle(&recipes)
    }

    /// What a pasted bundle would add, for the review screen. Nothing is saved.
    pub fn preview_import(&self, text: &str) -> Result<Vec<RecipePreview>> {
        Ok(share::parse_bundle(text)?
            .iter()
            .map(|recipe| share::preview(recipe, self.imported_version(&recipe.id).as_deref()))
            .collect())
    }

    /// Saves the chosen recipes of a pasted bundle. The bundle is parsed and validated again, so
    /// only what the review screen could have shown is ever saved.
    pub fn save_imported(&self, text: &str, ids: &[String]) -> Result<Vec<Recipe>> {
        let wanted: HashSet<&str> = ids.iter().map(String::as_str).collect();
        let chosen: Vec<Recipe> = share::parse_bundle(text)?
            .into_iter()
            .filter(|recipe| wanted.contains(recipe.id.as_str()))
            .collect();
        if chosen.is_empty() || chosen.len() != wanted.len() {
            return Err(Error::Recipe("choose recipes from the bundle".into()));
        }
        chosen
            .into_iter()
            .map(|recipe| self.store_imported(recipe))
            .collect()
    }

    /// Deletes an imported recipe; its saved switches are left behind and are harmless.
    pub fn remove_imported(&self, id: &str) -> Result<()> {
        if self.imported_version(id).is_none() {
            return Err(Error::UnknownSite);
        }
        match fs::remove_file(self.dir.join(format!("{id}.json"))) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error.into()),
            _ => {}
        }
        self.imported
            .write()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(id);
        Ok(())
    }

    /// Saves a recipe downloaded from the marketplace. `catalog::check_download` must already
    /// have tied it to the signed index; this only refuses anything that is not a `market.`
    /// recipe labelled imported.
    pub fn save_catalog(&self, recipe: Recipe) -> Result<Recipe> {
        if !recipe.id.starts_with(share::MARKET_PREFIX) || recipe.origin != Origin::Imported {
            return Err(Error::UnknownSite);
        }
        self.store_imported(recipe)
    }

    pub fn imported_version(&self, id: &str) -> Option<String> {
        self.imported
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .get(id)
            .map(|recipe| recipe.version.clone())
    }

    fn store_imported(&self, recipe: Recipe) -> Result<Recipe> {
        write_atomically(
            &self.dir.join(format!("{}.json", recipe.id)),
            &serde_json::to_vec_pretty(&recipe)?,
        )?;
        self.imported
            .write()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(recipe.id.clone(), recipe.clone());
        Ok(recipe)
    }
}

/// A recipe file downloaded from the marketplace: its own claims about origin are ignored and its
/// id must be a `market.` one.
pub fn parse_catalog_recipe(bytes: &[u8]) -> Result<Recipe> {
    share::parse_shared(bytes, share::Source::Catalog)
}

fn parse_custom(text: &str) -> Result<Recipe> {
    if text.len() > MAX_MADE_BYTES {
        return Err(Error::Recipe("the recipe is too large".into()));
    }
    let recipe = Recipe::parse(text)?;
    let id_is_safe = recipe.id.len() <= 80
        && recipe.id.strip_prefix(CUSTOM_PREFIX).is_some_and(|rest| {
            !rest.is_empty()
                && rest
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-')
        });
    if id_is_safe && matches!(recipe.origin, Origin::User | Origin::Ai) {
        Ok(recipe)
    } else {
        Err(Error::UnknownSite)
    }
}

/// Test-only: the official recipe files, read the way the app reads a marketplace download.
#[cfg(test)]
pub(crate) fn official_recipes() -> Vec<Recipe> {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../recipes/official");
    let mut files: Vec<_> = fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .collect();
    files.sort();
    files
        .iter()
        .map(|path| {
            share::parse_shared(&fs::read(path).unwrap(), share::Source::Catalog)
                .unwrap_or_else(|error| panic!("{}: {error}", path.display()))
        })
        .collect()
}

/// Test-only: every official recipe installed, as if the user had installed them all.
#[cfg(test)]
impl Recipes {
    pub fn official_installed() -> Self {
        let imported = official_recipes()
            .into_iter()
            .map(|recipe| (recipe.id.clone(), recipe))
            .collect();
        Self {
            dir: PathBuf::from("/nonexistent/openmedia-test"),
            custom: RwLock::new(BTreeMap::new()),
            imported: RwLock::new(imported),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{fs, path::Path};

    use scraper::{Html, Selector};

    use super::compile::recipe_css;
    use super::schema::Rule;
    use super::*;

    const OFFICIAL_PREFIX: &str = "market.official.";

    fn site_of(recipe: &Recipe) -> &str {
        recipe.id.strip_prefix(OFFICIAL_PREFIX).unwrap()
    }

    fn fixture_names(site: &str) -> Vec<String> {
        let fixtures_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../recipes/fixtures");
        fs::read_dir(fixtures_root.join(site))
            .unwrap_or_else(|_| panic!("site {site} has no fixtures"))
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn every_official_recipe_parses_validates_and_is_named_for_its_site() {
        let recipes = official_recipes();
        assert!(!recipes.is_empty());
        let mut ids: Vec<_> = recipes.iter().map(|r| r.id.as_str()).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), recipes.len());
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../recipes/official");
        for recipe in &recipes {
            assert!(recipe.id.starts_with(OFFICIAL_PREFIX), "{}", recipe.id);
            assert!(dir.join(format!("{}.json", site_of(recipe))).exists());
            assert!(recipe.homepage().is_some(), "{} has no homepage", recipe.id);
        }
    }

    #[test]
    fn official_files_carry_a_name_the_worker_accepts_as_origin() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../recipes/official");
        for entry in fs::read_dir(dir).unwrap() {
            let text = fs::read_to_string(entry.unwrap().path()).unwrap();
            let value: serde_json::Value = serde_json::from_str(&text).unwrap();
            assert_eq!(value["origin"], "user");
        }
    }

    #[test]
    fn official_platform_tags_follow_the_fixtures() {
        for recipe in official_recipes() {
            let names = fixture_names(site_of(&recipe));
            let mut expected = Vec::new();
            if names.iter().any(|name| name.starts_with("desktop-")) {
                expected.push("desktop");
            }
            if names.iter().any(|name| !name.starts_with("desktop-")) {
                expected.push("mobile");
            }
            let mut tags: Vec<&str> = recipe.tags.iter().map(String::as_str).collect();
            tags.sort_unstable();
            assert_eq!(tags, expected, "{}", recipe.id);
        }
    }

    fn fixture_pages(recipe: &Recipe) -> Vec<Html> {
        let fixtures_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../recipes/fixtures");
        let pages: Vec<Html> = fs::read_dir(fixtures_root.join(site_of(recipe)))
            .unwrap_or_else(|_| panic!("recipe {} has no fixtures", recipe.id))
            .map(|entry| Html::parse_document(&fs::read_to_string(entry.unwrap().path()).unwrap()))
            .collect();
        assert!(!pages.is_empty(), "recipe {} has no fixtures", recipe.id);
        pages
    }

    #[test]
    fn no_hide_rule_touches_an_element_a_fixture_marks_data_keep_or_its_ancestors() {
        let keep = Selector::parse("[data-keep]").unwrap();
        for recipe in official_recipes() {
            for page in fixture_pages(&recipe) {
                let mut hidden = std::collections::HashSet::new();
                for rule in &recipe.rules {
                    if let Rule::Hide { target, .. } = rule {
                        let selector = Selector::parse(&target.css).unwrap();
                        hidden.extend(
                            page.select(&selector)
                                .map(|element| (rule.id(), element.id())),
                        );
                    }
                }
                for element in page.select(&keep) {
                    for node in
                        std::iter::once(element.id()).chain(element.ancestors().map(|n| n.id()))
                    {
                        let culprit = hidden.iter().find(|(_, id)| *id == node);
                        assert!(
                            culprit.is_none(),
                            "{}: rule {:?} hides a protected element or its ancestor",
                            recipe.id,
                            culprit.map(|(rule, _)| rule)
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn every_official_rule_matches_something_in_its_dom_fixtures() {
        let mut unmatched = Vec::new();
        for recipe in official_recipes() {
            let pages = fixture_pages(&recipe);
            for rule in &recipe.rules {
                let (Rule::Hide { target, .. } | Rule::Css { target, .. }) = rule;
                let selector = Selector::parse(&target.css).unwrap();
                let matched = pages
                    .iter()
                    .any(|page| page.select(&selector).next().is_some());
                if !matched {
                    unmatched.push(format!("{}: {}", recipe.id, rule.id()));
                }
            }
        }
        assert!(
            unmatched.is_empty(),
            "rules that match nothing in their fixtures:\n{}",
            unmatched.join("\n")
        );
    }

    const TOGGLED: &str = r#"{"schema":1,"id":"t.default","name":"T","version":"1.0.0","origin":"user","tags":["desktop"],"match":["https://t.example/*"],
      "options":[
        {"id":"nag","label":"Nag","description":"d","group":"annoyance","default":true},
        {"id":"feed","label":"Feed","description":"d","group":"content","default":false}],
      "rules":[
        {"id":"r1","label":"l","type":"hide","option":"nag","target":{"css":".nag"}},
        {"id":"r2","label":"l","type":"hide","option":"feed","target":{"css":".feed"}},
        {"id":"r3","label":"l","type":"css","option":"nag","target":{"css":"body"},"declarations":{"overflow-y":"auto"}},
        {"id":"r4","label":"l","type":"hide","target":{"css":".always"}}]}"#;

    fn css_for(choices: &[(&str, bool)]) -> String {
        let recipe = Recipe::parse(TOGGLED).unwrap();
        let saved = choices
            .iter()
            .map(|(option, on)| ((*option).to_owned(), *on))
            .collect();
        recipe_css(
            &recipe,
            &OptionChoices::from([("t.default".to_owned(), saved)]),
        )
    }

    #[test]
    fn options_start_at_their_defaults_and_rules_without_one_always_apply() {
        let css = css_for(&[]);
        assert!(css.contains(".nag{display:none!important}"));
        assert!(css.contains("body{overflow-y:auto!important;}"));
        assert!(css.contains(".always{display:none!important}"));
        assert!(!css.contains(".feed"));
    }

    #[test]
    fn a_saved_choice_overrides_the_default_in_both_directions() {
        let css = css_for(&[("nag", false), ("feed", true)]);
        assert!(!css.contains(".nag"));
        assert!(!css.contains("overflow-y"));
        assert!(css.contains(".feed{display:none!important}"));
        assert!(css.contains(".always{display:none!important}"));
    }

    #[test]
    fn choices_for_other_recipes_or_unknown_options_change_nothing() {
        let recipe = Recipe::parse(TOGGLED).unwrap();
        let other = OptionChoices::from([(
            "other.default".to_owned(),
            [("nag".to_owned(), false)].into(),
        )]);
        let unknown =
            OptionChoices::from([("t.default".to_owned(), [("gone".to_owned(), true)].into())]);
        assert_eq!(recipe_css(&recipe, &other), css_for(&[]));
        assert_eq!(recipe_css(&recipe, &unknown), css_for(&[]));
    }

    #[test]
    fn the_page_script_only_carries_enabled_rules() {
        let recipes = vec![Recipe::parse(TOGGLED).unwrap()];
        let script = page_script(&recipes, &OptionChoices::new()).unwrap();
        assert!(script.contains(".nag{display:none!important}"));
        assert!(!script.contains(".feed"));
    }
    #[test]
    fn scoped_rules_are_serialized_only_for_their_matching_sites() {
        let json = TOGGLED
            .replace(
                "\"target\":{\"css\":\".nag\"}",
                "\"on\":[\"https://t.example/*\"],\"target\":{\"css\":\".nag\"}",
            )
            .replace(
                "\"match\":[\"https://t.example/*\"]",
                "\"match\":[\"https://t.example/*\",\"https://www.reddit.com/*\"]",
            );
        let recipe = Recipe::parse(&json).unwrap();
        let script = page_script(&[recipe], &OptionChoices::new()).unwrap();
        assert!(script.contains("t\\\\.example"));
        assert!(script.contains("www\\\\.reddit"));
        assert_eq!(script.matches(".nag{display:none!important}").count(), 1);
    }

    #[test]
    fn rule_scope_must_be_a_nonempty_subset_of_recipe_matches() {
        let json = TOGGLED.replace(
            "\"target\":{\"css\":\".nag\"}",
            "\"on\":[\"https://evil.example/*\"],\"target\":{\"css\":\".nag\"}",
        );
        assert!(Recipe::parse(&json).is_err());
        let empty = TOGGLED.replace(
            "\"target\":{\"css\":\".nag\"}",
            "\"on\":[],\"target\":{\"css\":\".nag\"}",
        );
        assert!(Recipe::parse(&empty).is_err());
    }

    #[test]
    fn a_fresh_install_has_no_recipes_and_no_script_rules() {
        let dir = tempfile::tempdir().unwrap();
        let recipes = Recipes::load(dir.path().join("recipes")).unwrap();
        assert!(recipes.all().is_empty());
        let page = Url::parse("https://www.reddit.com/r/rust/").unwrap();
        assert_eq!(recipes.for_url(&page), None);
    }

    #[test]
    fn a_page_belongs_to_the_recipe_that_matches_its_url() {
        let recipes = Recipes::official_installed();
        let page = |url: &str| {
            recipes
                .for_url(&Url::parse(url).unwrap())
                .map(|r| r.id.clone())
        };
        assert_eq!(
            page("https://www.reddit.com/r/rust/").as_deref(),
            Some("market.official.reddit")
        );
        assert_eq!(page("https://example.com/"), None);
    }

    #[test]
    fn annoyances_start_on_and_content_starts_off() {
        for recipe in official_recipes() {
            assert!(!recipe.options.is_empty(), "{} has no options", recipe.id);
            for option in &recipe.options {
                assert_eq!(
                    option.enabled_by_default,
                    option.group == OptionGroup::Annoyance,
                    "{}:{}",
                    recipe.id,
                    option.id
                );
            }
        }
    }

    fn with_tags(tags: &str) -> String {
        format!(
            r#"{{"schema":1,"id":"x.y","name":"n","version":"1.0.0","origin":"user","tags":{tags},"match":["https://a.com/*"],"rules":[{{"id":"r","label":"l","type":"hide","target":{{"css":"a"}}}}]}}"#
        )
    }

    #[test]
    fn tags_are_required_one_or_two_unique_platform_tags() {
        for good in [r#"["mobile"]"#, r#"["desktop"]"#, r#"["mobile","desktop"]"#] {
            assert!(Recipe::parse(&with_tags(good)).is_ok(), "{good}");
        }
        for bad in [
            "[]",
            r#"["official"]"#,
            r#"["community"]"#,
            r#"["mobile","official"]"#,
            r#"["mobile","mobile"]"#,
            r#"["tablet"]"#,
            r#"["Mobile"]"#,
            r#"["mobile","desktop","desktop"]"#,
            "null",
        ] {
            assert!(Recipe::parse(&with_tags(bad)).is_err(), "{bad}");
        }
        let missing = with_tags("[]").replace(r#""tags":[],"#, "");
        assert!(Recipe::parse(&missing).is_err());
    }

    #[test]
    fn options_must_be_used_and_rules_may_only_name_options_that_exist() {
        let with = |rules: &str, options: &str| {
            format!(
                r#"{{"schema":1,"id":"x.y","name":"n","version":"1.0.0","origin":"user","tags":["mobile"],"match":["https://a.com/*"],"options":[{options}],"rules":[{rules}]}}"#
            )
        };
        let option = |id: &str| {
            format!(
                r#"{{"id":"{id}","label":"l","description":"d","group":"content","default":false}}"#
            )
        };
        let rule = |option: &str| {
            format!(
                r#"{{"id":"r","label":"l","type":"hide","option":"{option}","target":{{"css":"a"}}}}"#
            )
        };
        assert!(Recipe::parse(&with(&rule("o"), &option("o"))).is_ok());
        assert!(Recipe::parse(&with(&rule("missing"), &option("o"))).is_err());
        assert!(
            Recipe::parse(&with(
                &rule("o"),
                &format!("{},{}", option("o"), option("p"))
            ))
            .is_err()
        );
        assert!(
            Recipe::parse(&with(
                &rule("o"),
                &format!("{},{}", option("o"), option("o"))
            ))
            .is_err()
        );
        assert!(Recipe::parse(&with(&rule("O"), &option("O"))).is_err());
    }

    #[test]
    fn unsupported_or_unsafe_recipes_are_refused() {
        let base = |extra: &str| {
            format!(
                r#"{{"schema":1,"id":"x.y","name":"n","version":"1.0.0","origin":"user","tags":["mobile"],"match":["https://a.com/*"],"rules":[{extra}]}}"#
            )
        };
        let hide = |css: &str| {
            format!(r#"{{"id":"r","label":"l","type":"hide","target":{{"css":"{css}"}}}}"#)
        };
        assert!(Recipe::parse(&base(&hide("a"))).is_ok());
        assert!(Recipe::parse(&base(&hide("a{x}"))).is_err());
        assert!(
            Recipe::parse(&base(
                r#"{"id":"r","label":"l","type":"hide","target":{"ariaLabel":"Reels"}}"#
            ))
            .is_err()
        );
        assert!(
            Recipe::parse(&base(
                r#"{"id":"r","label":"l","type":"script","code":"1"}"#
            ))
            .is_err()
        );
        let twice = format!("{},{}", hide("a"), hide("b"));
        assert!(Recipe::parse(&base(&twice)).is_err());
        assert!(Recipe::parse(&base(&hide("a")).replace("\"schema\":1", "\"schema\":2")).is_err());
        assert!(
            Recipe::parse(&base(&hide("a")).replace("https://a.com/*", "https://*/*")).is_err()
        );
        assert!(Recipe::parse(&base(&hide("a")).replace("\"user\"", "\"bundled\"")).is_err());
    }

    fn custom_recipe(id: &str, origin: &str) -> Recipe {
        Recipe::parse(&format!(
            r#"{{"schema":1,"id":"{id}","name":"example.org","version":"1.0.0","origin":"{origin}","tags":["mobile"],"match":["https://*.example.org/*"],
              "options":[{{"id":"mine","label":"Mine","description":"d","group":"content","default":true}}],
              "rules":[{{"id":"r","label":"l","type":"hide","option":"mine","target":{{"css":".x"}}}}]}}"#
        ))
        .unwrap()
    }

    #[test]
    fn a_made_recipe_is_listed_applied_and_survives_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("recipes");
        let recipes = Recipes::load(folder.clone()).unwrap();
        let saved = recipes
            .save_made(&custom_recipe("custom.example.org", "ai"))
            .unwrap();
        assert_eq!(recipes.all().len(), 1);
        let page = Url::parse("https://www.example.org/a").unwrap();
        assert_eq!(recipes.for_url(&page).map(|r| r.id), Some(saved.id.clone()));
        assert!(
            recipes
                .script(&OptionChoices::new())
                .unwrap()
                .contains(".x{display:none!important}")
        );
        let restarted = Recipes::load(folder).unwrap();
        assert_eq!(restarted.get("custom.example.org"), Some(saved));
    }

    #[test]
    fn a_made_recipe_needs_a_custom_id_and_a_user_or_ai_origin() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("recipes");
        let recipes = Recipes::load(folder.clone()).unwrap();
        for bad in [
            custom_recipe("other.example.org", "ai"),
            custom_recipe("market.official.reddit", "ai"),
            custom_recipe("custom.Example/../x", "ai"),
            custom_recipe("custom.example.org", "imported"),
        ] {
            assert!(recipes.save_made(&bad).is_err(), "{}", bad.id);
        }
        assert!(recipes.all().is_empty());
        assert!(!folder.exists() || fs::read_dir(&folder).unwrap().next().is_none());
    }

    #[test]
    fn a_damaged_or_stale_file_is_ignored_instead_of_stopping_startup() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("recipes");
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("broken.json"), "{ not json").unwrap();
        // The old format: no tags and a removed origin.
        fs::write(
            folder.join("youtube.default.json"),
            r#"{"schema":1,"id":"youtube.default","name":"YouTube","version":"1.0.0","origin":"bundled","match":["https://*.youtube.com/*"],"rules":[{"id":"r","label":"l","type":"hide","target":{"css":"a"}}]}"#,
        )
        .unwrap();
        fs::write(folder.join("notes.txt"), "hello").unwrap();
        let recipes = Recipes::load(folder).unwrap();
        assert!(recipes.all().is_empty());
    }

    fn shared_bundle(id: &str, version: &str) -> String {
        format!(
            r#"{{"openmediaBundle":1,"recipes":[{{"schema":1,"id":"{id}","name":"example.org","version":"{version}","origin":"user","tags":["mobile"],"match":["https://*.example.org/*"],
              "options":[{{"id":"mine","label":"Mine","description":"d","group":"content","default":true}}],
              "rules":[{{"id":"r","label":"l","type":"hide","option":"mine","target":{{"css":".x"}}}}]}}]}}"#
        )
    }

    #[test]
    fn an_imported_recipe_applies_survives_a_restart_and_can_be_removed() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("recipes");
        let recipes = Recipes::load(folder.clone()).unwrap();
        let text = shared_bundle("reddit.default", "1.0.0");
        let previews = recipes.preview_import(&text).unwrap();
        assert_eq!(previews[0].id, "imported.reddit.default");
        assert_eq!(previews[0].replaces, None);
        assert!(recipes.all().is_empty());

        let saved = recipes
            .save_imported(&text, &["imported.reddit.default".to_owned()])
            .unwrap();
        assert_eq!(saved[0].origin, Origin::Imported);
        assert!(
            recipes
                .script(&OptionChoices::new())
                .unwrap()
                .contains(".x{display:none!important}")
        );

        let restarted = Recipes::load(folder.clone()).unwrap();
        assert_eq!(
            restarted.get("imported.reddit.default"),
            Some(saved[0].clone())
        );
        let newer = shared_bundle("reddit.default", "1.1.0");
        let preview = restarted.preview_import(&newer).unwrap();
        assert_eq!(preview[0].replaces.as_deref(), Some("1.0.0"));

        restarted
            .remove_imported("imported.reddit.default")
            .unwrap();
        assert!(restarted.get("imported.reddit.default").is_none());
        assert!(
            Recipes::load(folder)
                .unwrap()
                .get("imported.reddit.default")
                .is_none()
        );
        assert!(
            restarted
                .remove_imported("imported.reddit.default")
                .is_err()
        );
    }

    #[test]
    fn saving_an_import_needs_ids_that_are_in_the_bundle() {
        let dir = tempfile::tempdir().unwrap();
        let recipes = Recipes::load(dir.path().join("recipes")).unwrap();
        let text = shared_bundle("calm.example", "1.0.0");
        assert!(recipes.save_imported(&text, &[]).is_err());
        assert!(
            recipes
                .save_imported(&text, &["imported.other".to_owned()])
                .is_err()
        );
        assert!(recipes.get("imported.other").is_none());
    }

    #[test]
    fn a_recipe_on_the_device_can_be_exported_with_its_tags_and_unknown_ids_cannot() {
        let dir = tempfile::tempdir().unwrap();
        let recipes = Recipes::load(dir.path().join("recipes")).unwrap();
        assert!(recipes.export(&["custom.nothing".to_owned()]).is_err());
        assert!(recipes.export(&[]).is_err());
        recipes
            .save_made(&custom_recipe("custom.example.org", "user"))
            .unwrap();
        let text = recipes.export(&["custom.example.org".to_owned()]).unwrap();
        assert!(text.contains(r#""tags""#));
        let reimported = Recipes::load(dir.path().join("elsewhere")).unwrap();
        let saved = reimported
            .save_imported(&text, &["imported.custom.example.org".to_owned()])
            .unwrap();
        assert_eq!(
            saved[0].rules,
            recipes.get("custom.example.org").unwrap().rules
        );
        assert_eq!(saved[0].tags, ["mobile"]);
    }

    #[test]
    fn a_made_and_an_installed_recipe_can_cover_one_page() {
        let dir = tempfile::tempdir().unwrap();
        let recipes = Recipes::load(dir.path().join("recipes")).unwrap();
        recipes
            .save_made(&custom_recipe("custom.example.org", "ai"))
            .unwrap();
        let text = shared_bundle("calm.example", "1.0.0");
        recipes
            .save_imported(&text, &["imported.calm.example".to_owned()])
            .unwrap();
        let page = Url::parse("https://www.example.org/").unwrap();
        let ids: Vec<_> = recipes.covering(&page).into_iter().map(|r| r.id).collect();
        assert_eq!(ids, ["custom.example.org", "imported.calm.example"]);
    }
}
