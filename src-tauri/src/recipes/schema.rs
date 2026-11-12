use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};
use url::Url;

use super::matcher::Matcher;
use super::script_policy::{self, Finding, MAX_CODE_BYTES, MAX_SCRIPT_RULES, MAX_TOTAL_CODE_BYTES};
use super::selector::{targets_page_root, validate_declarations, validate_selector};
use super::share::is_plain_text;
use crate::error::{Error, Result};

pub const SCHEMA_VERSION: u32 = 1;
const MAX_RULES: usize = 200;
const MAX_OPTIONS: usize = 30;
const MAX_LABEL_CHARS: usize = 60;
const MAX_DESCRIPTION_CHARS: usize = 160;
pub const MIN_HUB_TABS: usize = 2;
pub const MAX_HUB_TABS: usize = 6;
pub const MAX_HUB_LABEL_CHARS: usize = 20;
const MAX_HUB_URL_CHARS: usize = 300;
const MAX_SHOWN_FINDINGS: usize = 3;
const MAX_FINDING_CHARS: usize = 160;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Origin {
    User,
    Ai,
    Imported,
}

/// The platform tags a recipe may carry. The origin tags (`official`, `community`) are added by
/// the recipe library to a listing and are never part of a recipe.
pub const PLATFORM_TAGS: [&str; 2] = ["mobile", "desktop"];

/// The tag of the platform this build runs on: macOS, Windows and Linux are `desktop`.
pub const fn current_platform_tag() -> &'static str {
    if cfg!(any(target_os = "ios", target_os = "android")) {
        "mobile"
    } else {
        "desktop"
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Meta {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    /// Where "add to favorites" sends the user; also what a favorite of this site opens.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_verified: Option<String>,
    /// The one line the recipe library shows: plain text, 1 to 140 characters.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

/// Annoyances (install nags, scroll locks, promo bars) are meant to be hidden by default;
/// content (Reels, Shorts, suggested posts) is the user's choice and starts visible. The group
/// only orders and labels the toggles; the default is set per option.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OptionGroup {
    Annoyance,
    Content,
}

/// A user-facing toggle. Rules point at an option with their `option` field; the toggle turns all
/// of them on or off together.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SiteOption {
    pub id: String,
    pub label: String,
    pub description: String,
    pub group: OptionGroup,
    /// Whether the rules apply until the user chooses otherwise.
    #[serde(rename = "default")]
    pub enabled_by_default: bool,
}

/// Only a CSS selector for now. The wiki's semantic fields (aria-label, href, text) are refused,
/// not silently ignored, until the engine supports them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Target {
    pub css: String,
}

/// One page of a hub: a label for its tab and the address it opens.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HubTab {
    pub label: String,
    pub url: String,
}

/// A recipe that is also a set of pages from several sites, opened together as tabs. Each page
/// stays its own session on its own site; the recipe's `match` patterns and rules shape them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Hub {
    pub tabs: Vec<HubTab>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Rule {
    Hide {
        id: String,
        label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        option: Option<String>,
        /// Narrows the rule to some of the recipe's own `match` patterns (a hub shapes each of its
        /// sites separately); none means every page the recipe matches.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        on: Option<Vec<String>>,
        target: Target,
    },
    Css {
        id: String,
        label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        option: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        on: Option<Vec<String>>,
        target: Target,
        declarations: BTreeMap<String, String>,
    },
    /// The body of a function that runs once on each matching page. What it may do depends on the
    /// recipe's origin; see `script_policy`.
    Script {
        id: String,
        label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        option: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        on: Option<Vec<String>>,
        code: String,
    },
}

impl Rule {
    pub fn id(&self) -> &str {
        match self {
            Self::Hide { id, .. } | Self::Css { id, .. } | Self::Script { id, .. } => id,
        }
    }

