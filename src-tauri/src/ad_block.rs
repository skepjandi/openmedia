//! Ad and tracker blocking from bundled filter lists.
//!
//! Network and CSS rules are converted to WebKit content-rule lists. A separate cached Brave
//! engine returns URL-matched scriptlets for the native plugin to inject at document start.
//! Neither path downloads filter data at runtime. Tracking-parameter and redirect-tracker data is
//! compiled into a link-cleaning script that rides with the scriptlets (`link_clean`).

use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use adblock::{
    Engine,
    content_blocking::{CbRule, CbType},
    lists::{FilterSet, ParseOptions},
    resources::{MimeType, Resource, ResourceType},
};
use base64::{Engine as _, prelude::BASE64_STANDARD};
use sha2::{Digest, Sha256};
use tauri_plugin_siteview::ContentRuleList;

use crate::error::{Error, Result};
use crate::library::write_atomically;
use crate::link_clean;

/// WebKit refuses to compile a list with more rules than this.
const MAX_RULES_PER_LIST: usize = 150_000;

/// Part of every list id. Bump it when the `adblock` crate is upgraded or this file changes what
/// the conversion produces, so lists the old conversion made are rebuilt instead of reused from
/// WebKit's store.
const CONVERTER_REVISION: &str = "adblock-0.13.5-lone-exceptions";

const EASYLIST: &str = include_str!("../../blocklists/easylist.txt");
const EASYPRIVACY: &str = include_str!("../../blocklists/easyprivacy.txt");
const PETER_LOWE: &str = include_str!("../../blocklists/peter-lowe.txt");
const ADGUARD_MOBILE: &str = include_str!("../../blocklists/adguard-mobile.txt");
const UBLOCK_FILTERS: &str = include_str!("../../blocklists/ublock-filters.txt");
const UBLOCK_PRIVACY: &str = include_str!("../../blocklists/ublock-privacy.txt");
const UBLOCK_BADWARE: &str = include_str!("../../blocklists/ublock-badware.txt");
const UBLOCK_UNBREAK: &str = include_str!("../../blocklists/ublock-unbreak.txt");
const UBLOCK_QUICK_FIXES: &str = include_str!("../../blocklists/ublock-quick-fixes.txt");
const UBLOCK_RESOURCE_ABUSE: &str = include_str!("../../blocklists/ublock-resource-abuse.txt");
const BRAVE_SPECIFIC: &str = include_str!("../../blocklists/brave-specific.txt");
#[cfg(target_os = "ios")]
const BRAVE_IOS_SPECIFIC: &str = include_str!("../../blocklists/brave-ios-specific.txt");
/// Lists bundled on iOS only: Brave's iOS fixes, which include its YouTube ad fallback rules.
#[cfg(target_os = "ios")]
const IOS_ONLY: [&str; 1] = [BRAVE_IOS_SPECIFIC];
#[cfg(not(target_os = "ios"))]
const IOS_ONLY: [&str; 0] = [];
const BRAVE_FIRSTPARTY: &str = include_str!("../../blocklists/brave-firstparty.txt");
const BRAVE_FIRSTPARTY_CNAME: &str = include_str!("../../blocklists/brave-firstparty-cname.txt");
const BRAVE_FIRSTPARTY_REGIONAL: &str =
    include_str!("../../blocklists/brave-firstparty-regional.txt");

/// An exception (`@@`, `#@#`) only overrides rules in the same WebKit content-rule list, so the
/// uBlock lists that exist to undo breakage ride in every group instead of being a list of their
/// own, where they would override nothing. The few blocks they carry are duplicated, which is
/// harmless.
const SHARED_EXCEPTIONS: [&str; 2] = [UBLOCK_UNBREAK, UBLOCK_QUICK_FIXES];

/// One content-rule list. Its source lists convert together, so exceptions in one list apply to
/// the blocks of another in the same group.
struct Group {
    name: &'static str,
    lists: Vec<&'static str>,
}

