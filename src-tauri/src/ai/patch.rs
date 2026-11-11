//! What the model may ask for, and the strict validation of its answer. The answer is untrusted
//! text: it is parsed with unknown fields refused, every limit is checked here, and every selector
//! and style goes through the same validators as any recipe.

use std::collections::{BTreeMap, HashSet};
use std::fmt::Write;

use serde::Deserialize;
use serde_json::{Value, json};

use crate::error::{Error, Result};
use crate::recipes::{
    CSS_PROPERTIES, Meta, OptionGroup, Origin, Recipe, Rule, SiteOption, Target,
    current_platform_tag, validate_declarations, validate_selector,
};
use tauri_plugin_siteview::site::registrable_domain;

pub const MAX_RULES: usize = 8;
pub const MAX_LABEL_CHARS: usize = 60;
pub const MAX_DESCRIPTION_CHARS: usize = 160;
pub const MAX_SUMMARY_CHARS: usize = 200;
const MAX_ANSWER_BYTES: usize = 32 * 1024;
const MAX_ID_CHARS: usize = 40;

#[derive(Debug, Clone, PartialEq)]
pub struct PatchRule {
    pub label: String,
    pub selector: String,
    pub declarations: Option<BTreeMap<String, String>>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Patch {
    /// A switch for this already exists; accepting it turns that option on.
    ExistingOption { option_id: String, summary: String },
    /// A new switch with its hide rules.
    NewOption {
        summary: String,
        label: String,
        description: String,
        group: OptionGroup,
        rules: Vec<PatchRule>,
    },
}

impl Patch {
    pub fn summary(&self) -> &str {
        match self {
            Self::ExistingOption { summary, .. } | Self::NewOption { summary, .. } => summary,
        }
    }

