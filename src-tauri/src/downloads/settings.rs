//! The user's download choices: the folder, the naming mask, the speed, and the rules that rename
//! and route files.

use std::path::Path;

use regex::RegexBuilder;
use serde::{Deserialize, Serialize};
use url::Url;
use uuid::Uuid;

use super::kind::Kind;
use super::naming::{sanitize_component, validate_mask};
use crate::error::{Error, Result};

pub const MAX_RULES: usize = 50;
pub const MAX_SEGMENTS: u8 = 8;
const MAX_RULE_NAME_CHARS: usize = 60;
const MAX_REGEX_CHARS: usize = 200;
const REGEX_SIZE_LIMIT: usize = 100_000;

pub const DEFAULT_MASK: &str = "{filename}";

/// One rule: the first enabled rule whose conditions all hold decides the mask and the folder.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rule {
    pub id: Uuid,
    pub name: String,
    pub enabled: bool,
    /// The site, matched as itself or a parent domain (`example.com` matches `cdn.example.com`).
    #[serde(default)]
    pub host: Option<String>,
    /// Empty means any kind.
    #[serde(default)]
    pub kinds: Vec<Kind>,
    /// A regular expression the whole address must contain a match for.
    #[serde(default)]
    pub regex: Option<String>,
    #[serde(default)]
    pub mask: Option<String>,
    /// Subfolder of the download folder; the naming tokens work here too.
    #[serde(default)]
    pub folder: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    /// Whether the downloads button is on the floating button's fan.
    pub button: bool,
    pub mask: String,
    /// How many connections one large file uses, 1 to 8.
    pub segments: u8,
    /// Where files go; the device's downloads folder while unset.
    #[serde(default)]
    pub folder: Option<String>,
    #[serde(default)]
    pub rules: Vec<Rule>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            button: true,
            mask: DEFAULT_MASK.to_owned(),
            segments: 4,
            folder: None,
            rules: Vec::new(),
        }
    }
}

/// What a rule decided for one file.
#[derive(Debug, PartialEq, Eq)]
pub struct Routing<'a> {
    pub mask: &'a str,
    pub folder: Option<&'a str>,
}

fn host_matches(rule_host: &str, host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    host == rule_host
        || host
            .strip_suffix(rule_host)
            .is_some_and(|rest| rest.ends_with('.'))
}

fn matches(rule: &Rule, url: &Url, kind: Kind) -> bool {
    let host_ok = rule
        .host
        .as_deref()
        .is_none_or(|host| url.host_str().is_some_and(|h| host_matches(host, h)));
    let kind_ok = rule.kinds.is_empty() || rule.kinds.contains(&kind);
    let regex_ok = rule.regex.as_deref().is_none_or(|pattern| {
        RegexBuilder::new(pattern)
            .size_limit(REGEX_SIZE_LIMIT)
            .build()
            .is_ok_and(|regex| regex.is_match(url.as_str()))
    });
    host_ok && kind_ok && regex_ok
}

impl Settings {
    /// The mask and folder for a file: the first matching rule's, with the general mask where the
    /// rule has none.
    pub fn route(&self, url: &Url, kind: Kind) -> Routing<'_> {
        let rule = self
            .rules
            .iter()
            .find(|rule| rule.enabled && matches(rule, url, kind));
        Routing {
            mask: rule
                .and_then(|r| r.mask.as_deref())
                .filter(|m| !m.is_empty())
                .unwrap_or(&self.mask),
            folder: rule
                .and_then(|r| r.folder.as_deref())
                .filter(|f| !f.is_empty()),
        }
    }

    /// Checks everything the user typed and returns the settings cleaned up.
    pub fn validated(mut self) -> Result<Self> {
        validate_mask(&self.mask)?;
        if self.mask.trim().is_empty() {
            self.mask = DEFAULT_MASK.to_owned();
        }
        if !(1..=MAX_SEGMENTS).contains(&self.segments) {
            return Err(Error::Download(format!(
                "connections per file must be 1 to {MAX_SEGMENTS}"
            )));
        }
        self.folder = self
            .folder
            .map(|folder| folder.trim().to_owned())
            .filter(|folder| !folder.is_empty());
        if let Some(folder) = &self.folder
            && !Path::new(folder).is_absolute()
        {
            return Err(Error::Download(
                "the download folder must be a full path".to_owned(),
            ));
        }
        if self.rules.len() > MAX_RULES {
            return Err(Error::Download(format!(
                "at most {MAX_RULES} rules are allowed"
            )));
        }
        self.rules = self
            .rules
            .into_iter()
            .map(validated_rule)
            .collect::<Result<_>>()?;
        Ok(self)
    }
}

