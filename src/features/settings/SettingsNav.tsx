import type { ReactNode } from "react";
import type { MessageKey } from "../../i18n/messages";
import { useT } from "../../i18n/useT";
import {
  DatabaseIcon,
  ForwardIcon,
  GlobeIcon,
  IncognitoIcon,
  SlidersIcon,
  SparkIcon,
  TilesIcon,
  ToggleIcon,
} from "../../shared/icons";
import { Group } from "./ui";

export type SettingsCategory =
  "general" | "browsing" | "controls" | "sites" | "incognito" | "assistant" | "data";

interface CategoryInfo {
  id: SettingsCategory;
  label: MessageKey;
  icon: ReactNode;
  /** The names of what is inside, which a phone's list shows under the category's name. */
  parts: readonly MessageKey[];
}

export const SETTINGS_CATEGORIES: readonly CategoryInfo[] = [
  {
    id: "general",
    label: "settings.navGeneral",
    icon: <SlidersIcon />,
    parts: ["settings.profiles", "settings.appearance", "settings.language"],
  },
  {
    id: "browsing",
    label: "settings.browsing",
    icon: <GlobeIcon />,
    parts: [
      "settings.adBlock",
      "settings.darkMode",
      "settings.videoControls",
      "settings.downloads",
    ],
  },
  {
    id: "controls",
    label: "settings.navControls",
    icon: <ToggleIcon />,
    parts: ["settings.colorPicker", "settings.techDetector", "settings.accessibility"],
  },
  {
    id: "sites",
    label: "settings.navSites",
    icon: <TilesIcon />,
    parts: ["favorites.title", "recipes.title", "library.title"],
  },
  {
    id: "incognito",
    label: "fab.incognito",
    icon: <IncognitoIcon />,
    parts: ["incognito.favoritesTitle", "incognito.recipesTitle"],
  },
  {
    id: "assistant",
    label: "ai.title",
    icon: <SparkIcon />,
    parts: ["ai.providerLabel", "ai.apiKey", "ai.model"],
  },
  {
    id: "data",
    label: "settings.data",
    icon: <DatabaseIcon />,
    parts: ["settings.updates", "settings.history", "settings.chats", "settings.guide"],
  },
];

export function categoryLabel(id: SettingsCategory): MessageKey {
  const category = SETTINGS_CATEGORIES.find((entry) => entry.id === id);
  return category ? category.label : "settings.title";
}

interface SettingsNavProps {
  value: SettingsCategory;
  onChange: (category: SettingsCategory) => void;
}

/** Desktop: a column of names beside the page, one part of Settings showing at a time. */
export function SettingsNav({ value, onChange }: SettingsNavProps) {
  const t = useT();

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

/**
 * A phone's first page of Settings: every part as a row with an icon, its name and what is in it.
 * A tap opens that part as its own page, so no page is a long scroll.
 */
export function SettingsIndex({ onOpen }: { onOpen: (category: SettingsCategory) => void }) {
  const t = useT();

  return (
    <nav aria-label={t("settings.title")}>
      <Group>
        {SETTINGS_CATEGORIES.map((category) => (
          <button
            key={category.id}
            type="button"
            onClick={() => onOpen(category.id)}
            className="flex w-full items-center gap-3.5 px-4 py-3 text-start active:bg-paper/[0.06]"
          >
            <span
              aria-hidden="true"
              className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent/15 text-accent"
            >
              {category.icon}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-base font-medium">{t(category.label)}</span>
              <span className="line-clamp-2 text-sm leading-snug text-paper/55">
                {category.parts.map((part) => t(part)).join(" · ")}
              </span>
            </span>
            <span aria-hidden="true" className="text-paper/45 rtl:-scale-x-100">
              <ForwardIcon />
            </span>
          </button>
        ))}
      </Group>
    </nav>
  );
}
