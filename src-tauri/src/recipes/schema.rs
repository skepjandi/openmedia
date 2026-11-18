use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};
use url::Url;

use super::crowd::{self, SegmentCategory, VideoId};
use super::matcher::Matcher;
use super::prune::{self, PruneRemove};
use super::route::{RouteGlob, validate_target};
use super::script_policy::{self, Finding, MAX_CODE_BYTES, MAX_SCRIPT_RULES, MAX_TOTAL_CODE_BYTES};
use super::selector::{targets_page_root, validate_declarations, validate_selector};
use super::share::is_plain_text;
use crate::error::{Error, Result};

pub const SCHEMA_VERSION: u32 = 1;
const MAX_RULES: usize = 200;
const MAX_OPTIONS: usize = 32;
const MAX_LABEL_CHARS: usize = 60;
const MAX_DESCRIPTION_CHARS: usize = 160;
pub const MIN_CHOICES: usize = 2;
pub const MAX_CHOICES: usize = 4;
const MAX_CHOICE_LABEL_CHARS: usize = 24;
pub const MIN_HUB_TABS: usize = 2;
pub const MAX_HUB_TABS: usize = 6;
pub const MAX_HUB_LABEL_CHARS: usize = 20;
const MAX_HUB_URL_CHARS: usize = 300;
const MAX_SHOWN_FINDINGS: usize = 3;
const MAX_FINDING_CHARS: usize = 160;
const MAX_VIDEO_MENUS: usize = 4;
pub const MAX_DARK_INVERT: usize = 20;
const MAX_MENU_STEPS: usize = 3;
const MAX_MENU_TITLE_CHARS: usize = 24;
/// The attributes a site's menu may use to mark the entry in use.
pub const MENU_SELECTED_ATTRS: [&str; 7] = [
    "aria-checked",
    "aria-selected",
    "aria-current",
    "data-checked",
    "data-selected",
    "data-active",
    "data-state",
];

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

/// One state of a choice option, such as Show, Blur or Hide.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OptionChoice {
    pub id: String,
    pub label: String,
}

/// What an option is set to: a switch is on or off, a choice option is one of its choices. Saved
/// libraries hold plain booleans for switches, so that shape must keep loading.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum OptionValue {
    Toggle(bool),
    Choice(String),
}

/// A user-facing setting. Rules point at an option with their `option` field. A switch turns all
/// of its rules on or off together. A choice option (`choices` is not empty) has 2 to 4 states;
/// the first is the page left alone, and each rule names the states in which it applies.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SiteOption {
    pub id: String,
    pub label: String,
    pub description: String,
    pub group: OptionGroup,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub choices: Vec<OptionChoice>,
    /// What the option is set to until the user chooses otherwise: a boolean for a switch, a
    /// choice id for a choice option.
    #[serde(rename = "default")]
    pub default_value: OptionValue,
}

impl SiteOption {
    pub fn is_choice(&self) -> bool {
        !self.choices.is_empty()
    }

    /// Whether `value` is a state this option can be in.
    pub fn accepts(&self, value: &OptionValue) -> bool {
        match value {
            OptionValue::Toggle(_) => !self.is_choice(),
            OptionValue::Choice(id) => self.choices.iter().any(|choice| &choice.id == id),
        }
    }

    /// The state in effect: the saved one when this option still accepts it (a recipe update may
    /// have renamed a choice), else the default.
    pub fn current<'a>(&'a self, saved: Option<&'a OptionValue>) -> &'a OptionValue {
        saved
            .filter(|value| self.accepts(value))
            .unwrap_or(&self.default_value)
    }

    /// The state that leaves the page alone: a switch off, or the first choice.
    pub fn off_value(&self) -> OptionValue {
        match self.choices.first() {
            Some(first) => OptionValue::Choice(first.id.clone()),
            None => OptionValue::Toggle(false),
        }
    }

    /// A switch has a boolean default and no choices; a choice option has 2 to 4 distinct,
    /// short choices and names one of them as its default.
    fn has_valid_states(&self) -> bool {
        if !self.is_choice() {
            return matches!(self.default_value, OptionValue::Toggle(_));
        }
        let mut seen = HashSet::new();
        (MIN_CHOICES..=MAX_CHOICES).contains(&self.choices.len())
            && self.choices.iter().all(|choice| {
                !choice.id.is_empty()
                    && choice
                        .id
                        .chars()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
                    && !choice.label.trim().is_empty()
                    && choice.label.chars().count() <= MAX_CHOICE_LABEL_CHARS
                    && seen.insert(choice.id.as_str())
            })
            && matches!(&self.default_value, OptionValue::Choice(id)
                if self.choices.iter().any(|choice| &choice.id == id))
    }