    /// The toggle this rule belongs to; a rule with none always applies.
    pub fn option(&self) -> Option<&str> {
        match self {
            Self::Hide { option, .. } | Self::Css { option, .. } | Self::Script { option, .. } => {
                option.as_deref()
            }
        }
    }

    /// The `match` patterns this rule is limited to; `None` means all of the recipe's.
    pub fn on(&self) -> Option<&[String]> {
        match self {
            Self::Hide { on, .. } | Self::Css { on, .. } | Self::Script { on, .. } => on.as_deref(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Recipe {
    pub schema: u32,
    pub id: String,
    pub name: String,
    pub version: String,
    pub origin: Origin,
    /// `mobile` and/or `desktop`: the platforms the selectors were written and checked for.
    pub tags: Vec<String>,
    #[serde(rename = "match")]
    pub matches: Vec<String>,
    #[serde(default)]
    pub options: Vec<SiteOption>,
    pub rules: Vec<Rule>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<Meta>,
    /// Present when the recipe is a hub: the pages to open as tabs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hub: Option<Hub>,
}

impl Recipe {
    pub fn parse(json: &str) -> Result<Self> {
        let recipe: Self = serde_json::from_str(json).map_err(|e| Error::Recipe(e.to_string()))?;
        recipe.validate()?;
        Ok(recipe)
    }

    /// Whether one of the recipe's `match` patterns covers this page.
    pub fn covers(&self, url: &Url) -> bool {
        self.matches
            .iter()
            .filter_map(|pattern| Matcher::parse(pattern).ok())
            .any(|matcher| matcher.matches(url))
    }

    pub fn homepage(&self) -> Option<&str> {
        self.meta.as_ref()?.homepage.as_deref()
    }

    pub fn option(&self, id: &str) -> Option<&SiteOption> {
        self.options.iter().find(|option| option.id == id)
    }

    /// Whether a rule applies, given the user's saved choices for this recipe's options.
    pub fn rule_applies(&self, rule: &Rule, choices: Option<&BTreeMap<String, bool>>) -> bool {
        let Some(option) = rule.option().and_then(|id| self.option(id)) else {
            return true;
        };
        choices
            .and_then(|saved| saved.get(&option.id))
            .copied()
            .unwrap_or(option.enabled_by_default)
    }

    pub(super) fn validate(&self) -> Result<()> {
        if self.schema != SCHEMA_VERSION {
            return Err(Error::Recipe(format!(
                "recipe {} uses unsupported schema {}",
                self.id, self.schema
            )));
        }
        self.validate_tags()?;
        if self.id.trim().is_empty() || self.name.trim().is_empty() {
            return Err(Error::Recipe("a recipe needs an id and a name".into()));
        }
        if self.matches.is_empty() {
            return Err(Error::Recipe(format!(
                "recipe {} matches no pages",
                self.id
            )));
        }
        if self.rules.len() > MAX_RULES {
            return Err(Error::Recipe(format!(
                "recipe {} has too many rules",
                self.id
            )));
        }
        for pattern in &self.matches {
            let matcher = Matcher::parse(pattern)?;
            if matcher.is_broad() || matcher.is_suffix_wide() {
                return Err(Error::Recipe(format!(
                    "match pattern {pattern} is too broad"
                )));
            }
        }
        self.validate_options()?;
        self.validate_hub()?;
        self.validate_homepage()?;
        self.validate_script_totals()?;
        let mut seen = HashSet::new();
        for rule in &self.rules {
            if !seen.insert(rule.id()) {
                return Err(Error::Recipe(format!("duplicate rule id {}", rule.id())));
            }
            if let Some(option) = rule.option()
                && self.option(option).is_none()
            {
                return Err(Error::Recipe(format!(
                    "rule {} uses unknown option {option}",
                    rule.id()
                )));
            }
            if let Some(on) = rule.on()
                && (on.is_empty() || on.iter().any(|pattern| !self.matches.contains(pattern)))
            {
                return Err(Error::Recipe(format!(
                    "rule {} is limited to a pattern the recipe does not have",
                    rule.id()
                )));
            }
            match rule {
                Rule::Hide { target, .. } => {
                    validate_selector(&target.css)?;
                    if targets_page_root(&target.css) {
                        return Err(Error::Recipe(format!(
                            "rule {} would hide the whole page",
                            rule.id()
                        )));
                    }
                }
                Rule::Css {
                    target,
                    declarations,
                    ..
                } => {
                    validate_selector(&target.css)?;
                    validate_declarations(declarations)?;
                    if targets_page_root(&target.css) && hides_content(declarations) {
                        return Err(Error::Recipe(format!(
                            "rule {} would hide the whole page",
                            rule.id()
                        )));
                    }
                }
                Rule::Script { id, code, .. } => self.validate_script(id, code)?,
            }
        }
        Ok(())
    }

    fn validate_script(&self, id: &str, code: &str) -> Result<()> {
        let refuse = |reason: &str| Error::Recipe(format!("script rule {id} {reason}"));
        if code.trim().is_empty() {
            return Err(refuse("has no code"));
        }
        if code.len() > MAX_CODE_BYTES {
            return Err(refuse("is too long"));
        }
        if !is_script_text(code) {
            return Err(refuse("has characters that cannot be shown safely"));
        }
        if self.origin == Origin::Imported {
            let findings = script_policy::scan(code);
            if !findings.is_empty() {
                return Err(refuse(&format!("is refused: {}", describe(&findings))));
            }
        } else if let Some(finding) = script_policy::check_shape(code) {
            return Err(refuse(&format!("is refused: {}", describe(&[finding]))));
        }
        Ok(())
    }

    fn validate_script_totals(&self) -> Result<()> {
        let (count, bytes) = self
            .rules
            .iter()
            .filter_map(|rule| match rule {
                Rule::Script { code, .. } => Some(code.len()),
                _ => None,
            })
            .fold((0, 0), |(count, bytes), len| (count + 1, bytes + len));
        if count > MAX_SCRIPT_RULES || bytes > MAX_TOTAL_CODE_BYTES {
            return Err(Error::Recipe(format!(
                "recipe {} has too much script code",
                self.id
            )));
        }
        Ok(())
    }

    fn validate_tags(&self) -> Result<()> {
        let well_formed = !self.tags.is_empty()
            && self.tags.len() <= PLATFORM_TAGS.len()
            && self
                .tags
                .iter()
                .all(|tag| PLATFORM_TAGS.contains(&tag.as_str()))
            && self.tags.iter().collect::<HashSet<_>>().len() == self.tags.len();
        if well_formed {
            Ok(())
        } else {
            Err(Error::Recipe(format!(
                "recipe {} needs tags: mobile, desktop, or both",
                self.id
            )))
        }
    }

    fn validate_homepage(&self) -> Result<()> {
        let Some(homepage) = self.homepage() else {
            return Ok(());
        };
        match Url::parse(homepage) {
            Ok(url) if matches!(url.scheme(), "http" | "https") && url.host_str().is_some() => {
                Ok(())
            }
            _ => Err(Error::Recipe(format!(
                "recipe {} has an invalid homepage",
                self.id
            ))),
        }
    }

    /// A hub has 2 to 6 tabs, each an https page the recipe's own patterns cover, so a tab can
    /// never send the user to a site the review screen did not show as a site of the recipe.
    fn validate_hub(&self) -> Result<()> {
        let Some(hub) = &self.hub else {
            return Ok(());
        };
        let invalid = |reason: &str| Error::Recipe(format!("hub {}: {reason}", self.id));
        if !(MIN_HUB_TABS..=MAX_HUB_TABS).contains(&hub.tabs.len()) {
            return Err(invalid("a hub has 2 to 6 tabs"));
        }
        let mut seen = HashSet::new();
        for tab in &hub.tabs {
            if tab.label.trim().is_empty()
                || tab.label.chars().count() > MAX_HUB_LABEL_CHARS
                || tab.label.chars().any(|c| {
                    c.is_control()
                        || matches!(
                            c,
                            '\u{200B}'..='\u{200F}'
                                | '\u{202A}'..='\u{202E}'
                                | '\u{2066}'..='\u{2069}'
                                | '\u{FEFF}'
                        )
                })
            {
                return Err(invalid(
                    "a tab needs a plain-text label of up to 20 characters",
                ));
            }
            let url = Url::parse(&tab.url).ok().filter(|url| {
                tab.url.len() <= MAX_HUB_URL_CHARS
                    && !tab.url.contains('\\')
                    && !tab.url.chars().any(|c| {
                        c.is_control()
                            || matches!(
                                c,
                                '\u{200B}'..='\u{200F}'
                                    | '\u{202A}'..='\u{202E}'
                                    | '\u{2066}'..='\u{2069}'
                                    | '\u{FEFF}'
                            )
                    })
                    && url.scheme() == "https"
                    && url.host_str().is_some()
                    && url.username().is_empty()
                    && url.password().is_none()
            });
            let Some(url) = url else {
                return Err(invalid("a tab needs an https address without credentials"));
            };
            if !self.covers(&url) {
                return Err(invalid(
                    "a tab address is not covered by the recipe's patterns",
                ));
            }
            if !seen.insert(url.to_string()) {
                return Err(invalid("two tabs open the same address"));
            }
        }
        Ok(())
    }

    fn validate_options(&self) -> Result<()> {
        if self.options.len() > MAX_OPTIONS {
            return Err(Error::Recipe(format!(
                "recipe {} has too many options",
                self.id
            )));
        }
        let mut seen = HashSet::new();
        for option in &self.options {
            let well_formed = !option.id.is_empty()
                && option
                    .id
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
                && !option.label.trim().is_empty()
                && option.label.chars().count() <= MAX_LABEL_CHARS
                && option.description.chars().count() <= MAX_DESCRIPTION_CHARS;
            if !well_formed || !seen.insert(option.id.as_str()) {
                return Err(Error::Recipe(format!("option {} is invalid", option.id)));
            }
            if !self
                .rules
                .iter()
                .any(|rule| rule.option() == Some(option.id.as_str()))
            {
                return Err(Error::Recipe(format!("option {} has no rules", option.id)));
            }
        }
        Ok(())
    }
}

/// Script text may use tab, line feed and carriage return; no other control character, line
/// separator, zero-width or direction-override character.
pub(crate) fn is_script_text(code: &str) -> bool {
    let plain = code.replace(['\t', '\n', '\r'], "");
    is_plain_text(&plain, usize::MAX) && !plain.contains(['\u{2028}', '\u{2029}'])
}

/// At most three findings, each on its own, so a refusal stays short enough to show.
fn describe(findings: &[Finding]) -> String {
    let shown: Vec<String> = findings
        .iter()
        .take(MAX_SHOWN_FINDINGS)
        .map(|finding| {
            let message: String = finding.message.chars().take(MAX_FINDING_CHARS).collect();
            format!("{} at line {}: {message}", finding.code, finding.line)
        })
        .collect();
    shown.join("; ")
}

/// Whether declarations would make the elements they style disappear or stop reacting.
fn hides_content(declarations: &BTreeMap<String, String>) -> bool {
    let value = |property: &str| {
        declarations
            .get(property)
            .map(|value| value.trim().to_ascii_lowercase())
    };
    value("display").as_deref() == Some("none")
        || value("visibility").as_deref() == Some("hidden")
        || value("opacity").as_deref() == Some("0")
        || value("pointer-events").as_deref() == Some("none")
        || matches!(value("height").as_deref(), Some("0" | "0px"))
        || matches!(value("max-height").as_deref(), Some("0" | "0px"))
}
