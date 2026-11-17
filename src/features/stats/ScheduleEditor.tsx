import { useState } from "react";
import { selectLocale, useApp } from "../../app/store";
import { describeError } from "../../i18n/errors";
import { useT } from "../../i18n/useT";
import { quietButton } from "../settings/ui";
import { refusesRelaxing, scheduleRelaxes, useUsageLock } from "./lock";
import { usageLimits } from "./policy";
import {
  DEFAULT_WINDOW,
  MAX_WINDOWS,
  NO_SCHEDULE,
  endFromTimeValue,
  fromTimeValue,
  toTimeValue,
  toggleDay,
  weekdayNames,
  windowProblem,
  type Schedule,
  type ScheduleWindow,
} from "./schedule";

interface WindowRowProps {
  window: ScheduleWindow;
  names: string[];
  host: string;
  onChange: (next: ScheduleWindow) => void;
  onRemove: () => void;
}

function WindowRow({ window, names, host, onChange, onRemove }: WindowRowProps) {
  const t = useT();
  const time = (label: string, minute: number, apply: (value: string) => void) => (
    <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm text-paper/60">
      {label}
      <input
        type="time"
        value={toTimeValue(minute)}
        onChange={(event) => apply(event.target.value)}
        dir="ltr"
        className="min-h-11 rounded-xl border border-hair bg-paper/[0.06] px-3 text-base text-paper"
      />
    </label>
  );
  return (
    <li className="flex flex-col gap-3 px-4 py-4">
      <div
        role="group"
        aria-label={t("usage.scheduleDays", { host })}
        className="flex flex-wrap gap-1.5"
      >
        {names.map((name, weekday) => {
          const on = ((window.days >> weekday) & 1) === 1;
          return (
            <button
              key={weekday}
              type="button"
              aria-pressed={on}
              onClick={() => onChange({ ...window, days: toggleDay(window.days, weekday) })}
              className={`min-h-9 rounded-full px-3 text-sm font-medium ${
                on ? "bg-accent text-on-accent" : "border border-hair text-paper/75"
              }`}
            >
              {name}
            </button>
          );
        })}
      </div>
      <div className="flex items-end gap-3">
        {time(t("usage.scheduleStart"), window.startMinute, (value) => {
          const start = fromTimeValue(value);
          if (start !== null) onChange({ ...window, startMinute: start });
        })}
        {time(t("usage.scheduleEnd"), window.endMinute, (value) => {
          const end = endFromTimeValue(value, window.startMinute);
          if (end !== null) onChange({ ...window, endMinute: end });
        })}
        <button type="button" onClick={onRemove} className={`${quietButton} h-11 shrink-0`}>
          {t("usage.scheduleRemove")}
        </button>
      </div>
    </li>
  );
}

/**
 * The times of day a site is closed, as windows on chosen weekdays. A window whose end is before
 * its start runs through midnight. Each change is saved at once; the settings lock refuses a
 * change that would leave the site open at a time it was closed.
 */
export function ScheduleEditor({
  host,
  schedule,
}: {
  host: string;
  schedule: Schedule | undefined;
}) {
  const t = useT();
  const locale = useApp(selectLocale);
  const phase = useUsageLock((state) => state.status.phase);
  const [error, setError] = useState("");
  const windows = schedule?.windows ?? [];
  const names = weekdayNames(locale);

  const save = async (next: Schedule) => {
    const problem = next.windows.map(windowProblem).find((found) => found !== null);
    if (problem === "days") return setError(t("usage.scheduleNoDays"));
    if (problem === "same") return setError(t("usage.scheduleSameTime"));
    if (refusesRelaxing(phase) && scheduleRelaxes(schedule ?? NO_SCHEDULE, next)) {
      return setError(t("usage.lock.refused"));
    }
    setError("");
    try {
      await usageLimits.setSchedule(host, next);
    } catch (cause) {
      setError(describeError(cause, t));
    }
  };

  const replace = (index: number, next: ScheduleWindow) =>
    void save({ windows: windows.map((window, at) => (at === index ? next : window)) });

  return (
    <div className="border-t border-hair bg-paper/[0.03]">
      <div className="px-4 pt-4">
        <h3 className="text-base font-medium">{t("usage.scheduleTitle")}</h3>
        <p className="mt-0.5 text-sm leading-snug text-paper/55">{t("usage.scheduleHint")}</p>
      </div>
      {windows.length > 0 && (
        <ul className="divide-y divide-hair">
          {windows.map((window, index) => (
            <WindowRow
              key={index}
              window={window}
              names={names}
              host={host}
              onChange={(next) => replace(index, next)}
              onRemove={() => void save({ windows: windows.filter((_, at) => at !== index) })}
            />
          ))}
        </ul>
      )}
      <div className="px-4 py-4">
        {windows.length < MAX_WINDOWS && (
          <button
            type="button"
            onClick={() => void save({ windows: [...windows, DEFAULT_WINDOW] })}
            className={quietButton}
          >
            {t("usage.scheduleAdd")}
          </button>
        )}
        {error && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
