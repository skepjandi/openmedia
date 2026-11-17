//! The settings lock: a commitment device for usage limits, schedules, pause screens and the
//! recipe options the user marked as protected.
//!
//! While the lock is on, a restriction may be made stricter but never relaxed. To relax one the
//! user asks to unlock, which starts a cooling-off period of 24 hours. When it is over, the next
//! relaxing change is allowed once and the lock lifts with it. Asking again, or cancelling, is
//! always possible during the wait.
//!
//! The request time is a Unix timestamp that lives in `usage.json`, owned by Rust, so the shell
//! cannot move it. This is a promise to oneself, not a security boundary: it does not survive
//! reinstalling the app or moving the device clock, and the file sits on a device the user owns.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::recipes::OptionValue;

/// How long an unlock request must wait before relaxing is allowed.
pub const COOLING_OFF_SECONDS: i64 = 24 * 60 * 60;
/// How many recipe options may be marked protected, across all recipes.
pub const MAX_PROTECTED_OPTIONS: usize = 200;

/// The recipe options the user marked as protected, with the value each had when it was marked:
/// recipe id, then option id. While the lock is on, that value is the only one they may take.
pub type ProtectedOptions = BTreeMap<String, BTreeMap<String, OptionValue>>;

/// What `usage.json` keeps for the lock.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LockData {
    pub enabled: bool,
    /// When the user asked to unlock, in seconds since the Unix epoch.
    pub unlock_requested_at: Option<i64>,
    pub protected_options: ProtectedOptions,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LockPhase {
    /// No lock: every change is allowed.
    Off,
    /// Locked: restrictions can only get stricter.
    Locked,
    /// An unlock was requested and the 24 hours have not passed.
    CoolingOff,
    /// The wait is over: one relaxing change is allowed, and it lifts the lock.
    Ready,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtectedOption {
    pub recipe_id: String,
    pub option_id: String,
}

/// What the shell shows about the lock.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockStatus {
    pub phase: LockPhase,
    /// Seconds of cooling-off left; 0 outside `CoolingOff`.
    pub remaining_seconds: u64,
    pub protected_options: Vec<ProtectedOption>,
}

impl LockData {
    /// Where the lock stands at `now`. A clock moved back never stretches the wait past 24 hours.
    pub fn phase(&self, now: i64) -> LockPhase {
        match (self.enabled, self.unlock_requested_at) {
            (false, _) => LockPhase::Off,
            (true, None) => LockPhase::Locked,
            (true, Some(requested)) if self.remaining(requested, now) == 0 => LockPhase::Ready,
            (true, Some(_)) => LockPhase::CoolingOff,
        }
    }

    fn remaining(&self, requested: i64, now: i64) -> u64 {
        let elapsed = now.saturating_sub(requested).max(0);
        u64::try_from(COOLING_OFF_SECONDS.saturating_sub(elapsed)).unwrap_or(0)
    }

    pub fn status(&self, now: i64) -> LockStatus {
        let phase = self.phase(now);
        let remaining_seconds = match (phase, self.unlock_requested_at) {
            (LockPhase::CoolingOff, Some(requested)) => self.remaining(requested, now),
            _ => 0,
        };
        LockStatus {
            phase,
            remaining_seconds,
            protected_options: self
                .protected_options
                .iter()
                .flat_map(|(recipe_id, options)| {
                    options.keys().map(|option_id| ProtectedOption {
                        recipe_id: recipe_id.clone(),
                        option_id: option_id.clone(),
                    })
                })
                .collect(),
        }
    }

    pub fn enable(&mut self) {
        self.enabled = true;
        self.unlock_requested_at = None;
    }

    /// Starts the cooling-off period. A request already running keeps its original time, so
    /// asking again never restarts or shortens the wait.
    pub fn request_unlock(&mut self, now: i64) -> Result<()> {
        match self.phase(now) {
            LockPhase::Off => Err(Error::InvalidUsage("the lock is not on")),
            LockPhase::Locked => {
                self.unlock_requested_at = Some(now);
                Ok(())
            }
            LockPhase::CoolingOff | LockPhase::Ready => Ok(()),
        }
    }

    /// Drops the request: the lock stays on and the wait is forgotten.
    pub fn cancel_unlock(&mut self) {
        self.unlock_requested_at = None;
    }

