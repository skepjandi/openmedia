import { useApp } from "../../app/store";
import { useT } from "../../i18n/useT";
import type { SiteVideo } from "../../shared/ipc";
import { withoutFields } from "../../shared/overrides";
import { Screen } from "../../shared/Screen";
import { VIDEO_CONTROLS_DEFAULT, effectiveVideo } from "../../shared/videoControls";
import { Segmented } from "./Segmented";
import { VideoControlsFields } from "./VideoControlsFields";
import { Group, quietButton } from "./ui";

/**
 * One favorite's video controls. It has every setting the general page has; each follows general
 * until the site is given a value of its own. Opened from the favorite in Settings.
 */
export function SiteVideoControlsScreen() {
  const open = useApp((s) => s.sheet === "site-video");
  const site = useApp((s) => s.sheetSite);
  const name = useApp((s) => s.sheetSiteName);
  const closeSheet = useApp((s) => s.closeSheet);
  const parent = useApp((s) => s.sheetParent);
  const general = useApp((s) => s.state?.videoControls ?? VIDEO_CONTROLS_DEFAULT);
  const stored = useApp((s) => (site ? s.state?.videoSites[site] : undefined));
  const setSiteVideoControls = useApp((s) => s.setSiteVideoControls);
  const t = useT();
  if (!open || !site || name === null) return null;

  const own: SiteVideo = stored ?? {};
  const effective = effectiveVideo(general, own);
  const save = (next: SiteVideo) => void setSiteVideoControls(site, next);
  const overrides = {
    own,
    follow: (fields: (keyof SiteVideo)[]) => save(withoutFields(own, fields)),
  };
  const choice = own.panel === undefined ? "follow" : own.panel ? "on" : "off";

  return (
    <Screen
      title={t("site.videoTitle", { name })}
      subtitle={t("site.subtitle")}
      closeLabel={t(parent === "settings" ? "common.back" : "settings.close")}
      onClose={closeSheet}
      back={parent === "settings"}
    >
      <div className="flex flex-col gap-9">
        <div className="flex flex-col gap-2">
          <div className="px-1 text-sm font-medium">{t("favorites.videoPanel")}</div>
          <Segmented
            label={t("favorites.videoPanelLabel", { site })}
            value={choice}
            options={[
              { value: "follow", label: t("favorites.darkFollow") },
              { value: "on", label: t("favorites.darkOn") },
              { value: "off", label: t("favorites.darkOff") },
            ]}
            onChange={(next) =>
              save({ ...own, panel: next === "follow" ? undefined : next === "on" })
            }
          />
        </div>

        <VideoControlsFields
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
