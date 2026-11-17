import { describe, expect, it } from "vitest";
import {
  ALL_DAYS,
  closedAt,
  closedNow,
  endFromTimeValue,
  fromTimeValue,
  isContainedIn,
  minuteOf,
  nextOpening,
  toTimeValue,
  toggleDay,
  weekdayOf,
  windowProblem,
  type Schedule,
} from "./schedule";

const MON = 0b000_0001;
const FRI = 0b001_0000;
const SUN = 0b100_0000;

const win = (days: number, startMinute: number, endMinute: number) => ({
  days,
  startMinute,
  endMinute,
});
const schedule = (...windows: ReturnType<typeof win>[]): Schedule => ({ windows });

describe("schedule windows", () => {
  it("closes a same-day window from its start until its end", () => {
    const work = schedule(win(MON, 9 * 60, 17 * 60));
    expect(closedAt(work, 0, 9 * 60 - 1)).toBe(false);
    expect(closedAt(work, 0, 9 * 60)).toBe(true);
    expect(closedAt(work, 0, 17 * 60 - 1)).toBe(true);
    expect(closedAt(work, 0, 17 * 60)).toBe(false);
    expect(closedAt(work, 1, 12 * 60)).toBe(false);
  });

  it("runs a window that ends before it starts through midnight into the next weekday", () => {
    const night = schedule(win(FRI, 22 * 60, 7 * 60));
    expect(closedAt(night, 4, 21 * 60 + 59)).toBe(false);
    expect(closedAt(night, 4, 22 * 60)).toBe(true);
    expect(closedAt(night, 4, 1439)).toBe(true);
    expect(closedAt(night, 5, 0)).toBe(true);
    expect(closedAt(night, 5, 7 * 60 - 1)).toBe(true);
    expect(closedAt(night, 5, 7 * 60)).toBe(false);
    expect(closedAt(night, 5, 22 * 60)).toBe(false);
    expect(closedAt(night, 4, 6 * 60)).toBe(false);
  });

  it("wraps a Sunday night window to Monday", () => {
    const night = schedule(win(SUN, 23 * 60, 2 * 60));
    expect(closedAt(night, 6, 23 * 60 + 30)).toBe(true);
    expect(closedAt(night, 0, 60)).toBe(true);
    expect(closedAt(night, 0, 2 * 60)).toBe(false);
  });

  it("stores an end at midnight as 24:00 so it stays inside the start day", () => {
    const evening = schedule(win(MON, 20 * 60, 1440));
    expect(closedAt(evening, 0, 1439)).toBe(true);
    expect(closedAt(evening, 1, 0)).toBe(false);
    expect(endFromTimeValue("00:00", 20 * 60)).toBe(1440);
    expect(endFromTimeValue("00:00", 0)).toBe(0);
    expect(endFromTimeValue("07:30", 20 * 60)).toBe(450);
  });

  it("reads the local weekday and minute of a date, Monday first", () => {
    const sunday = new Date(2026, 0, 4, 23, 59, 30);
    expect(weekdayOf(sunday)).toBe(6);
    expect(minuteOf(sunday)).toBe(23 * 60 + 59);
    expect(weekdayOf(new Date(2026, 0, 5, 0, 0))).toBe(0);
    const night = schedule(win(SUN, 23 * 60, 2 * 60));
    expect(closedNow(night, sunday)).toBe(true);
    expect(closedNow(night, new Date(2026, 0, 5, 1, 59))).toBe(true);
    expect(closedNow(night, new Date(2026, 0, 5, 2, 0))).toBe(false);
  });
});

describe("opening time", () => {
  it("finds the first open minute, crossing midnight", () => {
    const night = schedule(win(ALL_DAYS, 22 * 60, 7 * 60));
    const late = new Date(2026, 0, 5, 23, 15, 40);
    const opens = nextOpening(night, late);
    expect(opens && [opens.getDate(), opens.getHours(), opens.getMinutes()]).toEqual([6, 7, 0]);
  });

  it("opens now when nothing is closed, and never when everything is", () => {
    const now = new Date(2026, 0, 5, 12, 0, 20);
    expect(nextOpening(schedule(win(MON, 22 * 60, 23 * 60)), now)?.getHours()).toBe(12);
    expect(nextOpening(schedule(win(ALL_DAYS, 0, 1440)), now)).toBeNull();
  });
});

describe("containment", () => {
  it("tells whether a change leaves the site open when it was closed", () => {
    const night = schedule(win(ALL_DAYS, 22 * 60, 7 * 60));
    const longer = schedule(win(ALL_DAYS, 21 * 60, 8 * 60));
    const shorter = schedule(win(ALL_DAYS, 23 * 60, 6 * 60));
    const split = schedule(win(ALL_DAYS, 22 * 60, 1440), win(ALL_DAYS, 0, 7 * 60));
    expect(isContainedIn(night, longer)).toBe(true);
    expect(isContainedIn(night, shorter)).toBe(false);
    expect(isContainedIn(night, split)).toBe(true);
    expect(isContainedIn(split, night)).toBe(true);
    expect(isContainedIn(schedule(), night)).toBe(true);
    expect(isContainedIn(night, schedule())).toBe(false);
    expect(isContainedIn(night, schedule(win(ALL_DAYS & ~SUN, 22 * 60, 7 * 60)))).toBe(false);
  });
});

describe("editing helpers", () => {
  it("round-trips time input values and rejects bad ones", () => {
    expect(toTimeValue(450)).toBe("07:30");
    expect(toTimeValue(1440)).toBe("00:00");
    expect(fromTimeValue("07:30")).toBe(450);
    for (const bad of ["", "7:30", "24:00", "12:60", "ab:cd"])
      expect(fromTimeValue(bad)).toBeNull();
  });

  it("flags windows that cannot be saved", () => {
    expect(windowProblem(win(0, 0, 60))).toBe("days");
    expect(windowProblem(win(MON, 60, 60))).toBe("same");
    expect(windowProblem(win(MON, 1320, 420))).toBeNull();
  });

  it("toggles weekday bits", () => {
    expect(toggleDay(MON, 6)).toBe(MON | SUN);
    expect(toggleDay(MON | SUN, 0)).toBe(SUN);
  });
});