    /// Whether `value` changes the page (a switch on, or any choice but the first).
    pub fn is_active(&self, value: &OptionValue) -> bool {
        *value != self.off_value()
    }
}

/// Only a CSS selector for now. The wiki's semantic fields (aria-label, href, text) are refused,
/// not silently ignored, until the engine supports them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Target {
    pub css: String,
}

/// What a video menu offers: the browser's own panel groups these.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VideoMenuKind {
    Quality,
    Captions,
    Audio,
    Other,
}

/// Whether a `dark` rule forces dark mode on or off for the pages it matches.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DarkFixMode {
    On,
    Off,
}

/// The method a `dark` rule asks dark mode to use for the pages it matches.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DarkFixMethod {
    Dynamic,
    Filter,
    Filterplus,
    Static,
}

/// How an entry of a site's menu shows that it is the one in use: an attribute that is set (and not
/// `false`) or a class it has. Exactly one of the two.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Selected {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attr: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub class: Option<String>,
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

/// When a `redirect` rule fires: the page's path matches the glob (see `route::RouteGlob`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RouteCondition {
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Rule {
    Hide {
        id: String,
        label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        option: Option<String>,
        /// For a rule on a choice option: the choices in which it applies.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        choice: Option<Vec<String>>,
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
        /// For a rule on a choice option: the choices in which it applies.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        choice: Option<Vec<String>>,
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
        /// For a rule on a choice option: the choices in which it applies.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        choice: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        on: Option<Vec<String>>,
        code: String,
    },
    /// An option list of the site's own player (quality, captions, audio) shown in the app's video
    /// controls. The app opens the site's menu by clicking `open` in order, reads the entries
    /// `items` matches (their text is the label), and picks one by clicking it. No code runs.
    VideoMenu {
        id: String,
        label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        option: Option<String>,
        /// For a rule on a choice option: the choices in which it applies.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        choice: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        on: Option<Vec<String>>,
        kind: VideoMenuKind,
        /// The group's name in the controls.
        title: String,
        /// Clicked in order to open the menu (the settings button, then the submenu); empty when the
        /// entries are always on the page.
        #[serde(default)]
        open: Vec<Target>,
        items: Target,
        selected: Selected,
        /// Clicked to close the menu again after a pick; none when picking an entry closes it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        close: Option<Target>,
    },
    /// Removes items from the JSON the page's own `fetch` and `XMLHttpRequest` calls receive,
    /// before the page reads it. A declarative rule, not code: it starts no request and sends
    /// nothing; see `prune`.
    Prune {
        id: String,
        label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        option: Option<String>,
        /// For a rule on a choice option: the choices in which it applies.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        choice: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        on: Option<Vec<String>>,
        /// Request paths on the page's own site (`*` matches any run of characters).
        urls: Vec<String>,
        remove: Vec<PruneRemove>,
    },
    /// Sends a page whose path matches `when.path` to the path `to` of the same site, on load and
    /// on every navigation the page makes without reloading. Nothing runs from the recipe; the
    /// app's own runtime does the replacing.
    Redirect {
        id: String,
        label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        option: Option<String>,
        /// For a rule on a choice option: the choices in which it applies.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        choice: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        on: Option<Vec<String>>,
        when: RouteCondition,
        to: String,
    },
    /// A fix for the app's dark mode on the pages the recipe matches: force it on or off, pick its
    /// method, and name the elements whose colours it flips (logos and icons drawn dark on
    /// transparent). Enums and validated selectors only; nothing runs.
    Dark {
        id: String,
        label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        option: Option<String>,
        /// For a rule on a choice option: the choices in which it applies.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        choice: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        on: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mode: Option<DarkFixMode>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        method: Option<DarkFixMethod>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        invert: Vec<String>,
    },
    /// Skips the segments the crowd-sourced SponsorBlock service lists for the video whose id is in
    /// the page's address, once each. Official recipes only: it asks a public service about the
    /// video (see `crowd.rs`). Nothing runs from the recipe.
    SponsorBlock {
        id: String,
        label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        option: Option<String>,
        /// For a rule on a choice option: the choices in which it applies.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        choice: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        on: Option<Vec<String>>,
        #[serde(rename = "videoId")]
        video_id: VideoId,
        categories: Vec<SegmentCategory>,
    },
    /// Writes the dislike count the Return YouTube Dislike service estimates for the video whose id
    /// is in the page's address into `target`, the site's dislike button. Official recipes only.
    DislikeCount {
        id: String,
        label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        option: Option<String>,
        /// For a rule on a choice option: the choices in which it applies.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        choice: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        on: Option<Vec<String>>,
        #[serde(rename = "videoId")]
        video_id: VideoId,
        target: Target,
    },
}

