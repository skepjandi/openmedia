import { useApp } from "../../app/store";
import { useT } from "../../i18n/useT";
import { Screen } from "../../shared/Screen";
import { VIDEO_CONTROLS_DEFAULT } from "../../shared/videoControls";
import { NavRow } from "./SiteParts";
import { VideoControlsFields } from "./VideoControlsFields";
import { Group } from "./ui";

/** The row in Settings that opens the video controls page. */
export function VideoControlsLink() {
  const openSheet = useApp((s) => s.openSheet);
  const t = useT();

  return (
    <Group>
      <NavRow
        title={t("settings.videoControls")}
        note={t("settings.videoControlsNote")}
        onClick={() => openSheet("video-controls")}
      />
    </Group>
  );
}

/**
 * The controls for the video in view in a full-screen feed: Shorts, Reels and the like. Opened
 * from Settings, or by holding the video controls button in the floating button's fan. A favorite's
 * Video controls page can override each setting for its site.
 */
export function VideoControlsScreen() {
  const open = useApp((s) => s.sheet === "video-controls");
  const closeSheet = useApp((s) => s.closeSheet);
  const parent = useApp((s) => s.sheetParent);
  const controls = useApp((s) => s.state?.videoControls ?? VIDEO_CONTROLS_DEFAULT);
  const setVideoControls = useApp((s) => s.setVideoControls);
  const t = useT();
  if (!open) return null;

  return (
    <Screen
      title={t("settings.videoControlsTitle")}
      subtitle={t("settings.videoControlsNote")}
      closeLabel={t(parent === "settings" ? "common.back" : "settings.close")}
      onClose={closeSheet}
      back={parent === "settings"}
    >
      <VideoControlsFields value={controls} change={(changes) => void setVideoControls(changes)} />
    </Screen>
  );
}
