pub mod bundled;
mod compile;
mod matcher;
mod prune;
mod schema;
pub mod script_policy;
mod selector;
mod share;

pub use compile::{OptionChoices, page_script};
pub(crate) use schema::is_script_text;
pub use schema::{
    Hub, HubTab, MAX_HUB_LABEL_CHARS, MAX_HUB_TABS, MIN_HUB_TABS, Meta, OptionChoice, OptionGroup,
    OptionValue, Origin, Recipe, Rule, Selected, SiteOption, Target, VideoMenuKind,
    current_platform_tag,
};
pub(crate) use schema::{MENU_SELECTED_ATTRS, validate_video_menu};
pub(crate) use selector::{
    CSS_PROPERTIES, targets_page_root, validate_declarations, validate_selector,
};
pub(crate) use share::{MARKET_PREFIX, MAX_RECIPE_BYTES, MAX_SUMMARY_CHARS, is_plain_text};
pub use share::{RecipePreview, preview as preview_recipe};

use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    sync::{PoisonError, RwLock},
};

use url::Url;

use crate::error::{Error, Result};
use crate::library::write_atomically;

const MAX_MADE_BYTES: usize = 256 * 1024;

/// Ids of recipes the user or the assistant made. Every other recipe is added from the bundled
/// library (`bundled`).
const CUSTOM_PREFIX: &str = "custom.";

