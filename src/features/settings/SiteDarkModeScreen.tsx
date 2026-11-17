import { useApp } from "../../app/store";
import { useT } from "../../i18n/useT";
import { DARK_MODE_DEFAULT, effectiveDark } from "../../shared/darkMode";
import type { SiteDark } from "../../shared/ipc";
import { withoutFields } from "../../shared/overrides";
import { Screen } from "../../shared/Screen";
import { DarkModeControls } from "./DarkModeControls";
import { Segmented } from "./Segmented";
import { Group, quietButton } from "./ui";

/**
 * One favorite's dark mode. It has every setting the general page has; each follows general until
 * the site is given a value of its own. Opened from the favorite in Settings, or by holding the
 * moon on the floating button.
 */
export function SiteDarkModeScreen() {
  const open = useApp((s) => s.sheet === "site-dark-mode");
  const site = useApp((s) => s.sheetSite);
  const name = useApp((s) => s.sheetSiteName);
  const closeSheet = useApp((s) => s.closeSheet);
  const parent = useApp((s) => s.sheetParent);
  const general = useApp((s) => s.state?.darkMode ?? DARK_MODE_DEFAULT);
  const stored = useApp((s) => (site ? s.state?.darkSites[site] : undefined));
  const setSiteDarkMode = useApp((s) => s.setSiteDarkMode);
  const t = useT();
  if (!open || !site || name === null) return null;

  const own: SiteDark = stored ?? {};
  const effective = effectiveDark(general, own);
  const save = (next: SiteDark) => void setSiteDarkMode(site, next);
  const overrides = {
    own,
    follow: (fields: (keyof SiteDark)[]) => save(withoutFields(own, fields)),
  };
  const choice = own.mode ?? "follow";

  return (
    <Screen
      title={t("site.darkTitle", { name })}
      subtitle={t("site.subtitle")}
      closeLabel={t(parent === "settings" ? "common.back" : "settings.close")}
      onClose={closeSheet}
      back={parent === "settings"}
    >
      <div className="flex flex-col gap-9">
        <div className="flex flex-col gap-2">
          <Segmented
            label={t("favorites.darkModeLabel", { site })}
            value={choice}
            options={[
              { value: "follow", label: t("favorites.darkFollow") },
              { value: "on", label: t("favorites.darkOn") },
              { value: "off", label: t("favorites.darkOff") },
            ]}
            onChange={(next) => save({ ...own, mode: next === "follow" ? undefined : next })}
          />
          <p className="px-1 text-[13px] leading-snug text-paper/50">
            {t(effective.enabled ? "favorites.darkEffectiveOn" : "favorites.darkEffectiveOff")}
          </p>
        </div>

        <DarkModeControls
          value={effective}
          change={(changes) => save({ ...own, ...changes })}
          overrides={overrides}
        />

        <Group>
          <div className="flex items-center justify-between gap-3 px-4 py-3.5">
            <span className="text-base">{t("site.resetAll")}</span>
            <button type="button" onClick={() => save({})} className={quietButton}>
              {t("settings.darkResetButton")}
            </button>
          </div>
        </Group>
      </div>
    </Screen>
  );
}
