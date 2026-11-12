//! The recipes that ship inside the app: the maintainers' official ones (`recipes/official/`) and
//! the community ones that were reviewed and merged (`recipes/community/`). `build.rs` embeds the
//! files; each is parsed once, as an imported recipe, so a script in it passes the same policy as
//! one from a file. Nothing here touches the network or the disk at run time.

use std::{collections::HashSet, sync::OnceLock};

use serde::Serialize;

use super::Recipe;
use super::share::{self, MARKET_PREFIX, Source};
use crate::error::{Error, Result};

include!(concat!(env!("OUT_DIR"), "/bundled_recipes.rs"));

/// Official ids are `market.official.<site>`, and only a file in `recipes/official` may have one.
pub const OFFICIAL_ID_PREFIX: &str = "market.official.";
pub const TAG_OFFICIAL: &str = "official";
pub const TAG_COMMUNITY: &str = "community";
pub const TAG_HUB: &str = "hub";

const MAX_SEARCH_RESULTS: usize = 8;
const MAX_HOSTS: usize = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    Official,
    Community,
}

impl Channel {
    fn directory(self) -> &'static str {
        match self {
            Self::Official => "official",
            Self::Community => "community",
        }
    }

    fn id_prefix(self) -> &'static str {
        match self {
            Self::Official => OFFICIAL_ID_PREFIX,
            Self::Community => MARKET_PREFIX,
        }
    }

    pub fn tag(self) -> &'static str {
        match self {
            Self::Official => TAG_OFFICIAL,
            Self::Community => TAG_COMMUNITY,
        }
    }
}

/// One embedded file: the directory it came from, its file name and its text.
pub struct File {
    pub channel: Channel,
    pub name: &'static str,
    pub text: &'static str,
}

#[derive(Debug, Clone)]
pub struct Bundled {
    pub recipe: Recipe,
    pub channel: Channel,
}

impl Bundled {
    pub fn is_official(&self) -> bool {
        self.channel == Channel::Official
    }

    pub fn summary(&self) -> &str {
        self.recipe
            .meta
            .as_ref()
            .and_then(|meta| meta.summary.as_deref())
            .unwrap_or_default()
    }

    /// Platform tags, then `official` or `community`, then `hub` for a recipe with launcher tabs.
    pub fn tags(&self) -> Vec<String> {
        let mut tags = self.recipe.tags.clone();
        tags.push(self.channel.tag().to_owned());
        if self.recipe.hub.is_some() {
            tags.push(TAG_HUB.to_owned());
        }
        tags
    }

    pub fn has_tag(&self, tag: &str) -> bool {
        self.recipe.tags.iter().any(|own| own == tag)
    }

    pub fn hosts(&self) -> Vec<String> {
        hosts_of(&self.recipe.matches)
    }
}

/// A bounded result handed to the assistant's hub builder.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub id: String,
    pub name: String,
    pub summary: String,
    pub hosts: Vec<String>,
    pub hub: bool,
}

/// Every bundled recipe that parses. One that does not is skipped rather than stopping the app;
/// the test over all of them is what keeps that from happening.
pub fn all() -> &'static [Bundled] {
    static ALL: OnceLock<Vec<Bundled>> = OnceLock::new();
    ALL.get_or_init(|| {
        parse_all(FILES)
            .into_iter()
            .filter_map(Result::ok)
            .collect()
    })
}

pub fn find(id: &str) -> Option<&'static Bundled> {
    all().iter().find(|bundled| bundled.recipe.id == id)
}

/// Searches name, summary, hosts and id, case-insensitively. At most eight results.
pub fn search(query: &str) -> Vec<SearchHit> {
    let query = query.trim().to_lowercase();
    all()
        .iter()
        .filter(|bundled| {
            let recipe = &bundled.recipe;
            recipe.name.to_lowercase().contains(&query)
                || bundled.summary().to_lowercase().contains(&query)
                || recipe.id.to_lowercase().contains(&query)
                || bundled
                    .hosts()
                    .iter()
                    .any(|host| host.to_lowercase().contains(&query))
        })
        .take(MAX_SEARCH_RESULTS)
        .map(|bundled| SearchHit {
            id: bundled.recipe.id.clone(),
            name: bundled.recipe.name.clone(),
            summary: bundled.summary().to_owned(),
            hosts: bundled.hosts(),
            hub: bundled.recipe.hub.is_some(),
        })
        .collect()
}

