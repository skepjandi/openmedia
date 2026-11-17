import type { MessageKey } from "../i18n/messages";
import type { DarkMethod, DarkMode, DarkScheduleKind, SiteDark } from "./ipc";

/** What the app starts with, and what Rust holds until the user chooses. */
export const DARK_MODE_DEFAULT: DarkMode = {
  enabled: false,
  method: "dynamic",
  brightness: 100,
  contrast: 100,
  sepia: 0,
  grayscale: 0,
  background: "#181a1b",
  text: "#e8e6e3",
  schedule: { kind: "always", from: "21:00", to: "07:00" },
  skipDarkPages: true,
  systemControls: true,
  scrollbars: true,
  images: true,
  textStroke: 0,
};

export interface DarkMethodInfo {
  value: DarkMethod;
  label: MessageKey;
  note: MessageKey;
}

export const DARK_METHODS: readonly DarkMethodInfo[] = [
  { value: "dynamic", label: "settings.darkMethodDynamic", note: "settings.darkMethodDynamicNote" },
  { value: "filter", label: "settings.darkMethodFilter", note: "settings.darkMethodFilterNote" },
  {
    value: "filterplus",
    label: "settings.darkMethodFilterPlus",
    note: "settings.darkMethodFilterPlusNote",
  },
  { value: "static", label: "settings.darkMethodStatic", note: "settings.darkMethodStaticNote" },
];

export const DARK_SCHEDULES: readonly { value: DarkScheduleKind; label: MessageKey }[] = [
  { value: "always", label: "settings.darkScheduleAlways" },
  { value: "system", label: "settings.darkScheduleSystem" },
  { value: "time", label: "settings.darkScheduleTime" },
];

export interface DarkPreset {
  id: string;
  label: MessageKey;
  background: string;
  text: string;
}

export const DARK_PRESETS: readonly DarkPreset[] = [
  { id: "default", label: "settings.darkPresetDefault", background: "#181a1b", text: "#e8e6e3" },
  { id: "black", label: "settings.darkPresetBlack", background: "#000000", text: "#e8e6e3" },
  { id: "graphite", label: "settings.darkPresetGraphite", background: "#202124", text: "#e8eaed" },
  { id: "midnight", label: "settings.darkPresetMidnight", background: "#0d1117", text: "#c9d1d9" },
  { id: "warm", label: "settings.darkPresetWarm", background: "#1c1a17", text: "#e6dccb" },
];

/** The preset whose two colours are the ones in use, if any. */
export function activePreset(dark: Pick<DarkMode, "background" | "text">): DarkPreset | undefined {
  const background = dark.background.toLowerCase();
  const text = dark.text.toLowerCase();
  return DARK_PRESETS.find((preset) => preset.background === background && preset.text === text);
}

/** `value` rounded to a whole number and held between `min` and `max`. */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Tenths of a pixel as a label: `3` is `0.3`, `10` is `1`. */
export function strokeLabel(tenths: number): string {
  return String(tenths / 10);
}

/** Whether `value` is the `HH:MM` a time input gives; an empty or half-typed one is not. */
export function isClockTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

/** The messages that say what a site's own choice is: its mode, then its method. */
export function darkSiteLabel(dark: SiteDark): MessageKey[] {
  const labels: MessageKey[] = [];
  if (dark.mode === "on") labels.push("favorites.darkOn");
  if (dark.mode === "off") labels.push("favorites.darkOff");
  const method = DARK_METHODS.find((entry) => entry.value === dark.method);
  if (method) labels.push(method.label);
  return labels;
}

/**
 * Whether dark mode is in effect for a site: its own mode when it has one, else the global
 * switch. Without a site (nothing open) only the global switch counts.
 */
export function darkActiveFor(
  darkMode: Pick<DarkMode, "enabled">,
  darkSites: Record<string, SiteDark>,
  site: string | null,
): boolean {
  const own = site ? darkSites[site]?.mode : undefined;
  return own === undefined ? darkMode.enabled : own === "on";
}
