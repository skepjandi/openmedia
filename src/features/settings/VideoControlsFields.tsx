import type { MessageKey } from "../../i18n/messages";
import { useT } from "../../i18n/useT";
import type { SiteVideo, VideoControls } from "../../shared/ipc";
import { MarginSlider } from "./MarginSlider";
import { FollowGeneral, type SiteOverrides } from "./SiteParts";
import { Switch } from "./Switch";
import { Group } from "./ui";

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
 */
export function VideoControlsFields({ value, change, overrides }: VideoControlsFieldsProps) {
  const t = useT();
  const follows = (fields: (keyof SiteVideo)[], label: MessageKey, className: string) => (
    <FollowGeneral overrides={overrides} fields={fields} label={t(label)} className={className} />
  );

  return (
    <Group>
      {value.panel && (
        <div>
          <Switch
            label={t("settings.videoFull")}
            description={t("settings.videoFullNote")}
            checked={value.fullVideos}
            onChange={(on) => change({ fullVideos: on })}
          />
          {follows(["fullVideos"], "settings.videoFull", "px-4 pb-3")}
        </div>
      )}
      {value.panel && (
        <div className="flex flex-col gap-2 px-4 py-3">
          <div className="text-base">{t("settings.videoHeight")}</div>
          <p className="text-sm leading-snug text-paper/55">{t("settings.videoHeightNote")}</p>
          <MarginSlider
            label={t("settings.videoHeightLabel")}
            value={value.height}
            onCommit={(pixels) => change({ height: pixels })}
          />
          {follows(["height"], "settings.videoHeight", "")}
        </div>
      )}
      <div>
        <Switch
          label={t("settings.videoRemember")}
          description={t("settings.videoRememberNote")}
          checked={value.remember}
          onChange={(on) => change({ remember: on })}
        />
        {follows(["remember"], "settings.videoRemember", "px-4 pb-3")}
      </div>
      <div>
        <Switch
          label={t("settings.videoLoopOff")}
          description={t("settings.videoLoopOffNote")}
          checked={value.loopOff || value.autoAdvance}
          onChange={(on) => change(on ? { loopOff: true } : { loopOff: false, autoAdvance: false })}
        />
        {follows(["loopOff"], "settings.videoLoopOff", "px-4 pb-3")}
      </div>
      <div>
        <Switch
          label={t("settings.videoAutoAdvance")}
          description={t("settings.videoAutoAdvanceNote")}
          checked={value.autoAdvance}
          onChange={(on) => change({ autoAdvance: on })}
        />
        {follows(["autoAdvance"], "settings.videoAutoAdvance", "px-4 pb-3")}
      </div>
    </Group>
  );
}
