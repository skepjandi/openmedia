//! Downtime schedules: the times of day when a site is closed, the same way an exhausted daily
//! limit closes it.
//!
//! A schedule is a list of windows. Each window names the weekdays it starts on and a start and
//! end time in minutes since local midnight. The shell passes its own local date and time, so
//! nothing here knows a time zone or a daylight-saving rule: a window is simply "these minutes of
//! the local day". A window whose end is before its start runs through midnight into the next
//! weekday.

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

/// Minutes in a local day.
pub const MINUTES_PER_DAY: u16 = 1440;
const WEEK_MINUTES: usize = 7 * MINUTES_PER_DAY as usize;
/// All seven weekday bits: bit 0 is Monday, bit 6 is Sunday.
const ALL_DAYS: u8 = 0b0111_1111;
/// How many windows one site's schedule may hold.
pub const MAX_WINDOWS: usize = 8;

/// One stretch of time the site is closed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleWindow {
    /// The weekdays the window starts on, one bit each: bit 0 is Monday, bit 6 is Sunday.
    pub days: u8,
    /// Minutes since local midnight when the site closes, 0 to 1439.
    pub start_minute: u16,
    /// Minutes since local midnight when the site opens again, 0 to 1440. At or before the start
    /// it is the next day: 22:00 to 07:00 closes the site overnight.
    pub end_minute: u16,
}

/// The downtime of one site. No windows means no downtime.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Schedule {
    pub windows: Vec<ScheduleWindow>,
}

impl Schedule {
    pub fn is_empty(&self) -> bool {
        self.windows.is_empty()
    }

    /// A window needs a weekday, a start inside the day, an end that is not the start, and no more
    /// windows than the cap.
    pub fn check(&self) -> Result<()> {
        if self.windows.len() > MAX_WINDOWS {
            return Err(Error::InvalidUsage("too many schedule windows"));
        }
        for window in &self.windows {
            if window.days == 0 || window.days & !ALL_DAYS != 0 {
                return Err(Error::InvalidUsage("a schedule window needs weekdays"));
            }
            if window.start_minute >= MINUTES_PER_DAY || window.end_minute > MINUTES_PER_DAY {
                return Err(Error::InvalidUsage("a schedule time is outside the day"));
            }
            if window.start_minute == window.end_minute {
                return Err(Error::InvalidUsage("a schedule window cannot be empty"));
            }
        }
        Ok(())
    }

    /// Whether the site is closed at `minute` of the local day on `weekday` (0 is Monday).
    pub fn closed_at(&self, weekday: u8, minute: u16) -> bool {
        self.windows
            .iter()
            .any(|window| window.covers(weekday, minute))
    }

    /// True when every minute this schedule closes the site, `other` closes it as well. Moving to
    /// a schedule that does not contain the old one opens the site at some time it was closed.
    pub fn is_contained_in(&self, other: &Schedule) -> bool {
        (0..WEEK_MINUTES).all(|index| {
            let (weekday, minute) = split(index);
            !self.closed_at(weekday, minute) || other.closed_at(weekday, minute)
        })
    }
}

impl ScheduleWindow {
    fn covers(&self, weekday: u8, minute: u16) -> bool {
        let starts_today = self.days >> weekday & 1 == 1;
        if self.start_minute < self.end_minute {
            return starts_today && (self.start_minute..self.end_minute).contains(&minute);
        }
        let started_yesterday = self.days >> ((weekday + 6) % 7) & 1 == 1;
        (starts_today && minute >= self.start_minute)
            || (started_yesterday && minute < self.end_minute)
    }
}

