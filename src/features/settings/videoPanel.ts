import { useApp } from "../../app/store";

/** Turns the video controls panel on or off for every site: a site's own "on" would keep it showing there. */
export function setVideoPanel(on: boolean): void {
  const { state, setVideoControls, setSiteVideoControls } = useApp.getState();
  void setVideoControls({ panel: on });
  if (on) return;
  for (const [site, own] of Object.entries(state?.videoSites ?? {})) {
    if (own.panel === true) void setSiteVideoControls(site, { ...own, panel: undefined });
  }
}