/// Groups keep each list far below WebKit's rule limit and let one change without recompiling
/// the rest. The sources of a group are chosen by what they pair with, not by size.
fn groups() -> Vec<Group> {
    let brave = [BRAVE_SPECIFIC, BRAVE_FIRSTPARTY, BRAVE_FIRSTPARTY_REGIONAL]
        .into_iter()
        .chain(IOS_ONLY)
        .collect();
    let named: [(&'static str, Vec<&'static str>); 6] = [
        ("easylist", vec![EASYLIST]),
        ("easyprivacy", vec![EASYPRIVACY, UBLOCK_PRIVACY]),
        (
            "ublock",
            vec![UBLOCK_FILTERS, UBLOCK_BADWARE, UBLOCK_RESOURCE_ABUSE],
        ),
        ("brave", brave),
        ("brave-cname", vec![BRAVE_FIRSTPARTY_CNAME]),
        ("mobile", vec![ADGUARD_MOBILE, PETER_LOWE]),
    ];
    named
        .into_iter()
        .map(|(name, mut lists)| {
            lists.extend(SHARED_EXCEPTIONS);
            Group { name, lists }
        })
        .collect()
}

/// Every distinct bundled list, for the scriptlet engine, which sees them all at once.
fn all_lists() -> Vec<&'static str> {
    let mut all: Vec<&'static str> = Vec::new();
    for list in groups().into_iter().flat_map(|group| group.lists) {
        if !all.contains(&list) {
            all.push(list);
        }
    }
    all
}

struct Source {
    id: String,
    lists: Vec<&'static str>,
}