    /// Lifts the lock once the wait is over. Before that it is refused.
    pub fn lift(&mut self, now: i64) -> Result<()> {
        match self.phase(now) {
            LockPhase::Off => Ok(()),
            LockPhase::Ready => {
                self.enabled = false;
                self.unlock_requested_at = None;
                Ok(())
            }
            LockPhase::Locked | LockPhase::CoolingOff => Err(Error::UsageLocked),
        }
    }

    /// The gate every change passes. A change that is not a relaxation always passes. A
    /// relaxation passes when the lock is off, and once the wait is over, in which case it lifts
    /// the lock; otherwise it is refused.
    pub fn allow(&mut self, relaxing: bool, now: i64) -> Result<()> {
        if relaxing { self.lift(now) } else { Ok(()) }
    }

    /// Marks an option protected at the value it has now. Allowed any time: it only restricts.
    pub fn protect(&mut self, recipe_id: &str, option_id: &str, value: OptionValue) -> Result<()> {
        let known = self
            .protected_options
            .get(recipe_id)
            .is_some_and(|options| options.contains_key(option_id));
        let count: usize = self.protected_options.values().map(BTreeMap::len).sum();
        if !known && count >= MAX_PROTECTED_OPTIONS {
            return Err(Error::InvalidUsage("too many protected options"));
        }
        self.protected_options
            .entry(recipe_id.to_owned())
            .or_default()
            .insert(option_id.to_owned(), value);
        Ok(())
    }

    /// Removes the mark. Returns whether it was there.
    pub fn unprotect(&mut self, recipe_id: &str, option_id: &str) -> bool {
        let Some(options) = self.protected_options.get_mut(recipe_id) else {
            return false;
        };
        let removed = options.remove(option_id).is_some();
        if options.is_empty() {
            self.protected_options.remove(recipe_id);
        }
        removed
    }

    /// The value a protected option must keep while the lock is on.
    pub fn protected_value(&self, recipe_id: &str, option_id: &str) -> Option<&OptionValue> {
        self.protected_options.get(recipe_id)?.get(option_id)
    }
}

/// True when a threshold in seconds moved to a higher value or was dropped: a limit or a
/// reminder that now allows more.
pub fn limit_relaxed(old: Option<u32>, new: Option<u32>) -> bool {
    old.is_some_and(|old| new.is_none_or(|new| new > old))
}