/// The sites a recipe covers, from its match patterns: the host without a leading `*.`, once
/// each, at most ten.
pub fn hosts_of(patterns: &[String]) -> Vec<String> {
    let mut hosts: Vec<String> = Vec::new();
    for pattern in patterns {
        let rest = pattern
            .split_once("://")
            .map_or(pattern.as_str(), |(_, rest)| rest);
        let host = rest.split('/').next().unwrap_or_default().to_lowercase();
        let host = host.strip_prefix("*.").unwrap_or(&host);
        if host.is_empty() || host == "*" || hosts.iter().any(|known| known == host) {
            continue;
        }
        hosts.push(host.to_owned());
        if hosts.len() == MAX_HOSTS {
            break;
        }
    }
    hosts
}

/// Parses every file, one result each, in the order given. A duplicate id is refused.
pub fn parse_all(files: &[File]) -> Vec<Result<Bundled>> {
    let mut seen = HashSet::new();
    files
        .iter()
        .map(|file| {
            let bundled = parse_one(file)?;
            if seen.insert(bundled.recipe.id.clone()) {
                Ok(bundled)
            } else {
                Err(problem(file, "its id is already used by another recipe"))
            }
        })
        .collect()
}

fn parse_one(file: &File) -> Result<Bundled> {
    let recipe = share::parse_shared(file.text.as_bytes(), Source::Bundled)
        .map_err(|error| problem(file, &error.to_string()))?;
    let official_id = recipe.id.starts_with(OFFICIAL_ID_PREFIX);
    if official_id != (file.channel == Channel::Official) {
        return Err(problem(
            file,
            "only a recipe in recipes/official has a market.official. id",
        ));
    }
    let expected = recipe
        .id
        .strip_prefix(file.channel.id_prefix())
        .map(|rest| format!("{rest}.json"));
    if expected.as_deref() != Some(file.name) {
        return Err(problem(file, "the file is not named after the recipe id"));
    }
    Ok(Bundled {
        recipe,
        channel: file.channel,
    })
}

