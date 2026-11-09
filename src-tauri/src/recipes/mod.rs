mod compile;
mod matcher;
mod schema;
mod selector;

pub use compile::{OptionChoices, page_script};
pub use schema::{Meta, OptionGroup, Origin, Recipe, Rule, SiteOption, Target};
pub(crate) use selector::validate_selector;

use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    sync::{PoisonError, RwLock},
};

use url::Url;

use crate::error::{Error, Result};
use crate::library::write_atomically;

const BUNDLED: &[&str] = &[
    include_str!("../../../recipes/bundled/instagram.json"),
    include_str!("../../../recipes/bundled/facebook.json"),
    include_str!("../../../recipes/bundled/twitter.json"),
    include_str!("../../../recipes/bundled/reddit.json"),
    include_str!("../../../recipes/bundled/youtube.json"),
    include_str!("../../../recipes/bundled/threads.json"),
    include_str!("../../../recipes/bundled/telegram.json"),
    include_str!("../../../recipes/bundled/douyin.json"),
    include_str!("../../../recipes/bundled/messenger.json"),
    include_str!("../../../recipes/bundled/discord.json"),
    include_str!("../../../recipes/bundled/kuaishou.json"),
    include_str!("../../../recipes/bundled/linkedin.json"),
    include_str!("../../../recipes/bundled/whatsapp.json"),
    include_str!("../../../recipes/bundled/snapchat.json"),
    include_str!("../../../recipes/bundled/pinterest.json"),
    include_str!("../../../recipes/bundled/weibo.json"),
    include_str!("../../../recipes/bundled/tiktok.json"),
    include_str!("../../../recipes/bundled/twitch.json"),
];

const MAX_FORK_BYTES: usize = 256 * 1024;

/// Test-only: the bundled recipes with no fork folder.
#[cfg(test)]
impl Recipes {
    pub fn bundled_only() -> Self {
        Self::load(PathBuf::from("/nonexistent/openmedia-test")).unwrap()
    }
}

pub fn bundled() -> Result<Vec<Recipe>> {
    BUNDLED.iter().map(|json| Recipe::parse(json)).collect()
}

/// The recipes in effect: the ones the app ships with, each replaced by the user's customized copy
/// (a fork) when one exists. A fork is a file in `dir`, written when the user or the assistant
/// changes a bundled recipe; app updates replace the bundled recipes but never touch these files,
/// so a user's changes survive an update. The page script is compiled on demand, because it
/// depends on the user's toggles.
pub struct Recipes {
    bundled: Vec<Recipe>,
    dir: PathBuf,
    forks: RwLock<BTreeMap<String, Recipe>>,
    custom: RwLock<BTreeMap<String, Recipe>>,
}

/// Ids of recipes the user or the assistant made for a site the app ships no recipe for.
const CUSTOM_PREFIX: &str = "custom.";