/// True when a pause delay moved to a shorter one or was dropped: less friction than before.
pub fn pause_relaxed(old: Option<u32>, new: Option<u32>) -> bool {
    old.is_some_and(|old| new.is_none_or(|new| new < old))
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000;

    fn locked() -> LockData {
        let mut lock = LockData::default();
        lock.enable();
        lock
    }

    #[test]
    fn a_new_lock_is_off_and_allows_everything() {
        let mut lock = LockData::default();
        assert_eq!(lock.phase(NOW), LockPhase::Off);
        assert!(lock.allow(true, NOW).is_ok());
        assert!(lock.request_unlock(NOW).is_err());
    }

    #[test]
    fn a_locked_lock_refuses_relaxing_and_allows_tightening() {
        let mut lock = locked();
        assert_eq!(lock.phase(NOW), LockPhase::Locked);
        assert!(lock.allow(false, NOW).is_ok());
        assert!(matches!(lock.allow(true, NOW), Err(Error::UsageLocked)));
        assert_eq!(lock.phase(NOW), LockPhase::Locked);
    }

    #[test]
    fn an_unlock_request_waits_a_full_day() {
        let mut lock = locked();
        lock.request_unlock(NOW).unwrap();
        assert_eq!(lock.phase(NOW), LockPhase::CoolingOff);
        let status = lock.status(NOW + 3600);
        assert_eq!(status.phase, LockPhase::CoolingOff);
        assert_eq!(status.remaining_seconds, 23 * 3600);
        assert!(lock.allow(true, NOW + COOLING_OFF_SECONDS - 1).is_err());
        assert!(lock.lift(NOW + COOLING_OFF_SECONDS - 1).is_err());
        assert_eq!(
            lock.phase(NOW + COOLING_OFF_SECONDS),
            LockPhase::Ready,
            "exactly 24 hours is enough"
        );
        assert_eq!(lock.status(NOW + COOLING_OFF_SECONDS).remaining_seconds, 0);
    }

    #[test]
    fn asking_again_never_restarts_the_wait() {
        let mut lock = locked();
        lock.request_unlock(NOW).unwrap();
        lock.request_unlock(NOW + 7200).unwrap();
        assert_eq!(lock.unlock_requested_at, Some(NOW));
        lock.request_unlock(NOW + COOLING_OFF_SECONDS + 5).unwrap();
        assert_eq!(lock.unlock_requested_at, Some(NOW));
    }

    #[test]
    fn cancelling_returns_to_locked() {
        let mut lock = locked();
        lock.request_unlock(NOW).unwrap();
        lock.cancel_unlock();
        assert_eq!(lock.phase(NOW + 1), LockPhase::Locked);
        lock.request_unlock(NOW + COOLING_OFF_SECONDS).unwrap();
        lock.cancel_unlock();
        assert_eq!(lock.phase(NOW + 2 * COOLING_OFF_SECONDS), LockPhase::Locked);
    }

    #[test]
    fn the_first_relaxing_change_after_the_wait_lifts_the_lock() {
        let mut lock = locked();
        lock.request_unlock(NOW).unwrap();
        let later = NOW + COOLING_OFF_SECONDS;
        lock.allow(true, later).unwrap();
        assert_eq!(lock.phase(later), LockPhase::Off);
        assert_eq!(lock.unlock_requested_at, None);
        assert!(lock.allow(true, later).is_ok(), "the lock is off now");
    }

    #[test]
    fn a_tightening_after_the_wait_leaves_the_request_standing() {
        let mut lock = locked();
        lock.request_unlock(NOW).unwrap();
        let later = NOW + COOLING_OFF_SECONDS + 10;
        lock.allow(false, later).unwrap();
        assert_eq!(lock.phase(later), LockPhase::Ready);
    }

    #[test]
    fn a_clock_moved_back_does_not_stretch_the_wait() {
        let mut lock = locked();
        lock.request_unlock(NOW).unwrap();
        let status = lock.status(NOW - 10 * COOLING_OFF_SECONDS);
        assert_eq!(status.phase, LockPhase::CoolingOff);
        assert_eq!(status.remaining_seconds, COOLING_OFF_SECONDS as u64);
    }

    #[test]
    fn lifting_without_a_wait_is_refused() {
        let mut lock = locked();
        assert!(lock.lift(NOW).is_err());
        assert!(lock.enabled);
    }

    #[test]
    fn protected_options_keep_their_marked_value() {
        let mut lock = LockData::default();
        lock.protect("a.default", "x", OptionValue::Toggle(true))
            .unwrap();
        lock.protect("a.default", "y", OptionValue::Choice("hide".into()))
            .unwrap();
        assert_eq!(
            lock.protected_value("a.default", "x"),
            Some(&OptionValue::Toggle(true))
        );
        assert_eq!(lock.status(NOW).protected_options.len(), 2);
        assert!(lock.unprotect("a.default", "x"));
        assert!(!lock.unprotect("a.default", "x"));
        assert!(lock.unprotect("a.default", "y"));
        assert!(lock.protected_options.is_empty());
    }

    #[test]
    fn protecting_is_capped() {
        let mut lock = LockData::default();
        for i in 0..MAX_PROTECTED_OPTIONS {
            lock.protect("a.default", &format!("o{i}"), OptionValue::Toggle(true))
                .unwrap();
        }
        assert!(
            lock.protect("a.default", "extra", OptionValue::Toggle(true))
                .is_err()
        );
        assert!(
            lock.protect("a.default", "o0", OptionValue::Toggle(false))
                .is_ok()
        );
    }

    #[test]
    fn thresholds_relax_when_they_grow_or_vanish() {
        assert!(!limit_relaxed(None, Some(60)));
        assert!(!limit_relaxed(None, None));
        assert!(!limit_relaxed(Some(60), Some(60)));
        assert!(!limit_relaxed(Some(60), Some(30)));
        assert!(limit_relaxed(Some(60), Some(61)));
        assert!(limit_relaxed(Some(60), None));
    }

    #[test]
    fn pauses_relax_when_they_shrink_or_vanish() {
        assert!(!pause_relaxed(None, Some(5)));
        assert!(!pause_relaxed(Some(10), Some(10)));
        assert!(!pause_relaxed(Some(10), Some(30)));
        assert!(pause_relaxed(Some(10), Some(5)));
        assert!(pause_relaxed(Some(10), None));
    }

    #[test]
    fn old_files_without_a_lock_load_as_off() {
        let lock: LockData = serde_json::from_str("{}").unwrap();
        assert_eq!(lock.phase(NOW), LockPhase::Off);
    }
}
