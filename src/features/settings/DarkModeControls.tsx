import type { MessageKey } from "../../i18n/messages";
import { useT } from "../../i18n/useT";
import {
  DARK_METHODS,
  DARK_PRESETS,
  DARK_SCHEDULES,
  activePreset,
  isClockTime,
  strokeLabel,
} from "../../shared/darkMode";
import type { DarkMode, SiteDark } from "../../shared/ipc";
import { ColorInput } from "./ColorInput";
import { Segmented } from "./Segmented";
import { FollowGeneral, type SiteOverrides } from "./SiteParts";
import { StepSlider } from "./StepSlider";
import { Switch } from "./Switch";
import { Group, Section, field } from "./ui";

const percent = (value: number) => `${value} %`;
const pixels = (tenths: number) => `${strokeLabel(tenths)} px`;

interface SliderSpec {
  key: "brightness" | "contrast" | "sepia" | "grayscale" | "textStroke";
  label: MessageKey;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
}

const SLIDERS: readonly SliderSpec[] = [
  {
    key: "brightness",
    label: "settings.darkBrightness",
    min: 50,
    max: 150,
    step: 5,
    format: percent,
  },
  { key: "contrast", label: "settings.darkContrast", min: 50, max: 150, step: 5, format: percent },
  { key: "sepia", label: "settings.darkSepia", min: 0, max: 100, step: 5, format: percent },
  { key: "grayscale", label: "settings.darkGrayscale", min: 0, max: 100, step: 5, format: percent },
  { key: "textStroke", label: "settings.darkTextStroke", min: 0, max: 10, step: 1, format: pixels },
];

interface SwitchSpec {
  key: "skipDarkPages" | "systemControls" | "scrollbars" | "images";
  label: MessageKey;
  note: MessageKey;
}

const SWITCHES: readonly SwitchSpec[] = [
  { key: "skipDarkPages", label: "settings.darkSkipDark", note: "settings.darkSkipDarkNote" },
  {
    key: "systemControls",
    label: "settings.darkSystemControls",
    note: "settings.darkSystemControlsNote",
  },
  { key: "scrollbars", label: "settings.darkScrollbars", note: "settings.darkScrollbarsNote" },
  { key: "images", label: "settings.darkImages", note: "settings.darkImagesNote" },
];

interface DarkModeControlsProps {
  /** What is in effect: general's value, or a site's own where it sets one. */
  value: DarkMode;
  /** Writes only the fields given. */
  change: (changes: Partial<Omit<DarkMode, "enabled">>) => void;
  /** Present on a site's page: which settings the site sets itself, and how to hand each back. */
  overrides?: SiteOverrides<SiteDark>;
}

/**
 * Every dark mode setting except the on/off choice, which each page words for itself. General and
 * a site's page render this one component, so a site can never lack a setting general has.
 */