fn validated_rule(mut rule: Rule) -> Result<Rule> {
    rule.name = rule.name.trim().chars().take(MAX_RULE_NAME_CHARS).collect();
    rule.host = rule
        .host
        .map(|host| host.trim().trim_start_matches('.').to_ascii_lowercase())
        .filter(|host| !host.is_empty());
    if let Some(host) = &rule.host
        && !host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    {
        return Err(Error::Download(
            "a rule's site must be a domain name".to_owned(),
        ));
    }
    rule.regex = rule.regex.filter(|pattern| !pattern.is_empty());
    if let Some(pattern) = &rule.regex {
        if pattern.chars().count() > MAX_REGEX_CHARS {
            return Err(Error::Download("a rule's pattern is too long".to_owned()));
        }
        RegexBuilder::new(pattern)
            .size_limit(REGEX_SIZE_LIMIT)
            .build()
            .map_err(|_| {
                Error::Download("a rule's pattern is not a valid expression".to_owned())
            })?;
    }
    if let Some(mask) = &rule.mask {
        validate_mask(mask)?;
    }
    if let Some(folder) = &rule.folder {
        validate_mask(folder)?;
        let cleaned: Vec<String> = folder
            .split('/')
            .map(|piece| {
                if piece.contains('{') {
                    piece.to_owned()
                } else {
                    sanitize_component(piece)
                }
            })
            .filter(|piece| !piece.is_empty())
            .collect();
        rule.folder = Some(cleaned.join("/")).filter(|f| !f.is_empty());
    }
    Ok(rule)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(f: impl FnOnce(&mut Rule)) -> Rule {
        let mut rule = Rule {
            id: Uuid::nil(),
            name: "r".to_owned(),
            enabled: true,
            host: None,
            kinds: Vec::new(),
            regex: None,
            mask: None,
            folder: None,
        };
        f(&mut rule);
        rule
    }

    fn url(text: &str) -> Url {
        Url::parse(text).unwrap()
    }

    #[test]
    fn the_first_matching_enabled_rule_routes() {
        let settings = Settings {
            rules: vec![
                rule(|r| {
                    r.enabled = false;
                    r.folder = Some("Off".into());
                }),
                rule(|r| {
                    r.host = Some("example.com".into());
                    r.kinds = vec![Kind::Audio];
                    r.folder = Some("Music".into());
                    r.mask = Some("{n:2} {title}".into());
                }),
            ],
            ..Settings::default()
        };
        let hit = settings.route(&url("https://cdn.example.com/a.mp3"), Kind::Audio);
        assert_eq!(
            hit,
            Routing {
                mask: "{n:2} {title}",
                folder: Some("Music")
            }
        );
        let miss = settings.route(&url("https://notexample.com/a.mp3"), Kind::Audio);
        assert_eq!(
            miss,
            Routing {
                mask: DEFAULT_MASK,
                folder: None
            }
        );
        let other_kind = settings.route(&url("https://example.com/a.jpg"), Kind::Image);
        assert_eq!(other_kind.folder, None);
    }

    #[test]
    fn a_rule_can_match_the_address_by_expression() {
        let settings = Settings {
            rules: vec![rule(|r| {
                r.regex = Some(r"\.(png|jpg)\?size=large".into());
                r.folder = Some("Big".into());
            })],
            ..Settings::default()
        };
        assert_eq!(
            settings
                .route(&url("https://a/x.png?size=large"), Kind::Image)
                .folder,
            Some("Big")
        );
        assert_eq!(
            settings
                .route(&url("https://a/x.png?size=small"), Kind::Image)
                .folder,
            None
        );
    }

    #[test]
    fn bad_settings_are_refused() {
        let bad_mask = Settings {
            mask: "{wat}".into(),
            ..Settings::default()
        };
        assert!(bad_mask.validated().is_err());
        let relative = Settings {
            folder: Some("rel/path".into()),
            ..Settings::default()
        };
        assert!(relative.validated().is_err());
        let segments = Settings {
            segments: 9,
            ..Settings::default()
        };
        assert!(segments.validated().is_err());
        let regex = Settings {
            rules: vec![rule(|r| r.regex = Some("(".into()))],
            ..Settings::default()
        };
        assert!(regex.validated().is_err());
        let host = Settings {
            rules: vec![rule(|r| r.host = Some("a b".into()))],
            ..Settings::default()
        };
        assert!(host.validated().is_err());
    }

    #[test]
    fn a_rule_folder_is_made_safe() {
        let settings = Settings {
            rules: vec![rule(|r| r.folder = Some("../Music/../{site}".into()))],
            ..Settings::default()
        };
        let cleaned = settings.validated().unwrap();
        assert_eq!(cleaned.rules[0].folder.as_deref(), Some("Music/{site}"));
    }
}
