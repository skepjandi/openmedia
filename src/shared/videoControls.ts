import type { SiteVideo, VideoControls } from "./ipc";
import { withOverrides } from "./overrides";

/** The panel on, the rest off: what the app starts with, and what Rust holds until the user chooses. */
export const VIDEO_CONTROLS_DEFAULT: VideoControls = {
  panel: true,
  height: 16,
  fullVideos: false,
  remember: false,
  loopOff: false,
  autoAdvance: false,
};

/** The most pixels the panel can sit above the bottom edge; the same cap as the bottom margin. */
export const MAX_VIDEO_HEIGHT = 200;

/** The video controls a site gets: its own fields laid over general. */
export function effectiveVideo(general: VideoControls, site: SiteVideo | undefined): VideoControls {
  return withOverrides(general, site);
}
