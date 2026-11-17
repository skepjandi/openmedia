import { useApp } from "../../app/store";
import { useT } from "../../i18n/useT";
import { ForwardIcon } from "../../shared/icons";
import { Screen } from "../../shared/Screen";
import { VIDEO_CONTROLS_DEFAULT } from "../../shared/videoControls";
import { MarginSlider } from "./MarginSlider";
import { Switch } from "./Switch";
import { Group } from "./ui";

/** The row in Settings that opens the video controls page. */
export function VideoControlsLink() {
  const openSheet = useApp((s) => s.openSheet);
  const t = useT();

  return (
    <Group>
      <button
        type="button"
        onClick={() => openSheet("video-controls")}
        className="flex w-full items-center gap-3 px-4 py-3.5 text-start active:bg-paper/[0.05]"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-base font-medium">{t("settings.videoControls")}</span>
          <span className="block text-sm text-paper/55">{t("settings.videoControlsNote")}</span>
        </span>
        <span aria-hidden="true" className="text-paper/50 rtl:-scale-x-100">
          <ForwardIcon />
        </span>
      </button>
    </Group>
  );
}

/**
 * The controls for the video in view in a full-screen feed: Shorts, Reels and the like. Opened
 * from Settings, or by holding the video controls button in the floating button's fan.
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
      title={t("settings.videoControls")}
      subtitle={t("settings.videoControlsNote")}
      closeLabel={t(parent === "settings" ? "common.back" : "settings.close")}
      onClose={closeSheet}
      back={parent === "settings"}
    >
      <Group>
        {controls.panel && (
          <Switch
            label={t("settings.videoFull")}
            description={t("settings.videoFullNote")}
            checked={controls.fullVideos}
            onChange={(on) => void setVideoControls({ fullVideos: on })}
          />
        )}
        {controls.panel && (
          <div className="flex flex-col gap-2 px-4 py-3">
            <div className="text-base">{t("settings.videoHeight")}</div>
            <p className="text-sm leading-snug text-paper/55">{t("settings.videoHeightNote")}</p>
            <MarginSlider
              label={t("settings.videoHeightLabel")}
              value={controls.height}
              onCommit={(pixels) => void setVideoControls({ height: pixels })}
            />
          </div>
        )}
        <Switch
          label={t("settings.videoRemember")}
          description={t("settings.videoRememberNote")}
          checked={controls.remember}
          onChange={(on) => void setVideoControls({ remember: on })}
        />
        <Switch
          label={t("settings.videoLoopOff")}
          description={t("settings.videoLoopOffNote")}
          checked={controls.loopOff || controls.autoAdvance}
          onChange={(on) =>
            void setVideoControls(on ? { loopOff: true } : { loopOff: false, autoAdvance: false })
          }
        />
        <Switch
          label={t("settings.videoAutoAdvance")}
          description={t("settings.videoAutoAdvanceNote")}
          checked={controls.autoAdvance}
          onChange={(on) => void setVideoControls({ autoAdvance: on })}
        />
      </Group>
    </Screen>
  );
}