impl Rule {
    pub fn id(&self) -> &str {
        match self {
            Self::Hide { id, .. }
            | Self::Css { id, .. }
            | Self::Script { id, .. }
            | Self::VideoMenu { id, .. }
            | Self::Prune { id, .. }
            | Self::Redirect { id, .. }
            | Self::SponsorBlock { id, .. }
            | Self::DislikeCount { id, .. }
            | Self::Dark { id, .. } => id,
        }
    }

    /// The toggle this rule belongs to; a rule with none always applies.
    pub fn option(&self) -> Option<&str> {
        match self {
            Self::Hide { option, .. }
            | Self::Css { option, .. }
            | Self::Script { option, .. }
            | Self::VideoMenu { option, .. }
            | Self::Prune { option, .. }
            | Self::Redirect { option, .. }
            | Self::SponsorBlock { option, .. }
            | Self::DislikeCount { option, .. }
            | Self::Dark { option, .. } => option.as_deref(),
        }
    }

    /// The choices of its option in which this rule applies; `None` for a rule on a switch.
    pub fn choice(&self) -> Option<&[String]> {
        match self {
            Self::Hide { choice, .. }
            | Self::Css { choice, .. }
            | Self::Script { choice, .. }
            | Self::VideoMenu { choice, .. }
            | Self::Prune { choice, .. }
            | Self::Redirect { choice, .. }
            | Self::SponsorBlock { choice, .. }
            | Self::DislikeCount { choice, .. }
            | Self::Dark { choice, .. } => choice.as_deref(),
        }
    }

