use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    sync::{Mutex, MutexGuard},
};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::library::write_atomically;
use tauri_plugin_siteview::site::{is_public_suffix, registrable_domain};

const FORMAT_VERSION: u32 = 1;
/// Days of history kept on disk, counting today.
pub const RETAINED_DAYS: u32 = 30;
const MAX_HOSTS_PER_DAY: usize = 200;
const MAX_SECTIONS_PER_HOST: usize = 60;
/// How many sites may carry a daily warning or limit.
pub const MAX_POLICY_HOSTS: usize = 200;
/// The largest threshold a policy may set: a whole day.
pub const MAX_POLICY_SECONDS: u32 = 86_400;
/// One flush never covers more than this; the shell flushes every few seconds.
pub const MAX_SECONDS_PER_RECORD: u32 = 3600;
const MAX_HOST_CHARS: usize = 253;
const MAX_SECTION_CHARS: usize = 24;
/// The section of a page at the root of its site.
pub const HOME_SECTION: &str = "/";
/// The section of every page whose first path segment is not a plain lowercase word.
pub const OTHER_SECTION: &str = "*";

type Sections = BTreeMap<String, u64>;
type Hosts = BTreeMap<String, Sections>;

#[derive(Debug, Serialize, Deserialize)]
struct UsageData {
    version: u32,
    /// Local date `YYYY-MM-DD` -> host -> section -> seconds.
    days: BTreeMap<String, Hosts>,
    /// The daily warning and limit the user set, per host. Kept in the same file as the
    /// seconds, but apart from them: clearing the stats never clears the limits.
    #[serde(default)]
    policies: UsagePolicies,
}

impl UsageData {
    fn empty() -> Self {
        Self {
            version: FORMAT_VERSION,
            days: BTreeMap::new(),
            policies: UsagePolicies::new(),
        }
    }
}

/// What the user set for one site: when the app warns, and when it closes the site for the day.
/// Both are seconds of use in one local day; `None` means that step never happens.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsagePolicy {
    /// Seconds after which the app warns; `None` warns never.
    #[serde(default)]
    pub warn_seconds: Option<u32>,
    /// Seconds after which the app closes the site for the day; `None` never closes it.
    #[serde(default)]
    pub limit_seconds: Option<u32>,
}

impl UsagePolicy {
    /// A policy with neither step: the site has no limit, and setting it removes the policy.
    fn is_unset(&self) -> bool {
        self.warn_seconds.is_none() && self.limit_seconds.is_none()
    }
}