impl Recipes {
    /// Loads the bundled recipes and every valid fork or custom recipe in `dir`. A file that is
    /// unreadable, invalid, or neither a fork of a bundled recipe nor a `custom.` recipe is skipped,
    /// so a damaged file can never stop the app from starting; the bundled recipe applies instead.
    pub fn load(dir: PathBuf) -> Result<Self> {
        let bundled = bundled()?;
        let mut forks = BTreeMap::new();
        let mut custom = BTreeMap::new();
        for entry in fs::read_dir(&dir).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.extension().is_none_or(|extension| extension != "json") {
                continue;
            }
            let Ok(text) = fs::read_to_string(&path) else {
                continue;
            };
            if let Ok(fork) = parse_fork(&bundled, &text) {
                forks.insert(fork.id.clone(), fork);
            } else if let Ok(recipe) = parse_custom(&text) {
                custom.insert(recipe.id.clone(), recipe);
            }
        }
        Ok(Self {
            bundled,
            dir,
            forks: RwLock::new(forks),
            custom: RwLock::new(custom),
        })
    }

    pub fn all(&self) -> Vec<Recipe> {
        let forks = self.forks.read().unwrap_or_else(PoisonError::into_inner);
        let custom = self.custom.read().unwrap_or_else(PoisonError::into_inner);
        self.bundled
            .iter()
            .map(|recipe| forks.get(&recipe.id).unwrap_or(recipe).clone())
            .chain(custom.values().cloned())
            .collect()
    }

    pub fn get(&self, id: &str) -> Option<Recipe> {
        self.all().into_iter().find(|recipe| recipe.id == id)
    }

    /// The version of the recipe the app currently ships under this id.
    pub fn bundled_version(&self, id: &str) -> Option<&str> {
        self.bundled
            .iter()
            .find(|recipe| recipe.id == id)
            .map(|recipe| recipe.version.as_str())
    }

    /// The recipe whose `match` patterns cover this page.
    pub fn for_url(&self, url: &Url) -> Option<Recipe> {
        self.all().into_iter().find(|recipe| {
            recipe
                .matches
                .iter()
                .filter_map(|pattern| matcher::Matcher::parse(pattern).ok())
                .any(|matcher| matcher.matches(url))
        })
    }

    /// The script injected into every site view: all recipes, matched by the page itself.
    pub fn script(&self, choices: &OptionChoices) -> Result<String> {
        page_script(&self.all(), choices)
    }

    /// Saves a changed copy of a bundled recipe. The copy keeps the bundled recipe's id and
    /// replaces it from now on. It is validated like any recipe, must not claim to be bundled, and
    /// records the bundled version it came from so Settings can say when the original has moved on.
    pub fn save_fork(&self, json: &str) -> Result<Recipe> {
        if json.len() > MAX_FORK_BYTES {
            return Err(Error::Recipe("the recipe is too large".into()));
        }
        let mut fork = Recipe::parse(json)?;
        let base = self
            .bundled
            .iter()
            .find(|recipe| recipe.id == fork.id)
            .ok_or(Error::UnknownSite)?;
        if !matches!(fork.origin, Origin::User | Origin::Ai) {
            return Err(Error::Recipe("a fork must have origin user or ai".into()));
        }
        fork.forked_from = Some(base.version.clone());
        write_atomically(
            &self.dir.join(format!("{}.json", fork.id)),
            &serde_json::to_vec_pretty(&fork)?,
        )?;
        self.forks
            .write()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(fork.id.clone(), fork.clone());
        Ok(fork)
    }

    /// Drops the customized copy; the bundled recipe applies again.
    pub fn restore_original(&self, id: &str) -> Result<()> {
        if self.bundled_version(id).is_none() {
            return Err(Error::UnknownSite);
        }
        match fs::remove_file(self.dir.join(format!("{id}.json"))) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error.into()),
            _ => {}
        }
        self.forks
            .write()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(id);
        Ok(())
    }

    /// Saves a recipe the assistant (or the user) made: a changed copy of a bundled recipe if the
    /// id is a bundled one, otherwise a `custom.` recipe for a site the app ships none for. It is
    /// validated again here, whatever produced it.
    pub fn save_made(&self, recipe: &Recipe) -> Result<Recipe> {
        let json = serde_json::to_string(recipe)?;
        if self.bundled_version(&recipe.id).is_some() {
            return self.save_fork(&json);
        }
        let saved = parse_custom(&json)?;
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
}

fn parse_fork(bundled: &[Recipe], text: &str) -> Result<Recipe> {
    let fork = Recipe::parse(text)?;
    let is_fork = fork.forked_from.is_some()
        && matches!(fork.origin, Origin::User | Origin::Ai)
        && bundled.iter().any(|recipe| recipe.id == fork.id);
    if is_fork {
        Ok(fork)
    } else {
        Err(Error::UnknownSite)
    }
}