    /// The `match` patterns this rule is limited to; `None` means all of the recipe's.
    pub fn on(&self) -> Option<&[String]> {
        match self {
            Self::Hide { on, .. }
            | Self::Css { on, .. }
            | Self::Script { on, .. }
            | Self::VideoMenu { on, .. }
            | Self::Prune { on, .. }
            | Self::Redirect { on, .. }
            | Self::SponsorBlock { on, .. }
            | Self::DislikeCount { on, .. }
            | Self::Dark { on, .. } => on.as_deref(),
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

    /// Whether a rule applies, given the user's saved values for this recipe's options.
    pub fn rule_applies(&self, rule: &Rule, saved: Option<&BTreeMap<String, OptionValue>>) -> bool {
        let Some(option) = rule.option().and_then(|id| self.option(id)) else {
            return true;
        };
        match (
            option.current(saved.and_then(|saved| saved.get(&option.id))),
            rule.choice(),
        ) {
            (OptionValue::Toggle(on), None) => *on,
            (OptionValue::Choice(selected), Some(applies)) => applies.contains(selected),
            _ => false,
        }
    }

    pub(super) fn validate(&self) -> Result<()> {
        self.validate_with(false)
    }

    /// `official`: the recipe is one the maintainers ship (reviewed in a pull request), which may
    /// carry `videoMenu` rules; every other imported recipe may not, since they click the site's
    /// own controls.
    pub(super) fn validate_with(&self, official: bool) -> Result<()> {
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
        self.validate_video_menus()?;
        self.validate_prunes()?;
        self.validate_crowd_rules()?;
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
            self.validate_rule_choice(rule)?;
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
                Rule::VideoMenu {
                    id,
                    title,
                    open,
                    items,
                    selected,
                    close,
                    ..
                } => {
                    if self.origin == Origin::Imported && !official {
                        return Err(Error::Recipe(format!(
                            "video menu {id} clicks the site's own controls, which a shared recipe cannot"
                        )));
                    }
                    validate_video_menu(id, title, open, items, selected, close.as_ref())?;
                }
                Rule::Prune {
                    id, urls, remove, ..
                } => prune::validate(id, urls, remove)?,
                Rule::Redirect { id, when, to, .. } => validate_redirect(id, &when.path, to)?,
                Rule::SponsorBlock {
                    id,
                    video_id,
                    categories,
                    ..
                } => {
                    self.require_official(id, official)?;
                    crowd::validate_sponsor_block(id, video_id, categories)?;
                }
                Rule::DislikeCount {
                    id,
                    video_id,
                    target,
                    ..
                } => {
                    self.require_official(id, official)?;
                    crowd::validate_dislike_count(id, video_id, target)?;
                }
                Rule::Dark {
                    id,
                    mode,
                    method,
                    invert,
                    ..
                } => validate_dark(id, *mode, *method, invert)?,
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

    fn validate_video_menus(&self) -> Result<()> {
        let count = self
            .rules
            .iter()
            .filter(|rule| matches!(rule, Rule::VideoMenu { .. }))
            .count();
        if count > MAX_VIDEO_MENUS {
            return Err(Error::Recipe(format!(
                "recipe {} has too many video menus",
                self.id
            )));
        }
        Ok(())
    }

    fn validate_crowd_rules(&self) -> Result<()> {
        let count = self
            .rules
            .iter()
            .filter(|rule| matches!(rule, Rule::SponsorBlock { .. } | Rule::DislikeCount { .. }))
            .count();
        if count > crowd::MAX_CROWD_RULES {
            return Err(Error::Recipe(format!(
                "recipe {} has too many sponsor or dislike rules",
                self.id
            )));
        }
        Ok(())
    }

    /// The rules that ask a public service about the video leave the device, so only the
    /// maintainers' reviewed recipes may carry them.
    fn require_official(&self, id: &str, official: bool) -> Result<()> {
        if self.origin == Origin::Imported && !official {
            return Err(Error::Recipe(format!(
                "rule {id} asks a public service about the video, which a shared recipe cannot"
            )));
        }
        Ok(())
    }

    fn validate_prunes(&self) -> Result<()> {
        let count = self
            .rules
            .iter()
            .filter(|rule| matches!(rule, Rule::Prune { .. }))
            .count();
        if count > prune::MAX_PRUNE_RULES {
            return Err(Error::Recipe(format!(
                "recipe {} has too many prune rules",
                self.id
            )));
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

    /// A rule on a choice option names the choices it applies in, never the first (that state
    /// leaves the page alone); a rule on a switch or on no option names none.
    fn validate_rule_choice(&self, rule: &Rule) -> Result<()> {
        let invalid = |reason: &str| Error::Recipe(format!("rule {} {reason}", rule.id()));
        let option = rule.option().and_then(|id| self.option(id));
        match (option, rule.choice()) {
            (Some(option), Some(applies)) if option.is_choice() => {
                let mut seen = HashSet::new();
                let known = |id: &String| option.choices.iter().skip(1).any(|c| &c.id == id);
                if applies.is_empty() || !applies.iter().all(|id| known(id) && seen.insert(id)) {
                    return Err(invalid(
                        "must list choices of its option, not the first, each once",
                    ));
                }
                Ok(())
            }
            (Some(option), None) if option.is_choice() => {
                Err(invalid("needs a choice because its option is a choice"))
            }
            (_, Some(_)) => Err(invalid(
                "has a choice but its option is not a choice option",
            )),
            _ => Ok(()),
        }
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
            if !well_formed || !seen.insert(option.id.as_str()) || !option.has_valid_states() {
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

/// A redirect is a path glob and a path of the same site; being declarative it is as safe in a
/// shared recipe as a `hide` rule.
fn validate_redirect(id: &str, glob: &str, to: &str) -> Result<()> {
    let glob = RouteGlob::parse(glob).map_err(|e| Error::Recipe(format!("redirect {id}: {e}")))?;
    validate_target(to, &glob).map_err(|e| Error::Recipe(format!("redirect {id}: {e}")))
}

/// A dark rule says something (a mode, a method or elements to flip) and only through enums and
/// selectors, so nothing in it can run.
pub fn validate_dark(
    id: &str,
    mode: Option<DarkFixMode>,
    method: Option<DarkFixMethod>,
    invert: &[String],
) -> Result<()> {
    let refuse = |reason: &str| Error::Recipe(format!("dark rule {id} {reason}"));
    if mode.is_none() && method.is_none() && invert.is_empty() {
        return Err(refuse("sets nothing"));
    }
    if invert.len() > MAX_DARK_INVERT {
        return Err(refuse("lists too many elements to invert"));
    }
    for css in invert {
        validate_selector(css)?;
        if targets_page_root(css) {
            return Err(refuse("would invert the whole page"));
        }
    }
    Ok(())
}

/// A video menu is made of selectors and one way to read the entry in use; nothing in it can run.
pub fn validate_video_menu(
    id: &str,
    title: &str,
    open: &[Target],
    items: &Target,
    selected: &Selected,
    close: Option<&Target>,
) -> Result<()> {
    let refuse = |reason: &str| Error::Recipe(format!("video menu {id} {reason}"));
    let title = title.trim();
    if title.is_empty()
        || title.chars().count() > MAX_MENU_TITLE_CHARS
        || title.chars().any(char::is_control)
    {
        return Err(refuse("needs a short plain title"));
    }
    if open.len() > MAX_MENU_STEPS {
        return Err(refuse("opens through too many steps"));
    }
    for target in open.iter().chain(std::iter::once(items)).chain(close) {
        validate_selector(&target.css)?;
        if targets_page_root(&target.css) {
            return Err(refuse("would act on the whole page"));
        }
    }
    match (&selected.attr, &selected.class) {
        (Some(attr), None) if MENU_SELECTED_ATTRS.contains(&attr.as_str()) => Ok(()),
        (None, Some(class))
            if !class.is_empty()
                && class.chars().count() <= 40
                && class
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') =>
        {
            Ok(())
        }
        _ => Err(refuse(
            "must say which entry is in use by one known attribute or one plain class name",
        )),
    }
}
