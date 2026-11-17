import { selectSheetHasBack, useApp } from "../../app/store";
import type { MessageKey } from "../../i18n/messages";
import { useT } from "../../i18n/useT";
import {
  DARK_METHODS,
  DARK_MODE_DEFAULT,
  DARK_PRESETS,
  DARK_SCHEDULES,
  activePreset,
  darkSiteLabel,
  isClockTime,
  strokeLabel,
} from "../../shared/darkMode";
import { ForwardIcon } from "../../shared/icons";
import type { DarkMode } from "../../shared/ipc";
import { Screen } from "../../shared/Screen";
import { ColorInput } from "./ColorInput";
import { Segmented } from "./Segmented";
import { StepSlider } from "./StepSlider";
import { Switch } from "./Switch";
import { Group, Section, field, quietButton } from "./ui";

/** The row in Settings that opens the dark mode page. */
export function DarkModeLink() {
  const openSheet = useApp((s) => s.openSheet);
  const t = useT();

  return (
    <Group>
      <button
        type="button"
        onClick={() => openSheet("dark-mode")}
        className="flex w-full items-center gap-3 px-4 py-3.5 text-start active:bg-paper/[0.05]"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-base font-medium">{t("settings.darkMode")}</span>
          <span className="block text-sm text-paper/55">{t("settings.darkModeNote")}</span>
        </span>
        <span aria-hidden="true" className="text-paper/50 rtl:-scale-x-100">
          <ForwardIcon />
        </span>
      </button>
    </Group>
  );
}

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

/**
 * Dark mode for the pages the user opens: on or off, how pages are darkened, the colours and when
 * it applies. A site can have its own choice, set in its page settings.
 */
