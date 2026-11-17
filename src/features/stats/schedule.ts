/**
 * Downtime schedules: times of day when a site is closed, like an exhausted daily limit. The shell
 * reads its own local clock and Rust never sees a time zone, so a window is just "these minutes of
 * the local day". The math mirrors `schedule.rs`.
 */

export const MINUTES_PER_DAY = 1440;
export const ALL_DAYS = 0b111_1111;
export const MAX_WINDOWS = 8;
const WEEK_MINUTES = 7 * MINUTES_PER_DAY;

export interface ScheduleWindow {
  /** One bit per weekday the window starts on: bit 0 is Monday, bit 6 is Sunday. */
  days: number;
  /** Minutes since local midnight when the site closes, 0 to 1439. */
  startMinute: number;
  /** Minutes since local midnight when it opens again, 0 to 1440. At or before the start: next day. */
  endMinute: number;
}

export interface Schedule {
  windows: ScheduleWindow[];
}

/** The downtime of every site the user set one for, keyed by host. */
export type Schedules = Record<string, Schedule>;

export const NO_SCHEDULE: Schedule = { windows: [] };

/** 22:00 to 07:00 every day: the window a new schedule starts from. */
export const DEFAULT_WINDOW: ScheduleWindow = {
  days: ALL_DAYS,
  startMinute: 22 * 60,
  endMinute: 7 * 60,
};

/** Monday is 0 and Sunday is 6, unlike `Date.getDay`. */
export const weekdayOf = (date: Date): number => (date.getDay() + 6) % 7;

export const minuteOf = (date: Date): number => date.getHours() * 60 + date.getMinutes();

function covers(window: ScheduleWindow, weekday: number, minute: number): boolean {
  const startsToday = ((window.days >> weekday) & 1) === 1;
  if (window.startMinute < window.endMinute) {
    return startsToday && minute >= window.startMinute && minute < window.endMinute;
  }
  const startedYesterday = ((window.days >> ((weekday + 6) % 7)) & 1) === 1;
  return (
    (startsToday && minute >= window.startMinute) || (startedYesterday && minute < window.endMinute)
  );
}

/** Whether the schedule has the site closed at `minute` of the local day on `weekday` (0 is Monday). */
export function closedAt(schedule: Schedule, weekday: number, minute: number): boolean {
  return schedule.windows.some((window) => covers(window, weekday, minute));
}

export function closedNow(schedule: Schedule, now: Date): boolean {
  return closedAt(schedule, weekdayOf(now), minuteOf(now));
}

/**
 * When the site opens again: the start of the first minute at or after now that no window covers.
 * An open site opens "now". `null` when it is closed every minute of the week.
 */
export function nextOpening(schedule: Schedule, now: Date): Date | null {
  const start = new Date(now);
  start.setSeconds(0, 0);
  for (let ahead = 0; ahead <= WEEK_MINUTES; ahead++) {
    const moment = new Date(start.getTime() + ahead * 60_000);
    if (!closedNow(schedule, moment)) return moment;
  }
  return null;
}

/** True when every minute `inner` closes the site, `outer` closes it as well. */
export function isContainedIn(inner: Schedule, outer: Schedule): boolean {
  for (let weekday = 0; weekday < 7; weekday++) {
    for (let minute = 0; minute < MINUTES_PER_DAY; minute++) {
      if (closedAt(inner, weekday, minute) && !closedAt(outer, weekday, minute)) return false;
    }
  }
  return true;
}

/** Why a window cannot be saved, or `null` when it can. */
export function windowProblem(window: ScheduleWindow): "days" | "same" | null {
  if (window.days === 0) return "days";
  return window.startMinute === window.endMinute ? "same" : null;
}

export const toggleDay = (days: number, weekday: number): number => days ^ (1 << weekday);

/** `HH:MM` for a time input. 1440 reads as 24:00, which an input cannot hold, so it is 00:00. */
export function toTimeValue(minute: number): string {
  const wrapped = minute % MINUTES_PER_DAY;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(Math.floor(wrapped / 60))}:${pad(wrapped % 60)}`;
}

/** Minutes since midnight for an `HH:MM` value, or `null` when it is not one. */
export function fromTimeValue(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [hours, minutes] = [Number(match[1]), Number(match[2])];
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : null;
}

/** A midnight end is stored as 24:00 so a window can run to the end of its own day. */
export function endFromTimeValue(value: string, startMinute: number): number | null {
  const minute = fromTimeValue(value);
  if (minute === null) return null;
  return minute === 0 && startMinute > 0 ? MINUTES_PER_DAY : minute;
}

const SHORT_TIME: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };

/** A clock time in the reader's own format. */
export function formatClock(date: Date, locale: string): string {
  return date.toLocaleTimeString(locale, SHORT_TIME);
}

/** A clock time, with the weekday in front when it is not today. */
export function formatOpening(date: Date, now: Date, locale: string): string {
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay
    ? formatClock(date, locale)
    : `${date.toLocaleDateString(locale, { weekday: "short" })} ${formatClock(date, locale)}`;
}

/** The short weekday names, Monday first, in the reader's language. */
export function weekdayNames(locale: string): string[] {
  const format = new Intl.DateTimeFormat(locale, { weekday: "short" });
  // 5 Jan 2026 is a Monday.
  return Array.from({ length: 7 }, (_, index) => format.format(new Date(2026, 0, 5 + index)));
}

/** A one-line summary of the windows, such as `22:00–07:00`; several windows are joined. */
export function summarize(schedule: Schedule, locale: string): string {
  const at = (minute: number) =>
    formatClock(
      new Date(2026, 0, 5, Math.floor((minute % MINUTES_PER_DAY) / 60), minute % 60),
      locale,
    );
  return schedule.windows.map((w) => `${at(w.startMinute)}–${at(w.endMinute)}`).join(", ");
}
