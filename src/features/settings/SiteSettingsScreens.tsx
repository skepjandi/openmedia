import type { ReactNode } from "react";
import { selectSheetHasBack, useApp } from "../../app/store";
import { useT } from "../../i18n/useT";
import { DARK_METHODS, DARK_MODE_DEFAULT, darkActiveFor } from "../../shared/darkMode";
import { ForwardIcon } from "../../shared/icons";
import type { DarkMethod } from "../../shared/ipc";
import { Screen } from "../../shared/Screen";
import { siteOf } from "../../shared/site";
import { VIDEO_CONTROLS_DEFAULT } from "../../shared/videoControls";
import { MarginSlider } from "./MarginSlider";
import { Picker } from "./Picker";
import { Segmented } from "./Segmented";
import { Switch } from "./Switch";
import { Group, quietButton } from "./ui";

/** The row style of the page links in Settings: a title, a note and a forward arrow. */
function PageRow({ title, note, onOpen }: { title: string; note: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-3 px-4 py-3.5 text-start active:bg-paper/[0.05]"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-base font-medium">{title}</span>
        <span className="block text-sm text-paper/55">{note}</span>
      </span>
      <span aria-hidden="true" className="text-paper/50 rtl:-scale-x-100">
        <ForwardIcon />
      </span>
    </button>
  );
}

/** The site the open site page is about, and the page's frame: back arrow when it has a page to go back to. */
function SitePage({
  sheet,
  title,
  subtitle,
  children,
}: {
  sheet: "site-settings" | "site-dark-mode" | "site-video";
  title: string;
  subtitle: (site: string, name: string) => string;
  children: (site: string) => ReactNode;
}) {
  const open = useApp((s) => s.sheet === sheet);
  const site = useApp((s) => s.sheetSite);
  const name = useApp((s) => {
    const favorite = s.state?.favorites.find((entry) => siteOf(entry.url) === s.sheetSite);
    return favorite?.name ?? "";
  });
  const closeSheet = useApp((s) => s.closeSheet);
  const back = useApp((s) => s.sheetParent === "settings" || selectSheetHasBack(s));
  const t = useT();
  if (!open || !site) return null;
  return (
    <Screen
      title={title}
      subtitle={subtitle(site, name)}
      closeLabel={t(back ? "common.back" : "settings.close")}
      onClose={closeSheet}
      back={back}
    >
      {children(site)}
    </Screen>
  );
}

const siteLabel = (site: string, name: string) =>
  name && name !== site ? `${name} · ${site}` : site;

/** The hub of one site's pages: opened from its favorite in Settings. */
export function SiteSettingsScreen() {
  const openSiteSheet = useApp((s) => s.openSiteSheet);
  const t = useT();
  return (
    <SitePage sheet="site-settings" title={t("favorites.pageSettings")} subtitle={siteLabel}>
      {(site) => (
        <Group>
          <PageRow
            title={t("settings.darkMode")}
            note={t("siteSettings.darkNote")}
            onOpen={() => openSiteSheet("site-dark-mode", site)}
          />
          <PageRow
            title={t("settings.videoControls")}
            note={t("siteSettings.videoNote")}
            onOpen={() => openSiteSheet("site-video", site)}
          />
        </Group>
      )}
    </SitePage>
  );
}

/** The method a picker value names; an empty value follows the shared one. */
function methodOf(value: string): DarkMethod | undefined {
  return DARK_METHODS.find((entry) => entry.value === value)?.value;
}

/**
 * This site's own dark mode choice: always on, off, or following the shared settings, and the
 * method it darkens with. It saves at once.
 */