/// The policy of every site the user set one for, keyed by host.
pub type UsagePolicies = BTreeMap<String, UsagePolicy>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionUsage {
    pub section: String,
    pub seconds: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteUsage {
    pub host: String,
    /// The bundled recipe's name for the site, when one covers it; filled in by the command.
    pub name: Option<String>,
    pub seconds: u64,
    pub sections: Vec<SectionUsage>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    pub total_seconds: u64,
    /// Busiest site first.
    pub sites: Vec<SiteUsage>,
}

/// Seconds spent per site and per area of the site, per local day. Holds only host names, the
/// first path segment and counts: never a full address, query or title. Kept in its own file so
/// the library stays small, and it never leaves the device.
pub struct Usage {
    path: PathBuf,
    data: Mutex<UsageData>,
}

impl Usage {
    /// A missing, corrupt or newer-format file starts empty: these numbers are disposable.
    pub fn load(path: PathBuf) -> Result<Self> {
        let data = match fs::read_to_string(&path) {
            Ok(text) => parse(&text),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => UsageData::empty(),
            Err(e) => return Err(e.into()),
        };
        Ok(Self {
            path,
            data: Mutex::new(data),
        })
    }

    /// Adds `seconds` to a site section for `day`, then drops days older than the retention
    /// window counted back from the newest recorded day. Sites or sections beyond the per-day caps are not recorded.
    /// A site that has reached its daily limit does not accrue more time: the app closes it, so
    /// the seconds it would earn are never counted.
    pub fn record(&self, day: &str, host: &str, section: &str, seconds: u32) -> Result<()> {
        let today = day_number(day).ok_or(Error::InvalidUsage("the day must be YYYY-MM-DD"))?;
        if !valid_host(host) {
            return Err(Error::InvalidUsage("invalid host"));
        }
        if !valid_section(section) {
            return Err(Error::InvalidUsage("invalid section"));
        }
        if seconds == 0 || seconds > MAX_SECONDS_PER_RECORD {
            return Err(Error::InvalidUsage("seconds out of range"));
        }
        let mut data = self.lock()?;
        if reached_limit(&data, day, host) {
            return Ok(());
        }
        let hosts = data.days.entry(day.to_owned()).or_default();
        if hosts.contains_key(host) || hosts.len() < MAX_HOSTS_PER_DAY {
            let sections = hosts.entry(host.to_owned()).or_default();
            if sections.contains_key(section) || sections.len() < MAX_SECTIONS_PER_HOST {
                let total = sections.entry(section.to_owned()).or_default();
                *total = total.saturating_add(u64::from(seconds));
            }
        }
        let newest = data
            .days
            .keys()
            .filter_map(|key| day_number(key))
            .max()
            .unwrap_or(today);
        data.days.retain(|key, _| {
            day_number(key).is_some_and(|number| number > newest - i64::from(RETAINED_DAYS))
        });
        self.save(&data)
    }

    /// Totals for the `days` days ending at `today`, today included.
    pub fn report(&self, today: &str, days: u32) -> Result<UsageReport> {
        let end = day_number(today).ok_or(Error::InvalidUsage("the day must be YYYY-MM-DD"))?;
        let start = end - i64::from(days.clamp(1, RETAINED_DAYS)) + 1;
        let data = self.lock()?;
        let mut merged = Hosts::new();
        for (key, hosts) in &data.days {
            if !day_number(key).is_some_and(|number| (start..=end).contains(&number)) {
                continue;
            }
            for (host, sections) in hosts {
                let target = merged.entry(host.clone()).or_default();
                for (section, seconds) in sections {
                    let total = target.entry(section.clone()).or_default();
                    *total = total.saturating_add(*seconds);
                }
            }
        }
        Ok(summarize(merged))
    }

    /// The daily warning and limit of every site the user set one for.
    pub fn policies(&self) -> Result<UsagePolicies> {
        let data = self.lock()?;
        Ok(data.policies.clone())
    }

    /// Saves the daily warning and limit for one site, and returns every policy. A policy with
    /// neither step removes the site's policy, which is how a limit is lifted.
    pub fn set_policy(&self, host: &str, policy: UsagePolicy) -> Result<UsagePolicies> {
        if !valid_host(host) {
            return Err(Error::InvalidUsage("invalid host"));
        }
        check_policy(&policy)?;
        let mut data = self.lock()?;
        let previous = data.policies.clone();
        if policy.is_unset() {
            data.policies.remove(host);
        } else {
            if !data.policies.contains_key(host) && data.policies.len() >= MAX_POLICY_HOSTS {
                return Err(Error::InvalidUsage("too many sites carry a limit"));
            }
            data.policies.insert(host.to_owned(), policy);
        }
        if let Err(error) = self.save(&data) {
            data.policies = previous;
            return Err(error);
        }
        Ok(data.policies.clone())
    }

    /// Sites an earlier build stored under a public suffix (`github.io`, `com.br`) because it
    /// did not know the suffix list. Their seconds belong to no site and are dropped; a limit
    /// moves to each favorite under that suffix, which is how the user reached the site.
    pub fn retire_public_suffix_sites(&self, favorite_hosts: &[String]) -> Result<()> {
        let mut data = self.lock()?;
        let mut changed = false;
        for hosts in data.days.values_mut() {
            let before = hosts.len();
            hosts.retain(|site, _| !is_public_suffix(site));
            changed |= hosts.len() != before;
        }
        let stale: Vec<String> = data
            .policies
            .keys()
            .filter(|site| is_public_suffix(site))
            .cloned()
            .collect();
        for suffix in stale {
            let Some(policy) = data.policies.remove(&suffix) else {
                continue;
            };
            let under = format!(".{suffix}");
            for host in favorite_hosts.iter().filter(|host| host.ends_with(&under)) {
                if let Some(site) = registrable_domain(host) {
                    data.policies.entry(site).or_insert_with(|| policy.clone());
                }
            }
            changed = true;
        }
        if changed {
            self.save(&data)?;
        }
        Ok(())
    }

    /// Wipes every recorded usage second. The limits the user set stay: they are the user's
    /// settings, not the numbers they produced.
    pub fn clear(&self) -> Result<()> {
        let mut data = self.lock()?;
        data.days.clear();
        self.save(&data)
    }

    fn lock(&self) -> Result<MutexGuard<'_, UsageData>> {
        self.data.lock().map_err(|_| Error::Poisoned)
    }

    fn save(&self, data: &UsageData) -> Result<()> {
        write_atomically(&self.path, &serde_json::to_vec(data)?)?;
        Ok(())
    }
}

