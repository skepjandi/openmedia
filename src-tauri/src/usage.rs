use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    sync::{Mutex, MutexGuard},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::library::write_atomically;
use crate::recipes::OptionValue;
use crate::schedule::Schedule;
use crate::usage_lock::{LockData, LockStatus, limit_relaxed, pause_relaxed};
use tauri_plugin_siteview::site::{is_public_suffix, registrable_domain};

const FORMAT_VERSION: u32 = 1;
/// Days of history kept on disk, counting today.
pub const RETAINED_DAYS: u32 = 30;
const MAX_HOSTS_PER_DAY: usize = 200;
const MAX_SECTIONS_PER_HOST: usize = 60;
/// How many sites may carry a daily warning or limit.
pub const MAX_POLICY_HOSTS: usize = 200;
/// How many parts of one site may carry a daily warning or limit.
pub const MAX_SECTION_POLICIES: usize = 60;
/// The largest threshold a policy may set: a whole day.
pub const MAX_POLICY_SECONDS: u32 = 86_400;
/// One flush never covers more than this; the shell flushes every few seconds.
pub const MAX_SECONDS_PER_RECORD: u32 = 3600;
const MAX_HOST_CHARS: usize = 253;
const MAX_SECTION_CHARS: usize = 24;
/// The shortest and longest pause-screen delay a site may carry.
pub const MIN_PAUSE_SECONDS: u32 = 3;
pub const MAX_PAUSE_SECONDS: u32 = 120;
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
    /// The daily warning and limit the user set for a part of a site, per host and per
    /// section, such as Reels inside Instagram.
    #[serde(default)]
    section_policies: SectionPolicies,
    /// The times of day each site is closed. Files from before schedules existed have none.
    #[serde(default)]
    schedules: Schedules,
    /// The pause-screen delay of each site.
    #[serde(default)]
    pauses: Pauses,
    /// Whether pause screens show at all; on unless the user turned them off.
    #[serde(default = "pauses_on")]
    pause_enabled: bool,
    /// The settings lock and its cooling-off request.
    #[serde(default)]
    lock: LockData,
}

fn pauses_on() -> bool {
    true
}

/// Everything the settings lock guards, copied so a refused or failed change can be undone.
struct Rules {
    policies: UsagePolicies,
    section_policies: SectionPolicies,
    schedules: Schedules,
    pauses: Pauses,
    pause_enabled: bool,
    lock: LockData,
}

impl UsageData {
    fn empty() -> Self {
        Self {
            version: FORMAT_VERSION,
            days: BTreeMap::new(),
            policies: UsagePolicies::new(),
            section_policies: SectionPolicies::new(),
            schedules: Schedules::new(),
            pauses: Pauses::new(),
            pause_enabled: true,
            lock: LockData::default(),
        }
    }

    fn rules(&self) -> Rules {
        Rules {
            policies: self.policies.clone(),
            section_policies: self.section_policies.clone(),
            schedules: self.schedules.clone(),
            pauses: self.pauses.clone(),
            pause_enabled: self.pause_enabled,
            lock: self.lock.clone(),
        }
    }

    fn restore(&mut self, rules: Rules) {
        self.policies = rules.policies;
        self.section_policies = rules.section_policies;
        self.schedules = rules.schedules;
        self.pauses = rules.pauses;
        self.pause_enabled = rules.pause_enabled;
        self.lock = rules.lock;
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

/// The policy of every part of a site the user set one for, keyed by host and then by section.
pub type SectionPolicies = BTreeMap<String, UsagePolicies>;

/// The downtime schedule of every site the user set one for, keyed by host.
pub type Schedules = BTreeMap<String, Schedule>;

/// The pause-screen delay in seconds of every site the user set one for, keyed by host.
pub type Pauses = BTreeMap<String, u32>;

/// Every rule the user set: limits for whole sites and for parts of them, downtime schedules and
/// pause screens.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageLimits {
    /// The limit of every site, keyed by host.
    pub sites: UsagePolicies,
    /// The limit of every part of a site, keyed by host and then by section.
    pub sections: SectionPolicies,
    /// The downtime of every site, keyed by host.
    pub schedules: Schedules,
    /// The pause-screen delay of every site, keyed by host.
    pub pauses: Pauses,
    /// The global switch for pause screens; off means no site shows one, whatever its delay.
    pub pause_enabled: bool,
}

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
    /// The name of the recipe that covers the site, when one does; filled in by the command.
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
/// the library stays small, and it never leaves the device. The same file holds the rules the
/// user set around that time: limits, schedules, pause screens and the settings lock.
pub struct Usage {
    path: PathBuf,
    data: Mutex<UsageData>,
    /// Seconds since the Unix epoch. Only the settings lock reads it, to time its cooling-off
    /// period; everything else works on the local date the shell passes.
    clock: Box<dyn Fn() -> i64 + Send + Sync>,
}

impl Usage {
    /// A missing, corrupt or newer-format file starts empty: these numbers are disposable.
    pub fn load(path: PathBuf) -> Result<Self> {
        Self::load_with_clock(path, Box::new(unix_now))
    }

