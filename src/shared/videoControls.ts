import type { SiteVideo, VideoControls } from "./ipc";
import { withOverrides } from "./overrides";

/** The panel on, the rest off: what the app starts with, and what Rust holds until the user chooses. */
export const VIDEO_CONTROLS_DEFAULT: VideoControls = {
  panel: true,
  height: 16,
  skip: 10,
  fullVideos: false,
  dragToMini: true,
  remember: false,
  loopOff: false,
  autoAdvance: false,
};

/** The seconds the skip buttons and a double tap can jump by. */
export const VIDEO_SKIP_CHOICES = [5, 10, 15, 30] as const;

/** The most pixels the panel can sit above the bottom edge; the same cap as the bottom margin. */
export const MAX_VIDEO_HEIGHT = 200;

/** The video controls a site gets: its own fields laid over general. */
export function effectiveVideo(general: VideoControls, site: SiteVideo | undefined): VideoControls {
  return withOverrides(general, site);
}