/// A threshold must be a real number of seconds inside one day, and the warning must come
/// before the limit: a limit at or below the warning would close the site before it warns.
fn check_policy(policy: &UsagePolicy) -> Result<()> {
    for seconds in [policy.warn_seconds, policy.limit_seconds]
        .into_iter()
        .flatten()
    {
        if seconds == 0 || seconds > MAX_POLICY_SECONDS {
            return Err(Error::InvalidUsage(
                "a usage threshold must be between 1 and 86400 seconds",
            ));
        }
    }
    if let (Some(warn), Some(limit)) = (policy.warn_seconds, policy.limit_seconds)
        && warn >= limit
    {
        return Err(Error::InvalidUsage(
            "the warning threshold must be below the limit",
        ));
    }
    Ok(())
}

/// True when the site has already used up its daily limit on `day`.
fn reached_limit(data: &UsageData, day: &str, host: &str) -> bool {
    let Some(policy) = policy_for_host(&data.policies, host) else {
        return false;
    };
    let Some(limit) = policy.limit_seconds else {
        return false;
    };
    let spent = data
        .days
        .get(day)
        .and_then(|hosts| hosts.get(host))
        .map(|sections| sections.values().sum::<u64>())
        .unwrap_or(0);
    spent >= u64::from(limit)
}

/// The policy that applies to `host`: the strictest one among the host itself and the domains
/// around it, so a limit set on a site also covers its subdomains and the other way round. The
/// shell matches domains the same way; see `policyForHost` in `src/features/stats/policy.ts`.
fn policy_for_host(policies: &UsagePolicies, host: &str) -> Option<UsagePolicy> {
    policies
        .iter()
        .filter(|(site, _)| same_site(host, site))
        .map(|(_, policy)| policy)
        .cloned()
        .reduce(|best, policy| UsagePolicy {
            warn_seconds: strictest(best.warn_seconds, policy.warn_seconds),
            limit_seconds: strictest(best.limit_seconds, policy.limit_seconds),
        })
}

/// True when `site` is `host` itself or a domain around it: a parent domain or a subdomain.
fn same_site(host: &str, site: &str) -> bool {
    host == site || ends_with_domain(host, site) || ends_with_domain(site, host)
}

/// True when `host` ends with `domain` at a domain boundary: `m.youtube.com` ends with
/// `youtube.com`, but `notyoutube.com` does not.
fn ends_with_domain(host: &str, domain: &str) -> bool {
    host.strip_suffix(domain)
        .is_some_and(|rest| rest.ends_with('.'))
}

/// The stricter of two thresholds. `None` means there is no threshold, so the other one wins.
fn strictest(a: Option<u32>, b: Option<u32>) -> Option<u32> {
    match (a, b) {
        (None, other) | (other, None) => other,
        (Some(a), Some(b)) => Some(a.min(b)),
    }
}

fn parse(text: &str) -> UsageData {
    match serde_json::from_str::<UsageData>(text) {
        Ok(data) if data.version == FORMAT_VERSION => data,
        _ => UsageData::empty(),
    }
}

fn summarize(merged: Hosts) -> UsageReport {
    let mut sites: Vec<SiteUsage> = merged
        .into_iter()
        .map(|(host, sections)| {
            let mut sections: Vec<SectionUsage> = sections
                .into_iter()
                .map(|(section, seconds)| SectionUsage { section, seconds })
                .collect();
            sections.sort_by(|a, b| b.seconds.cmp(&a.seconds).then(a.section.cmp(&b.section)));
            SiteUsage {
                host,
                name: None,
                seconds: sections.iter().map(|s| s.seconds).sum(),
                sections,
            }
        })
        .collect();
    sites.sort_by(|a, b| b.seconds.cmp(&a.seconds).then(a.host.cmp(&b.host)));
    UsageReport {
        total_seconds: sites.iter().map(|site| site.seconds).sum(),
        sites,
    }
}

