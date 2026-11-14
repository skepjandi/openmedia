import { useApp } from "../../app/store";
import { useT } from "../../i18n/useT";
import { VIDEO_CONTROLS_OFF } from "../../shared/videoControls";
import { Switch } from "./Switch";
import { Group, Section } from "./ui";

/** The controls for the video in view in a full-screen feed: Shorts, Reels and the like. */
export function VideoControlsSection() {
  const controls = useApp((s) => s.state?.videoControls ?? VIDEO_CONTROLS_OFF);
  const setVideoControls = useApp((s) => s.setVideoControls);
  const t = useT();

  return (
    <Section title={t("settings.videoControls")} note={t("settings.videoControlsNote")}>
      <Group>
        <Switch
          label={t("settings.videoSeekBar")}
          description={t("settings.videoSeekBarNote")}
          checked={controls.seekBar}
          onChange={(on) => void setVideoControls({ seekBar: on })}
        />
        <Switch
          label={t("settings.videoSpeed")}
          description={t("settings.videoSpeedNote")}
          checked={controls.speed}
          onChange={(on) => void setVideoControls({ speed: on })}
        />
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
