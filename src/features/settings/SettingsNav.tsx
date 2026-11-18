import { useApp } from "../../app/store";
import type { MessageKey } from "../../i18n/messages";
import { useT } from "../../i18n/useT";

export type SettingsCategory =
  "general" | "browsing" | "controls" | "sites" | "incognito" | "assistant" | "data";

export const SETTINGS_CATEGORIES: readonly { id: SettingsCategory; label: MessageKey }[] = [
  { id: "general", label: "settings.navGeneral" },
  { id: "browsing", label: "settings.browsing" },
  { id: "controls", label: "settings.navControls" },
  { id: "sites", label: "settings.navSites" },
  { id: "incognito", label: "fab.incognito" },
  { id: "assistant", label: "ai.title" },
  { id: "data", label: "settings.data" },
];

interface SettingsNavProps {
  value: SettingsCategory;
  onChange: (category: SettingsCategory) => void;
}

/**
 * Which part of Settings shows. A column of names beside the page on desktop, a row of chips that
 * scrolls sideways on a phone; either way one part at a time, not one long list.
 */
export function SettingsNav({ value, onChange }: SettingsNavProps) {
  const desktop = useApp((s) => s.desktop);
  const t = useT();

  if (desktop) {
    return (
      <nav aria-label={t("settings.title")} className="flex flex-col gap-0.5">
        {SETTINGS_CATEGORIES.map((category) => {
          const current = category.id === value;
          return (
            <button
              key={category.id}
              type="button"
              aria-current={current ? "page" : undefined}
              onClick={() => onChange(category.id)}
              className={`relative rounded-lg px-3 py-2 text-start text-sm font-medium transition-colors ${
                current
                  ? "bg-paper/[0.08] text-paper"
                  : "text-paper/60 hover:bg-paper/[0.05] hover:text-paper"
              }`}
            >
              {current && (
                <span
                  aria-hidden="true"
                  className="absolute inset-y-2 start-0 w-0.5 rounded-full bg-accent"
                />
              )}
              {t(category.label)}
            </button>
          );
        })}
      </nav>
    );
  }

  return (
    <nav
      aria-label={t("settings.title")}
      className="chip-row -mx-4 flex gap-2 overflow-x-auto px-4 pb-1"
    >
      {SETTINGS_CATEGORIES.map((category) => {
        const current = category.id === value;
        return (
          <button
            key={category.id}
            type="button"
            aria-current={current ? "page" : undefined}
            onClick={() => onChange(category.id)}
            className={`shrink-0 rounded-full border px-4 py-2 text-sm font-medium ${
              current
                ? "border-accent bg-accent text-on-accent"
                : "border-hair text-paper/75 active:bg-paper/[0.08]"
            }`}
          >
            {t(category.label)}
          </button>
        );
      })}
    </nav>
  );
}