fn valid_host(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= MAX_HOST_CHARS
        && !host.starts_with(['.', '-'])
        && !host.ends_with(['.', '-'])
        && host
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
}

fn valid_section(section: &str) -> bool {
    if section == HOME_SECTION || section == OTHER_SECTION {
        return true;
    }
    section.strip_prefix('/').is_some_and(|segment| {
        (1..=MAX_SECTION_CHARS).contains(&segment.len())
            && segment
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
    })
}

/// Days since 1970-01-01 for a `YYYY-MM-DD` date, or `None` when it is not a real date.
fn day_number(day: &str) -> Option<i64> {
    let bytes = day.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let digits = |range: std::ops::Range<usize>| -> Option<i64> {
        let part = day.get(range)?;
        part.bytes()
            .all(|b| b.is_ascii_digit())
            .then(|| part.parse().ok())?
    };
    let (year, month, date) = (digits(0..4)?, digits(5..7)?, digits(8..10)?);
    if !(1970..=9999).contains(&year) || !(1..=12).contains(&month) {
        return None;
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let length = match month {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    if !(1..=length).contains(&date) {
        return None;
    }
    let shifted_year = if month <= 2 { year - 1 } else { year };
    let era = shifted_year / 400;
    let year_of_era = shifted_year - era * 400;
    let day_of_year = (153 * ((month + 9) % 12) + 2) / 5 + date - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    Some(era * 146_097 + day_of_era - 719_468)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usage() -> (tempfile::TempDir, Usage) {
        let dir = tempfile::tempdir().unwrap();
        let usage = Usage::load(dir.path().join("usage.json")).unwrap();
        (dir, usage)
    }

    fn reload(dir: &tempfile::TempDir) -> Usage {
        Usage::load(dir.path().join("usage.json")).unwrap()
    }

    #[test]
    fn day_numbers_count_real_calendar_days() {
        assert_eq!(day_number("1970-01-01"), Some(0));
        assert_eq!(
            day_number("2024-03-01"),
            day_number("2024-02-29").map(|n| n + 1)
        );
        assert_eq!(
            day_number("2025-03-01"),
            day_number("2025-02-28").map(|n| n + 1)
        );
        assert_eq!(
            day_number("2026-01-01"),
            day_number("2025-12-31").map(|n| n + 1)
        );
    }

    #[test]
    fn day_numbers_reject_malformed_dates() {
        for bad in [
            "",
            "2025-1-01",
            "2025-13-01",
            "2025-02-29",
            "2025-04-31",
            "2025-00-10",
            "2025-01-00",
            "20250101",
            "2025/01/01",
            "abcd-ef-gh",
            "1969-12-31",
            "2025-01-0١",
            "+025-01-01",
        ] {
            assert_eq!(day_number(bad), None, "{bad}");
        }
    }

    #[test]
    fn records_accumulate_per_site_and_section() {
        let (_dir, usage) = usage();
        usage
            .record("2026-11-08", "youtube.com", "/watch", 30)
            .unwrap();
        usage
            .record("2026-11-08", "youtube.com", "/watch", 20)
            .unwrap();
        usage
            .record("2026-11-08", "youtube.com", "/shorts", 10)
            .unwrap();
        usage.record("2026-11-08", "reddit.com", "/", 5).unwrap();
        let report = usage.report("2026-11-08", 1).unwrap();
        assert_eq!(report.total_seconds, 65);
        assert_eq!(report.sites[0].host, "youtube.com");
        assert_eq!(report.sites[0].seconds, 60);
        assert_eq!(
            report.sites[0].sections,
            vec![
                SectionUsage {
                    section: "/watch".into(),
                    seconds: 50
                },
                SectionUsage {
                    section: "/shorts".into(),
                    seconds: 10
                },
            ]
        );
        assert_eq!(report.sites[1].host, "reddit.com");
    }

    #[test]
    fn reports_cover_only_the_requested_window() {
        let (_dir, usage) = usage();
        usage.record("2026-11-08", "a.com", "/", 1).unwrap();
        usage.record("2026-11-02", "a.com", "/", 10).unwrap();
        usage.record("2026-10-20", "a.com", "/", 100).unwrap();
        assert_eq!(usage.report("2026-11-08", 1).unwrap().total_seconds, 1);
        assert_eq!(usage.report("2026-11-08", 7).unwrap().total_seconds, 11);
        assert_eq!(usage.report("2026-11-08", 30).unwrap().total_seconds, 111);
        assert_eq!(usage.report("2026-11-08", 999).unwrap().total_seconds, 111);
    }

    #[test]
    fn days_older_than_the_retention_window_are_pruned() {
        let (dir, usage) = usage();
        usage.record("2026-10-01", "a.com", "/", 5).unwrap();
        usage.record("2026-10-10", "a.com", "/", 5).unwrap();
        usage.record("2026-11-08", "a.com", "/", 5).unwrap();
        let reloaded = reload(&dir);
        assert_eq!(reloaded.report("2026-10-10", 30).unwrap().total_seconds, 5);
        assert_eq!(reloaded.report("2026-11-08", 30).unwrap().total_seconds, 10);
    }

    #[test]
    fn records_survive_a_reload_and_clear_wipes_them() {
        let (dir, usage) = usage();
        usage.record("2026-11-08", "a.com", "/x", 5).unwrap();
        assert_eq!(
            reload(&dir).report("2026-11-08", 7).unwrap().total_seconds,
            5
        );
        usage.clear().unwrap();
        let report = reload(&dir).report("2026-11-08", 30).unwrap();
        assert_eq!(report.total_seconds, 0);
        assert!(report.sites.is_empty());
    }

    #[test]
    fn rejects_untrusted_input() {
        let (_dir, usage) = usage();
        let cases = [
            ("2026-11-08", "https://a.com/x", "/", 5),
            ("2026-11-08", "A.com", "/", 5),
            ("2026-11-08", "", "/", 5),
            ("2026-11-08", "a.com/path", "/", 5),
            ("2026-11-08", "a.com", "/@user", 5),
            ("2026-11-08", "a.com", "watch", 5),
            ("2026-11-08", "a.com", "/Watch", 5),
            ("2026-11-08", "a.com", "/with space", 5),
            ("2026-11-08", "a.com", "/ünï", 5),
            ("2026-11-08", "a.com", "/", 0),
            ("2026-11-08", "a.com", "/", MAX_SECONDS_PER_RECORD + 1),
            ("yesterday", "a.com", "/", 5),
        ];
        for (day, host, section, seconds) in cases {
            assert!(
                matches!(
                    usage.record(day, host, section, seconds),
                    Err(Error::InvalidUsage(_))
                ),
                "{day} {host} {section} {seconds}"
            );
        }
        assert!(
            usage
                .record("2026-11-08", "a.com", &format!("/{}", "a".repeat(25)), 5)
                .is_err()
        );
        assert!(
            usage
                .record("2026-11-08", "a.com", &format!("/{}", "a".repeat(24)), 5)
                .is_ok()
        );
        assert!(
            usage
                .record("2026-11-08", "a.com", OTHER_SECTION, 5)
                .is_ok()
        );
        assert_eq!(usage.report("2026-11-08", 1).unwrap().sites.len(), 1);
    }

    #[test]
    fn caps_hosts_and_sections_per_day() {
        let (_dir, usage) = usage();
        for i in 0..MAX_SECTIONS_PER_HOST + 5 {
            usage
                .record("2026-11-08", "a.com", &format!("/s{i}"), 1)
                .unwrap();
        }
        for i in 0..MAX_HOSTS_PER_DAY + 5 {
            usage
                .record("2026-11-08", &format!("h{i}.com"), "/", 1)
                .unwrap();
        }
        usage.record("2026-11-08", "a.com", "/s0", 1).unwrap();
        let report = usage.report("2026-11-08", 1).unwrap();
        assert_eq!(report.sites.len(), MAX_HOSTS_PER_DAY);
        let a = report.sites.iter().find(|s| s.host == "a.com").unwrap();
        assert_eq!(a.sections.len(), MAX_SECTIONS_PER_HOST);
        assert_eq!(
            a.sections
                .iter()
                .find(|s| s.section == "/s0")
                .unwrap()
                .seconds,
            2
        );
    }

    #[test]
    fn a_corrupt_or_newer_file_starts_empty() {
        for text in ["not json", r#"{"version":99,"days":{}}"#] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("usage.json");
            fs::write(&path, text).unwrap();
            let usage = Usage::load(path).unwrap();
            assert_eq!(usage.report("2026-11-08", 30).unwrap().total_seconds, 0);
        }
    }

    #[test]
    fn the_file_holds_only_names_and_seconds() {
        let (dir, usage) = usage();
        usage
            .record("2026-11-08", "youtube.com", "/watch", 7)
            .unwrap();
        let text = fs::read_to_string(dir.path().join("usage.json")).unwrap();
        assert_eq!(
            text,
            r#"{"version":1,"days":{"2026-11-08":{"youtube.com":{"/watch":7}}},"policies":{}}"#
        );
    }

    fn policy(warn: Option<u32>, limit: Option<u32>) -> UsagePolicy {
        UsagePolicy {
            warn_seconds: warn,
            limit_seconds: limit,
        }
    }

    #[test]
    fn policies_persist_and_survive_a_reload() {
        let (dir, usage) = usage();
        let policies = usage
            .set_policy("youtube.com", policy(Some(300), Some(3600)))
            .unwrap();
        assert_eq!(policies.len(), 1);
        assert_eq!(
            policies.get("youtube.com"),
            Some(&policy(Some(300), Some(3600)))
        );
        let reloaded = reload(&dir);
        assert_eq!(
            reloaded.policies().unwrap().get("youtube.com"),
            Some(&policy(Some(300), Some(3600)))
        );
        // A policy with only a limit is a policy too.
        usage
            .set_policy("reddit.com", policy(None, Some(600)))
            .unwrap();
        assert_eq!(
            reload(&dir).policies().unwrap().get("reddit.com"),
            Some(&policy(None, Some(600)))
        );
    }

    #[test]
    fn a_policy_with_neither_step_removes_the_site() {
        let (dir, usage) = usage();
        usage
            .set_policy("youtube.com", policy(Some(300), None))
            .unwrap();
        let policies = usage.set_policy("youtube.com", policy(None, None)).unwrap();
        assert!(policies.is_empty());
        assert!(reload(&dir).policies().unwrap().is_empty());
    }

    #[test]
    fn rejects_invalid_thresholds_and_hosts() {
        let (_dir, usage) = usage();
        let bad = [
            policy(Some(0), None),
            policy(None, Some(0)),
            policy(None, Some(MAX_POLICY_SECONDS + 1)),
            policy(Some(MAX_POLICY_SECONDS + 1), None),
            policy(Some(600), Some(600)),
            policy(Some(900), Some(600)),
        ];
        for policy in bad {
            let shown = format!("{policy:?}");
            assert!(
                matches!(
                    usage.set_policy("youtube.com", policy),
                    Err(Error::InvalidUsage(_))
                ),
                "{shown}"
            );
        }
        for host in ["", "A.com", "https://a.com", "a.com/path"] {
            assert!(
                matches!(
                    usage.set_policy(host, policy(Some(60), Some(120))),
                    Err(Error::InvalidUsage(_))
                ),
                "{host}"
            );
        }
        assert!(usage.policies().unwrap().is_empty());
    }

    #[test]
    fn clearing_the_stats_keeps_the_policies() {
        let (dir, usage) = usage();
        usage
            .record("2026-11-08", "youtube.com", "/watch", 7)
            .unwrap();
        usage
            .set_policy("youtube.com", policy(Some(300), Some(3600)))
            .unwrap();
        usage.clear().unwrap();
        let reloaded = reload(&dir);
        assert_eq!(reloaded.report("2026-11-08", 30).unwrap().total_seconds, 0);
        assert_eq!(
            reloaded.policies().unwrap().get("youtube.com"),
            Some(&policy(Some(300), Some(3600)))
        );
    }

    #[test]
    fn a_site_at_its_limit_stops_accruing_time() {
        let (_dir, usage) = usage();
        usage
            .set_policy("youtube.com", policy(Some(300), Some(600)))
            .unwrap();
        usage
            .record("2026-11-08", "youtube.com", "/watch", 600)
            .unwrap();
        usage
            .record("2026-11-08", "youtube.com", "/watch", 60)
            .unwrap();
        assert_eq!(usage.report("2026-11-08", 1).unwrap().sites[0].seconds, 600);
        // Another day counts on its own.
        usage
            .record("2026-11-09", "youtube.com", "/watch", 60)
            .unwrap();
        assert_eq!(usage.report("2026-11-09", 1).unwrap().sites[0].seconds, 60);
    }

    #[test]
    fn a_limit_covers_the_domains_around_the_site() {
        let (_dir, usage) = usage();
        usage
            .set_policy("youtube.com", policy(None, Some(600)))
            .unwrap();
        usage
            .record("2026-11-08", "m.youtube.com", "/watch", 600)
            .unwrap();
        usage
            .record("2026-11-08", "m.youtube.com", "/watch", 60)
            .unwrap();
        assert_eq!(usage.report("2026-11-08", 1).unwrap().sites[0].seconds, 600);
        // A lookalike domain is a site of its own.
        usage
            .record("2026-11-08", "notyoutube.com", "/", 60)
            .unwrap();
        assert_eq!(usage.report("2026-11-08", 1).unwrap().total_seconds, 660);
    }

    #[test]
    fn an_existing_file_without_policies_still_loads() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("usage.json");
        fs::write(
            &path,
            r#"{"version":1,"days":{"2026-11-08":{"a.com":{"/":5}}}}"#,
        )
        .unwrap();
        let usage = Usage::load(path).unwrap();
        assert_eq!(usage.report("2026-11-08", 1).unwrap().total_seconds, 5);
        assert!(usage.policies().unwrap().is_empty());
    }

    #[test]
    fn caps_the_number_of_sites_with_a_limit() {
        let (_dir, usage) = usage();
        for i in 0..MAX_POLICY_HOSTS {
            usage
                .set_policy(&format!("h{i}.com"), policy(None, Some(600)))
                .unwrap();
        }
        assert!(matches!(
            usage.set_policy("one-too-many.com", policy(None, Some(600))),
            Err(Error::InvalidUsage(_))
        ));
    }

    #[test]
    fn sites_stored_under_a_public_suffix_are_retired() {
        let (dir, usage) = usage();
        usage.record("2026-11-08", "github.io", "/", 60).unwrap();
        usage.record("2026-11-08", "youtube.com", "/", 30).unwrap();
        usage.record("2026-11-08", "localhost", "/", 10).unwrap();
        usage
            .set_policy("github.io", policy(Some(300), Some(600)))
            .unwrap();
        usage
            .set_policy("youtube.com", policy(None, Some(900)))
            .unwrap();
        let favorites = vec!["alice.github.io".to_owned(), "www.example.org".to_owned()];

        usage.retire_public_suffix_sites(&favorites).unwrap();

        for usage in [&usage, &reload(&dir)] {
            let report = usage.report("2026-11-08", 1).unwrap();
            let sites: Vec<&str> = report.sites.iter().map(|s| s.host.as_str()).collect();
            assert_eq!(report.total_seconds, 40);
            assert!(sites.contains(&"youtube.com") && sites.contains(&"localhost"));
            let policies = usage.policies().unwrap();
            assert_eq!(
                policies.keys().map(String::as_str).collect::<Vec<_>>(),
                ["alice.github.io", "youtube.com"]
            );
            assert_eq!(policies["alice.github.io"], policy(Some(300), Some(600)));
        }
    }

    #[test]
    fn retiring_with_nothing_stale_changes_nothing() {
        let (dir, usage) = usage();
        usage.record("2026-11-08", "youtube.com", "/", 30).unwrap();
        let before = std::fs::read(dir.path().join("usage.json")).unwrap();
        usage.retire_public_suffix_sites(&[]).unwrap();
        assert_eq!(
            std::fs::read(dir.path().join("usage.json")).unwrap(),
            before
        );
    }
}