export function DarkModeScreen() {
  const open = useApp((s) => s.sheet === "dark-mode");
  const closeSheet = useApp((s) => s.closeSheet);
  const back = useApp((s) => s.sheetParent === "settings" || selectSheetHasBack(s));
  const dark = useApp((s) => s.state?.darkMode ?? DARK_MODE_DEFAULT);
  const setDarkMode = useApp((s) => s.setDarkMode);
  const t = useT();
  if (!open) return null;

  const method = DARK_METHODS.find((entry) => entry.value === dark.method) ?? DARK_METHODS[0];
  const preset = activePreset(dark);
  const change = (changes: Partial<DarkMode>) => void setDarkMode(changes);
  const setTime = (key: "from" | "to", value: string) => {
    if (isClockTime(value)) change({ schedule: { ...dark.schedule, [key]: value } });
  };

  return (
    <Screen
      title={t("settings.darkMode")}
      subtitle={t("settings.darkModeNote")}
      closeLabel={t(back ? "common.back" : "settings.close")}
      onClose={closeSheet}
      back={back}
    >
      <div className="flex flex-col gap-9">
        <div className="flex flex-col gap-2">
          <Group>
            <Switch
              label={t("settings.darkEnabled")}
              description={t("settings.darkEnabledNote")}
              checked={dark.enabled}
              onChange={(on) => change({ enabled: on })}
            />
          </Group>
          <p className="px-1 text-[13px] leading-snug text-paper/50">
            {t("settings.darkSitesNote")}
          </p>
        </div>

        <Section title={t("settings.darkMethod")}>
          <div className="flex flex-col gap-2">
            <Segmented
              label={t("settings.darkMethod")}
              value={dark.method}
              options={DARK_METHODS.map((entry) => ({
                value: entry.value,
                label: t(entry.label),
              }))}
              onChange={(next) => change({ method: next })}
            />
            <p className="px-1 text-[13px] leading-snug text-paper/50">{t(method.note)}</p>
          </div>
        </Section>

        <Section title={t("settings.darkLook")}>
          <Group>
            {SLIDERS.map((slider) => (
              <div key={slider.key} className="flex flex-col gap-1.5 px-4 py-3">
                <div className="text-base">{t(slider.label)}</div>
                <StepSlider
                  label={t(slider.label)}
                  value={dark[slider.key]}
                  min={slider.min}
                  max={slider.max}
                  step={slider.step}
                  format={slider.format}
                  onCommit={(value) => {
                    const changes: Partial<DarkMode> = {};
                    changes[slider.key] = value;
                    change(changes);
                  }}
                />
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
                value={dark.background}
                onCommit={(color) => change({ background: color })}
              />
            </div>
            <div className="flex items-center justify-between gap-3 px-4 py-3.5">
              <span className="text-base">{t("settings.darkText")}</span>
              <ColorInput
                label={t("settings.darkText")}
                value={dark.text}
                onCommit={(color) => change({ text: color })}
              />
            </div>
          </Group>
        </Section>

        <Section title={t("settings.darkSchedule")}>
          <div className="flex flex-col gap-2">
            <Segmented
              label={t("settings.darkSchedule")}
              value={dark.schedule.kind}
              options={DARK_SCHEDULES.map((entry) => ({
                value: entry.value,
                label: t(entry.label),
              }))}
              onChange={(kind) => change({ schedule: { ...dark.schedule, kind } })}
            />
            {dark.schedule.kind === "system" && (
              <p className="px-1 text-[13px] leading-snug text-paper/50">
                {t("settings.darkScheduleSystemNote")}
              </p>
            )}
            {dark.schedule.kind === "time" && (
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1.5 text-xs text-paper/60">
                  {t("settings.darkFrom")}
                  <input
                    type="time"
                    value={dark.schedule.from}
                    onChange={(event) => setTime("from", event.target.value)}
                    className={field}
                  />
                </label>
                <label className="flex flex-col gap-1.5 text-xs text-paper/60">
                  {t("settings.darkTo")}
                  <input
                    type="time"
                    value={dark.schedule.to}
                    onChange={(event) => setTime("to", event.target.value)}
                    className={field}
                  />
                </label>
              </div>
            )}
          </div>
        </Section>

        <Section title={t("settings.darkBehavior")}>
          <Group>
            <Switch
              label={t("settings.darkSkipDark")}
              description={t("settings.darkSkipDarkNote")}
              checked={dark.skipDarkPages}
              onChange={(on) => change({ skipDarkPages: on })}
            />
            <Switch
              label={t("settings.darkSystemControls")}
              description={t("settings.darkSystemControlsNote")}
              checked={dark.systemControls}
              onChange={(on) => change({ systemControls: on })}
            />
            <Switch
              label={t("settings.darkScrollbars")}
              description={t("settings.darkScrollbarsNote")}
              checked={dark.scrollbars}
              onChange={(on) => change({ scrollbars: on })}
            />
            <Switch
              label={t("settings.darkImages")}
              description={t("settings.darkImagesNote")}
              checked={dark.images}
              onChange={(on) => change({ images: on })}
            />
          </Group>
        </Section>

        <DarkSites />

        <Group>
          <div className="flex items-center justify-between gap-3 px-4 py-3.5">
            <span className="text-base">{t("settings.darkReset")}</span>
            <button
              type="button"
              onClick={() => change({ ...DARK_MODE_DEFAULT, enabled: dark.enabled })}
              className={quietButton}
            >
              {t("settings.darkResetButton")}
            </button>
          </div>
        </Group>
      </div>
    </Screen>
  );
}

/** The sites with a dark mode choice of their own, each with a way back to the shared settings. */
function DarkSites() {
  const sites = useApp((s) => s.state?.darkSites);
  const setSiteDarkMode = useApp((s) => s.setSiteDarkMode);
  const t = useT();
  const entries = Object.entries(sites ?? {}).sort(([a], [b]) => a.localeCompare(b));

  return (
    <Section title={t("settings.darkSites")}>
      {entries.length === 0 ? (
        <p className="px-1 text-sm text-paper/55">{t("settings.darkSitesEmpty")}</p>
      ) : (
        <Group>
          {entries.map(([site, choice]) => (
            <div key={site} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <div className="truncate text-base">{site}</div>
                <div className="truncate text-sm text-paper/55">
                  {darkSiteLabel(choice)
                    .map((key) => t(key))
                    .join(" · ")}
                </div>
              </div>
              <button
                type="button"
                aria-label={t("settings.darkSiteRemove", { site })}
                onClick={() => void setSiteDarkMode(site, {})}
                className={`shrink-0 ${quietButton}`}
              >
                {t("common.remove")}
              </button>
            </div>
          ))}
        </Group>
      )}
    </Section>
  );
}