export function DarkModeControls({ value, change, overrides }: DarkModeControlsProps) {
  const t = useT();
  const method = DARK_METHODS.find((entry) => entry.value === value.method) ?? DARK_METHODS[0];
  const preset = activePreset(value);
  const setTime = (key: "from" | "to", time: string) => {
    if (isClockTime(time)) change({ schedule: { ...value.schedule, [key]: time } });
  };
  const follows = (fields: (keyof SiteDark)[], label: MessageKey, className?: string) => (
    <FollowGeneral overrides={overrides} fields={fields} label={t(label)} className={className} />
  );

  return (
    <>
      <Section title={t("settings.darkMethod")}>
        <div className="flex flex-col gap-2">
          <Segmented
            label={t("settings.darkMethod")}
            value={value.method}
            options={DARK_METHODS.map((entry) => ({
              value: entry.value,
              label: t(entry.label),
            }))}
            onChange={(next) => change({ method: next })}
          />
          <p className="px-1 text-[13px] leading-snug text-paper/50">{t(method.note)}</p>
          {follows(["method"], "settings.darkMethod", "px-1")}
        </div>
      </Section>

      <Section title={t("settings.darkLook")}>
        <Group>
          {SLIDERS.map((slider) => (
            <div key={slider.key} className="flex flex-col gap-1.5 px-4 py-3">
              <div className="text-base">{t(slider.label)}</div>
              <StepSlider
                label={t(slider.label)}
                value={value[slider.key]}
                min={slider.min}
                max={slider.max}
                step={slider.step}
                format={slider.format}
                onCommit={(next) => {
                  const changes: Partial<DarkMode> = {};
                  changes[slider.key] = next;
                  change(changes);
                }}
              />
              {follows([slider.key], slider.label)}
            </div>
          ))}
        </Group>
      </Section>

      <Section title={t("settings.darkColors")} note={t("settings.darkColorsNote")}>
        <Group>
          <div className="flex flex-col gap-3 px-4 py-3.5">
            <div className="text-base">{t("settings.darkPreset")}</div>
            <div className="flex flex-wrap gap-3">
              {DARK_PRESETS.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  aria-label={t(entry.label)}
                  aria-pressed={preset?.id === entry.id}
                  onClick={() => change({ background: entry.background, text: entry.text })}
                  className={`flex w-16 flex-col items-center gap-1.5 rounded-xl p-1.5 text-xs ${
                    preset?.id === entry.id ? "bg-accent/15 text-accent" : "text-paper/70"
                  }`}
                >
                  <span
                    aria-hidden="true"
                    style={{ backgroundColor: entry.background, color: entry.text }}
                    className="grid size-10 place-items-center rounded-full border border-hair text-sm font-semibold"
                  >
                    A
                  </span>
                  <span className="max-w-full truncate">{t(entry.label)}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center justify-between gap-3 px-4 py-3.5">
            <span className="text-base">{t("settings.darkBackground")}</span>
            <ColorInput
              label={t("settings.darkBackground")}
              value={value.background}
              onCommit={(color) => change({ background: color })}
            />
          </div>
          <div className="flex items-center justify-between gap-3 px-4 py-3.5">
            <span className="text-base">{t("settings.darkText")}</span>
            <ColorInput
              label={t("settings.darkText")}
              value={value.text}
              onCommit={(color) => change({ text: color })}
            />
          </div>
          {follows(["background", "text"], "settings.darkColors", "px-4 py-3")}
        </Group>
      </Section>

      <Section title={t("settings.darkSchedule")}>
        <div className="flex flex-col gap-2">
          <Segmented
            label={t("settings.darkSchedule")}
            value={value.schedule.kind}
            options={DARK_SCHEDULES.map((entry) => ({
              value: entry.value,
              label: t(entry.label),
            }))}
            onChange={(kind) => change({ schedule: { ...value.schedule, kind } })}
          />
          {value.schedule.kind === "system" && (
            <p className="px-1 text-[13px] leading-snug text-paper/50">
              {t("settings.darkScheduleSystemNote")}
            </p>
          )}
          {value.schedule.kind === "time" && (
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1.5 text-xs text-paper/60">
                {t("settings.darkFrom")}
                <input
                  type="time"
                  value={value.schedule.from}
                  onChange={(event) => setTime("from", event.target.value)}
                  className={field}
                />
              </label>
              <label className="flex flex-col gap-1.5 text-xs text-paper/60">
                {t("settings.darkTo")}
                <input
                  type="time"
                  value={value.schedule.to}
                  onChange={(event) => setTime("to", event.target.value)}
                  className={field}
                />
              </label>
            </div>
          )}
          {follows(["schedule"], "settings.darkSchedule", "px-1")}
        </div>
      </Section>

      <Section title={t("settings.darkBehavior")}>
        <Group>
          {SWITCHES.map((entry) => (
            <div key={entry.key}>
              <Switch
                label={t(entry.label)}
                description={t(entry.note)}
                checked={value[entry.key]}
                onChange={(on) => {
                  const changes: Partial<DarkMode> = {};
                  changes[entry.key] = on;
                  change(changes);
                }}
              />
              {follows([entry.key], entry.label, "px-4 pb-3")}
            </div>
          ))}
        </Group>
      </Section>
    </>
  );
}
