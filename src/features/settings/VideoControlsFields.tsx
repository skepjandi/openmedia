import type { MessageKey } from "../../i18n/messages";
import { useApp } from "../../app/store";
import { useT } from "../../i18n/useT";
import type { SiteVideo, VideoControls } from "../../shared/ipc";
import { VIDEO_SKIP_CHOICES } from "../../shared/videoControls";
import { MarginSlider } from "./MarginSlider";
import { Segmented } from "./Segmented";
import { FollowGeneral, type SiteOverrides } from "./SiteParts";
import { Switch } from "./Switch";
import { Group, GroupLabel } from "./ui";

interface VideoControlsFieldsProps {
  /** What is in effect: general's value, or a site's own where it sets one. */
  value: VideoControls;
  /** Writes only the fields given. */
  change: (changes: Partial<VideoControls>) => void;
  /** Present on a site's page: which settings the site sets itself, and how to hand each back. */
  overrides?: SiteOverrides<SiteVideo>;
}

/**
 * Every video controls setting except whether the panel shows, which each page words for itself.
 * General and a site's page render this one component, so a site can never lack a setting general has.
 * Desktop splits them into the panel's own settings and the playback ones; a phone keeps one card.
 */
export function VideoControlsFields({ value, change, overrides }: VideoControlsFieldsProps) {
  const t = useT();
  const desktop = useApp((s) => s.desktop);
  const follows = (fields: (keyof SiteVideo)[], label: MessageKey, className: string) => (
    <FollowGeneral overrides={overrides} fields={fields} label={t(label)} className={className} />
  );

  const panelRows = value.panel
    ? [
        <div key="full">
          <Switch
            label={t("settings.videoFull")}
            description={t("settings.videoFullNote")}
            checked={value.fullVideos}
            onChange={(on) => change({ fullVideos: on })}
          />
          {follows(["fullVideos"], "settings.videoFull", "px-4 pb-3")}
        </div>,
        <div key="height" className="flex flex-col gap-2 px-4 py-3">
          <div className="text-base desktop:text-[15px]">{t("settings.videoHeight")}</div>
          <p className="text-sm leading-snug text-paper/55 desktop:text-[13px]">
            {t("settings.videoHeightNote")}
          </p>
          <MarginSlider
            label={t("settings.videoHeightLabel")}
            value={value.height}
            onCommit={(pixels) => change({ height: pixels })}
          />
          {follows(["height"], "settings.videoHeight", "")}
        </div>,
      ]
    : [];

  const playbackRows = [
    <div key="skip" className="flex flex-col gap-2 px-4 py-3">
      <div className="text-base desktop:text-[15px]">{t("settings.videoSkip")}</div>
      <p className="text-sm leading-snug text-paper/55 desktop:text-[13px]">
        {t("settings.videoSkipNote")}
      </p>
      <Segmented
        label={t("settings.videoSkipLabel")}
        value={String(value.skip)}
        options={VIDEO_SKIP_CHOICES.map((seconds) => ({
          value: String(seconds),
          label: t("settings.videoSkipSeconds", { seconds }),
        }))}
        onChange={(seconds) => change({ skip: Number(seconds) })}
      />
      {follows(["skip"], "settings.videoSkip", "")}
    </div>,
    <div key="drag">
      <Switch
        label={t("settings.videoDragMini")}
        description={t("settings.videoDragMiniNote")}
        checked={value.dragToMini}
        onChange={(on) => change({ dragToMini: on })}
      />
      {follows(["dragToMini"], "settings.videoDragMini", "px-4 pb-3")}
    </div>,
    <div key="remember">
      <Switch
        label={t("settings.videoRemember")}
        description={t("settings.videoRememberNote")}
        checked={value.remember}
        onChange={(on) => change({ remember: on })}
      />
      {follows(["remember"], "settings.videoRemember", "px-4 pb-3")}
    </div>,
    <div key="loop">
      <Switch
        label={t("settings.videoLoopOff")}
        description={t("settings.videoLoopOffNote")}
        checked={value.loopOff || value.autoAdvance}
        onChange={(on) => change(on ? { loopOff: true } : { loopOff: false, autoAdvance: false })}
      />
      {follows(["loopOff"], "settings.videoLoopOff", "px-4 pb-3")}
    </div>,
    <div key="advance">
      <Switch
        label={t("settings.videoAutoAdvance")}
        description={t("settings.videoAutoAdvanceNote")}
        checked={value.autoAdvance}
        onChange={(on) => change({ autoAdvance: on })}
      />
      {follows(["autoAdvance"], "settings.videoAutoAdvance", "px-4 pb-3")}
    </div>,
  ];

  if (!desktop) return <Group>{[...panelRows, ...playbackRows]}</Group>;

  return (
    <div className="flex flex-col gap-8">
      {panelRows.length > 0 && (
        <div>
          <GroupLabel>{t("settings.videoGroupPanel")}</GroupLabel>
          <Group>{panelRows}</Group>
        </div>
      )}
      <div>
        <GroupLabel>{t("settings.videoGroupPlayback")}</GroupLabel>
        <Group>{playbackRows}</Group>
      </div>
    </div>
  );
}