fn split(index: usize) -> (u8, u16) {
    let per_day = usize::from(MINUTES_PER_DAY);
    (
        u8::try_from(index / per_day).unwrap_or(0),
        u16::try_from(index % per_day).unwrap_or(0),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const MON: u8 = 0b000_0001;
    const FRI: u8 = 0b001_0000;
    const SUN: u8 = 0b100_0000;

    fn window(days: u8, start: u16, end: u16) -> ScheduleWindow {
        ScheduleWindow {
            days,
            start_minute: start,
            end_minute: end,
        }
    }

    fn schedule(windows: Vec<ScheduleWindow>) -> Schedule {
        Schedule { windows }
    }

    #[test]
    fn a_same_day_window_is_closed_from_its_start_until_its_end() {
        let work = schedule(vec![window(MON, 9 * 60, 17 * 60)]);
        assert!(!work.closed_at(0, 9 * 60 - 1));
        assert!(work.closed_at(0, 9 * 60));
        assert!(work.closed_at(0, 17 * 60 - 1));
        assert!(!work.closed_at(0, 17 * 60));
        assert!(!work.closed_at(1, 12 * 60));
    }

    #[test]
    fn a_window_through_midnight_runs_into_the_next_weekday() {
        let night = schedule(vec![window(FRI, 22 * 60, 7 * 60)]);
        assert!(!night.closed_at(4, 21 * 60 + 59));
        assert!(night.closed_at(4, 22 * 60));
        assert!(night.closed_at(4, MINUTES_PER_DAY - 1));
        assert!(night.closed_at(5, 0));
        assert!(night.closed_at(5, 7 * 60 - 1));
        assert!(!night.closed_at(5, 7 * 60));
        assert!(
            !night.closed_at(5, 22 * 60),
            "Saturday evening is not listed"
        );
        assert!(
            !night.closed_at(4, 6 * 60),
            "Friday morning belongs to Thursday's night"
        );
    }

    #[test]
    fn a_window_through_midnight_on_sunday_wraps_to_monday() {
        let night = schedule(vec![window(SUN, 23 * 60, 2 * 60)]);
        assert!(night.closed_at(6, 23 * 60 + 30));
        assert!(night.closed_at(0, 60));
        assert!(!night.closed_at(0, 2 * 60));
    }

    #[test]
    fn an_end_of_exactly_midnight_stays_inside_the_start_day() {
        let evening = schedule(vec![window(MON, 20 * 60, MINUTES_PER_DAY)]);
        assert!(evening.closed_at(0, MINUTES_PER_DAY - 1));
        assert!(!evening.closed_at(1, 0));
    }

    #[test]
    fn an_end_at_zero_closes_until_midnight_without_spilling_over() {
        let evening = schedule(vec![window(MON, 20 * 60, 0)]);
        assert!(evening.closed_at(0, MINUTES_PER_DAY - 1));
        assert!(!evening.closed_at(1, 0));
    }

    #[test]
    fn check_rejects_windows_that_mean_nothing() {
        for bad in [
            window(0, 0, 60),
            window(0b1000_0000, 0, 60),
            window(MON, 60, 60),
            window(MON, MINUTES_PER_DAY, 60),
            window(MON, 0, MINUTES_PER_DAY + 1),
        ] {
            assert!(schedule(vec![bad]).check().is_err());
        }
        assert!(
            schedule(vec![window(MON, 0, MINUTES_PER_DAY)])
                .check()
                .is_ok()
        );
        assert!(schedule(vec![window(MON, 1380, 360)]).check().is_ok());
        assert!(
            schedule(vec![window(MON, 0, 60); MAX_WINDOWS + 1])
                .check()
                .is_err()
        );
    }

    #[test]
    fn containment_decides_whether_a_change_opens_the_site_anywhere() {
        let night = schedule(vec![window(ALL_DAYS, 22 * 60, 7 * 60)]);
        let longer = schedule(vec![window(ALL_DAYS, 21 * 60, 8 * 60)]);
        let shorter = schedule(vec![window(ALL_DAYS, 23 * 60, 6 * 60)]);
        let split_night = schedule(vec![
            window(ALL_DAYS, 22 * 60, MINUTES_PER_DAY),
            window(ALL_DAYS, 0, 7 * 60),
        ]);
        assert!(night.is_contained_in(&longer));
        assert!(!night.is_contained_in(&shorter));
        assert!(night.is_contained_in(&split_night));
        assert!(split_night.is_contained_in(&night));
        assert!(Schedule::default().is_contained_in(&night));
        assert!(!night.is_contained_in(&Schedule::default()));
        let weekdays_only = schedule(vec![window(ALL_DAYS & !SUN, 22 * 60, 7 * 60)]);
        assert!(!night.is_contained_in(&weekdays_only));
    }
}