impl Source {
    fn new(name: &str, lists: Vec<&'static str>) -> Self {
        let mut hasher = Sha256::new();
        hasher.update(CONVERTER_REVISION.as_bytes());
        for list in &lists {
            hasher.update([0]);
            hasher.update(list.as_bytes());
        }
        // The first 8 bytes, as 16 lowercase hex characters. sha2 0.11 digests no longer implement `LowerHex`.
        let short: String = hasher
            .finalize()
            .iter()
            .take(8)
            .map(|b| format!("{b:02x}"))
            .collect();
        Self {
            id: format!("openmedia-{name}-{short}"),
            lists,
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
        let sources = groups()
            .into_iter()
            .map(|group| Source::new(group.name, group.lists))
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
                write_atomically(&path, content_rules_json(&source.lists)?.as_bytes())?;
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
    ///
    /// Sites move between `example.com`, `www.example.com` and `m.example.com` on their own (a
    /// phone user agent is sent to `m.`), so the same site's other forms are matched too, each
    /// under its own exact-origin guard.
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
        let mut guarded: Vec<String> = Vec::new();
        for url in site_forms(&page_url) {
            let script = engine.url_cosmetic_resources(url.as_str()).injected_script;
            if script.is_empty() {
                continue;
            }
            let origin = serde_json::to_string(&url.origin().ascii_serialization())
                .map_err(|error| Error::AdBlock(format!("invalid scriptlet origin: {error}")))?;
            let wrapped = format!(
                "(function(){{if(window.top!==window||location.origin!=={origin})return;{script}}})();"
            );
            if !guarded.contains(&wrapped) {
                guarded.push(wrapped);
            }
        }
        Ok(guarded.concat())
    }

    /// Everything the page gets at document start for a page opened at `url`: the matched
    /// scriptlets, then the link cleaner, which every page gets.
    pub fn page_script_for_url(&self, url: &str) -> Result<String> {
        let mut script = self.scriptlets_for_url(url)?;
        script.push_str(link_clean::script()?);
        Ok(script)
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
/// The page's own URL first, then the same site with and without a leading `www.` or `m.`.
fn site_forms(page_url: &url::Url) -> Vec<url::Url> {
    let mut forms = vec![page_url.clone()];
    let Some(host) = page_url.host_str() else {
        return forms;
    };
    let bare = ["www.", "m."]
        .iter()
        .find_map(|prefix| host.strip_prefix(prefix))
        .unwrap_or(host);
    // A bare label such as `localhost` or an IP address has no other forms.
    if !bare.contains('.') || bare.parse::<std::net::IpAddr>().is_ok() {
        return forms;
    }
    for candidate in [bare.to_owned(), format!("www.{bare}"), format!("m.{bare}")] {
        let mut form = page_url.clone();
        if candidate != host && form.set_host(Some(&candidate)).is_ok() {
            forms.push(form);
        }
    }
    forms
}

/// Scriptlets OpenMedia writes itself, by the name its own list uses.
const OWN_RESOURCES: [(&str, &str); 1] = [(
    "openmedia-youtube-ads.js",
    include_str!("../../blocklists/openmedia-youtube-ads.js"),
)];

/// OpenMedia's own scriptlet rules. Scriptlets only, so it is not converted for WebKit.
const OWN_SCRIPTLET_RULES: &str = include_str!("../../blocklists/openmedia-specific.txt");

fn scriptlet_engine() -> Result<Engine> {
    let mut filters = FilterSet::new(false);
    for list in all_lists() {
        filters.add_filter_list(list.to_owned(), ParseOptions::default());
    }
    filters.add_filter_list(OWN_SCRIPTLET_RULES.to_owned(), ParseOptions::default());
    let mut resources: Vec<Resource> =
        serde_json::from_str(include_str!("../../blocklists/brave-resources.json"))
            .map_err(|error| Error::AdBlock(format!("invalid Brave resource bundle: {error}")))?;
    resources.extend(OWN_RESOURCES.iter().map(|(name, code)| Resource {
        name: (*name).to_owned(),
        aliases: Vec::new(),
        kind: ResourceType::Mime(MimeType::ApplicationJavascript),
        content: BASE64_STANDARD.encode(code),
        dependencies: Vec::new(),
        permission: Default::default(),
    }));
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

/// Converts ABP-syntax lists to WebKit's content-blocking JSON as one rule list. Network rules
/// become `block` and exceptions; element-hiding rules become `css-display-none`. Rules WebKit
/// cannot express (scriptlets, procedural cosmetics, `$redirect`) are dropped by the converter.
/// The lists are converted together so an exception in one applies to the blocks of another.
fn content_rules_json(lists: &[&str]) -> Result<String> {
    let mut set = FilterSet::new(true);
    for list in lists {
        set.add_filter_list((*list).to_owned(), ParseOptions::default());
    }
    let (mut rules, _converted) = set
        .into_content_blocking()
        .map_err(|()| Error::AdBlock("the filter list could not be converted".into()))?;
    if rules.is_empty() || rules.len() > MAX_RULES_PER_LIST {
        return Err(Error::AdBlock(format!(
            "a filter list produced {} rules; WebKit accepts 1 to {MAX_RULES_PER_LIST}",
            rules.len()
        )));
    }
    drop_hides_made_from_lone_exceptions(&mut rules, lists);
    include_subdomains(&mut rules);
    serde_json::to_string(&rules).map_err(|e| Error::AdBlock(e.to_string()))
}

/// The converter turns an element-hiding exception (`example.org#@#svg`) into a hide of that
/// selector on every site but `example.org`, which is right only where a generic `##svg` exists
/// for it to be an exception to. uBlock's unbreak list has exceptions with no such rule (its
/// `redtube.com#@#svg` came out as "hide every `svg` on the web", which removed every icon and
/// logo from every page). A hide that applies everywhere but a few domains is kept only if the
/// lists have the generic rule behind it.
fn drop_hides_made_from_lone_exceptions(rules: &mut Vec<CbRule>, lists: &[&str]) {
    let generic: std::collections::HashSet<&str> = lists
        .iter()
        .flat_map(|list| list.lines())
        .filter_map(|line| line.strip_prefix("##"))
        .collect();
    rules.retain(|rule| {
        let lone = rule.action.typ == CbType::CssDisplayNone
            && rule.trigger.unless_domain.is_some()
            && rule.trigger.if_domain.is_none();
        if !lone {
            return true;
        }
        let selector = rule.action.selector.as_deref().unwrap_or_default();
        generic.contains(selector)
            || selector
                .split(',')
                .any(|part| generic.contains(part.trim()))
    });
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
        group_rules(&[list])
    }

    fn group_rules(lists: &[&str]) -> Vec<Value> {
        let json = content_rules_json(lists).expect("lists convert");
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
    fn an_exception_with_no_generic_hide_behind_it_does_not_hide_anything() {
        // uBlock's unbreak list has `redtube.com#@#svg`; the converter made it hide every svg.
        let lone = group_rules(&["redtube.com#@#svg\n||tracker.example^\n"]);
        assert!(of_type(&lone, "css-display-none").is_empty());
        let paired = group_rules(&["##.banner\nexample.org#@#.banner\n"]);
        let hides = of_type(&paired, "css-display-none");
        assert!(!hides.is_empty());
        assert!(
            hides
                .iter()
                .all(|rule| rule["action"]["selector"] == ".banner")
        );
    }

    #[test]
    fn no_bundled_group_hides_svg_everywhere() {
        for group in groups() {
            let converted = group_rules(&group.lists);
            let hides_svg = of_type(&converted, "css-display-none")
                .into_iter()
                .any(|rule| rule["action"]["selector"] == "svg");
            assert!(!hides_svg, "{} hides every svg", group.name);
        }
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
            content_rules_json(&["! only a comment\n"]),
            Err(Error::AdBlock(_))
        ));
    }

    #[test]
    fn every_group_converts_within_webkits_rule_limit() {
        for group in groups() {
            let count = group_rules(&group.lists).len();
            assert!(
                (1_000..=MAX_RULES_PER_LIST).contains(&count),
                "{} produced {count} rules",
                group.name
            );
        }
    }

    #[test]
    fn an_exception_in_one_list_overrides_a_block_in_another_of_the_same_group() {
        let converted = group_rules(&[
            "||ads.example.com^\n",
            "@@||ads.example.com^$domain=shop.example.org\n",
        ]);
        let kinds: Vec<&Value> = converted
            .iter()
            .map(|rule| &rule["action"]["type"])
            .collect();
        assert!(kinds.contains(&&Value::from("block")), "{kinds:?}");
        assert!(
            kinds.contains(&&Value::from("ignore-previous-rules")),
            "{kinds:?}"
        );
    }

    #[test]
    fn every_group_carries_the_breakage_exceptions() {
        let unbreak = of_type(&rules(UBLOCK_UNBREAK), "ignore-previous-rules").len();
        assert!(unbreak > 500, "only {unbreak} unbreak exceptions");
        for group in groups() {
            let converted = group_rules(&group.lists);
            let exceptions = of_type(&converted, "ignore-previous-rules").len();
            assert!(
                exceptions >= unbreak,
                "{} has {exceptions} exceptions, fewer than the {unbreak} in the unbreak list",
                group.name
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
        let ios_rules = BRAVE_IOS_SPECIFIC;
        assert!(ios_rules.contains(
            "||googlevideo.com/videoplayback*ctier=L&*%2Cxpc%2Cctier%2C$domain=m.youtube.com|music.youtube.com"
        ));
        assert!(rules(ios_rules).len() > 1_000);
    }

    #[test]
    fn brave_youtube_scriptlets_match_only_youtube_pages() {
        let dir = tempfile::tempdir().expect("tempdir");
        let ad_block = AdBlock::bundled(dir.path().to_owned());
        let brave_rules = BRAVE_SPECIFIC;
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

    #[test]
    fn youtube_ad_removal_follows_the_site_across_its_hosts() {
        let dir = tempfile::tempdir().expect("tempdir");
        let ad_block = AdBlock::bundled(dir.path().to_owned());
        // A phone is sent from the bare host to `m.`, a desktop to `www.`: the start URL's
        // origin alone would leave the scriptlet inert after the redirect.
        for start in [
            "https://youtube.com/",
            "https://www.youtube.com/watch?v=x",
            "https://m.youtube.com/",
        ] {
            let script = ad_block.scriptlets_for_url(start).expect("scriptlets");
            assert!(script.contains("__openmediaYoutubeAds"), "{start}");
            for origin in [
                "https://youtube.com",
                "https://www.youtube.com",
                "https://m.youtube.com",
            ] {
                assert!(
                    script.contains(&format!("location.origin!==\"{origin}\"")),
                    "{start} lacks a guard for {origin}"
                );
            }
        }
        let other = ad_block
            .scriptlets_for_url("https://example.org/")
            .expect("scriptlets");
        assert!(!other.contains("__openmediaYoutubeAds"));
    }

    fn ad_block_with(dir: &Path, text: &'static str) -> AdBlock {
        AdBlock(Arc::new(Inner {
            dir: dir.to_owned(),
            sources: vec![Source::new("test", vec![text])],
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

    /// Writes every converted list to `$OPENMEDIA_RULE_DIR` for `scripts/check-blocklists-webkit.sh`.
    #[test]
    #[ignore = "run by scripts/check-blocklists-webkit.sh"]
    fn write_rule_lists() {
        let dir = std::env::var("OPENMEDIA_RULE_DIR").expect("OPENMEDIA_RULE_DIR is set");
        let lists = AdBlock::bundled(PathBuf::from(dir))
            .rule_lists()
            .expect("lists convert");
        assert!(!lists.is_empty());
    }

    /// A request as WebKit's content blocker sees it.
    struct Probe<'a> {
        url: &'a str,
        page: &'a str,
        resource: &'a str,
        third_party: bool,
    }

    const fn script(url: &'static str) -> Probe<'static> {
        Probe {
            url,
            page: "news.example.org",
            resource: "script",
            third_party: true,
        }
    }

    /// The part of WebKit's content-rule matching the converter's output uses: URL regex, resource
    /// and load type, page-domain conditions, and `ignore-previous-rules` undoing earlier blocks
    /// within one list.
    struct Matcher {
        pattern: regex::Regex,
        resources: Option<Vec<String>>,
        third_party: Option<bool>,
        if_domain: Option<Vec<String>>,
        unless_domain: Option<Vec<String>>,
        exception: bool,
    }

    fn strings(value: &Value) -> Option<Vec<String>> {
        value.as_array().map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect()
        })
    }

    fn matcher(rule: &Value) -> Option<Matcher> {
        let exception = match rule["action"]["type"].as_str()? {
            "block" => false,
            "ignore-previous-rules" => true,
            _ => return None,
        };
        let trigger = &rule["trigger"];
        let pattern = regex::RegexBuilder::new(trigger["url-filter"].as_str()?)
            .case_insensitive(trigger["url-filter-is-case-sensitive"] != true)
            .build()
            .ok()?;
        let third_party = trigger["load-type"].as_array().and_then(|types| {
            match types.iter().filter_map(Value::as_str).collect::<Vec<_>>()[..] {
                ["third-party"] => Some(true),
                ["first-party"] => Some(false),
                _ => None,
            }
        });
        Some(Matcher {
            pattern,
            resources: strings(&trigger["resource-type"]),
            third_party,
            if_domain: strings(&trigger["if-domain"]),
            unless_domain: strings(&trigger["unless-domain"]),
            exception,
        })
    }

    fn domain_matches(page: &str, domain: &str) -> bool {
        match domain.strip_prefix('*') {
            Some(suffix) => page == suffix || page.ends_with(&format!(".{suffix}")),
            None => page == domain,
        }
    }

    impl Matcher {
        fn matches(&self, probe: &Probe<'_>) -> bool {
            self.resources
                .as_ref()
                .is_none_or(|kinds| kinds.iter().any(|kind| kind == probe.resource))
                && self
                    .third_party
                    .is_none_or(|third| third == probe.third_party)
                && self
                    .if_domain
                    .as_ref()
                    .is_none_or(|ds| ds.iter().any(|d| domain_matches(probe.page, d)))
                && self
                    .unless_domain
                    .as_ref()
                    .is_none_or(|ds| !ds.iter().any(|d| domain_matches(probe.page, d)))
                && self.pattern.is_match(probe.url)
        }
    }

    /// Whether any list blocks the request: within a list the last matching rule decides.
    fn blocked(lists: &[Vec<Matcher>], probe: &Probe<'_>) -> bool {
        lists.iter().any(|list| {
            list.iter().fold(false, |blocked, rule| {
                match (rule.matches(probe), rule.exception) {
                    (true, exception) => !exception,
                    (false, _) => blocked,
                }
            })
        })
    }

    fn compiled_groups() -> Vec<Vec<Matcher>> {
        groups()
            .iter()
            .map(|group| {
                group_rules(&group.lists)
                    .iter()
                    .filter_map(matcher)
                    .collect()
            })
            .collect()
    }

    /// The first `||host^` rule of a plain host list: some host the list is there to block.
    fn first_listed_host(list: &str) -> &str {
        list.lines()
            .find_map(|line| line.strip_prefix("||")?.strip_suffix('^'))
            .expect("the list has a host rule")
    }

    #[test]
    fn known_trackers_are_blocked_and_common_libraries_still_load() {
        let lists = compiled_groups();
        let cname = format!(
            "https://{}/pixel.js",
            first_listed_host(BRAVE_FIRSTPARTY_CNAME)
        );
        let lowe = format!("https://{}/a.js", first_listed_host(PETER_LOWE));
        let badware = format!("https://{}/a.js", first_listed_host(UBLOCK_BADWARE));
        let must_block = [
            script("https://www.google-analytics.com/analytics.js"),
            script("https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"),
            script("https://securepubads.g.doubleclick.net/tag/js/gpt.js"),
            script("https://connect.facebook.net/en_US/fbevents.js"),
            script("https://static.ads-twitter.com/uwt.js"),
            script("https://bat.bing.com/bat.js"),
            script("https://cdn.taboola.com/libtrc/example/loader.js"),
            script("https://cdn.segment.com/analytics.js/v1/key/analytics.min.js"),
            script("https://static.hotjar.com/c/hotjar-1.js"),
        ];
        for probe in &must_block {
            assert!(blocked(&lists, probe), "{} is not blocked", probe.url);
        }
        // Hosts taken from the lists themselves, one for each list that holds only host rules.
        for url in [&cname, &lowe, &badware] {
            let probe = Probe {
                url: url.as_str(),
                page: "news.example.org",
                resource: "script",
                third_party: true,
            };
            assert!(blocked(&lists, &probe), "{url} is not blocked");
        }
        let must_load = [
            script("https://cdn.jsdelivr.net/npm/vue@3/dist/vue.global.js"),
            script("https://code.jquery.com/jquery-3.7.1.min.js"),
            script(
                "https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js",
            ),
            Probe {
                resource: "style-sheet",
                ..script("https://fonts.googleapis.com/css2?family=Inter")
            },
            Probe {
                url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
                page: "www.youtube.com",
                resource: "document",
                third_party: false,
            },
            Probe {
                url: "https://en.wikipedia.org/wiki/Main_Page",
                page: "en.wikipedia.org",
                resource: "document",
                third_party: false,
            },
        ];
        for probe in &must_load {
            assert!(!blocked(&lists, probe), "{} is blocked", probe.url);
        }
    }
}
