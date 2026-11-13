//! Ad and tracker blocking from bundled filter lists.
//!
//! Network and CSS rules are converted to WebKit content-rule lists. A separate cached Brave
//! engine returns URL-matched scriptlets for the native plugin to inject at document start.
//! Neither path downloads filter data at runtime.

use std::{
    borrow::Cow,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use adblock::{
    Engine,
    content_blocking::CbRule,
    lists::{FilterSet, ParseOptions},
    resources::Resource,
};
use sha2::{Digest, Sha256};
use tauri_plugin_siteview::ContentRuleList;

use crate::error::{Error, Result};
use crate::library::write_atomically;

/// WebKit refuses to compile a list with more rules than this.
const MAX_RULES_PER_LIST: usize = 150_000;

/// Part of every list id. Bump it when the `adblock` crate is upgraded, so lists the old converter
/// produced are rebuilt instead of reused from WebKit's store.
const CONVERTER_REVISION: &str = "adblock-0.13.5";

/// One list per file keeps each far below WebKit's limit and lets a list change independently.
#[cfg(target_os = "ios")]
const BUNDLED: [(&str, &str); 4] = [
    ("easylist", include_str!("../../blocklists/easylist.txt")),
    (
        "easyprivacy",
        include_str!("../../blocklists/easyprivacy.txt"),
    ),
    (
        "brave-specific",
        include_str!("../../blocklists/brave-specific.txt"),
    ),
    (
        "brave-ios-specific",
        include_str!("../../blocklists/brave-ios-specific.txt"),
    ),
];

#[cfg(not(target_os = "ios"))]
const BUNDLED: [(&str, &str); 3] = [
    ("easylist", include_str!("../../blocklists/easylist.txt")),
    (
        "easyprivacy",
        include_str!("../../blocklists/easyprivacy.txt"),
    ),
    (
        "brave-specific",
        include_str!("../../blocklists/brave-specific.txt"),
    ),
];

struct Source {
    id: String,
    text: Cow<'static, str>,
}

impl Source {
    fn new(name: &str, text: Cow<'static, str>) -> Self {
        let mut hasher = Sha256::new();
        hasher.update(CONVERTER_REVISION.as_bytes());
        hasher.update([0]);
        hasher.update(text.as_bytes());
        // The first 8 bytes, as 16 lowercase hex characters. sha2 0.11 digests no longer implement `LowerHex`.
        let short: String = hasher
            .finalize()
            .iter()
            .take(8)
            .map(|b| format!("{b:02x}"))
            .collect();
        Self {
            id: format!("openmedia-{name}-{short}"),
            text,
        }
    }
}

struct Inner {
    dir: PathBuf,
    sources: Vec<Source>,
    /// One conversion at a time: the launch-time warm-up and the first `open_site` can overlap.
    conversion: Mutex<()>,
    /// Built once on the first scriptlet query and reused for every starting URL.
    scriptlet_engine: Mutex<Option<Engine>>,
}

/// The bundled blocklists and the directory their converted JSON is cached in. Cheap to clone.
#[derive(Clone)]
pub struct AdBlock(Arc<Inner>);

impl AdBlock {
    pub fn bundled(dir: PathBuf) -> Self {
        let sources = BUNDLED
            .iter()
            .map(|(name, text)| Source::new(name, Cow::Borrowed(*text)))
            .collect();
        Self(Arc::new(Inner {
            dir,
            sources,
            conversion: Mutex::new(()),
            scriptlet_engine: Mutex::new(None),
        }))
    }

    /// The lists for the native side, converting any whose JSON is not on disk yet. A list's id
    /// changes with its content, so a file that exists is current and is never rewritten.
    pub fn rule_lists(&self) -> Result<Vec<ContentRuleList>> {
        let inner = &self.0;
        let _one_at_a_time = inner
            .conversion
            .lock()
            .map_err(|_| Error::AdBlock("a conversion panicked".into()))?;
        fs::create_dir_all(&inner.dir)?;
        let mut lists = Vec::with_capacity(inner.sources.len());
        for source in &inner.sources {
            let path = inner.dir.join(format!("{}.json", source.id));
            if !path.exists() {
                write_atomically(&path, content_rules_json(&source.text)?.as_bytes())?;
            }
            lists.push(ContentRuleList {
                id: source.id.clone(),
                path: path
                    .to_str()
                    .ok_or_else(|| Error::AdBlock("the cache path is not valid UTF-8".into()))?
                    .to_owned(),
            });
        }
        self.remove_stale_files()?;
        Ok(lists)
    }
    /// Scriptlet code matched to the page's opening URL. Native integration owns activation and timing.
    pub fn scriptlets_for_url(&self, url: &str) -> Result<String> {
        let page_url = url::Url::parse(url)
            .map_err(|error| Error::AdBlock(format!("invalid scriptlet URL: {error}")))?;
        let mut cached = self
            .0
            .scriptlet_engine
            .lock()
            .map_err(|_| Error::AdBlock("the scriptlet engine panicked".into()))?;
        if cached.is_none() {
            *cached = Some(scriptlet_engine()?);
        }
        let engine = cached
            .as_ref()
            .ok_or_else(|| Error::AdBlock("the scriptlet engine is unavailable".into()))?;
        let script = engine
            .url_cosmetic_resources(page_url.as_str())
            .injected_script;
        if script.is_empty() {
            return Ok(script);
        }
        let origin = serde_json::to_string(&page_url.origin().ascii_serialization())
            .map_err(|error| Error::AdBlock(format!("invalid scriptlet origin: {error}")))?;
        Ok(format!(
            "(function(){{if(window.top!==window||location.origin!=={origin})return;{script}}})();"
        ))
    }

    fn remove_stale_files(&self) -> Result<()> {
        for entry in fs::read_dir(&self.0.dir)? {
            let path = entry?.path();
            if is_cache_file(&path) && !self.is_current(&path) {
                fs::remove_file(path)?;
            }
        }
        Ok(())
    }

    fn is_current(&self, path: &Path) -> bool {
        path.file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|name| {
                self.0
                    .sources
                    .iter()
                    .any(|s| name == format!("{}.json", s.id))
            })
    }
}
fn scriptlet_engine() -> Result<Engine> {
    let mut filters = FilterSet::new(false);
    for (_, text) in BUNDLED {
        filters.add_filter_list(text.to_owned(), ParseOptions::default());
    }
    let resources: Vec<Resource> =
        serde_json::from_str(include_str!("../../blocklists/brave-resources.json"))
            .map_err(|error| Error::AdBlock(format!("invalid Brave resource bundle: {error}")))?;
    let mut engine = Engine::new_with_filter_set(filters);
    engine.use_resources(resources);
    Ok(engine)
}