    /// The new rules, in order; empty for an existing option.
    pub fn rules(&self) -> &[PatchRule] {
        match self {
            Self::ExistingOption { .. } => &[],
            Self::NewOption { rules, .. } => rules,
        }
    }
}

/// The JSON Schema both providers are asked to follow. It is flat (one object, every property
/// required, nullable where it does not apply) because that is the subset OpenAI's strict mode and
/// Anthropic's tool input accept alike. Limits that strict mode cannot express are checked by
/// [`parse_patch`].
pub fn patch_schema() -> Value {
    let css_properties = CSS_PROPERTIES.to_vec();
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["kind", "summary", "optionId", "label", "description", "group", "rules"],
        "properties": {
            "kind": {
                "type": "string",
                "enum": ["existingOption", "newOption"],
                "description": "existingOption when a switch that already exists covers the request; otherwise newOption."
            },
            "summary": {
                "type": "string",
                "description": "One sentence, at most 200 characters, saying what the switch changes and any limits."
            },
            "optionId": {
                "type": ["string", "null"],
                "description": "existingOption only: the id of the existing switch. null for newOption."
            },
            "label": {
                "type": ["string", "null"],
                "description": "newOption only: an imperative switch label, at most 60 characters. null for existingOption."
            },
            "description": {
                "type": ["string", "null"],
                "description": "newOption only: what the switch changes, at most 160 characters. null for existingOption."
            },
            "group": {
                "type": ["string", "null"],
                "enum": ["annoyance", "content", null],
                "description": "newOption only: annoyance for nags, banners and prompts; content for feed content. null for existingOption."
            },
            "rules": {
                "type": ["array", "null"],
                "description": "newOption only: 1 to 8 rules. null or empty for existingOption.",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["label", "selector", "declarations"],
                    "properties": {
                        "label": { "type": "string", "description": "What this rule changes, at most 60 characters." },
                        "selector": { "type": "string", "description": "One CSS selector (comma list allowed): at most 300 characters, at most 2 uses of :has(, none of { } ; \\ < @." },
                        "declarations": {
                            "type": ["array", "null"],
                            "description": "null to hide the selected elements; otherwise 1 or more safe CSS declaration pairs to restyle them.",
                            "items": {
                                "type": "object",
                                "additionalProperties": false,
                                "required": ["property", "value"],
                                "properties": {
                                    "property": { "type": "string", "enum": css_properties },
                                    "value": { "type": "string", "description": "A safe value, at most 60 characters; no URLs or expressions." }
                                }
                            }
                        }
                    }
                }
            }
        }
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Raw {
    kind: String,
    summary: String,
    #[serde(default)]
    option_id: Option<String>,
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    group: Option<String>,
    #[serde(default)]
    rules: Option<Vec<RawRule>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawRule {
    label: String,
    selector: String,
    #[serde(default)]
    declarations: Option<Vec<RawDeclaration>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawDeclaration {
    property: String,
    value: String,
}

fn reject(why: impl AsRef<str>) -> Error {
    Error::Recipe(format!(
        "the assistant's answer was rejected: {}",
        why.as_ref()
    ))
}

/// The answer object inside the model's text. Models that cannot be forced to JSON wrap it in a
/// Markdown fence, reasoning tags or a sentence, so the first `{` that starts a valid answer
/// and ends at the last `}` wins.
fn parse_raw(text: &str) -> Option<Raw> {
    let text = text.trim();
    let end = text.rfind('}')?;
    text.match_indices('{')
        .take_while(|(start, _)| *start < end)
        .find_map(|(start, _)| serde_json::from_str(&text[start..=end]).ok())
}

fn plain(text: &str, what: &str, max: usize, allow_empty: bool) -> Result<String> {
    let text = text.trim();
    if text.chars().any(char::is_control) {
        return Err(reject(format!("{what} has control characters")));
    }
    if text.is_empty() && !allow_empty {
        return Err(reject(format!("{what} is empty")));
    }
    if text.chars().count() > max {
        return Err(reject(format!("{what} is longer than {max} characters")));
    }
    Ok(text.to_owned())
}

/// Selectors that would hide or restyle the whole page or its main structure.
fn targets_page_root(selector: &str) -> bool {
    selector.split(',').any(|part| {
        let part = part.trim().to_ascii_lowercase().replace('\'', "\"");
        matches!(
            part.as_str(),
            "html"
                | "body"
                | ":root"
                | "*"
                | "main"
                | "[role=\"main\"]"
                | "[role=main]"
                | "html body"
                | "body > *"
        )
    })
}

/// Validates the model's answer. `recipe` is the recipe the page already has, if any: an
/// `existingOption` must name one of its options, and a new label must not repeat one.
pub fn parse_patch(json: &str, recipe: Option<&Recipe>) -> Result<Patch> {
    if json.len() > MAX_ANSWER_BYTES {
        return Err(reject("it is too long"));
    }
    let raw = parse_raw(json).ok_or_else(|| reject("it does not follow the schema"))?;
    let summary = plain(&raw.summary, "the summary", MAX_SUMMARY_CHARS, false)?;
    let blank = |value: &Option<String>| value.as_deref().is_none_or(|v| v.trim().is_empty());
    match raw.kind.as_str() {
        "existingOption" => {
            if raw.rules.as_ref().is_some_and(|rules| !rules.is_empty()) {
                return Err(reject("an existing option takes no new rules"));
            }
            let option_id = raw.option_id.as_deref().map(str::trim).unwrap_or_default();
            if !recipe.is_some_and(|recipe| recipe.option(option_id).is_some()) {
                return Err(reject("the option it names does not exist for this site"));
            }
            Ok(Patch::ExistingOption {
                option_id: option_id.to_owned(),
                summary,
            })
        }
        "newOption" => {
            if !blank(&raw.option_id) {
                return Err(reject("a new option has no optionId"));
            }
            let label = plain(
                raw.label.as_deref().unwrap_or(""),
                "the label",
                MAX_LABEL_CHARS,
                false,
            )?;
            let description = plain(
                raw.description.as_deref().unwrap_or(""),
                "the description",
                MAX_DESCRIPTION_CHARS,
                false,
            )?;
            let group = match raw.group.as_deref() {
                Some("annoyance") => OptionGroup::Annoyance,
                Some("content") => OptionGroup::Content,
                _ => return Err(reject("the group must be annoyance or content")),
            };
            if let Some(clash) = recipe.and_then(|recipe| {
                recipe
                    .options
                    .iter()
                    .find(|option| option.label.trim().eq_ignore_ascii_case(&label))
            }) {
                return Err(reject(format!(
                    "a switch labelled \"{}\" already exists; use existingOption with optionId {}",
                    clash.label, clash.id
                )));
            }
            let rules = raw.rules.unwrap_or_default();
            if rules.is_empty() || rules.len() > MAX_RULES {
                return Err(reject(format!("a new option needs 1 to {MAX_RULES} rules")));
            }
            let mut seen_labels = HashSet::new();
            let mut seen_selectors = HashSet::new();
            let mut checked = Vec::with_capacity(rules.len());
            for rule in rules {
                let rule_label = plain(&rule.label, "a rule label", MAX_LABEL_CHARS, false)?;
                let selector = rule.selector.trim().to_owned();
                validate_selector(&selector)?;
                if targets_page_root(&selector) {
                    return Err(reject("a rule would target the whole page"));
                }
                if !seen_labels.insert(rule_label.to_lowercase()) {
                    return Err(reject("two rules have the same label"));
                }
                if !seen_selectors.insert(selector.clone()) {
                    return Err(reject("two rules have the same selector"));
                }
                let declarations = match rule.declarations {
                    Some(declarations) => {
                        let mut checked = BTreeMap::new();
                        for declaration in declarations {
                            if checked
                                .insert(declaration.property, declaration.value)
                                .is_some()
                            {
                                return Err(reject("a style repeats a CSS property"));
                            }
                        }
                        validate_declarations(&checked)?;
                        Some(checked)
                    }
                    None => None,
                };
                checked.push(PatchRule {
                    label: rule_label,
                    selector,
                    declarations,
                });
            }
            Ok(Patch::NewOption {
                summary,
                label,
                description,
                group,
                rules: checked,
            })
        }
        _ => Err(reject("the kind is not known")),
    }
}

/// Lowercase `a-z0-9-` with single dashes, at most `max` characters; empty when nothing is left.
fn slug(text: &str, max: usize) -> String {
    let mut out = String::new();
    for c in text.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    out.truncate(max);
    out.trim_end_matches('-').to_owned()
}

fn unique(base: &str, taken: &HashSet<String>) -> String {
    if !taken.contains(base) {
        return base.to_owned();
    }
    (2..)
        .map(|n| format!("{base}-{n}"))
        .find(|candidate| !taken.contains(candidate))
        .unwrap_or_else(|| base.to_owned())
}

/// The option id a new option with this label would get next to `recipe`'s options.
pub fn option_id_for(label: &str, recipe: Option<&Recipe>) -> String {
    let taken: HashSet<String> = recipe
        .map(|recipe| {
            recipe
                .options
                .iter()
                .map(|option| option.id.clone())
                .collect()
        })
        .unwrap_or_default();
    let base = slug(label, MAX_ID_CHARS);
    unique(if base.is_empty() { "custom" } else { &base }, &taken)
}

/// Whether `recipe` is one the user's own assistant made, which a new switch may be added to.
/// Installed recipes (`market.`, `imported.`) are never edited.
pub fn is_made(recipe: &Recipe) -> bool {
    recipe.id.starts_with("custom.")
}

/// The full recipe to save for a new option. With a made base recipe (`custom.`) the result is a
/// copy of it with the option and its rules appended (origin `ai`). With no base, or an installed
/// one, it is a fresh `custom.<host_domain>` recipe matching the whole site, tagged with this
/// platform. The option is on by
/// default, because the user asked for it. The result has passed [`Recipe::parse`].
///
/// An `existingOption` patch changes no recipe, so it is refused here: the caller only turns the
/// option on.
pub fn apply_patch(base: Option<&Recipe>, host_domain: &str, patch: &Patch) -> Result<Recipe> {
    let Patch::NewOption {
        label,
        description,
        group,
        rules,
        ..
    } = patch
    else {
        return Err(reject("an existing option needs no new recipe"));
    };
    let base = base.filter(|base| is_made(base));
    let mut recipe = match base {
        Some(base) => {
            let mut copy = base.clone();
            copy.origin = Origin::Ai;
            let platform = current_platform_tag();
            if !copy.tags.iter().any(|tag| tag == platform) {
                copy.tags.push(platform.to_owned());
            }
            copy
        }
        None => custom_recipe(host_domain)?,
    };
    let option_id = option_id_for(label, base);
    let mut rule_ids: HashSet<String> = recipe
        .rules
        .iter()
        .map(|rule| rule.id().to_owned())
        .collect();
    recipe.options.push(SiteOption {
        id: option_id.clone(),
        label: label.clone(),
        description: description.clone(),
        group: *group,
        enabled_by_default: true,
    });
    for (index, rule) in rules.iter().enumerate() {
        let tail = slug(&rule.label, MAX_ID_CHARS);
        let tail = if tail.is_empty() {
            format!("rule-{}", index + 1)
        } else {
            tail
        };
        let id = unique(&format!("{option_id}-{tail}"), &rule_ids);
        rule_ids.insert(id.clone());
        let rule = match &rule.declarations {
            Some(declarations) => Rule::Css {
                id,
                label: rule.label.clone(),
                option: Some(option_id.clone()),
                on: None,
                target: Target {
                    css: rule.selector.clone(),
                },
                declarations: declarations.clone(),
            },
            None => Rule::Hide {
                id,
                label: rule.label.clone(),
                option: Some(option_id.clone()),
                on: None,
                target: Target {
                    css: rule.selector.clone(),
                },
            },
        };
        recipe.rules.push(rule);
    }
    let json =
        serde_json::to_string(&recipe).map_err(|_| reject("the recipe could not be built"))?;
    Recipe::parse(&json)
}

fn custom_recipe(domain: &str) -> Result<Recipe> {
    let domain = domain.trim().to_ascii_lowercase();
    let valid = registrable_domain(&domain).as_deref() == Some(domain.as_str());
    if !valid {
        return Err(reject("the page has no site name to save the switch under"));
    }
    Ok(Recipe {
        schema: 1,
        id: format!("custom.{domain}"),
        name: domain.clone(),
        version: "1.0.0".to_owned(),
        origin: Origin::Ai,
        tags: vec![current_platform_tag().to_owned()],
        matches: vec![format!("https://*.{domain}/*")],
        options: Vec::new(),
        rules: Vec::new(),
        meta: Some(Meta {
            author: None,
            homepage: Some(format!("https://{domain}/")),
            last_verified: None,
            notes: Some("Created by the in-app assistant.".to_owned()),
        }),
        hub: None,
    })
}

/// The css that previews a new option, matching what acceptance will save.
pub fn preview_css(patch: &Patch) -> String {
    let mut css = String::new();
    for rule in patch.rules() {
        append_rule_css(&mut css, &rule.selector, rule.declarations.as_ref());
    }
    css
}

/// The css of an existing option's hide and style rules, to preview turning it on.
pub fn option_css(recipe: &Recipe, option_id: &str) -> String {
    let mut css = String::new();
    for rule in &recipe.rules {
        match rule {
            Rule::Hide { target, option, .. } if option.as_deref() == Some(option_id) => {
                append_rule_css(&mut css, &target.css, None);
            }
            Rule::Css {
                target,
                option,
                declarations,
                ..
            } if option.as_deref() == Some(option_id) => {
                append_rule_css(&mut css, &target.css, Some(declarations));
            }
            _ => {}
        }
    }
    css
}

fn append_rule_css(
    css: &mut String,
    selector: &str,
    declarations: Option<&BTreeMap<String, String>>,
) {
    css.push_str(selector);
    css.push('{');
    if let Some(declarations) = declarations {
        for (property, value) in declarations {
            let _ = write!(css, "{property}:{value}!important;");
        }
    } else {
        css.push_str("display:none!important;");
    }
    css.push_str("}\n");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::recipes::official_recipes;

    fn youtube() -> Recipe {
        official_recipes()
            .into_iter()
            .find(|r| r.id == "market.official.youtube")
            .unwrap()
    }

    fn new_option(rules: Value) -> String {
        json!({
            "kind": "newOption", "summary": "Hides the stories row.", "optionId": null,
            "label": "Hide the stories row", "description": "The row of story circles above the feed.",
            "group": "content", "rules": rules
        })
        .to_string()
    }

    fn one_rule(selector: &str) -> Value {
        json!([{ "label": "Stories row", "selector": selector }])
    }

    #[test]
    fn a_good_new_option_is_accepted() {
        let patch = parse_patch(
            &new_option(one_rule("div:has(> a[href^=\"/stories/\"])")),
            None,
        )
        .unwrap();
        let Patch::NewOption {
            label,
            group,
            rules,
            ..
        } = &patch
        else {
            panic!()
        };
        assert_eq!(label, "Hide the stories row");
        assert_eq!(*group, OptionGroup::Content);
        assert_eq!(rules[0].selector, "div:has(> a[href^=\"/stories/\"])");
        assert_eq!(
            preview_css(&patch),
            "div:has(> a[href^=\"/stories/\"]){display:none!important;}\n"
        );
    }

    #[test]
    fn restyles_are_validated_previewed_and_saved() {
        let rules = json!([{
            "label": "Google logo",
            "selector": "img[alt=\"Google\"]",
            "declarations": [{ "property": "filter", "value": "grayscale(1)" }]
        }]);
        let patch = parse_patch(&new_option(rules), None).unwrap();
        let expected = "img[alt=\"Google\"]{filter:grayscale(1)!important;}\n";
        assert_eq!(preview_css(&patch), expected);

        let recipe = apply_patch(None, "google.com", &patch).unwrap();
        assert!(matches!(
            &recipe.rules[0],
            Rule::Css { declarations, .. }
                if declarations.get("filter").map(String::as_str) == Some("grayscale(1)")
        ));
        assert_eq!(option_css(&recipe, &recipe.options[0].id), expected);
    }

    #[test]
    fn unsafe_styles_are_refused() {
        for declarations in [
            json!([{ "property": "background", "value": "red" }]),
            json!([{ "property": "filter", "value": "url(https://evil.test/x)" }]),
            json!([]),
            json!([
                { "property": "filter", "value": "grayscale(1)" },
                { "property": "filter", "value": "none" }
            ]),
        ] {
            let rules = json!([{
                "label": "Logo",
                "selector": "img",
                "declarations": declarations
            }]);
            assert!(parse_patch(&new_option(rules), None).is_err());
        }
    }

    #[test]
    fn an_answer_wrapped_in_prose_or_reasoning_is_tolerated() {
        let body = new_option(one_rule("ytm-reel-shelf-renderer"));
        for wrapped in [
            format!("<think>hmm {{maybe}}</think>\n{body}"),
            format!("Here is the patch:\n```json\n{body}\n```\nDone."),
        ] {
            assert!(parse_patch(&wrapped, None).is_ok(), "{wrapped}");
        }
    }

    #[test]
    fn a_fenced_answer_is_tolerated() {
        let fenced = format!(
            "```json\n{}\n```",
            new_option(one_rule("ytm-reel-shelf-renderer"))
        );
        assert!(parse_patch(&fenced, None).is_ok());
    }

    #[test]
    fn selectors_the_recipe_validator_refuses_are_refused() {
        for bad in [
            "a{color:red}",
            "a;b",
            "@import x",
            "a\\b",
            "a<b",
            "a[",
            "a:has(b):has(c):has(d)",
            &"a".repeat(301),
            &vec!["a"; 21].join(","),
        ] {
            assert!(
                parse_patch(&new_option(one_rule(bad)), None).is_err(),
                "{bad}"
            );
        }
        for page_wide in [
            "body",
            "html",
            "main",
            "*",
            ":root",
            "a, body",
            "[role=\"main\"]",
        ] {
            assert!(
                parse_patch(&new_option(one_rule(page_wide)), None).is_err(),
                "{page_wide}"
            );
        }
        assert!(parse_patch(&new_option(one_rule("main > div:has(> h1)")), None).is_ok());
    }

    #[test]
    fn other_rule_types_and_extra_fields_are_refused() {
        let script = new_option(
            json!([{ "label": "x", "selector": "a", "type": "script", "code": "alert(1)" }]),
        );
        assert!(parse_patch(&script, None).is_err());
        let css = new_option(
            json!([{ "label": "x", "selector": "a", "declarations": { "display": "none" } }]),
        );
        assert!(parse_patch(&css, None).is_err());
        let redirect = json!({"kind":"newOption","summary":"s","label":"l","description":"d","group":"content",
            "rules":[{"label":"x","selector":"a"}],"redirect":"https://evil.test"}).to_string();
        assert!(parse_patch(&redirect, None).is_err());
        for junk in [
            "",
            "not json",
            "[]",
            "{}",
            "null",
            r#"{"kind":"deleteEverything","summary":"s"}"#,
        ] {
            assert!(parse_patch(junk, None).is_err(), "{junk}");
        }
    }

    #[test]
    fn counts_and_lengths_are_limited() {
        let nine: Vec<Value> = (0..9)
            .map(|i| json!({"label": format!("r{i}"), "selector": format!("a.x{i}")}))
            .collect();
        assert!(parse_patch(&new_option(json!(nine)), None).is_err());
        let eight: Vec<Value> = (0..8)
            .map(|i| json!({"label": format!("r{i}"), "selector": format!("a.x{i}")}))
            .collect();
        assert!(parse_patch(&new_option(json!(eight)), None).is_ok());
        assert!(parse_patch(&new_option(json!([])), None).is_err());

        let with = |field: &str, value: String| {
            let mut v: Value = serde_json::from_str(&new_option(one_rule("a.x"))).unwrap();
            v[field] = json!(value);
            v.to_string()
        };
        assert!(parse_patch(&with("label", "x".repeat(61)), None).is_err());
        assert!(parse_patch(&with("label", "x".repeat(60)), None).is_ok());
        assert!(parse_patch(&with("description", "x".repeat(161)), None).is_err());
        assert!(parse_patch(&with("description", "x".repeat(160)), None).is_ok());
        assert!(parse_patch(&with("summary", "x".repeat(201)), None).is_err());
        assert!(parse_patch(&with("label", "  ".into()), None).is_err());
        assert!(parse_patch(&with("label", "two\nlines".into()), None).is_err());
        let long_rule = new_option(json!([{ "label": "x".repeat(61), "selector": "a.x" }]));
        assert!(parse_patch(&long_rule, None).is_err());
    }

    #[test]
    fn duplicates_are_refused() {
        let dup_label =
            new_option(json!([{"label":"Row","selector":"a.x"},{"label":"row","selector":"a.y"}]));
        assert!(parse_patch(&dup_label, None).is_err());
        let dup_selector =
            new_option(json!([{"label":"One","selector":"a.x"},{"label":"Two","selector":"a.x"}]));
        assert!(parse_patch(&dup_selector, None).is_err());
        let recipe = youtube();
        let existing_label = recipe.options[0].label.clone();
        let mut v: Value = serde_json::from_str(&new_option(one_rule("a.x"))).unwrap();
        v["label"] = json!(existing_label.to_uppercase());
        let err = parse_patch(&v.to_string(), Some(&recipe))
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("existingOption") && err.contains(&recipe.options[0].id),
            "{err}"
        );
    }

    #[test]
    fn an_existing_option_must_exist_and_takes_no_rules() {
        let recipe = youtube();
        let answer = |id: &str, rules: Value| {
            json!({"kind":"existingOption","summary":"Turns on the Shorts switch.","optionId":id,
                   "label":null,"description":null,"group":null,"rules":rules})
            .to_string()
        };
        let patch = parse_patch(&answer("shorts", Value::Null), Some(&recipe)).unwrap();
        assert_eq!(
            patch,
            Patch::ExistingOption {
                option_id: "shorts".into(),
                summary: "Turns on the Shorts switch.".into()
            }
        );
        assert!(parse_patch(&answer("shorts", json!([])), Some(&recipe)).is_ok());
        assert!(parse_patch(&answer("nope", Value::Null), Some(&recipe)).is_err());
        assert!(parse_patch(&answer("shorts", Value::Null), None).is_err());
        assert!(parse_patch(&answer("shorts", one_rule("a.x")), Some(&recipe)).is_err());
        assert_eq!(preview_css(&patch), "");
        assert!(
            option_css(&recipe, "shorts")
                .contains("ytm-reel-shelf-renderer{display:none!important;}")
        );
        assert!(apply_patch(Some(&recipe), "youtube.com", &patch).is_err());
    }

    #[test]
    fn the_schema_is_a_flat_strict_object() {
        let schema = patch_schema();
        assert_eq!(schema["type"], "object");
        assert_eq!(schema["additionalProperties"], false);
        let required: Vec<&str> = schema["required"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        let mut properties: Vec<&str> = schema["properties"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        properties.sort_unstable();
        let mut sorted = required.clone();
        sorted.sort_unstable();
        assert_eq!(
            properties, sorted,
            "strict mode needs every property listed as required"
        );
        assert_eq!(
            schema["properties"]["rules"]["items"]["additionalProperties"],
            false
        );
    }

    #[test]
    fn a_switch_for_an_installed_recipe_goes_into_a_new_custom_recipe_beside_it() {
        let base = youtube();
        let patch = parse_patch(&new_option(json!([
            {"label": "Stories row", "selector": "ytm-stories-shelf"},
            {"label": "Stories tab", "selector": "ytm-pivot-bar-item-renderer:has(.pivot-stories)"}
        ])), Some(&base)).unwrap();
        let recipe = apply_patch(Some(&base), "youtube.com", &patch).unwrap();
        assert_eq!(recipe.id, "custom.youtube.com");
        assert_eq!(recipe.origin, Origin::Ai);
        assert_eq!(recipe.tags, [current_platform_tag()]);
        assert_eq!(recipe.options.len(), 1);
        assert_eq!(recipe.rules.len(), 2);
        let option = &recipe.options[0];
        assert_eq!(option.id, "hide-the-stories-row");
        assert!(option.enabled_by_default);
        assert_eq!(option.group, OptionGroup::Content);
        assert!(
            matches!(&recipe.rules[0], Rule::Hide { id, option, .. } if id == "hide-the-stories-row-stories-row" && option.as_deref() == Some("hide-the-stories-row"))
        );
        let again = Recipe::parse(&serde_json::to_string(&recipe).unwrap()).unwrap();
        assert_eq!(again, recipe);
    }

    #[test]
    fn a_made_base_is_extended_and_gains_this_platforms_tag() {
        let patch = parse_patch(&new_option(one_rule("div.promo")), None).unwrap();
        let mut made = apply_patch(None, "example.com", &patch).unwrap();
        let other = if current_platform_tag() == "mobile" {
            "desktop"
        } else {
            "mobile"
        };
        made.tags = vec![other.to_owned()];
        let mut other_switch: Value =
            serde_json::from_str(&new_option(one_rule("div.other"))).unwrap();
        other_switch["label"] = json!("Hide the other banner");
        let patch = parse_patch(&other_switch.to_string(), Some(&made)).unwrap();
        let extended = apply_patch(Some(&made), "example.com", &patch).unwrap();
        assert_eq!(extended.id, made.id);
        assert_eq!(extended.options.len(), 2);
        assert!(
            extended
                .tags
                .iter()
                .any(|tag| tag == current_platform_tag())
        );
        assert!(extended.tags.iter().any(|tag| tag == other));
    }

    #[test]
    fn ids_stay_unique_against_the_base() {
        let base = youtube();
        let mut v: Value = serde_json::from_str(&new_option(one_rule("a.x"))).unwrap();
        v["label"] = json!("Hide the Stories row!");
        let patch = parse_patch(&v.to_string(), Some(&base)).unwrap();
        let once = apply_patch(Some(&base), "youtube.com", &patch).unwrap();
        // Applying the same request again, now against the made recipe, cannot collide.
        let mut v2 = v.clone();
        v2["label"] = json!("Hide the stories row");
        let again_patch = parse_patch(&v2.to_string(), Some(&base)).unwrap();
        let twice = apply_patch(Some(&once), "youtube.com", &again_patch).unwrap();
        let ids: HashSet<&str> = twice.options.iter().map(|o| o.id.as_str()).collect();
        assert_eq!(ids.len(), twice.options.len());
        assert!(ids.contains("hide-the-stories-row") && ids.contains("hide-the-stories-row-2"));
        let rule_ids: HashSet<&str> = twice.rules.iter().map(Rule::id).collect();
        assert_eq!(rule_ids.len(), twice.rules.len());
        assert_eq!(option_id_for("!!!", None), "custom");
        assert!(option_id_for(&"x".repeat(60), None).len() <= MAX_ID_CHARS);
    }

    #[test]
    fn without_a_base_a_custom_recipe_for_the_site_is_made() {
        let patch = parse_patch(&new_option(one_rule("div.promo-banner")), None).unwrap();
        let recipe = apply_patch(None, "example.com", &patch).unwrap();
        assert_eq!(recipe.id, "custom.example.com");
        assert_eq!(recipe.name, "example.com");
        assert_eq!(recipe.origin, Origin::Ai);
        assert_eq!(recipe.matches, ["https://*.example.com/*"]);
        assert_eq!(recipe.options.len(), 1);
        assert!(recipe.options[0].enabled_by_default);
        assert_eq!(recipe.homepage(), Some("https://example.com/"));
        assert_eq!(recipe.tags, [current_platform_tag()]);
        for bad in [
            "",
            "localhost",
            "a b.com",
            "exa_mple.com",
            "-a.com",
            "192.168.0.1x",
            "a..com",
        ] {
            assert!(apply_patch(None, bad, &patch).is_err(), "{bad}");
        }
    }
}