fn problem(file: &File, message: &str) -> Error {
    Error::Recipe(format!(
        "recipes/{}/{}: {message}",
        file.channel.directory(),
        file.name
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::recipes::Rule;

    /// Whether the recipe has any script rule, for the reviewer-facing checks in tests.
    fn has_script(recipe: &Recipe) -> bool {
        recipe
            .rules
            .iter()
            .any(|rule| matches!(rule, Rule::Script { .. }))
    }

    fn recipe_text(id: &str, extra_rule: &str) -> String {
        format!(
            r#"{{"schema":1,"id":"{id}","name":"Calm","version":"1.0.0","origin":"user","tags":["mobile"],
            "match":["https://*.example.com/*"],
            "options":[{{"id":"o","label":"Hide shelf","description":"d","group":"content","default":false}}],
            "rules":[{{"id":"r","label":"l","type":"hide","target":{{"css":".x"}},"option":"o"}}{extra_rule}],
            "meta":{{"summary":"Hides the shelf."}}}}"#
        )
    }

    fn file(channel: Channel, name: &'static str, text: String) -> File {
        File {
            channel,
            name,
            text: Box::leak(text.into_boxed_str()),
        }
    }

    fn outcomes(files: &[File]) -> Vec<bool> {
        parse_all(files).iter().map(Result::is_ok).collect()
    }

    #[test]
    fn every_bundled_file_parses_and_follows_the_naming_rules() {
        let results = parse_all(FILES);
        assert!(!results.is_empty());
        for result in &results {
            if let Err(error) = result {
                panic!("{error}");
            }
        }
        assert_eq!(all().len(), FILES.len());
    }

    #[test]
    fn every_bundled_recipe_has_a_summary_and_the_official_ones_a_homepage() {
        for bundled in all() {
            assert!(
                !bundled.summary().is_empty(),
                "{} has no summary",
                bundled.recipe.id
            );
            if bundled.is_official() {
                assert!(bundled.recipe.homepage().is_some(), "{}", bundled.recipe.id);
            }
        }
    }

    #[test]
    fn the_official_files_are_all_there() {
        assert!(
            all()
                .iter()
                .any(|bundled| bundled.recipe.id == "market.official.youtube")
        );
        assert!(find("market.official.messages-hub").is_some_and(|b| b.recipe.hub.is_some()));
        assert!(find("market.official.nothing").is_none());
    }

    #[test]
    fn only_the_official_directory_may_use_an_official_id() {
        let files = [
            file(
                Channel::Official,
                "calm.json",
                recipe_text("market.official.calm", ""),
            ),
            file(
                Channel::Community,
                "official.calm.json",
                recipe_text("market.official.calm", ""),
            ),
            file(
                Channel::Official,
                "calm.json",
                recipe_text("market.calm", ""),
            ),
        ];
        assert_eq!(outcomes(&files[..1]), [true]);
        assert_eq!(outcomes(&files[1..2]), [false]);
        assert_eq!(outcomes(&files[2..]), [false]);
    }

    #[test]
    fn a_file_is_named_after_its_id_and_ids_are_market_ids() {
        let files = [
            file(
                Channel::Community,
                "calm.json",
                recipe_text("market.calm", ""),
            ),
            file(
                Channel::Community,
                "other.json",
                recipe_text("market.calm", ""),
            ),
            file(
                Channel::Community,
                "calm.json",
                recipe_text("custom.calm", ""),
            ),
            file(Channel::Community, "calm.json", recipe_text("calm", "")),
        ];
        assert_eq!(outcomes(&files[..1]), [true]);
        assert_eq!(outcomes(&files[1..2]), [false]);
        assert_eq!(outcomes(&files[2..3]), [false]);
        assert_eq!(outcomes(&files[3..]), [false]);
    }

    #[test]
    fn a_duplicate_id_is_refused() {
        let files = [
            file(
                Channel::Community,
                "calm.json",
                recipe_text("market.calm", ""),
            ),
            file(
                Channel::Community,
                "calm.json",
                recipe_text("market.calm", ""),
            ),
        ];
        assert_eq!(outcomes(&files), [true, false]);
    }

    #[test]
    fn a_script_that_breaks_the_policy_is_refused_and_one_inside_it_is_not() {
        let script = |code: &str| {
            format!(
                r#",{{"id":"s","label":"Tidy","type":"script","code":{}}}"#,
                serde_json::to_string(code).unwrap()
            )
        };
        let files = [
            file(
                Channel::Community,
                "calm.json",
                recipe_text("market.calm", &script("fetch('/x')")),
            ),
            file(
                Channel::Community,
                "tidy.json",
                recipe_text(
                    "market.tidy",
                    &script("for (const e of document.querySelectorAll('.x')) e.hidden = true;"),
                ),
            ),
        ];
        let results = parse_all(&files);
        assert!(results[0].is_err());
        match &results[1] {
            Ok(bundled) => assert!(has_script(&bundled.recipe)),
            Err(error) => panic!("{error}"),
        }
    }

    #[test]
    fn tags_are_the_platforms_then_the_channel_then_hub() {
        let official = find("market.official.youtube").unwrap();
        assert_eq!(official.tags().last().map(String::as_str), Some("official"));
        let hub = find("market.official.messages-hub").unwrap();
        let tags = hub.tags();
        assert_eq!(tags[tags.len() - 2..], ["official", "hub"]);
        assert!(!official.tags().contains(&"hub".to_owned()));
    }

    #[test]
    fn hosts_come_from_the_match_patterns() {
        let patterns = [
            "https://*.example.com/*".to_owned(),
            "https://example.com/a/*".to_owned(),
            "https://m.Example.org/*".to_owned(),
            "*://*/*".to_owned(),
        ];
        assert_eq!(hosts_of(&patterns), ["example.com", "m.example.org"]);
    }

    #[test]
    fn search_matches_name_host_and_summary_and_is_capped() {
        let ids: Vec<_> = search("YOUTUBE").into_iter().map(|hit| hit.id).collect();
        assert!(ids.contains(&"market.official.youtube".to_owned()));
        let by_host: Vec<_> = search("youtube.com")
            .into_iter()
            .map(|hit| hit.id)
            .collect();
        assert!(by_host.contains(&"market.official.youtube".to_owned()));
        assert!(search("").len() <= MAX_SEARCH_RESULTS);
        assert!(search("no such recipe anywhere").is_empty());
        assert!(search("tabs").iter().any(|hit| hit.hub));
    }
}