    fn load_with_clock(path: PathBuf, clock: Box<dyn Fn() -> i64 + Send + Sync>) -> Result<Self> {
        let data = match fs::read_to_string(&path) {
            Ok(text) => parse(&text),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => UsageData::empty(),
            Err(e) => return Err(e.into()),
        };
        Ok(Self {
            path,
            data: Mutex::new(data),
            clock,
        })
    }

    /// Adds `seconds` to a site section for `day`, then drops days older than the retention
    /// window counted back from the newest recorded day. Sites or sections beyond the per-day caps are not recorded.
    /// A site that has reached its daily limit does not accrue more time: the app closes it, so
    /// the seconds it would earn are never counted. A part of a site that has reached its own
    /// daily limit stops accruing time as well, while the rest of the site keeps counting.
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
        if reached_limit(&data, day, host) || reached_section_limit(&data, day, host, section) {
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

    /// Every limit the user set: for whole sites and for the parts of them, plus the schedules and
    /// pause screens that sit beside them.
    pub fn limits(&self) -> Result<UsageLimits> {
        let data = self.lock()?;
        Ok(limits_of(&data))
    }

    /// Saves the daily warning and limit for one site, and returns every limit. A policy with
    /// neither step removes the site's policy, which is how a limit is lifted. While the settings
    /// lock is on, a higher or removed threshold is refused.
    pub fn set_limit(&self, host: &str, policy: UsagePolicy) -> Result<UsageLimits> {
        if !valid_host(host) {
            return Err(Error::InvalidUsage("invalid host"));
        }
        check_policy(&policy)?;
        self.change(|data| {
            let relaxing = policy_relaxed(data.policies.get(host), &policy);
            if policy.is_unset() {
                data.policies.remove(host);
            } else {
                if !data.policies.contains_key(host) && data.policies.len() >= MAX_POLICY_HOSTS {
                    return Err(Error::InvalidUsage("too many sites carry a limit"));
                }
                data.policies.insert(host.to_owned(), policy);
            }
            Ok(relaxing)
        })
    }

    /// Saves the daily warning and limit for one part of a site, and returns every limit. A
    /// policy with neither step removes the part's policy, which is how a limit is lifted. The
    /// settings lock refuses a relaxation the same way as for a whole site.
    pub fn set_section_limit(
        &self,
        host: &str,
        section: &str,
        policy: UsagePolicy,
    ) -> Result<UsageLimits> {
        if !valid_host(host) {
            return Err(Error::InvalidUsage("invalid host"));
        }
        if !valid_section(section) {
            return Err(Error::InvalidUsage("invalid section"));
        }
        check_policy(&policy)?;
        self.change(|data| {
            let known = data.section_policies.get(host);
            let relaxing = policy_relaxed(known.and_then(|parts| parts.get(section)), &policy);
            if !policy.is_unset() {
                let parts = known.map(|parts| parts.len()).unwrap_or(0);
                let is_new = !known.is_some_and(|parts| parts.contains_key(section));
                if known.is_none() && data.section_policies.len() >= MAX_POLICY_HOSTS {
                    return Err(Error::InvalidUsage("too many sites carry a limit"));
                }
                if is_new && parts >= MAX_SECTION_POLICIES {
                    return Err(Error::InvalidUsage(
                        "too many parts of a site carry a limit",
                    ));
                }
            }
            let parts = data.section_policies.entry(host.to_owned()).or_default();
            if policy.is_unset() {
                parts.remove(section);
            } else {
                parts.insert(section.to_owned(), policy);
            }
            if parts.is_empty() {
                data.section_policies.remove(host);
            }
            Ok(relaxing)
        })
    }

    /// Saves the downtime schedule of one site and returns every limit. A schedule without
    /// windows removes it. While the settings lock is on, a schedule that leaves the site open
    /// at a time the old one closed it is refused.
    pub fn set_schedule(&self, host: &str, schedule: Schedule) -> Result<UsageLimits> {
        if !valid_host(host) {
            return Err(Error::InvalidUsage("invalid host"));
        }
        schedule.check()?;
        self.change(|data| {
            let relaxing = data
                .schedules
                .get(host)
                .is_some_and(|old| !old.is_contained_in(&schedule));
            if schedule.is_empty() {
                data.schedules.remove(host);
            } else {
                if !data.schedules.contains_key(host) && data.schedules.len() >= MAX_POLICY_HOSTS {
                    return Err(Error::InvalidUsage("too many sites carry a schedule"));
                }
                data.schedules.insert(host.to_owned(), schedule);
            }
            Ok(relaxing)
        })
    }

    /// Saves the pause-screen delay of one site, or removes it with `None`, and returns every
    /// limit. While the settings lock is on, a shorter delay or none is refused.
    pub fn set_pause(&self, host: &str, seconds: Option<u32>) -> Result<UsageLimits> {
        if !valid_host(host) {
            return Err(Error::InvalidUsage("invalid host"));
        }
        if seconds
            .is_some_and(|seconds| !(MIN_PAUSE_SECONDS..=MAX_PAUSE_SECONDS).contains(&seconds))
        {
            return Err(Error::InvalidUsage(
                "a pause must be between 3 and 120 seconds",
            ));
        }
        self.change(|data| {
            let relaxing = pause_relaxed(data.pauses.get(host).copied(), seconds);
            match seconds {
                None => {
                    data.pauses.remove(host);
                }
                Some(seconds) => {
                    if !data.pauses.contains_key(host) && data.pauses.len() >= MAX_POLICY_HOSTS {
                        return Err(Error::InvalidUsage("too many sites carry a pause"));
                    }
                    data.pauses.insert(host.to_owned(), seconds);
                }
            }
            Ok(relaxing)
        })
    }

    /// Turns every pause screen on or off at once, keeping each site's delay. While the settings
    /// lock is on, turning them off is refused.
    pub fn set_pause_enabled(&self, enabled: bool) -> Result<UsageLimits> {
        self.change(|data| {
            let relaxing = data.pause_enabled && !enabled;
            data.pause_enabled = enabled;
            Ok(relaxing)
        })
    }

    /// Where the settings lock stands now.
    pub fn lock_status(&self) -> Result<LockStatus> {
        Ok(self.lock()?.lock.status((self.clock)()))
    }

    /// Turns the settings lock on. Always allowed: it only restricts.
    pub fn enable_lock(&self) -> Result<LockStatus> {
        self.change_lock(|lock, _| {
            lock.enable();
            Ok(())
        })
    }

    /// Starts the 24 hour cooling-off period before the lock may be relaxed. A request already
    /// running keeps its time.
    pub fn request_unlock(&self) -> Result<LockStatus> {
        self.change_lock(|lock, now| lock.request_unlock(now))
    }

    /// Cancels an unlock request, during the wait or after it, and keeps the lock on.
    pub fn cancel_unlock(&self) -> Result<LockStatus> {
        self.change_lock(|lock, _| {
            lock.cancel_unlock();
            Ok(())
        })
    }

    /// Lifts the lock without changing anything, once the cooling-off period is over.
    pub fn lift_lock(&self) -> Result<LockStatus> {
        self.change_lock(|lock, now| lock.lift(now))
    }

    /// Marks a recipe option protected at `value`, the value it has now. Always allowed.
    pub fn protect_option(
        &self,
        recipe_id: &str,
        option_id: &str,
        value: OptionValue,
    ) -> Result<LockStatus> {
        self.change_lock(|lock, _| lock.protect(recipe_id, option_id, value))
    }

    /// Removes the protection mark. While the lock is on this is a relaxation.
    pub fn unprotect_option(&self, recipe_id: &str, option_id: &str) -> Result<LockStatus> {
        self.change_lock(|lock, now| {
            let relaxing = lock.enabled && lock.protected_value(recipe_id, option_id).is_some();
            lock.allow(relaxing, now)?;
            lock.unprotect(recipe_id, option_id);
            Ok(())
        })
    }

    /// Checks a write to a recipe option against the settings lock. While the lock is on, a
    /// protected option may only keep the value it was marked with; any other value is a
    /// relaxation. Call before saving the option.
    pub fn check_option_write(
        &self,
        recipe_id: &str,
        option_id: &str,
        value: &OptionValue,
    ) -> Result<()> {
        let enabled_and_marked = |lock: &LockData| {
            lock.enabled
                && lock
                    .protected_value(recipe_id, option_id)
                    .is_some_and(|marked| marked != value)
        };
        if !enabled_and_marked(&self.lock()?.lock) {
            return Ok(());
        }
        self.change_lock(|lock, now| lock.allow(true, now))?;
        Ok(())
    }

    /// Applies `edit` to the rules, then lets the settings lock judge it: `edit` reports whether
    /// it relaxed anything. A refused or failed change leaves every rule as it was.
    fn change(&self, edit: impl FnOnce(&mut UsageData) -> Result<bool>) -> Result<UsageLimits> {
        let now = (self.clock)();
        let mut data = self.lock()?;
        let before = data.rules();
        let outcome = edit(&mut data)
            .and_then(|relaxing| data.lock.allow(relaxing, now))
            .and_then(|()| self.save(&data));
        if let Err(error) = outcome {
            data.restore(before);
            return Err(error);
        }
        Ok(limits_of(&data))
    }

    /// Applies `edit` to the settings lock alone and saves it.
    fn change_lock(
        &self,
        edit: impl FnOnce(&mut LockData, i64) -> Result<()>,
    ) -> Result<LockStatus> {
        let now = (self.clock)();
        let mut data = self.lock()?;
        let before = data.lock.clone();
        if let Err(error) = edit(&mut data.lock, now).and_then(|()| self.save(&data)) {
            data.lock = before;
            return Err(error);
        }
        Ok(data.lock.status(now))
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
        let stale_parts: Vec<String> = data
            .section_policies
            .keys()
            .filter(|site| is_public_suffix(site))
            .cloned()
            .collect();
        for suffix in stale_parts {
            let Some(parts) = data.section_policies.remove(&suffix) else {
                continue;
            };
            let under = format!(".{suffix}");
            for host in favorite_hosts.iter().filter(|host| host.ends_with(&under)) {
                let Some(site) = registrable_domain(host) else {
                    continue;
                };
                let target = data.section_policies.entry(site).or_default();
                for (section, policy) in &parts {
                    target.entry(section.clone()).or_insert(policy.clone());
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

/// Every limit the user set, with the schedules and pause screens beside them.
fn limits_of(data: &UsageData) -> UsageLimits {
    UsageLimits {
        sites: data.policies.clone(),
        sections: data.section_policies.clone(),
        schedules: data.schedules.clone(),
        pauses: data.pauses.clone(),
        pause_enabled: data.pause_enabled,
    }
}

/// True when moving to `new` lets a site use more than `old` did: a higher or dropped threshold.
/// A site that had no policy cannot be relaxed by adding one.
fn policy_relaxed(old: Option<&UsagePolicy>, new: &UsagePolicy) -> bool {
    old.is_some_and(|old| {
        limit_relaxed(old.warn_seconds, new.warn_seconds)
            || limit_relaxed(old.limit_seconds, new.limit_seconds)
    })
}

/// True when the site has already used up its daily limit on `day`.
fn reached_limit(data: &UsageData, day: &str, host: &str) -> bool {
    let Some(policy) = policy_for_host(&data.policies, host) else {
        return false;
    };
    let Some(limit) = policy.limit_seconds else {
        return false;
    };
    site_seconds(data, day, host) >= u64::from(limit)
}

/// The seconds a site used on `day`, counting the domains around it, the way the shell
/// counts them; see `usageSeconds` in `src/features/stats/policy.ts`.
fn site_seconds(data: &UsageData, day: &str, host: &str) -> u64 {
    data.days
        .get(day)
        .map(|hosts| {
            hosts
                .iter()
                .filter(|(site, _)| same_site(host, site))
                .map(|(_, sections)| sections.values().sum::<u64>())
                .sum()
        })
        .unwrap_or(0)
}

/// The seconds one part of a site used on `day`, counting the domains around it.
fn section_seconds(data: &UsageData, day: &str, host: &str, section: &str) -> u64 {
    data.days
        .get(day)
        .map(|hosts| {
            hosts
                .iter()
                .filter(|(site, _)| same_site(host, site))
                .filter_map(|(_, sections)| sections.get(section))
                .sum()
        })
        .unwrap_or(0)
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

/// True when the part of the site has already used up its daily limit on `day`.
fn reached_section_limit(data: &UsageData, day: &str, host: &str, section: &str) -> bool {
    let Some(policy) = section_policy_for_host(&data.section_policies, host, section) else {
        return false;
    };
    let Some(limit) = policy.limit_seconds else {
        return false;
    };
    section_seconds(data, day, host, section) >= u64::from(limit)
}

/// The policy that applies to one part of a site: the strictest one among the host itself and
/// the domains around it, for the same section.
fn section_policy_for_host(
    policies: &SectionPolicies,
    host: &str,
    section: &str,
) -> Option<UsagePolicy> {
    policies
        .iter()
        .filter(|(site, _)| same_site(host, site))
        .filter_map(|(_, parts)| parts.get(section))
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

/// Seconds since the Unix epoch; a clock set before 1970 reads as 0.
fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|elapsed| i64::try_from(elapsed.as_secs()).ok())
        .unwrap_or(0)
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
            concat!(
                r#"{"version":1,"days":{"2026-11-08":{"youtube.com":{"/watch":7}}},"#,
                r#""policies":{},"section_policies":{},"schedules":{},"pauses":{},"#,
                r#""pause_enabled":true,"lock":{"enabled":false,"unlockRequestedAt":null,"#,
                r#""protectedOptions":{}}}"#
            )
        );
    }

    fn policy(warn: Option<u32>, limit: Option<u32>) -> UsagePolicy {
        UsagePolicy {
            warn_seconds: warn,
            limit_seconds: limit,
        }
    }

    #[test]
    fn limits_persist_and_survive_a_reload() {
        let (dir, usage) = usage();
        let limits = usage
            .set_limit("youtube.com", policy(Some(300), Some(3600)))
            .unwrap();
        assert_eq!(limits.sites.len(), 1);
        assert_eq!(
            limits.sites.get("youtube.com"),
            Some(&policy(Some(300), Some(3600)))
        );
        let reloaded = reload(&dir);
        assert_eq!(
            reloaded.limits().unwrap().sites.get("youtube.com"),
            Some(&policy(Some(300), Some(3600)))
        );
        // A policy with only a limit is a policy too.
        usage
            .set_limit("reddit.com", policy(None, Some(600)))
            .unwrap();
        assert_eq!(
            reload(&dir).limits().unwrap().sites.get("reddit.com"),
            Some(&policy(None, Some(600)))
        );
    }

    #[test]
    fn a_policy_with_neither_step_removes_the_site() {
        let (dir, usage) = usage();
        usage
            .set_limit("youtube.com", policy(Some(300), None))
            .unwrap();
        let limits = usage.set_limit("youtube.com", policy(None, None)).unwrap();
        assert!(limits.sites.is_empty());
        assert!(reload(&dir).limits().unwrap().sites.is_empty());
    }

    #[test]
    fn part_limits_persist_and_survive_a_reload() {
        let (dir, usage) = usage();
        let limits = usage
            .set_section_limit("youtube.com", "/watch", policy(Some(300), Some(1800)))
            .unwrap();
        assert_eq!(
            limits
                .sections
                .get("youtube.com")
                .and_then(|parts| parts.get("/watch")),
            Some(&policy(Some(300), Some(1800)))
        );
        assert!(limits.sites.is_empty());
        let reloaded = reload(&dir);
        assert_eq!(
            reloaded
                .limits()
                .unwrap()
                .sections
                .get("youtube.com")
                .and_then(|parts| parts.get("/watch")),
            Some(&policy(Some(300), Some(1800)))
        );
    }

    #[test]
    fn a_policy_with_neither_step_removes_the_part() {
        let (dir, usage) = usage();
        usage
            .set_section_limit("youtube.com", "/watch", policy(Some(300), None))
            .unwrap();
        let limits = usage
            .set_section_limit("youtube.com", "/watch", policy(None, None))
            .unwrap();
        assert!(limits.sections.is_empty());
        assert!(reload(&dir).limits().unwrap().sections.is_empty());
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
                    usage.set_limit("youtube.com", policy),
                    Err(Error::InvalidUsage(_))
                ),
                "{shown}"
            );
        }
        for host in ["", "A.com", "https://a.com", "a.com/path"] {
            assert!(
                matches!(
                    usage.set_limit(host, policy(Some(60), Some(120))),
                    Err(Error::InvalidUsage(_))
                ),
                "{host}"
            );
        }
        assert!(usage.limits().unwrap().sites.is_empty());
    }

    #[test]
    fn rejects_invalid_parts() {
        let (_dir, usage) = usage();
        for host in ["", "A.com", "https://a.com", "a.com/path"] {
            assert!(
                matches!(
                    usage.set_section_limit(host, "/watch", policy(Some(60), Some(120))),
                    Err(Error::InvalidUsage(_))
                ),
                "{host}"
            );
        }
        for section in ["", "watch", "/Watch", "/@user", "/ünï"] {
            assert!(
                matches!(
                    usage.set_section_limit("youtube.com", section, policy(Some(60), Some(120))),
                    Err(Error::InvalidUsage(_))
                ),
                "{section}"
            );
        }
        assert!(usage.limits().unwrap().sections.is_empty());
    }

    #[test]
    fn clearing_the_stats_keeps_the_limits() {
        let (dir, usage) = usage();
        usage
            .record("2026-11-08", "youtube.com", "/watch", 7)
            .unwrap();
        usage
            .set_limit("youtube.com", policy(Some(300), Some(3600)))
            .unwrap();
        usage
            .set_section_limit("youtube.com", "/watch", policy(None, Some(900)))
            .unwrap();
        usage.clear().unwrap();
        let reloaded = reload(&dir);
        assert_eq!(reloaded.report("2026-11-08", 30).unwrap().total_seconds, 0);
        let limits = reloaded.limits().unwrap();
        assert_eq!(
            limits.sites.get("youtube.com"),
            Some(&policy(Some(300), Some(3600)))
        );
        assert_eq!(
            limits
                .sections
                .get("youtube.com")
                .and_then(|parts| parts.get("/watch")),
            Some(&policy(None, Some(900)))
        );
    }

    #[test]
    fn a_site_at_its_limit_stops_accruing_time() {
        let (_dir, usage) = usage();
        usage
            .set_limit("youtube.com", policy(Some(300), Some(600)))
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
    fn a_part_at_its_limit_stops_accruing_time_while_the_site_keeps_counting() {
        let (_dir, usage) = usage();
        usage
            .set_section_limit("youtube.com", "/watch", policy(Some(300), Some(600)))
            .unwrap();
        usage
            .record("2026-11-08", "youtube.com", "/watch", 600)
            .unwrap();
        usage
            .record("2026-11-08", "youtube.com", "/watch", 60)
            .unwrap();
        usage
            .record("2026-11-08", "youtube.com", "/shorts", 30)
            .unwrap();
        let report = usage.report("2026-11-08", 1).unwrap();
        assert_eq!(report.sites[0].seconds, 630);
        assert_eq!(
            report.sites[0]
                .sections
                .iter()
                .find(|section| section.section == "/watch")
                .map(|section| section.seconds),
            Some(600)
        );
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
            .set_limit("youtube.com", policy(None, Some(600)))
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
    fn a_part_limit_covers_the_domains_around_the_site() {
        let (_dir, usage) = usage();
        usage
            .set_section_limit("youtube.com", "/watch", policy(None, Some(600)))
            .unwrap();
        usage
            .record("2026-11-08", "m.youtube.com", "/watch", 600)
            .unwrap();
        usage
            .record("2026-11-08", "m.youtube.com", "/watch", 60)
            .unwrap();
        assert_eq!(usage.report("2026-11-08", 1).unwrap().sites[0].seconds, 600);
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
        let limits = usage.limits().unwrap();
        assert!(limits.sites.is_empty());
        assert!(limits.sections.is_empty());
    }

    #[test]
    fn caps_the_number_of_sites_with_a_limit() {
        let (_dir, usage) = usage();
        for i in 0..MAX_POLICY_HOSTS {
            usage
                .set_limit(&format!("h{i}.com"), policy(None, Some(600)))
                .unwrap();
        }
        assert!(matches!(
            usage.set_limit("one-too-many.com", policy(None, Some(600))),
            Err(Error::InvalidUsage(_))
        ));
    }

    #[test]
    fn caps_the_number_of_parts_within_a_site() {
        let (_dir, usage) = usage();
        for i in 0..MAX_SECTION_POLICIES {
            usage
                .set_section_limit("youtube.com", &format!("/p{i}"), policy(None, Some(600)))
                .unwrap();
        }
        assert!(matches!(
            usage.set_section_limit("youtube.com", "/one-too-many", policy(None, Some(600))),
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
            .set_limit("github.io", policy(Some(300), Some(600)))
            .unwrap();
        usage
            .set_limit("youtube.com", policy(None, Some(900)))
            .unwrap();
        usage
            .set_section_limit("github.io", "/watch", policy(None, Some(300)))
            .unwrap();
        let favorites = vec!["alice.github.io".to_owned(), "www.example.org".to_owned()];

        usage.retire_public_suffix_sites(&favorites).unwrap();

        for usage in [&usage, &reload(&dir)] {
            let report = usage.report("2026-11-08", 1).unwrap();
            let sites: Vec<&str> = report.sites.iter().map(|s| s.host.as_str()).collect();
            assert_eq!(report.total_seconds, 40);
            assert!(sites.contains(&"youtube.com") && sites.contains(&"localhost"));
            let limits = usage.limits().unwrap();
            assert_eq!(
                limits.sites.keys().map(String::as_str).collect::<Vec<_>>(),
                ["alice.github.io", "youtube.com"]
            );
            assert_eq!(
                limits.sites["alice.github.io"],
                policy(Some(300), Some(600))
            );
            assert_eq!(
                limits
                    .sections
                    .get("alice.github.io")
                    .and_then(|parts| parts.get("/watch")),
                Some(&policy(None, Some(300)))
            );
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

#[cfg(test)]
mod time_controls_tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicI64, Ordering};

    use super::*;
    use crate::schedule::ScheduleWindow;
    use crate::usage_lock::{COOLING_OFF_SECONDS, LockPhase};

    const START: i64 = 1_800_000_000;

    struct Harness {
        dir: tempfile::TempDir,
        clock: Arc<AtomicI64>,
        usage: Usage,
    }

    fn harness() -> Harness {
        let dir = tempfile::tempdir().unwrap();
        let clock = Arc::new(AtomicI64::new(START));
        let shared = Arc::clone(&clock);
        let usage = Usage::load_with_clock(
            dir.path().join("usage.json"),
            Box::new(move || shared.load(Ordering::SeqCst)),
        )
        .unwrap();
        Harness { dir, clock, usage }
    }

    impl Harness {
        fn advance(&self, seconds: i64) {
            self.clock.fetch_add(seconds, Ordering::SeqCst);
        }

        fn reload(&self) -> Usage {
            let shared = Arc::clone(&self.clock);
            Usage::load_with_clock(
                self.dir.path().join("usage.json"),
                Box::new(move || shared.load(Ordering::SeqCst)),
            )
            .unwrap()
        }
    }

    fn policy(warn: Option<u32>, limit: Option<u32>) -> UsagePolicy {
        UsagePolicy {
            warn_seconds: warn,
            limit_seconds: limit,
        }
    }

    fn night(start: u16, end: u16) -> Schedule {
        Schedule {
            windows: vec![ScheduleWindow {
                days: 0b111_1111,
                start_minute: start,
                end_minute: end,
            }],
        }
    }

    fn is_locked<T: std::fmt::Debug>(result: Result<T>) -> bool {
        matches!(result, Err(Error::UsageLocked))
    }

    #[test]
    fn schedules_and_pauses_persist_and_old_files_load_without_them() {
        let h = harness();
        h.usage
            .set_schedule("youtube.com", night(1320, 420))
            .unwrap();
        h.usage.set_pause("youtube.com", Some(10)).unwrap();
        h.usage.set_pause_enabled(false).unwrap();
        let limits = h.reload().limits().unwrap();
        assert_eq!(limits.schedules["youtube.com"], night(1320, 420));
        assert_eq!(limits.pauses["youtube.com"], 10);
        assert!(!limits.pause_enabled);

        let old = r#"{"version":1,"days":{},"policies":{"a.com":{"warnSeconds":null,"limitSeconds":60}}}"#;
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("usage.json"), old).unwrap();
        let loaded = Usage::load(dir.path().join("usage.json")).unwrap();
        let limits = loaded.limits().unwrap();
        assert_eq!(limits.sites["a.com"].limit_seconds, Some(60));
        assert!(limits.schedules.is_empty() && limits.pauses.is_empty());
        assert!(limits.pause_enabled, "pause screens default to on");
        assert_eq!(loaded.lock_status().unwrap().phase, LockPhase::Off);
    }

    #[test]
    fn a_schedule_is_validated_and_an_empty_one_removes_it() {
        let h = harness();
        assert!(h.usage.set_schedule("Bad Host", night(0, 60)).is_err());
        assert!(h.usage.set_schedule("a.com", night(60, 60)).is_err());
        h.usage.set_schedule("a.com", night(1320, 420)).unwrap();
        let limits = h.usage.set_schedule("a.com", Schedule::default()).unwrap();
        assert!(limits.schedules.is_empty());
    }

    #[test]
    fn pauses_are_validated() {
        let h = harness();
        assert!(h.usage.set_pause("a.com", Some(2)).is_err());
        assert!(h.usage.set_pause("a.com", Some(121)).is_err());
        h.usage.set_pause("a.com", Some(5)).unwrap();
        let limits = h.usage.set_pause("a.com", None).unwrap();
        assert!(limits.pauses.is_empty());
    }

    #[test]
    fn without_a_lock_every_change_is_allowed() {
        let h = harness();
        h.usage.set_limit("a.com", policy(None, Some(600))).unwrap();
        h.usage
            .set_limit("a.com", policy(None, Some(6000)))
            .unwrap();
        h.usage.set_limit("a.com", policy(None, None)).unwrap();
        h.usage.set_pause("a.com", Some(30)).unwrap();
        h.usage.set_pause("a.com", Some(5)).unwrap();
    }

    #[test]
    fn a_locked_lock_lets_limits_get_stricter_and_refuses_the_rest() {
        let h = harness();
        h.usage
            .set_limit("a.com", policy(Some(300), Some(600)))
            .unwrap();
        h.usage.enable_lock().unwrap();

        h.usage
            .set_limit("a.com", policy(Some(200), Some(500)))
            .unwrap();
        h.usage.set_limit("b.com", policy(None, Some(900))).unwrap();
        assert!(is_locked(
            h.usage.set_limit("a.com", policy(Some(200), Some(501)))
        ));
        assert!(is_locked(
            h.usage.set_limit("a.com", policy(None, Some(500)))
        ));
        assert!(is_locked(h.usage.set_limit("a.com", policy(None, None))));
        assert!(is_locked(
            h.usage.set_limit("b.com", policy(None, Some(901)))
        ));
        let limits = h.usage.limits().unwrap();
        assert_eq!(limits.sites["a.com"], policy(Some(200), Some(500)));
        assert_eq!(limits.sites["b.com"], policy(None, Some(900)));
    }

    #[test]
    fn a_locked_lock_refuses_to_relax_a_part_of_a_site() {
        let h = harness();
        h.usage
            .set_section_limit("a.com", "/watch", policy(None, Some(600)))
            .unwrap();
        h.usage.enable_lock().unwrap();
        h.usage
            .set_section_limit("a.com", "/watch", policy(None, Some(300)))
            .unwrap();
        h.usage
            .set_section_limit("a.com", "/feed", policy(None, Some(300)))
            .unwrap();
        assert!(is_locked(h.usage.set_section_limit(
            "a.com",
            "/watch",
            policy(None, None)
        )));
        assert!(is_locked(h.usage.set_section_limit(
            "a.com",
            "/watch",
            policy(None, Some(301))
        )));
        assert_eq!(
            h.usage.limits().unwrap().sections["a.com"]["/watch"],
            policy(None, Some(300))
        );
    }

    #[test]
    fn a_locked_lock_allows_adding_and_growing_a_schedule_but_not_shrinking_it() {
        let h = harness();
        h.usage.set_schedule("a.com", night(1320, 420)).unwrap();
        h.usage.enable_lock().unwrap();

        h.usage.set_schedule("a.com", night(1260, 480)).unwrap();
        h.usage.set_schedule("b.com", night(0, 60)).unwrap();
        assert!(is_locked(h.usage.set_schedule("a.com", night(1320, 420))));
        assert!(is_locked(h.usage.set_schedule("a.com", night(1260, 479))));
        assert!(is_locked(
            h.usage.set_schedule("a.com", Schedule::default())
        ));
        assert_eq!(
            h.usage.limits().unwrap().schedules["a.com"],
            night(1260, 480)
        );
    }

    #[test]
    fn a_locked_lock_refuses_shorter_and_disabled_pauses() {
        let h = harness();
        h.usage.set_pause("a.com", Some(10)).unwrap();
        h.usage.enable_lock().unwrap();

        h.usage.set_pause("a.com", Some(30)).unwrap();
        h.usage.set_pause("b.com", Some(5)).unwrap();
        assert!(is_locked(h.usage.set_pause("a.com", Some(10))));
        assert!(is_locked(h.usage.set_pause("a.com", None)));
        assert!(is_locked(h.usage.set_pause_enabled(false)));
        h.usage.set_pause_enabled(true).unwrap();
        assert_eq!(h.usage.limits().unwrap().pauses["a.com"], 30);
    }

    #[test]
    fn protected_options_keep_their_value_while_locked() {
        let h = harness();
        let on = OptionValue::Toggle(true);
        let off = OptionValue::Toggle(false);
        h.usage.protect_option("r", "shorts", on.clone()).unwrap();
        h.usage.check_option_write("r", "shorts", &off).unwrap();

        h.usage.enable_lock().unwrap();
        h.usage.check_option_write("r", "shorts", &on).unwrap();
        h.usage.check_option_write("r", "other", &off).unwrap();
        assert!(is_locked(h.usage.check_option_write("r", "shorts", &off)));
        assert!(is_locked(h.usage.unprotect_option("r", "shorts")));
        h.usage.protect_option("r", "other", off).unwrap();
        assert_eq!(h.usage.lock_status().unwrap().protected_options.len(), 2);
    }

    #[test]
    fn unlocking_waits_a_day_then_allows_one_relaxation_and_lifts_the_lock() {
        let h = harness();
        h.usage.set_limit("a.com", policy(None, Some(600))).unwrap();
        h.usage.enable_lock().unwrap();
        assert!(is_locked(h.usage.set_limit("a.com", policy(None, None))));

        let status = h.usage.request_unlock().unwrap();
        assert_eq!(status.phase, LockPhase::CoolingOff);
        assert_eq!(status.remaining_seconds, COOLING_OFF_SECONDS as u64);
        h.advance(COOLING_OFF_SECONDS - 1);
        assert!(is_locked(h.usage.set_limit("a.com", policy(None, None))));
        assert_eq!(h.usage.lock_status().unwrap().remaining_seconds, 1);

        h.advance(1);
        assert_eq!(h.usage.lock_status().unwrap().phase, LockPhase::Ready);
        h.usage.set_limit("a.com", policy(None, None)).unwrap();
        assert_eq!(h.usage.lock_status().unwrap().phase, LockPhase::Off);
        h.usage
            .set_limit("a.com", policy(None, Some(6000)))
            .unwrap();
    }

    #[test]
    fn the_request_time_is_kept_by_rust_across_restarts() {
        let h = harness();
        h.usage.enable_lock().unwrap();
        h.usage.request_unlock().unwrap();
        h.advance(3600);
        let reloaded = h.reload();
        let status = reloaded.lock_status().unwrap();
        assert_eq!(status.phase, LockPhase::CoolingOff);
        assert_eq!(
            status.remaining_seconds,
            (COOLING_OFF_SECONDS - 3600) as u64
        );
    }

    #[test]
    fn cancelling_during_the_wait_keeps_the_lock_and_restarts_nothing() {
        let h = harness();
        h.usage.set_pause("a.com", Some(10)).unwrap();
        h.usage.enable_lock().unwrap();
        h.usage.request_unlock().unwrap();
        h.advance(COOLING_OFF_SECONDS / 2);
        assert_eq!(h.usage.cancel_unlock().unwrap().phase, LockPhase::Locked);
        h.advance(COOLING_OFF_SECONDS);
        assert!(is_locked(h.usage.set_pause("a.com", None)));
    }

    #[test]
    fn lifting_without_a_relaxation_needs_the_wait_too() {
        let h = harness();
        h.usage.enable_lock().unwrap();
        assert!(is_locked(h.usage.lift_lock()));
        h.usage.request_unlock().unwrap();
        assert!(is_locked(h.usage.lift_lock()));
        h.advance(COOLING_OFF_SECONDS);
        assert_eq!(h.usage.lift_lock().unwrap().phase, LockPhase::Off);
    }

    #[test]
    fn a_ready_lock_lifts_on_a_protected_option_write_once() {
        let h = harness();
        h.usage
            .protect_option("r", "shorts", OptionValue::Toggle(true))
            .unwrap();
        h.usage.enable_lock().unwrap();
        h.usage.request_unlock().unwrap();
        h.advance(COOLING_OFF_SECONDS);
        h.usage
            .check_option_write("r", "shorts", &OptionValue::Toggle(false))
            .unwrap();
        assert_eq!(h.usage.lock_status().unwrap().phase, LockPhase::Off);
    }

    #[test]
    fn a_failed_save_leaves_every_rule_and_the_lock_as_they_were() {
        let h = harness();
        h.usage.set_limit("a.com", policy(None, Some(600))).unwrap();
        h.usage.enable_lock().unwrap();
        h.usage.request_unlock().unwrap();
        h.advance(COOLING_OFF_SECONDS);
        let blocker = h.dir.path().join("not-a-folder");
        let broken =
            Usage::load_with_clock(blocker.join("usage.json"), Box::new(|| START)).unwrap();
        std::fs::write(&blocker, "").unwrap();
        broken
            .set_limit("a.com", policy(None, Some(600)))
            .unwrap_err();
        assert!(broken.limits().unwrap().sites.is_empty());
        broken.enable_lock().unwrap_err();
        assert_eq!(broken.lock_status().unwrap().phase, LockPhase::Off);
    }

    #[test]
    fn clearing_usage_keeps_the_lock_and_the_rules() {
        let h = harness();
        h.usage.set_schedule("a.com", night(0, 60)).unwrap();
        h.usage.enable_lock().unwrap();
        h.usage.clear().unwrap();
        assert!(!h.usage.limits().unwrap().schedules.is_empty());
        assert_eq!(h.usage.lock_status().unwrap().phase, LockPhase::Locked);
    }
}