fn parse_custom(text: &str) -> Result<Recipe> {
    if text.len() > MAX_FORK_BYTES {
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
    if id_is_safe
        && matches!(recipe.origin, Origin::User | Origin::Ai)
        && recipe.forked_from.is_none()
    {
        Ok(recipe)
    } else {
        Err(Error::UnknownSite)
    }
}

#[cfg(test)]
mod tests {
    use std::{fs, path::Path};

    use scraper::{Html, Selector};

    use super::compile::recipe_css;
    use super::schema::Rule;
    use super::*;

    #[test]
    fn every_bundled_recipe_parses_and_validates() {
        let recipes = bundled().unwrap();
        assert!(!recipes.is_empty());
        let mut ids: Vec<_> = recipes.iter().map(|r| r.id.as_str()).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), recipes.len());
    }

    fn fixture_pages(recipe: &Recipe) -> Vec<Html> {
        let fixtures_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../recipes/fixtures");
        let site = recipe.id.split('.').next().unwrap();
        let pages: Vec<Html> = fs::read_dir(fixtures_root.join(site))
            .unwrap_or_else(|_| panic!("recipe {} has no fixtures", recipe.id))
            .map(|entry| Html::parse_document(&fs::read_to_string(entry.unwrap().path()).unwrap()))
            .collect();
        assert!(!pages.is_empty(), "recipe {} has no fixtures", recipe.id);
        pages
    }

    #[test]
    fn no_hide_rule_touches_an_element_a_fixture_marks_data_keep_or_its_ancestors() {
        let keep = Selector::parse("[data-keep]").unwrap();
        for recipe in bundled().unwrap() {
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
    fn every_bundled_rule_matches_something_in_its_dom_fixtures() {
        let mut unmatched = Vec::new();
        for recipe in bundled().unwrap() {
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

    const TOGGLED: &str = r#"{"schema":1,"id":"t.default","name":"T","version":"1.0.0","origin":"bundled","match":["https://t.example/*"],
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

    fn fork_json(id: &str, origin: &str, css: &str) -> String {
        format!(
            r#"{{"schema":1,"id":"{id}","name":"Reddit","version":"1.0.0","origin":"{origin}","forkedFrom":"0.0.1","match":["https://*.reddit.com/*"],
              "options":[{{"id":"mine","label":"Mine","description":"d","group":"content","default":true}}],
              "rules":[{{"id":"r","label":"l","type":"hide","option":"mine","target":{{"css":"{css}"}}}}]}}"#
        )
    }

    #[test]
    fn a_fork_replaces_its_bundled_recipe_and_survives_a_restart_until_restored() {
        let dir = tempfile::tempdir().unwrap();
        let recipes = Recipes::load(dir.path().join("recipes")).unwrap();
        let before = recipes.get("reddit.default").unwrap();
        assert_eq!(before.forked_from, None);

        let saved = recipes
            .save_fork(&fork_json("reddit.default", "ai", ".mine-only"))
            .unwrap();
        assert_eq!(
            saved.forked_from.as_deref(),
            recipes.bundled_version("reddit.default"),
            "the recorded base is the bundled version, not what the JSON claimed"
        );
        let script = recipes.script(&OptionChoices::new()).unwrap();
        assert!(script.contains(".mine-only"));
        assert!(
            !script.contains("shreddit-ad-post"),
            "the bundled rules are gone"
        );
        assert_eq!(recipes.all().len(), bundled().unwrap().len());

        let restarted = Recipes::load(dir.path().join("recipes")).unwrap();
        assert_eq!(restarted.get("reddit.default"), Some(saved));

        restarted.restore_original("reddit.default").unwrap();
        assert_eq!(restarted.get("reddit.default"), Some(before));
        let after_restore = Recipes::load(dir.path().join("recipes")).unwrap();
        assert_eq!(
            after_restore.get("reddit.default").unwrap().forked_from,
            None
        );
    }

    #[test]
    fn only_user_or_ai_copies_of_bundled_recipes_can_be_saved_and_nothing_is_written_otherwise() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("recipes");
        let recipes = Recipes::load(folder.clone()).unwrap();
        for json in [
            fork_json("reddit.default", "bundled", "a"),
            fork_json("reddit.default", "imported", "a"),
            fork_json("nothing.default", "ai", "a"),
            fork_json("reddit.default", "ai", "a{x}"),
        ] {
            assert!(recipes.save_fork(&json).is_err(), "{json}");
        }
        assert!(recipes.save_fork(&"x".repeat(MAX_FORK_BYTES + 1)).is_err());
        assert!(!folder.exists() || fs::read_dir(&folder).unwrap().next().is_none());
        assert!(recipes.restore_original("nothing.default").is_err());
        assert_eq!(recipes.get("reddit.default").unwrap().forked_from, None);
    }

    #[test]
    fn a_damaged_or_stale_fork_file_is_ignored_instead_of_stopping_startup() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("recipes");
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("reddit.default.json"), "{ not json").unwrap();
        fs::write(
            folder.join("old.default.json"),
            fork_json("old.default", "user", "a"),
        )
        .unwrap();
        fs::write(
            folder.join("youtube.default.json"),
            fork_json("youtube.default", "bundled", "a"),
        )
        .unwrap();
        fs::write(folder.join("notes.txt"), "hello").unwrap();
        let recipes = Recipes::load(folder).unwrap();
        assert!(
            recipes
                .all()
                .iter()
                .all(|recipe| recipe.forked_from.is_none())
        );
    }

    #[test]
    fn a_page_belongs_to_the_recipe_that_matches_its_url() {
        let recipes = Recipes::bundled_only();
        let page = |url: &str| {
            recipes
                .for_url(&Url::parse(url).unwrap())
                .map(|r| r.id.clone())
        };
        assert_eq!(
            page("https://www.reddit.com/r/rust/").as_deref(),
            Some("reddit.default")
        );
        assert_eq!(page("https://example.com/"), None);
    }

    #[test]
    fn annoyances_start_on_and_content_starts_off() {
        for recipe in bundled().unwrap() {
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

    #[test]
    fn options_must_be_used_and_rules_may_only_name_options_that_exist() {
        let with = |rules: &str, options: &str| {
            format!(
                r#"{{"schema":1,"id":"x.y","name":"n","version":"1.0.0","origin":"user","match":["https://a.com/*"],"options":[{options}],"rules":[{rules}]}}"#
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
                r#"{{"schema":1,"id":"x.y","name":"n","version":"1.0.0","origin":"user","match":["https://a.com/*"],"rules":[{extra}]}}"#
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
    }

    fn custom_recipe(id: &str, origin: &str) -> Recipe {
        Recipe::parse(&format!(
            r#"{{"schema":1,"id":"{id}","name":"example.org","version":"1.0.0","origin":"{origin}","match":["https://*.example.org/*"],
              "options":[{{"id":"mine","label":"Mine","description":"d","group":"content","default":true}}],
              "rules":[{{"id":"r","label":"l","type":"hide","option":"mine","target":{{"css":".x"}}}}]}}"#
        ))
        .unwrap()
    }

    #[test]
    fn a_made_recipe_for_an_unbundled_site_is_listed_applied_and_survives_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("recipes");
        let recipes = Recipes::load(folder.clone()).unwrap();
        let saved = recipes
            .save_made(&custom_recipe("custom.example.org", "ai"))
            .unwrap();
        assert_eq!(recipes.all().len(), bundled().unwrap().len() + 1);
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
    fn a_made_recipe_for_a_bundled_site_becomes_a_fork_and_bad_ids_or_origins_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let recipes = Recipes::load(dir.path().join("recipes")).unwrap();
        let fork = recipes
            .save_made(&custom_recipe("reddit.default", "ai"))
            .unwrap();
        assert!(fork.forked_from.is_some());
        for bad in [
            custom_recipe("other.example.org", "ai"),
            custom_recipe("custom.Example/../x", "ai"),
            custom_recipe("custom.example.org", "bundled"),
            custom_recipe("custom.example.org", "imported"),
        ] {
            assert!(recipes.save_made(&bad).is_err(), "{}", bad.id);
        }
        assert_eq!(recipes.all().len(), bundled().unwrap().len());
    }
}