fn is_cache_file(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    name.starts_with("openmedia-") && (name.ends_with(".json") || name.ends_with(".tmp"))
}

/// Converts an ABP-syntax list to WebKit's content-blocking JSON. Network rules become `block`
/// and exceptions; element-hiding rules become `css-display-none`. Rules WebKit cannot express
/// (scriptlets, procedural cosmetics, `$redirect`) are dropped by the converter.
fn content_rules_json(list_text: &str) -> Result<String> {
    let mut set = FilterSet::new(true);
    set.add_filter_list(list_text.to_owned(), ParseOptions::default());
    let (mut rules, _converted) = set
        .into_content_blocking()
        .map_err(|()| Error::AdBlock("the filter list could not be converted".into()))?;
    if rules.is_empty() || rules.len() > MAX_RULES_PER_LIST {
        return Err(Error::AdBlock(format!(
            "a filter list produced {} rules; WebKit accepts 1 to {MAX_RULES_PER_LIST}",
            rules.len()
        )));
    }
    include_subdomains(&mut rules);
    serde_json::to_string(&rules).map_err(|e| Error::AdBlock(e.to_string()))
}

/// ABP's `example.org##.ad` applies on `www.example.org` too, but WebKit matches a bare domain
/// exactly and needs a `*` prefix to include subdomains. The converter adds the prefix for
/// `$domain=` options and not for element-hiding rules, which would leave most of them inert on
/// `www.` hosts.
fn include_subdomains(rules: &mut [CbRule]) {
    for trigger in rules.iter_mut().map(|rule| &mut rule.trigger) {
        let domains = [trigger.if_domain.as_mut(), trigger.unless_domain.as_mut()];
        for domain in domains.into_iter().flatten().flatten() {
            if !domain.starts_with('*') {
                domain.insert(0, '*');
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::Value;
    use tauri_plugin_siteview::validate::validate_rule_lists;

    use super::*;

    fn rules(list: &str) -> Vec<Value> {
        let json = content_rules_json(list).expect("list converts");
        serde_json::from_str(&json).expect("output is a JSON array")
    }

    fn of_type<'a>(rules: &'a [Value], kind: &str) -> Vec<&'a Value> {
        rules
            .iter()
            .filter(|r| r["action"]["type"] == kind)
            .collect()
    }

    #[test]
    fn network_rules_exceptions_and_element_hides_become_webkit_rules() {
        let converted = rules(
            "||ads.example.com^\n\
             @@||ads.example.com/allowed^\n\
             example.org##.sponsored\n",
        );

        let blocks = of_type(&converted, "block");
        assert!(
            blocks.iter().any(|r| r["trigger"]["url-filter"]
                .as_str()
                .is_some_and(|f| f.contains("ads"))),
            "{blocks:?}"
        );
        assert!(!of_type(&converted, "ignore-previous-rules").is_empty());

        let hides = of_type(&converted, "css-display-none");
        assert_eq!(hides.len(), 1);
        assert_eq!(hides[0]["action"]["selector"], ".sponsored");
        assert_eq!(hides[0]["trigger"]["if-domain"][0], "*example.org");
    }

    #[test]
    fn every_domain_condition_includes_subdomains() {
        let converted = rules(
            "example.org,example.net##.ad\n\
             ##.banner\n\
             example.org#@#.banner\n\
             ||tracker.example.com^$domain=example.org\n",
        );
        let conditions: Vec<&str> = converted
            .iter()
            .flat_map(|r| ["if-domain", "unless-domain"].map(|key| &r["trigger"][key]))
            .filter_map(Value::as_array)
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        assert_eq!(conditions.len(), 4, "{conditions:?}");
        assert!(
            conditions.iter().all(|d| d.starts_with('*')),
            "{conditions:?}"
        );
    }

    #[test]
    fn an_exception_comes_after_the_block_it_overrides() {
        let converted = rules("||ads.example.com^\n@@||ads.example.com/allowed^\n");
        let position = |kind: &str| converted.iter().position(|r| r["action"]["type"] == kind);
        assert!(position("block") < position("ignore-previous-rules"));
    }

    #[test]
    fn a_list_with_no_usable_rules_is_an_error_not_an_empty_file() {
        assert!(matches!(
            content_rules_json("! only a comment\n"),
            Err(Error::AdBlock(_))
        ));
    }

    #[test]
    fn every_bundled_list_converts_within_webkits_rule_limit() {
        for (name, text) in BUNDLED {
            let count = rules(text).len();
            let minimum = if name.starts_with("brave") { 1 } else { 1_000 };
            assert!(
                (minimum..=MAX_RULES_PER_LIST).contains(&count),
                "{name} produced {count} rules"
            );
        }
    }

    #[test]
    fn brave_ios_specific_rules_convert() {
        let text = include_str!("../../blocklists/brave-ios-specific.txt");
        let converted = rules(text);
        assert!(
            converted.len() > 1_000,
            "only {} rules converted",
            converted.len()
        );
        assert!(
            converted.iter().any(|rule| {
                rule["trigger"]["url-filter"]
                    .as_str()
                    .is_some_and(|pattern| pattern.contains("googlevideo"))
            }),
            "Brave iOS YouTube fallback was not converted"
        );
    }

    #[cfg(target_os = "ios")]
    #[test]
    fn ios_uses_braves_youtube_fallback_rules() {
        let ios_rules = BUNDLED
            .iter()
            .find(|(name, _)| *name == "brave-ios-specific")
            .map(|(_, text)| *text)
            .expect("Brave iOS Specific is bundled");
        assert!(ios_rules.contains(
            "||googlevideo.com/videoplayback*ctier=L&*%2Cxpc%2Cctier%2C$domain=m.youtube.com|music.youtube.com"
        ));
        assert!(rules(ios_rules).len() > 1_000);
    }

    #[test]
    fn brave_youtube_scriptlets_match_only_youtube_pages() {
        let dir = tempfile::tempdir().expect("tempdir");
        let ad_block = AdBlock::bundled(dir.path().to_owned());
        let brave_rules = BUNDLED
            .iter()
            .find(|(name, _)| *name == "brave-specific")
            .map(|(_, text)| *text)
            .expect("Brave Specific is bundled");
        assert!(brave_rules.contains("youtube.*##+js(brave-youtube-theater-fix)"));

        let youtube = ad_block
            .scriptlets_for_url("https://www.youtube.com/watch?v=test")
            .expect("scriptlets are available");
        let other_site = ad_block
            .scriptlets_for_url("https://example.org/")
            .expect("scriptlets are available");
        assert!(youtube.contains("window.top!==window"));
        assert!(youtube.contains("location.origin!==\"https://www.youtube.com\""));
        assert!(!youtube.is_empty());
        assert!(other_site.is_empty());
    }

    fn ad_block_with(dir: &Path, text: &'static str) -> AdBlock {
        AdBlock(Arc::new(Inner {
            dir: dir.to_owned(),
            sources: vec![Source::new("test", Cow::Borrowed(text))],
            conversion: Mutex::new(()),
            scriptlet_engine: Mutex::new(None),
        }))
    }

    #[test]
    fn json_is_written_once_per_list_version() {
        let dir = tempfile::tempdir().expect("tempdir");
        let ad_block = ad_block_with(dir.path(), "||ads.example.com^\n");

        let first = ad_block.rule_lists().expect("first run converts");
        assert_eq!(first.len(), 1);
        validate_rule_lists(&first).expect("the native side accepts what Rust produces");
        let file = PathBuf::from(&first[0].path);
        assert!(file.starts_with(dir.path()));

        fs::write(&file, "sentinel").expect("overwrite");
        let second = ad_block.rule_lists().expect("second run reuses");
        assert_eq!(second, first);
        assert_eq!(fs::read_to_string(&file).expect("read"), "sentinel");
    }

    #[test]
    fn a_changed_list_gets_a_new_id_and_its_old_file_is_removed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let unrelated = dir.path().join("notes.json");
        fs::write(&unrelated, "{}").expect("write");

        let old = ad_block_with(dir.path(), "||ads.example.com^\n")
            .rule_lists()
            .expect("old");
        let new = ad_block_with(dir.path(), "||ads.example.net^\n")
            .rule_lists()
            .expect("new");

        assert_ne!(old[0].id, new[0].id);
        assert!(!Path::new(&old[0].path).exists());
        assert!(Path::new(&new[0].path).exists());
        assert!(unrelated.exists(), "files this module did not write stay");
    }
}
