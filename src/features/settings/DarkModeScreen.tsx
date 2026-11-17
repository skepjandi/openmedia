import { useApp } from "../../app/store";
import { useT } from "../../i18n/useT";
import { DARK_MODE_DEFAULT } from "../../shared/darkMode";
import type { DarkMode } from "../../shared/ipc";
import { overrideCount } from "../../shared/overrides";
import { Screen } from "../../shared/Screen";
import { DarkModeControls } from "./DarkModeControls";
import { NavRow } from "./SiteParts";
import { Switch } from "./Switch";
import { Group, Section, quietButton } from "./ui";

/** The row in Settings that opens the dark mode page. */
export function DarkModeLink() {
  const openSheet = useApp((s) => s.openSheet);
  const t = useT();

  return (
    <Group>
      <NavRow
        title={t("settings.darkMode")}
        note={t("settings.darkModeNote")}
        onClick={() => openSheet("dark-mode")}
      />
    </Group>
  );
}

/**
 * Dark mode for the pages the user opens: on or off, how pages are darkened, the colours and when
 * it applies. A favorite's Dark mode page can override each setting for its site.
 */
export function DarkModeScreen() {
  const open = useApp((s) => s.sheet === "dark-mode");
  const closeSheet = useApp((s) => s.closeSheet);
  const parent = useApp((s) => s.sheetParent);
  const dark = useApp((s) => s.state?.darkMode ?? DARK_MODE_DEFAULT);
  const setDarkMode = useApp((s) => s.setDarkMode);
  const t = useT();
  if (!open) return null;

  const change = (changes: Partial<DarkMode>) => void setDarkMode(changes);

  return (
    <Screen
      title={t("settings.darkModeTitle")}
      subtitle={t("settings.darkModeSubtitle")}
      closeLabel={t(parent === "settings" ? "common.back" : "settings.close")}
      onClose={closeSheet}
      back={parent === "settings"}
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

        <DarkModeControls value={dark} change={change} />

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
                  {t("site.overrideCount", { count: overrideCount(choice) })}
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
