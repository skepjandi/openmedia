import { useApp } from "../../app/store";
import { useT } from "../../i18n/useT";
import { VIDEO_CONTROLS_DEFAULT } from "../../shared/videoControls";
import { MarginSlider } from "./MarginSlider";
import { Switch } from "./Switch";
import { Group, Section } from "./ui";

/** The controls for the video in view in a full-screen feed: Shorts, Reels and the like. */
export function VideoControlsSection() {
  const controls = useApp((s) => s.state?.videoControls ?? VIDEO_CONTROLS_DEFAULT);
  const setVideoControls = useApp((s) => s.setVideoControls);
  const t = useT();

  return (
    <Section title={t("settings.videoControls")} note={t("settings.videoControlsNote")}>
      <Group>
        <Switch
          label={t("settings.videoPanel")}
          description={t("settings.videoPanelNote")}
          checked={controls.panel}
          onChange={(on) => void setVideoControls({ panel: on })}
        />
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
    </Section>
  );
}