/// The recipes in effect: the ones the user or the assistant made (`custom.`) and the ones
/// installed from the library (`market.`, or `imported.` from earlier versions). Files live in `dir`, so app updates never touch
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

    /// Deletes an installed recipe, a library one or one an earlier version imported from text; its saved switches are left behind and are harmless.
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

    /// Saves a recipe of the bundled library. It was parsed as a bundled recipe when the app
    /// started; this only refuses anything that is not a `market.` recipe labelled imported.
    pub fn save_bundled(&self, recipe: Recipe) -> Result<Recipe> {
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

/// A recipe as the bundled library and the share check read it: its own claims about origin are
/// ignored, its id must be a `market.` one, and its scripts must pass the policy.
pub fn parse_bundled_recipe(bytes: &[u8]) -> Result<Recipe> {
    share::parse_shared(bytes, share::Source::Bundled)
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

/// Test-only: the official recipes, as the app bundles them.
#[cfg(test)]
pub(crate) fn official_recipes() -> Vec<Recipe> {
    bundled::all()
        .iter()
        .filter(|bundled| bundled.is_official())
        .map(|bundled| bundled.recipe.clone())
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
            // A hub that only opens pages has no rules, so there is no page to fixture.
            if recipe.rules.is_empty() {
                continue;
            }
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
            if recipe.rules.is_empty() {
                continue;
            }
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
            if recipe.rules.is_empty() {
                continue;
            }
            let pages = fixture_pages(&recipe);
            for rule in &recipe.rules {
                let (Rule::Hide { target, .. } | Rule::Css { target, .. }) = rule else {
                    continue;
                };
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
            .map(|(option, on)| ((*option).to_owned(), OptionValue::Toggle(*on)))
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

    const CHOICE: &str = r#"{"schema":1,"id":"c.default","name":"C","version":"1.0.0","origin":"user","tags":["mobile"],"match":["https://c.example/*"],
      "options":[
        {"id":"media","label":"Media","description":"d","group":"content",
         "choices":[{"id":"show","label":"Show"},{"id":"blur","label":"Blur"},{"id":"hide","label":"Hide"}],"default":"show"}],
      "rules":[
        {"id":"b","label":"l","type":"css","option":"media","choice":["blur"],"target":{"css":".pic"},"declarations":{"filter":"blur(8px)"}},
        {"id":"h","label":"l","type":"hide","option":"media","choice":["hide"],"target":{"css":".pic"}},
        {"id":"x","label":"l","type":"hide","option":"media","choice":["blur","hide"],"target":{"css":".both"}}]}"#;

    fn choice_css(saved: Option<OptionValue>) -> String {
        let recipe = Recipe::parse(CHOICE).unwrap();
        let choices = saved
            .map(|value| {
                OptionChoices::from([(
                    "c.default".to_owned(),
                    [("media".to_owned(), value)].into(),
                )])
            })
            .unwrap_or_default();
        recipe_css(&recipe, &choices)
    }

    #[test]
    fn a_choice_option_applies_only_the_rules_of_its_selected_choice() {
        assert_eq!(choice_css(None), "");
        assert_eq!(choice_css(Some(OptionValue::Choice("show".into()))), "");
        let blur = choice_css(Some(OptionValue::Choice("blur".into())));
        assert!(blur.contains(".pic{filter:blur(8px)!important;}"));
        assert!(blur.contains(".both{display:none!important}"));
        assert!(!blur.contains(".pic{display:none"));
        let hide = choice_css(Some(OptionValue::Choice("hide".into())));
        assert!(hide.contains(".pic{display:none!important}"));
        assert!(hide.contains(".both{display:none!important}"));
        assert!(!hide.contains("blur"));
    }

    #[test]
    fn a_saved_value_the_option_no_longer_accepts_falls_back_to_the_default() {
        assert_eq!(choice_css(Some(OptionValue::Choice("gone".into()))), "");
        assert_eq!(choice_css(Some(OptionValue::Toggle(true))), "");
    }

    #[test]
    fn an_option_accepts_only_values_of_its_own_kind() {
        let choice = Recipe::parse(CHOICE).unwrap();
        let media = choice.option("media").unwrap();
        assert!(media.accepts(&OptionValue::Choice("hide".into())));
        assert!(!media.accepts(&OptionValue::Choice("gone".into())));
        assert!(!media.accepts(&OptionValue::Toggle(true)));
        assert_eq!(media.off_value(), OptionValue::Choice("show".into()));
        let toggle = Recipe::parse(TOGGLED).unwrap();
        let nag = toggle.option("nag").unwrap();
        assert!(nag.accepts(&OptionValue::Toggle(false)));
        assert!(!nag.accepts(&OptionValue::Choice("show".into())));
        assert_eq!(nag.off_value(), OptionValue::Toggle(false));
    }

    #[test]
    fn choice_options_and_their_rules_must_be_well_formed() {
        let build = |option_extra: &str, rule_extra: &str| {
            format!(
                r#"{{"schema":1,"id":"c.default","name":"C","version":"1.0.0","origin":"user","tags":["mobile"],"match":["https://c.example/*"],
                "options":[{{"id":"media","label":"M","description":"d","group":"content"{option_extra}}}],
                "rules":[{{"id":"r","label":"l","type":"hide","option":"media","target":{{"css":".x"}}{rule_extra}}}]}}"#
            )
        };
        let choices = r#","choices":[{"id":"show","label":"Show"},{"id":"hide","label":"Hide"}]"#;
        assert!(
            Recipe::parse(&build(
                &format!(r#"{choices},"default":"show""#),
                r#","choice":["hide"]"#
            ))
            .is_ok()
        );
        let refused = [
            // a switch carrying a choice list on its rule, or a string default
            (r#","default":false"#.to_owned(), r#","choice":["hide"]"#),
            (r#","default":"show""#.to_owned(), ""),
            // a choice option with a bad default, rule, or too few or many states
            (format!(r#"{choices},"default":false"#), r#","choice":["hide"]"#),
            (format!(r#"{choices},"default":"gone""#), r#","choice":["hide"]"#),
            (format!(r#"{choices},"default":"show""#), ""),
            (format!(r#"{choices},"default":"show""#), r#","choice":[]"#),
            (format!(r#"{choices},"default":"show""#), r#","choice":["show"]"#),
            (format!(r#"{choices},"default":"show""#), r#","choice":["gone"]"#),
            (format!(r#"{choices},"default":"show""#), r#","choice":["hide","hide"]"#),
            (
                r#","choices":[{"id":"only","label":"Only"}],"default":"only""#.to_owned(),
                r#","choice":["only"]"#,
            ),
            (
                r#","choices":[{"id":"a","label":"A"},{"id":"a","label":"B"}],"default":"a""#.to_owned(),
                r#","choice":["a"]"#,
            ),
            (
                r#","choices":[{"id":"a","label":"A"},{"id":"b","label":"B"},{"id":"c","label":"C"},{"id":"d","label":"D"},{"id":"e","label":"E"}],"default":"a""#.to_owned(),
                r#","choice":["b"]"#,
            ),
            (
                r#","choices":[{"id":"a","label":"A"},{"id":"b","label":"  "}],"default":"a""#.to_owned(),
                r#","choice":["b"]"#,
            ),
        ];
        for (option, rule) in refused {
            assert!(
                Recipe::parse(&build(&option, rule)).is_err(),
                "{option} {rule}"
            );
        }
        let orphan = r#"{"schema":1,"id":"c.default","name":"C","version":"1.0.0","origin":"user","tags":["mobile"],"match":["https://c.example/*"],
            "rules":[{"id":"r","label":"l","type":"hide","choice":["hide"],"target":{"css":".x"}}]}"#;
        assert!(Recipe::parse(orphan).is_err());
    }

    #[test]
    fn choices_for_other_recipes_or_unknown_options_change_nothing() {
        let recipe = Recipe::parse(TOGGLED).unwrap();
        let other = OptionChoices::from([(
            "other.default".to_owned(),
            [("nag".to_owned(), OptionValue::Toggle(false))].into(),
        )]);
        let unknown = OptionChoices::from([(
            "t.default".to_owned(),
            [("gone".to_owned(), OptionValue::Toggle(true))].into(),
        )]);
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
    fn video_menus_are_carried_with_their_runtime_only_when_a_recipe_has_one() {
        let without =
            page_script(&[Recipe::parse(TOGGLED).unwrap()], &OptionChoices::new()).unwrap();
        assert!(without.contains("const menuRuntime = null;"));
        let menu = TOGGLED.replace(
            "\"rules\":[",
            "\"rules\":[{\"id\":\"q\",\"label\":\"Quality\",\"type\":\"videoMenu\",\"kind\":\"quality\",\"title\":\"Quality\",\"open\":[{\"css\":\"button.gear\"}],\"items\":{\"css\":\"li.level\"},\"selected\":{\"attr\":\"aria-checked\"}},",
        );
        let with = page_script(&[Recipe::parse(&menu).unwrap()], &OptionChoices::new()).unwrap();
        assert!(with.contains("openmedia.videoMenus"));
        assert!(with.contains("li.level"));
        assert!(!with.contains("const menuRuntime = null;"));
    }

    fn prune_recipe(origin: &str, rules: &str) -> String {
        TOGGLED
            .replace("\"origin\":\"user\"", &format!("\"origin\":\"{origin}\""))
            .replace("\"rules\":[", &format!("\"rules\":[{rules},"))
    }

    const PRUNE_RULE: &str = r#"{"id":"p","label":"Drop reels","type":"prune","option":"feed","urls":["/api/feed"],"remove":[{"path":"data.items[*]","when":{"key":"media_type","equals":2}}]}"#;

    #[test]
    fn prune_rules_follow_their_option_and_carry_their_runtime_only_when_one_applies() {
        let recipe = Recipe::parse(&prune_recipe("user", PRUNE_RULE)).unwrap();
        let off = page_script(std::slice::from_ref(&recipe), &OptionChoices::new()).unwrap();
        assert!(off.contains("const pruneRuntime = null;"));
        assert!(!off.contains("^/api/feed$"));
        let on = OptionChoices::from([(
            "t.default".to_owned(),
            [("feed".to_owned(), OptionValue::Toggle(true))].into(),
        )]);
        let with = page_script(&[recipe], &on).unwrap();
        assert!(with.contains("openmedia.prune"));
        assert!(with.contains("^/api/feed$"));
        assert!(!with.contains("const pruneRuntime = null;"));
    }

    #[test]
    fn a_prune_rule_changes_only_what_the_page_reads_so_every_origin_may_have_one() {
        for origin in ["user", "ai", "imported"] {
            assert!(
                Recipe::parse(&prune_recipe(origin, PRUNE_RULE)).is_ok(),
                "{origin}"
            );
        }
    }

    #[test]
    fn prune_rules_are_limited_and_closed() {
        let numbered = |n: usize| {
            PRUNE_RULE
                .replacen("\"id\":\"p\"", &format!("\"id\":\"p{n}\""), 1)
                .to_owned()
        };
        let nine: Vec<String> = (0..9).map(numbered).collect();
        assert!(Recipe::parse(&prune_recipe("user", &nine.join(","))).is_err());
        let eight: Vec<String> = (0..8).map(numbered).collect();
        assert!(Recipe::parse(&prune_recipe("user", &eight.join(","))).is_ok());
        for bad in [
            PRUNE_RULE.replace("/api/feed", "https://other.example/api/feed"),
            PRUNE_RULE.replace("data.items[*]", "data..items"),
            PRUNE_RULE.replace("\"equals\":2", "\"equals\":{\"a\":1}"),
            PRUNE_RULE.replace("\"when\":", "\"if\":"),
            PRUNE_RULE.replace("\"urls\":[\"/api/feed\"]", "\"urls\":[]"),
            PRUNE_RULE.replace("\"type\":\"prune\"", "\"type\":\"prune\",\"url\":\"/x\""),
        ] {
            assert!(Recipe::parse(&prune_recipe("user", &bad)).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_video_menu_clicks_the_sites_controls_so_an_imported_recipe_cannot_have_one() {
        let menu = |origin: &str| {
            TOGGLED
                .replace("\"origin\":\"user\"", &format!("\"origin\":\"{origin}\""))
                .replace(
                    "\"rules\":[",
                    "\"rules\":[{\"id\":\"q\",\"label\":\"Quality\",\"type\":\"videoMenu\",\"kind\":\"quality\",\"title\":\"Quality\",\"items\":{\"css\":\"li.level\"},\"selected\":{\"class\":\"on\"}},",
                )
        };
        assert!(Recipe::parse(&menu("user")).is_ok());
        assert!(Recipe::parse(&menu("imported")).is_err());
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

    fn with_script_rules(origin: &str, codes: &[&str]) -> String {
        let scripts: Vec<String> = codes
            .iter()
            .enumerate()
            .map(|(n, code)| {
                let code = serde_json::to_string(code).unwrap();
                format!(r#"{{"id":"s{n}","label":"l","type":"script","code":{code}}}"#)
            })
            .collect();
        let rules = format!(
            r#""rules":[{{"id":"c1","label":"l","type":"hide","target":{{"css":".nag"}}}},{}]}}"#,
            scripts.join(",")
        );
        format!(
            r#"{{"schema":1,"id":"t.script","name":"T","version":"1.0.0","origin":"{origin}","tags":["desktop"],"match":["https://t.example/*"],{rules}"#
        )
    }

    #[test]
    fn script_rules_are_embedded_raw_and_indexed_per_entry() {
        let json = with_script_rules("user", &["document.title;", "return 1;"]);
        let recipe = Recipe::parse(&json).unwrap();
        let script = page_script(&[recipe], &OptionChoices::new()).unwrap();
        assert!(script.contains(
            "const scripts = [(function(){\"use strict\";\ndocument.title;\n}),\n(function(){\"use strict\";\nreturn 1;\n})];"
        ));
        assert!(script.contains("\"scripts\":[0,1]"));
        assert!(script.contains(".nag{display:none!important}"));
        assert!(script.contains("DOMContentLoaded"));
    }

    #[test]
    fn a_recipe_without_scripts_gets_an_empty_script_list() {
        let recipes = vec![Recipe::parse(TOGGLED).unwrap()];
        let script = page_script(&recipes, &OptionChoices::new()).unwrap();
        assert!(script.contains("const scripts = []"));
        assert!(script.contains("\"scripts\":[]"));
    }

    #[test]
    fn script_rules_follow_their_option_toggle() {
        let json = with_script_rules("user", &["document.title;"]).replace(
            "\"type\":\"script\"",
            "\"type\":\"script\",\"option\":\"opt\"",
        );
        let json = json.replace(
            "\"rules\"",
            "\"options\":[{\"id\":\"opt\",\"label\":\"O\",\"description\":\"d\",\"group\":\"content\",\"default\":false}],\"rules\"",
        );
        let recipe = Recipe::parse(&json).unwrap();
        let off = page_script(std::slice::from_ref(&recipe), &OptionChoices::new()).unwrap();
        assert!(off.contains("const scripts = []"));
        let on = OptionChoices::from([(
            "t.script".to_owned(),
            [("opt".to_owned(), OptionValue::Toggle(true))].into(),
        )]);
        assert!(
            page_script(&[recipe], &on)
                .unwrap()
                .contains("document.title;")
        );
    }

    #[test]
    fn code_that_could_leave_its_wrapper_is_refused_for_every_origin() {
        for origin in ["user", "ai", "imported"] {
            let json = with_script_rules(origin, &["}); evil(); (function(){"]);
            assert!(Recipe::parse(&json).is_err(), "{origin}");
        }
    }

    #[test]
    fn script_limits_and_hidden_characters_are_enforced_for_every_origin() {
        let big = "a;".repeat(script_policy::MAX_CODE_BYTES);
        let nine = ["a;"; script_policy::MAX_SCRIPT_RULES + 1];
        let total = vec!["a;".repeat(8 * 1024); 5];
        let total: Vec<&str> = total.iter().map(String::as_str).collect();
        let cases: Vec<Vec<&str>> = vec![
            vec![" \n"],
            vec![big.as_str()],
            nine.to_vec(),
            total,
            vec!["a;\u{202E}"],
            vec!["a;\u{2028}"],
            vec!["a;\u{0}"],
            vec!["a;\u{200B}"],
        ];
        for origin in ["user", "ai", "imported"] {
            for codes in &cases {
                assert!(Recipe::parse(&with_script_rules(origin, codes)).is_err());
            }
        }
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
            if recipe.hub.is_some() && recipe.rules.is_empty() {
                continue;
            }
            assert!(!recipe.options.is_empty(), "{} has no options", recipe.id);
            for option in &recipe.options {
                assert_eq!(
                    option.is_active(&option.default_value),
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
                r#"{"id":"r","label":"l","type":"script","code":"1","target":{"css":"a"}}"#
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

    fn library_recipe(id: &str, version: &str) -> Recipe {
        parse_bundled_recipe(
            format!(
                r#"{{"schema":1,"id":"{id}","name":"example.org","version":"{version}","origin":"user","tags":["mobile"],"match":["https://*.example.org/*"],
              "options":[{{"id":"mine","label":"Mine","description":"d","group":"content","default":true}}],
              "rules":[{{"id":"r","label":"l","type":"hide","option":"mine","target":{{"css":".x"}}}}]}}"#
            )
            .as_bytes(),
        )
        .unwrap()
    }

    #[test]
    fn an_installed_recipe_applies_survives_a_restart_and_can_be_removed() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("recipes");
        let recipes = Recipes::load(folder.clone()).unwrap();
        let saved = recipes
            .save_bundled(library_recipe("market.reddit.default", "1.0.0"))
            .unwrap();
        assert_eq!(saved.origin, Origin::Imported);
        assert_eq!(
            recipes.imported_version("market.reddit.default").as_deref(),
            Some("1.0.0")
        );
        assert!(
            recipes
                .script(&OptionChoices::new())
                .unwrap()
                .contains(".x{display:none!important}")
        );

        let restarted = Recipes::load(folder.clone()).unwrap();
        assert_eq!(restarted.get("market.reddit.default"), Some(saved));

        restarted.remove_imported("market.reddit.default").unwrap();
        assert!(restarted.get("market.reddit.default").is_none());
        assert!(
            Recipes::load(folder)
                .unwrap()
                .get("market.reddit.default")
                .is_none()
        );
        assert!(restarted.remove_imported("market.reddit.default").is_err());
    }

    #[test]
    fn a_recipe_imported_by_an_earlier_version_still_loads_and_can_be_removed() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("recipes");
        fs::create_dir_all(&folder).unwrap();
        let mut legacy = library_recipe("market.calm.example", "1.0.0");
        legacy.id = "imported.calm.example".to_owned();
        fs::write(
            folder.join("imported.calm.example.json"),
            serde_json::to_vec(&legacy).unwrap(),
        )
        .unwrap();
        let recipes = Recipes::load(folder.clone()).unwrap();
        assert_eq!(recipes.get("imported.calm.example"), Some(legacy));
        recipes.remove_imported("imported.calm.example").unwrap();
        assert!(!folder.join("imported.calm.example.json").exists());
    }

    #[test]
    fn saving_a_library_recipe_refuses_other_ids() {
        let dir = tempfile::tempdir().unwrap();
        let recipes = Recipes::load(dir.path().join("recipes")).unwrap();
        let mut other = library_recipe("market.calm", "1.0.0");
        other.id = "imported.calm".to_owned();
        assert!(recipes.save_bundled(other).is_err());
        assert!(recipes.all().is_empty());
    }

    #[test]
    fn a_made_and_an_installed_recipe_can_cover_one_page() {
        let dir = tempfile::tempdir().unwrap();
        let recipes = Recipes::load(dir.path().join("recipes")).unwrap();
        recipes
            .save_made(&custom_recipe("custom.example.org", "ai"))
            .unwrap();
        recipes
            .save_bundled(library_recipe("market.calm.example", "1.0.0"))
            .unwrap();
        let page = Url::parse("https://www.example.org/").unwrap();
        let ids: Vec<_> = recipes.covering(&page).into_iter().map(|r| r.id).collect();
        assert_eq!(ids, ["custom.example.org", "market.calm.example"]);
    }
}