export function SiteDarkModeScreen() {
  const darkMode = useApp((s) => s.state?.darkMode ?? DARK_MODE_DEFAULT);
  const darkSites = useApp((s) => s.state?.darkSites);
  const setSiteDarkMode = useApp((s) => s.setSiteDarkMode);
  const openSheet = useApp((s) => s.openSheet);
  const t = useT();
  return (
    <SitePage sheet="site-dark-mode" title={t("settings.darkMode")} subtitle={siteLabel}>
      {(site) => {
        const own = darkSites?.[site];
        const mode = own?.mode ?? "follow";
        const active = darkActiveFor(darkMode, darkSites ?? {}, site);
        return (
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-2">
              <Segmented
                label={t("favorites.darkModeLabel", { site })}
                value={mode}
                options={[
                  { value: "follow", label: t("favorites.darkFollow") },
                  { value: "on", label: t("favorites.darkOn") },
                  { value: "off", label: t("favorites.darkOff") },
                ]}
                onChange={(next) =>
                  void setSiteDarkMode(site, { ...own, mode: next === "follow" ? undefined : next })
                }
              />
              <p className="px-1 text-[13px] leading-snug text-paper/50">
                {t(active ? "siteDark.effectiveOn" : "siteDark.effectiveOff")}
              </p>
            </div>
            {mode !== "off" && (
              <Picker
                label={t("favorites.darkMethod")}
                value={own?.method ?? ""}
                options={[
                  { value: "", label: t("favorites.darkMethodDefault") },
                  ...DARK_METHODS.map((entry) => ({ value: entry.value, label: t(entry.label) })),
                ]}
                onChange={(next) => void setSiteDarkMode(site, { ...own, method: methodOf(next) })}
              />
            )}
            <Group>
              <PageRow
                title={t("siteDark.openShared")}
                note={t("siteDark.openSharedNote")}
                onOpen={() => openSheet("dark-mode")}
              />
            </Group>
          </div>
        );
      }}
    </SitePage>
  );
}

type PanelChoice = "follow" | "on" | "off";

const panelChoice = (panel: boolean | undefined): PanelChoice =>
  panel === undefined ? "follow" : panel ? "on" : "off";

/**
 * This site's own video controls: whether the tap panel shows on it, whether it also covers full
 * videos, and how high it sits. A site with no choice follows the shared one in Settings. It
 * saves at once.
 */
export function SiteVideoScreen() {
  const shared = useApp((s) => s.state?.videoControls ?? VIDEO_CONTROLS_DEFAULT);
  const videoSites = useApp((s) => s.state?.videoSites);
  const setSiteVideoControls = useApp((s) => s.setSiteVideoControls);
  const t = useT();
  return (
    <SitePage sheet="site-video" title={t("settings.videoControls")} subtitle={siteLabel}>
      {(site) => {
        const own = videoSites?.[site];
        const panel = own?.panel ?? shared.panel;
        return (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <div className="text-sm font-medium">{t("favorites.videoPanel")}</div>
              <Segmented
                label={t("favorites.videoPanelLabel", { site })}
                value={panelChoice(own?.panel)}
                options={[
                  { value: "follow", label: t("favorites.darkFollow") },
                  { value: "on", label: t("favorites.darkOn") },
                  { value: "off", label: t("favorites.darkOff") },
                ]}
                onChange={(next) =>
                  void setSiteVideoControls(site, {
                    ...own,
                    panel: next === "follow" ? undefined : next === "on",
                  })
                }
              />
            </div>
            {panel && (
              <Group>
                <Switch
                  label={t("favorites.videoFull")}
                  description={t("favorites.videoFullNote")}
                  checked={own?.fullVideos ?? shared.fullVideos}
                  onChange={(next) => void setSiteVideoControls(site, { ...own, fullVideos: next })}
                />
              </Group>
            )}
            {panel && (
              <div className="flex flex-col gap-2">
                <div className="text-sm font-medium">{t("favorites.videoHeight")}</div>
                <p className="text-sm leading-snug text-paper/55">
                  {own?.height === undefined
                    ? t("favorites.videoHeightShared")
                    : t("favorites.videoHeightOwn")}
                </p>
                <MarginSlider
                  label={t("favorites.videoHeightLabel", { site })}
                  value={own?.height ?? shared.height}
                  onCommit={(pixels) => void setSiteVideoControls(site, { ...own, height: pixels })}
                />
              </div>
            )}
            {own && (
              <button
                type="button"
                onClick={() => void setSiteVideoControls(site, {})}
                className={`self-start ${quietButton}`}
              >
                {t("favorites.videoUseShared")}
              </button>
            )}
          </div>
        );
      }}
    </SitePage>
  );
}
